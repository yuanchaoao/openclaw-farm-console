#!/usr/bin/env python3
"""Restricted, synchronous MCP facade for one configured OpenClaw Kimi K3 model."""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import json
import math
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Mapping, NoReturn

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.server.fastmcp.server import Settings as FastMCPSettings

    FastMCPSettings.model_rebuild()
except ModuleNotFoundError as exc:  # pragma: no cover - installation check
    raise SystemExit("Python package 'mcp' is required; install scripts/requirements.txt") from exc

import openclaw_farm as farm
import private_storage as storage


AGENT_ID = "kimi-k3-api"
MAX_PROMPT_BYTES = 1_500_000
MAX_GATEWAY_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_CHARS = 1_000_000
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5_000_000
MAX_TOTAL_IMAGE_BYTES = 12_000_000
MAX_IMAGE_FILENAME_BYTES = 128
MIN_TIMEOUT_MS = 1_000
MAX_TIMEOUT_MS = 600_000
DEFAULT_TIMEOUT_MS = 300_000
PREFLIGHT_TIMEOUT_MS = 30_000
HISTORY_TIMEOUT_MS = 10_000
HISTORY_LIMIT = 1_000
HISTORY_MAX_CHARS = 8_000
HISTORY_POLL_SECONDS = 0.25
MAX_JOURNAL_BYTES = 8 * 1024 * 1024
JOURNAL_SCHEMA_VERSION = 1
JOURNAL_STAGES = frozenset(
    {"prepared", "submit_started", "accepted", "recovering", "final", "failed"}
)
ACTIVE_JOURNAL_STAGES = frozenset({"submit_started", "accepted", "recovering"})
TERMINAL_JOURNAL_STAGES = frozenset({"final", "failed"})
HANDLER_REJECTION_CODES = frozenset(
    {"scope_upgrade_required", "pairing_required", "gateway_auth_error"}
)
ACTIVE_POINTER_SCHEMA_VERSION = 1
TERMINAL_STOP_REASONS = frozenset({"stop", "length", "error", "aborted"})
HISTORY_OVERSIZED_TEXT = "[chat.history omitted: message too large]"
HISTORY_TRUNCATED_SUFFIX = "\n...(truncated)..."
REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
GATEWAY_REQUEST_ID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
DATA_URL = re.compile(r"^data:([^;,]+);base64,(.*)$", re.IGNORECASE | re.DOTALL)
BASE64_WHITESPACE = re.compile(r"[\t\n\r\f\v ]+")
ALLOWED_IMAGE_MIMES = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/heic",
        "image/heif",
    }
)
MIME_ALIASES = {"image/jpg": "image/jpeg"}
MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
HEIC_BRANDS = frozenset({b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis"})
HEIF_BRANDS = frozenset({b"mif1", b"msf1"})

TARGET_INSTANCE = ""
TARGET_MODEL_REF = ""
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_SESSIONS: set[str] = set()


class KimiApiError(RuntimeError):
    """A structured, safe error returned by the restricted MCP facade."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def error_response(
    code: str,
    message: str,
    *,
    request_id: str = "",
    conversation_id: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if request_id:
        payload["request_id"] = request_id
    if conversation_id:
        payload["conversation_id"] = conversation_id
    return payload


def configure(instance: str, model_ref: str) -> None:
    global TARGET_INSTANCE, TARGET_MODEL_REF
    instance_id = farm.validate_instance_id(instance)
    provider, separator, model_id = model_ref.partition("/")
    if separator != "/" or not provider or not model_id or any(ch.isspace() for ch in model_ref):
        raise farm.FarmError("模型引用必须使用 provider/model 格式。")
    TARGET_INSTANCE = instance_id
    TARGET_MODEL_REF = model_ref


def _validate_identifier(value: str, name: str, *, max_bytes: int = 256) -> str:
    if not isinstance(value, str):
        raise KimiApiError("invalid_request", f"{name} 必须是字符串。")
    normalized = value.strip()
    if not normalized:
        raise KimiApiError("invalid_request", f"{name} 不能为空。")
    if len(normalized.encode("utf-8")) > max_bytes or any(ord(ch) < 32 for ch in normalized):
        raise KimiApiError("invalid_request", f"{name} 过长或包含控制字符。")
    return normalized


def _validate_inputs(
    prompt: str,
    conversation_id: str,
    request_id: str,
    timeout_ms: int,
    images: Any = None,
) -> tuple[str, str, str, int, list[dict[str, str]]]:
    if not TARGET_INSTANCE or not TARGET_MODEL_REF:
        raise KimiApiError("invalid_request", "Kimi K3 MCP 未绑定实例和模型。")
    if not isinstance(prompt, str) or not prompt.strip():
        raise KimiApiError("invalid_request", "prompt 不能为空。")
    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise KimiApiError("invalid_request", "prompt 超过 1.5 MiB 上限。")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int):
        raise KimiApiError("invalid_request", "timeout_ms 必须是整数。")
    if timeout_ms < MIN_TIMEOUT_MS or timeout_ms > MAX_TIMEOUT_MS:
        raise KimiApiError("invalid_request", "timeout_ms 必须在 1000 到 600000 之间。")

    normalized_request = request_id.strip() if isinstance(request_id, str) else ""
    if not normalized_request:
        normalized_request = uuid.uuid4().hex
    if not REQUEST_ID.fullmatch(normalized_request):
        raise KimiApiError("invalid_request", "request_id 格式不合法。")

    normalized_conversation = conversation_id.strip() if isinstance(conversation_id, str) else ""
    if not normalized_conversation:
        normalized_conversation = f"conv_{normalized_request}"
    normalized_conversation = _validate_identifier(normalized_conversation, "conversation_id")
    normalized_images = _validate_images(images)
    return prompt, normalized_conversation, normalized_request, timeout_ms, normalized_images


def _normalize_mime(value: Any, *, field: str) -> str:
    if not isinstance(value, str):
        raise KimiApiError("invalid_image", f"{field} 必须是字符串。")
    normalized = MIME_ALIASES.get(value.strip().lower(), value.strip().lower())
    if normalized not in ALLOWED_IMAGE_MIMES:
        raise KimiApiError(
            "unsupported_image_type",
            "图片 MIME 仅支持 JPEG、PNG、WEBP、GIF、HEIC 和 HEIF。",
        )
    return normalized


def _sniff_image_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        box_size = int.from_bytes(data[:4], "big")
        scan_end = min(len(data), box_size if box_size >= 16 else len(data), 256)
        brands = {data[8:12]}
        brands.update(data[offset : offset + 4] for offset in range(16, scan_end - 3, 4))
        if brands & HEIC_BRANDS:
            return "image/heic"
        if brands & HEIF_BRANDS:
            return "image/heif"
    return None


def _mimes_compatible(left: str, right: str) -> bool:
    return left == right or {left, right} <= {"image/heic", "image/heif"}


def _validate_image_filename(value: Any, index: int, mime_type: str) -> str:
    if value in (None, ""):
        return f"image-{index}{MIME_EXTENSIONS[mime_type]}"
    if not isinstance(value, str):
        raise KimiApiError("invalid_image", "图片 filename 必须是字符串。")
    filename = value.strip()
    if (
        not filename
        or len(filename.encode("utf-8")) > MAX_IMAGE_FILENAME_BYTES
        or any(ord(ch) < 32 for ch in filename)
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
    ):
        raise KimiApiError("invalid_image", "图片 filename 过长或包含路径/控制字符。")
    return filename


def _decode_image(item: Any, index: int) -> tuple[dict[str, str], int]:
    if not isinstance(item, dict):
        raise KimiApiError("invalid_image", "images 的每一项必须是对象。")
    unknown = set(item) - {"data", "mime_type", "filename"}
    if unknown:
        raise KimiApiError("invalid_image", "图片对象只允许 data、mime_type、filename 字段。")
    raw = item.get("data")
    if not isinstance(raw, str) or not raw.strip():
        raise KimiApiError("invalid_image", "图片 data 必须是非空 base64 或 data URL。")

    declared_mime: str | None = None
    body = raw.strip()
    data_url = DATA_URL.fullmatch(body)
    if body[:5].lower() == "data:" and data_url is None:
        raise KimiApiError("invalid_image", "图片 data URL 必须使用 data:image/...;base64,... 格式。")
    if data_url is not None:
        declared_mime = _normalize_mime(data_url.group(1), field="data URL MIME")
        body = data_url.group(2)

    supplied_mime: str | None = None
    if "mime_type" in item and item.get("mime_type") not in (None, ""):
        supplied_mime = _normalize_mime(item.get("mime_type"), field="mime_type")
    if declared_mime and supplied_mime and not _mimes_compatible(declared_mime, supplied_mime):
        raise KimiApiError("image_type_mismatch", "图片 data URL MIME 与 mime_type 不一致。")

    normalized_base64 = BASE64_WHITESPACE.sub("", body)
    max_encoded = 4 * math.ceil(MAX_IMAGE_BYTES / 3)
    if not normalized_base64 or len(normalized_base64) > max_encoded:
        raise KimiApiError("image_too_large", "单张图片超过 5,000,000 字节上限。")
    try:
        decoded = base64.b64decode(normalized_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise KimiApiError("invalid_image", "图片 data 不是有效的标准 base64。") from exc
    if not decoded:
        raise KimiApiError("invalid_image", "图片不能为空。")
    if len(decoded) > MAX_IMAGE_BYTES:
        raise KimiApiError("image_too_large", "单张图片超过 5,000,000 字节上限。")
    sniffed_mime = _sniff_image_mime(decoded)
    if sniffed_mime is None:
        raise KimiApiError("unsupported_image_type", "无法从图片魔数识别受支持的图片格式。")
    claimed_mime = supplied_mime or declared_mime
    if claimed_mime and not _mimes_compatible(claimed_mime, sniffed_mime):
        raise KimiApiError("image_type_mismatch", "图片声明 MIME 与文件魔数不一致。")
    final_mime = claimed_mime if claimed_mime and _mimes_compatible(claimed_mime, sniffed_mime) else sniffed_mime
    filename = _validate_image_filename(item.get("filename"), index, final_mime)
    return (
        {
            "type": "image",
            "mimeType": final_mime,
            "fileName": filename,
            "content": normalized_base64,
        },
        len(decoded),
    )


def _validate_images(images: Any) -> list[dict[str, str]]:
    if images is None:
        return []
    if not isinstance(images, list):
        raise KimiApiError("invalid_image", "images 必须是数组。")
    if len(images) > MAX_IMAGES:
        raise KimiApiError("too_many_images", "单次请求最多允许 4 张图片。")
    attachments: list[dict[str, str]] = []
    total_bytes = 0
    for index, item in enumerate(images, start=1):
        attachment, decoded_bytes = _decode_image(item, index)
        total_bytes += decoded_bytes
        if total_bytes > MAX_TOTAL_IMAGE_BYTES:
            raise KimiApiError("images_too_large", "图片解码后总大小超过 12,000,000 字节上限。")
        attachments.append(attachment)
    return attachments


def _session_identity(instance: str, model_ref: str, conversation_id: str) -> tuple[str, str]:
    digest = hashlib.sha256(f"{instance}|{model_ref}|{conversation_id}".encode("utf-8")).hexdigest()[:16]
    suffix = f"mcp-kimi-k3-{digest}"
    return f"agent:{AGENT_ID}:{suffix}", suffix


def _idempotency_key(
    instance: str,
    model_ref: str,
    conversation_id: str,
    request_id: str,
    prompt: str,
    attachments: list[dict[str, str]] | None = None,
) -> str:
    digest = hashlib.sha256()
    for value in (instance, model_ref, conversation_id, request_id, prompt):
        encoded_value = value.encode("utf-8")
        digest.update(len(encoded_value).to_bytes(8, "big"))
        digest.update(encoded_value)
    for attachment in attachments or []:
        for key in ("mimeType", "fileName", "content"):
            encoded_value = attachment[key].encode("utf-8")
            digest.update(len(encoded_value).to_bytes(8, "big"))
            digest.update(encoded_value)
    return "mcp-kimi-k3-" + digest.hexdigest()


def _journal_identity_digest(
    instance: str,
    model_ref: str,
    conversation_id: str,
    request_id: str,
) -> str:
    digest = hashlib.sha256()
    for value in (instance, model_ref, conversation_id, request_id):
        raw = value.encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _journal_marker(identity_digest: str) -> str:
    return f"kimi_k3_mcp:{identity_digest[:48]}"


def _journal_path(identity_digest: str) -> Path:
    journal_directory = farm.adapter_state_dir() / "kimi-k3-journal"
    farm.ensure_private_directory(journal_directory)
    return journal_directory / f"{identity_digest}.json"


def _conversation_identity_digest(instance: str, model_ref: str, conversation_id: str) -> str:
    digest = hashlib.sha256()
    for value in (instance, model_ref, conversation_id):
        raw = value.encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _active_pointer_path(instance: str, model_ref: str, conversation_id: str) -> Path:
    active_directory = farm.adapter_state_dir() / "kimi-k3-active"
    farm.ensure_private_directory(active_directory)
    digest = _conversation_identity_digest(instance, model_ref, conversation_id)
    return active_directory / f"{digest}.json"


def _validate_run_id(value: Any) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > 256
        or any(ord(ch) < 32 for ch in value)
    ):
        raise KimiApiError("journal_error", "本地请求 journal 的 run_id 不合法。")
    return value


def _read_private_json(path: Path, *, kind: str) -> dict[str, Any] | None:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise KimiApiError("journal_error", f"无法读取本地{kind}。") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or not storage.is_private(path, metadata)
            or metadata.st_nlink != 1
            or metadata.st_size > MAX_JOURNAL_BYTES
        ):
            raise KimiApiError(
                "journal_error", f"本地{kind}的类型、权限或大小不合法。"
            )
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = -1
            payload = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise KimiApiError("journal_error", f"本地{kind}无法解析。") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(payload, dict):
        raise KimiApiError("journal_error", f"本地{kind}结构不合法。")
    return payload


def _load_journal(
    path: Path,
    *,
    instance: str,
    model_ref: str,
    conversation_id: str,
    request_id: str,
    payload_fingerprint: str,
    marker: str,
) -> dict[str, Any] | None:
    payload = _read_private_json(path, kind="请求 journal")
    if payload is None:
        return None

    if not isinstance(payload, dict) or payload.get("schema_version") != JOURNAL_SCHEMA_VERSION:
        raise KimiApiError("journal_error", "本地请求 journal 版本不合法。")
    expected_identity = {
        "instance": instance,
        "model_ref": model_ref,
        "conversation_id": conversation_id,
        "request_id": request_id,
        "marker": marker,
    }
    if any(payload.get(key) != value for key, value in expected_identity.items()):
        raise KimiApiError("journal_error", "本地请求 journal 身份不匹配。")
    if payload.get("payload_fingerprint") != payload_fingerprint:
        raise KimiApiError(
            "idempotency_conflict",
            "同一 request_id 已绑定不同的 prompt 或图片载荷。",
        )
    baseline = payload.get("baseline")
    if isinstance(baseline, bool) or not isinstance(baseline, int) or baseline < 0:
        raise KimiApiError("journal_error", "本地请求 journal 的 baseline 不合法。")
    stage = payload.get("stage")
    if stage not in JOURNAL_STAGES:
        raise KimiApiError("journal_error", "本地请求 journal 的 stage 不合法。")
    if not isinstance(payload.get("session_created"), bool):
        raise KimiApiError("journal_error", "本地请求 journal 的会话标记不合法。")
    _validate_run_id(payload.get("run_id"))
    if stage in TERMINAL_JOURNAL_STAGES and not isinstance(payload.get("final"), dict):
        raise KimiApiError("journal_error", "本地请求 journal 缺少最终结果。")
    return payload


def _write_journal(path: Path, payload: dict[str, Any]) -> None:
    payload = {**payload, "updated_at": time.time()}
    body = (encoded(payload) + "\n").encode("utf-8")
    if len(body) > MAX_JOURNAL_BYTES:
        raise KimiApiError("journal_error", "本地请求 journal 超过大小上限。")
    farm.ensure_private_directory(path.parent)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.stem}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        storage.private_fchmod(descriptor, temporary)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        storage.protect(path)
        storage.fsync_directory(path.parent)
    except OSError as exc:
        raise KimiApiError("journal_error", "无法原子写入本地请求 journal。") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _load_active_pointer(
    path: Path,
    *,
    instance: str,
    model_ref: str,
    conversation_id: str,
) -> dict[str, Any] | None:
    payload = _read_private_json(path, kind="会话恢复指针")
    if payload is None:
        return None
    if payload.get("schema_version") != ACTIVE_POINTER_SCHEMA_VERSION:
        raise KimiApiError("journal_error", "本地会话恢复指针版本不合法。")
    expected = {
        "instance": instance,
        "model_ref": model_ref,
        "conversation_id": conversation_id,
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        raise KimiApiError("journal_error", "本地会话恢复指针身份不匹配。")
    request_id = payload.get("request_id")
    journal_digest = payload.get("journal_digest")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise KimiApiError("journal_error", "本地会话恢复指针 request_id 不合法。")
    if not isinstance(journal_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", journal_digest):
        raise KimiApiError("journal_error", "本地会话恢复指针 journal 摘要不合法。")
    return payload


def _write_active_pointer(
    path: Path,
    *,
    instance: str,
    model_ref: str,
    conversation_id: str,
    request_id: str,
    journal_digest: str,
) -> None:
    _write_journal(
        path,
        {
            "schema_version": ACTIVE_POINTER_SCHEMA_VERSION,
            "instance": instance,
            "model_ref": model_ref,
            "conversation_id": conversation_id,
            "request_id": request_id,
            "journal_digest": journal_digest,
        },
    )


def _clear_active_pointer(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
        if path.parent.is_dir():
            storage.fsync_directory(path.parent)
    except OSError as exc:
        raise KimiApiError("journal_error", "无法清除本地会话恢复指针。") from exc


def _guard_conversation_active(
    active_path: Path,
    *,
    instance: str,
    model_ref: str,
    conversation_id: str,
    request_id: str,
    journal_digest: str,
    journal: dict[str, Any] | None,
) -> None:
    pointer = _load_active_pointer(
        active_path,
        instance=instance,
        model_ref=model_ref,
        conversation_id=conversation_id,
    )
    if pointer is None:
        return
    same_request = (
        pointer["request_id"] == request_id and pointer["journal_digest"] == journal_digest
    )
    if same_request:
        if journal is None:
            raise KimiApiError(
                "conversation_recovery_pending",
                "会话存在当前请求的恢复指针，但请求 journal 暂不可用。",
            )
        if journal["stage"] in TERMINAL_JOURNAL_STAGES:
            _clear_active_pointer(active_path)
        return

    pointed_path = _journal_path(pointer["journal_digest"])
    pointed = _read_private_json(pointed_path, kind="活动请求 journal")
    if pointed is None:
        raise KimiApiError(
            "conversation_recovery_pending",
            "该 conversation_id 存在无法核验的恢复中请求。",
        )
    expected = {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "instance": instance,
        "model_ref": model_ref,
        "conversation_id": conversation_id,
        "request_id": pointer["request_id"],
    }
    if any(pointed.get(key) != value for key, value in expected.items()):
        raise KimiApiError("journal_error", "活动请求 journal 与会话恢复指针不匹配。")
    if _journal_identity_digest(
        instance, model_ref, conversation_id, pointer["request_id"]
    ) != pointer["journal_digest"]:
        raise KimiApiError("journal_error", "会话恢复指针的 journal 路径不匹配。")
    stage = pointed.get("stage")
    if stage in ACTIVE_JOURNAL_STAGES:
        raise KimiApiError(
            "conversation_recovery_pending",
            "该 conversation_id 有另一个请求仍在恢复；仅原 request_id 可继续恢复。",
        )
    if stage not in JOURNAL_STAGES:
        raise KimiApiError("journal_error", "活动请求 journal 的 stage 不合法。")
    _clear_active_pointer(active_path)


def _session_lock_path(session_key: str) -> Path:
    lock_directory = farm.adapter_state_dir() / "kimi-k3-locks"
    farm.ensure_private_directory(lock_directory)
    digest = hashlib.sha256(session_key.encode("utf-8")).hexdigest()
    return lock_directory / f"{digest}.lock"


def _acquire_session_file_lock(session_key: str) -> int:
    path = _session_lock_path(session_key)
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise KimiApiError("local_lock_error", "无法打开本地会话锁。") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or not storage.is_private(path, metadata)
            or metadata.st_nlink != 1
        ):
            raise KimiApiError("local_lock_error", "本地会话锁不是当前用户的独占普通文件。")
        storage.private_fchmod(descriptor, path)
        storage.lock_descriptor(descriptor)
        return descriptor
    except BlockingIOError as exc:
        os.close(descriptor)
        raise KimiApiError("conversation_busy", "该 conversation_id 已有一个请求在运行。") from exc
    except Exception:
        os.close(descriptor)
        raise


def _claim_session(session_key: str) -> int:
    with _ACTIVE_LOCK:
        if session_key in _ACTIVE_SESSIONS:
            raise KimiApiError("conversation_busy", "该 conversation_id 已有一个请求在运行。")
        _ACTIVE_SESSIONS.add(session_key)
    try:
        return _acquire_session_file_lock(session_key)
    except Exception:
        with _ACTIVE_LOCK:
            _ACTIVE_SESSIONS.discard(session_key)
        raise


def _release_session(session_key: str, descriptor: int | None) -> None:
    if descriptor is not None:
        try:
            storage.unlock_descriptor(descriptor)
        except OSError:
            pass
        try:
            os.close(descriptor)
        except OSError:
            pass
    with _ACTIVE_LOCK:
        _ACTIVE_SESSIONS.discard(session_key)


def _remaining_ms(deadline: float) -> int:
    remaining = math.floor((deadline - time.monotonic()) * 1000)
    if remaining < 1:
        raise KimiApiError("gateway_timeout", "请求已超过总超时时间。")
    return remaining


def _required_scope(method: str, params: Mapping[str, Any] | None = None) -> str:
    if method == "agent" and params and any(
        field in params for field in ("agentId", "provider", "model")
    ):
        return "operator.admin"
    return "operator.write" if method in {"sessions.create", "agent"} else "operator.read"


def _raise_gateway_failure(
    detail: str, method: str, params: Mapping[str, Any] | None = None
) -> NoReturn:
    redacted_detail = farm.redact(detail or "")
    match = GATEWAY_REQUEST_ID.search(redacted_detail)
    lowered = redacted_detail[:65_536].lower()
    suffix = f"（request ID: {match.group(0)}）" if match else ""
    if "pairing required" in lowered:
        raise KimiApiError("pairing_required", f"Gateway 需要批准设备配对{suffix}。")
    if "scope" in lowered and any(word in lowered for word in ("required", "upgrade", "missing")):
        raise KimiApiError(
            "scope_upgrade_required",
            f"Gateway 需要批准 {_required_scope(method, params)}{suffix}。",
        )
    if any(word in lowered for word in ("timed out", "timeout", "etimedout")):
        raise KimiApiError("gateway_timeout", "Gateway 调用超时。")
    if any(word in lowered for word in ("unauthorized", "authentication", "forbidden")):
        raise KimiApiError("gateway_auth_error", f"Gateway 身份验证失败{suffix}。")
    raise KimiApiError("gateway_error", "Gateway 调用失败。")


def _gateway_json(
    record: dict[str, Any],
    token: str,
    method: str,
    params: dict[str, Any],
    deadline: float,
    *,
    timeout_cap_ms: int | None = None,
    expect_final: bool = False,
) -> Any:
    remaining_ms = _remaining_ms(deadline)
    rpc_timeout_ms = min(remaining_ms, timeout_cap_ms) if timeout_cap_ms else remaining_ms
    wall_timeout_ms = min(remaining_ms, rpc_timeout_ms + 15_000)
    try:
        completed = farm.gateway_call(
            record,
            method,
            params,
            rpc_timeout_ms,
            token,
            expect_final=expect_final,
            outer_timeout_ms=wall_timeout_ms,
        )
    except farm.GatewayTimeoutError as exc:
        raise KimiApiError("gateway_timeout", "Gateway 调用超时。") from exc
    except farm.FarmError as exc:
        raise KimiApiError("gateway_error", "本地 Gateway 调用失败。") from exc

    if completed.returncode != 0:
        _raise_gateway_failure(completed.stderr, method, params)
    stdout = completed.stdout or ""
    if len(stdout.encode("utf-8")) > MAX_GATEWAY_RESPONSE_BYTES:
        raise KimiApiError("protocol_error", "Gateway 响应超过 8 MiB 上限。")
    try:
        return json.loads(stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise KimiApiError("protocol_error", "Gateway 返回了无效 JSON。") from exc


def _confirm_model(
    record: dict[str, Any],
    token: str,
    deadline: float,
    *,
    require_images: bool,
) -> tuple[str, str]:
    provider, _, model_id = TARGET_MODEL_REF.partition("/")
    payload = _gateway_json(
        record,
        token,
        "models.list",
        {},
        deadline,
        timeout_cap_ms=PREFLIGHT_TIMEOUT_MS,
    )
    models = payload.get("models") if isinstance(payload, dict) else payload
    if not isinstance(models, list):
        raise KimiApiError("protocol_error", "models.list 响应结构不合法。")
    matches = [
        item
        for item in models
        if isinstance(item, dict) and item.get("provider") == provider and item.get("id") == model_id
    ]
    if not matches:
        raise KimiApiError("model_unavailable", f"实例未提供已配置模型 {TARGET_MODEL_REF}。")
    if len(matches) > 1:
        raise KimiApiError("model_ambiguous", f"实例返回了多个 {TARGET_MODEL_REF} 模型。")
    if require_images:
        declared_inputs = matches[0].get("input")
        if not isinstance(declared_inputs, list) or not all(
            modality in declared_inputs for modality in ("text", "image")
        ):
            raise KimiApiError(
                "model_not_multimodal",
                "实例中的 Kimi K3 模型目录尚未同时声明 text 和 image 输入。",
            )
    return provider, model_id


def _session_rows(payload: Any) -> list[dict[str, Any]]:
    rows = payload.get("sessions") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise KimiApiError("protocol_error", "sessions.list 响应结构不合法。")
    return [row for row in rows if isinstance(row, dict)]


def _find_session(
    record: dict[str, Any],
    token: str,
    session_key: str,
    label: str,
    deadline: float,
) -> dict[str, Any] | None:
    payload = _gateway_json(
        record,
        token,
        "sessions.list",
        {
            "limit": 10,
            "includeGlobal": False,
            "includeUnknown": False,
            "label": label,
            "agentId": AGENT_ID,
        },
        deadline,
        timeout_cap_ms=PREFLIGHT_TIMEOUT_MS,
    )
    return next((row for row in _session_rows(payload) if row.get("key") == session_key), None)


def _require_session_model(row: dict[str, Any], provider: str, model_id: str) -> None:
    if row.get("modelProvider") != provider or row.get("model") != model_id:
        raise KimiApiError("model_mismatch", "专用会话的实际模型不是已配置的 Kimi K3。")


def _ensure_session(
    record: dict[str, Any],
    token: str,
    session_key: str,
    label: str,
    provider: str,
    model_id: str,
    deadline: float,
) -> bool:
    existing = _find_session(record, token, session_key, label, deadline)
    if existing is not None:
        _require_session_model(existing, provider, model_id)
        return False

    created = _gateway_json(
        record,
        token,
        "sessions.create",
        {"key": session_key, "agentId": AGENT_ID, "label": label, "model": TARGET_MODEL_REF},
        deadline,
        timeout_cap_ms=PREFLIGHT_TIMEOUT_MS,
    )
    if not isinstance(created, dict) or created.get("ok") is not True:
        raise KimiApiError("protocol_error", "sessions.create 未确认会话创建。")
    canonical_key = created.get("key")
    if canonical_key != session_key:
        raise KimiApiError("protocol_error", "sessions.create 返回了意外的会话键。")
    verified = _find_session(record, token, session_key, label, deadline)
    if verified is None:
        raise KimiApiError("protocol_error", "创建后无法重新读取专用会话。")
    _require_session_model(verified, provider, model_id)
    return True


def _read_history(
    record: dict[str, Any],
    token: str,
    session_key: str,
    deadline: float,
) -> list[dict[str, Any]]:
    payload = _gateway_json(
        record,
        token,
        "chat.history",
        {"sessionKey": session_key, "limit": HISTORY_LIMIT, "maxChars": HISTORY_MAX_CHARS},
        deadline,
        timeout_cap_ms=HISTORY_TIMEOUT_MS,
    )
    if not isinstance(payload, dict) or payload.get("sessionKey") != session_key:
        raise KimiApiError("protocol_error", "chat.history 返回了意外的会话。")
    messages = payload.get("messages")
    if not isinstance(messages, list) or any(not isinstance(item, dict) for item in messages):
        raise KimiApiError("protocol_error", "chat.history 消息结构不合法。")
    return messages


def _history_seq(message: dict[str, Any]) -> int | None:
    metadata = message.get("__openclaw")
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise KimiApiError("protocol_error", "chat.history 的消息元数据不合法。")
    seq = metadata.get("seq")
    if seq is None:
        return None
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        raise KimiApiError("protocol_error", "chat.history 的消息 seq 不合法。")
    return seq


def _history_texts(message: dict[str, Any]) -> list[str]:
    values: list[str] = []
    text = message.get("text")
    if isinstance(text, str):
        values.append(text)
    content = message.get("content")
    if isinstance(content, str):
        values.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                values.append(block["text"])
    return values


def _history_message_is_oversized(message: dict[str, Any]) -> bool:
    metadata = message.get("__openclaw")
    if isinstance(metadata, dict) and metadata.get("truncated") is True:
        return True
    return any(text == HISTORY_OVERSIZED_TEXT for text in _history_texts(message))


def _history_message_is_text_truncated(message: dict[str, Any]) -> bool:
    return any(text.endswith(HISTORY_TRUNCATED_SUFFIX) for text in _history_texts(message))


def _validate_history_order(messages: list[dict[str, Any]]) -> int:
    previous = 0
    for message in messages:
        seq = _history_seq(message)
        if seq is None:
            continue
        if seq <= previous:
            raise KimiApiError("protocol_error", "chat.history 的消息 seq 未严格递增。")
        previous = seq
    return previous


def _normalized_usage(usage: Any, *, history: bool) -> dict[str, int | float]:
    if not isinstance(usage, dict):
        source = "assistant history" if history else "agentMeta"
        raise KimiApiError("protocol_error", f"Kimi K3 {source} 缺少 usage。")
    total = usage.get("totalTokens") if history else usage.get("total")
    if total is None:
        total = usage.get("total") if history else usage.get("totalTokens")
    values = {
        "input": usage.get("input"),
        "output": usage.get("output"),
        "total": total,
    }
    for source, target in (("cacheRead", "cacheRead"), ("cacheWrite", "cacheWrite")):
        if source in usage:
            values[target] = usage[source]
    result: dict[str, int | float] = {}
    for key, value in values.items():
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
        ):
            raise KimiApiError("protocol_error", "Kimi K3 usage 不合法或缺少必需字段。")
        result[key] = value
    return result


def _history_usage(message: dict[str, Any]) -> dict[str, int | float]:
    return _normalized_usage(message.get("usage"), history=True)


def _timestamp_seconds(value: Any) -> int | None:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or value < 0
    ):
        return None
    return math.floor(value / 1000) if value >= 1_000_000_000_000 else math.floor(value)


def _terminal_error_response(
    code: str,
    message: str,
    *,
    provider: str,
    model_id: str,
    conversation_id: str,
    request_id: str,
    run_id: str | None,
    session_created: bool,
    image_count: int,
    recovered_from: str,
    finish_reason: str = "error",
    created_at: int | None = None,
) -> dict[str, Any]:
    response = error_response(
        code,
        message,
        request_id=request_id,
        conversation_id=conversation_id,
    )
    response.update(
        {
            "model": {"provider": provider, "id": model_id, "ref": TARGET_MODEL_REF},
            "session_created": session_created,
            "image_count": image_count,
            "finish_reason": finish_reason,
            "recovered_from": recovered_from,
        }
    )
    if run_id is not None:
        response["run_id"] = run_id
    if created_at is not None:
        response["created_at"] = created_at
    return response


def _direct_stop_reason(meta: dict[str, Any]) -> str:
    """Normalize OpenClaw run-level and provider-level completion reasons."""
    completion = meta.get("completion")
    candidates: list[Any] = []
    if isinstance(completion, dict):
        candidates.extend((completion.get("finishReason"), completion.get("stopReason")))
    candidates.append(meta.get("stopReason"))
    raw = next((value for value in candidates if isinstance(value, str) and value), None)
    if raw is None:
        return "stop"
    normalized = raw.strip().lower().replace("-", "_")
    if normalized in {"stop", "completed", "complete", "end", "end_turn"}:
        return "stop"
    if normalized in {"length", "max_tokens", "max_output_tokens", "token_limit"}:
        return "length"
    raise KimiApiError("protocol_error", "agent 终态 stopReason 不合法。")


def _extract_agent_final(
    payload: Any,
    *,
    provider: str,
    model_id: str,
    conversation_id: str,
    request_id: str,
    session_created: bool,
    image_count: int,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        raise KimiApiError("protocol_error", "agent 未返回完整的 ok 终态。")
    run_id = _validate_run_id(payload.get("runId"))
    if run_id is None:
        raise KimiApiError("protocol_error", "agent 终态缺少 runId。")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise KimiApiError("protocol_error", "agent 终态缺少 result。")
    meta = result.get("meta")
    if not isinstance(meta, dict):
        raise KimiApiError("protocol_error", "agent 终态缺少 meta。")
    if meta.get("aborted") is True or isinstance(meta.get("error"), dict):
        raise KimiApiError("model_error", "Kimi K3 运行以错误或中止状态结束。")
    agent_meta = meta.get("agentMeta")
    if not isinstance(agent_meta, dict):
        raise KimiApiError("protocol_error", "agent 终态缺少 agentMeta。")
    if agent_meta.get("provider") != provider or agent_meta.get("model") != model_id:
        raise KimiApiError("model_mismatch", "实际推理模型不是已配置的 Kimi K3。")
    usage = _normalized_usage(agent_meta.get("usage"), history=False)

    payloads = result.get("payloads")
    if payloads is not None and not isinstance(payloads, list):
        raise KimiApiError("protocol_error", "agent 终态 payloads 结构不合法。")
    if isinstance(payloads, list) and any(
        isinstance(item, dict) and item.get("isError") is True for item in payloads
    ):
        raise KimiApiError("model_error", "Kimi K3 返回了错误结果。")
    visible = meta.get("finalAssistantVisibleText")
    if isinstance(visible, str) and visible:
        text = visible
    else:
        if not isinstance(payloads, list):
            raise KimiApiError("protocol_error", "agent 终态缺少可见文本。")
        texts = [
            item["text"]
            for item in payloads
            if isinstance(item, dict)
            and isinstance(item.get("text"), str)
            and item.get("text")
            and item.get("isReasoning") is not True
        ]
        text = "\n".join(texts)
    if not text:
        raise KimiApiError("protocol_error", "Kimi K3 未返回可见文本。")
    if len(text) > MAX_OUTPUT_CHARS:
        raise KimiApiError(
            "output_limit_exceeded",
            "Kimi K3 最终文本超过本地输出上限；拒绝静默截断。",
        )

    stop_reason = _direct_stop_reason(meta)
    response: dict[str, Any] = {
        "ok": True,
        "text": text,
        "conversation_id": conversation_id,
        "request_id": request_id,
        "run_id": run_id,
        "model": {"provider": provider, "id": model_id, "ref": TARGET_MODEL_REF},
        "usage": usage,
        "session_created": session_created,
        "image_count": image_count,
        "stop_reason": stop_reason,
        "finish_reason": stop_reason,
        "recovered_from": "direct",
        "truncated": stop_reason == "length",
    }
    for timestamp_key in ("completedAt", "endedAt", "timestamp", "createdAt"):
        created_at = _timestamp_seconds(meta.get(timestamp_key))
        if created_at is not None:
            response["created_at"] = created_at
            break
    duration_ms = meta.get("durationMs")
    if (
        isinstance(duration_ms, (int, float))
        and not isinstance(duration_ms, bool)
        and math.isfinite(duration_ms)
        and duration_ms >= 0
    ):
        response["duration_ms"] = duration_ms
    return response


def _visible_assistant_text(message: dict[str, Any]) -> str:
    text_value = message.get("text")
    if isinstance(text_value, str):
        text = text_value
    else:
        content = message.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = [
                block["text"]
                for block in content
                if isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ]
            text = "\n".join(part for part in parts if part)
        else:
            text = ""
    if not text:
        raise KimiApiError("protocol_error", "Kimi K3 assistant history 没有可见文本。")
    if text == HISTORY_OVERSIZED_TEXT:
        raise KimiApiError("history_oversized", "chat.history 省略了过大的最终结果。")
    if text.endswith(HISTORY_TRUNCATED_SUFFIX) or len(text) > MAX_OUTPUT_CHARS:
        raise KimiApiError("history_truncated", "chat.history 最终结果不完整，拒绝返回部分文本。")
    return text


def _history_final_response(
    message: dict[str, Any],
    *,
    provider: str,
    model_id: str,
    conversation_id: str,
    request_id: str,
    run_id: str | None,
    session_created: bool,
    image_count: int,
    recovered_from: str,
) -> dict[str, Any]:
    if _history_message_is_oversized(message):
        raise KimiApiError("history_oversized", "chat.history 省略了过大的最终结果。")
    if _history_message_is_text_truncated(message):
        raise KimiApiError("history_truncated", "chat.history 最终结果被截断，拒绝返回部分文本。")
    if message.get("provider") != provider or message.get("model") != model_id:
        raise KimiApiError("model_mismatch", "assistant history 的实际模型不是已配置的 Kimi K3。")
    stop_reason = message.get("stopReason")
    if stop_reason == "toolUse":
        raise KimiApiError("protocol_error", "内部 toolUse 消息不是最终 assistant 结果。")
    if stop_reason not in TERMINAL_STOP_REASONS:
        raise KimiApiError("protocol_error", "Kimi K3 assistant history 缺少终态 stopReason。")
    seq = _history_seq(message)
    if seq is None:
        raise KimiApiError("protocol_error", "Kimi K3 最终 assistant history 缺少 seq。")
    timestamp = _timestamp_seconds(message.get("timestamp"))
    if stop_reason in {"error", "aborted"}:
        return _terminal_error_response(
            "model_error",
            f"Kimi K3 运行以 {stop_reason} 终态结束。",
            provider=provider,
            model_id=model_id,
            conversation_id=conversation_id,
            request_id=request_id,
            run_id=run_id,
            session_created=session_created,
            image_count=image_count,
            recovered_from=recovered_from,
            finish_reason=stop_reason,
            created_at=timestamp,
        )
    response: dict[str, Any] = {
        "ok": True,
        "text": _visible_assistant_text(message),
        "conversation_id": conversation_id,
        "request_id": request_id,
        "model": {"provider": provider, "id": model_id, "ref": TARGET_MODEL_REF},
        "usage": _history_usage(message),
        "session_created": session_created,
        "image_count": image_count,
        "stop_reason": stop_reason,
        "finish_reason": stop_reason,
        "recovered_from": recovered_from,
        "history_seq": seq,
        "truncated": stop_reason == "length",
    }
    if timestamp is not None:
        response["created_at"] = timestamp
    if run_id is not None:
        response["run_id"] = run_id
    return response


def _find_history_final(
    messages: list[dict[str, Any]],
    *,
    baseline: int,
    marker: str,
    provider: str,
    model_id: str,
    conversation_id: str,
    request_id: str,
    run_id: str | None,
    session_created: bool,
    image_count: int,
    recovered_from: str,
) -> dict[str, Any] | None:
    _validate_history_order(messages)
    marker_seq: int | None = None
    assistants: list[dict[str, Any]] = []
    for message in messages:
        seq = _history_seq(message)
        if marker_seq is None:
            if seq is None or seq <= baseline:
                continue
            provenance = message.get("provenance")
            if (
                message.get("role") == "user"
                and isinstance(provenance, dict)
                and provenance.get("kind") == "external_user"
                and provenance.get("sourceTool") == marker
            ):
                marker_seq = seq
            continue
        if message.get("role") == "user":
            break
        if message.get("role") != "assistant":
            continue
        assistants.append(message)
    if not assistants:
        return None
    last = assistants[-1]
    if last.get("stopReason") == "toolUse":
        return None
    return _history_final_response(
        last,
        provider=provider,
        model_id=model_id,
        conversation_id=conversation_id,
        request_id=request_id,
        run_id=run_id,
        session_created=session_created,
        image_count=image_count,
        recovered_from=recovered_from,
    )


def _poll_history_final(
    record: dict[str, Any],
    token: str,
    session_key: str,
    deadline: float,
    **match: Any,
) -> dict[str, Any] | None:
    while True:
        if deadline - time.monotonic() <= 0:
            return None
        try:
            messages = _read_history(record, token, session_key, deadline)
        except KimiApiError as exc:
            if exc.code not in {"gateway_error", "gateway_timeout"}:
                raise
            if deadline - time.monotonic() <= 0:
                return None
        else:
            final = _find_history_final(messages, **match)
            if final is not None:
                return final
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(HISTORY_POLL_SECONDS, remaining))


def _validated_cached_result(
    payload: Any,
    *,
    provider: str,
    model_id: str,
    conversation_id: str,
    request_id: str,
    image_count: int,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
        raise KimiApiError("journal_error", "本地请求 journal 的终态结果不合法。")
    if payload.get("conversation_id") != conversation_id or payload.get("request_id") != request_id:
        raise KimiApiError("journal_error", "本地请求 journal 的终态结果身份不匹配。")
    model = payload.get("model")
    if not isinstance(model, dict) or model != {
        "provider": provider,
        "id": model_id,
        "ref": TARGET_MODEL_REF,
    }:
        raise KimiApiError("journal_error", "本地请求 journal 的终态模型不匹配。")
    if payload.get("image_count") != image_count:
        raise KimiApiError("journal_error", "本地请求 journal 的图片计数不匹配。")
    if not isinstance(payload.get("session_created"), bool):
        raise KimiApiError("journal_error", "本地请求 journal 的会话标记不合法。")
    recovered_from = payload.get("recovered_from")
    if recovered_from not in {"direct", "history"}:
        raise KimiApiError("journal_error", "本地请求 journal 的恢复来源不合法。")
    run_id = _validate_run_id(payload.get("run_id"))
    created_at = payload.get("created_at")
    if created_at is not None and (
        isinstance(created_at, bool) or not isinstance(created_at, int) or created_at < 0
    ):
        raise KimiApiError("journal_error", "本地请求 journal 的 created_at 不合法。")

    if payload["ok"] is False:
        error = payload.get("error")
        if not isinstance(error, dict) or error.get("code") not in {
            "model_error",
            "model_mismatch",
            "output_limit_exceeded",
            "protocol_error",
        }:
            raise KimiApiError("journal_error", "本地请求 journal 的终态错误代码不合法。")
        message = error.get("message")
        if not isinstance(message, str) or not message or len(message.encode("utf-8")) > 2_048:
            raise KimiApiError("journal_error", "本地请求 journal 的终态错误消息不合法。")
        finish_reason = payload.get("finish_reason")
        if finish_reason not in {"error", "aborted"}:
            raise KimiApiError("journal_error", "本地请求 journal 的错误终态不合法。")
        result = {
            "ok": False,
            "error": {"code": error["code"], "message": message},
            "conversation_id": conversation_id,
            "request_id": request_id,
            "model": dict(model),
            "session_created": payload["session_created"],
            "image_count": image_count,
            "finish_reason": finish_reason,
            "recovered_from": "journal",
        }
        if run_id is not None:
            result["run_id"] = run_id
        if created_at is not None:
            result["created_at"] = created_at
        return result

    text = payload.get("text")
    if not isinstance(text, str) or not text or len(text) > MAX_OUTPUT_CHARS:
        raise KimiApiError("journal_error", "本地请求 journal 的最终文本不合法。")
    usage = payload.get("usage")
    if not isinstance(usage, dict) or not {"input", "output", "total"} <= set(usage):
        raise KimiApiError("journal_error", "本地请求 journal 的 usage 不合法。")
    for value in usage.values():
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            raise KimiApiError("journal_error", "本地请求 journal 的 usage 不合法。")
    if payload.get("stop_reason") not in {"stop", "length"}:
        raise KimiApiError("journal_error", "本地请求 journal 的 stop_reason 不合法。")
    if payload.get("finish_reason") != payload.get("stop_reason"):
        raise KimiApiError("journal_error", "本地请求 journal 的 finish_reason 不合法。")
    history_seq = payload.get("history_seq")
    if recovered_from == "history" and (
        not isinstance(history_seq, int) or isinstance(history_seq, bool) or history_seq < 1
    ):
        raise KimiApiError("journal_error", "本地请求 journal 的 history_seq 不合法。")
    if history_seq is not None and (
        not isinstance(history_seq, int) or isinstance(history_seq, bool) or history_seq < 1
    ):
        raise KimiApiError("journal_error", "本地请求 journal 的 history_seq 不合法。")
    if payload.get("truncated") is not (payload.get("stop_reason") == "length"):
        raise KimiApiError("journal_error", "本地请求 journal 的 truncated 标记不合法。")
    result = {
        "ok": True,
        "text": text,
        "conversation_id": conversation_id,
        "request_id": request_id,
        "model": dict(model),
        "usage": dict(usage),
        "session_created": payload["session_created"],
        "image_count": image_count,
        "stop_reason": payload["stop_reason"],
        "finish_reason": payload["finish_reason"],
        "recovered_from": "journal",
        "truncated": payload["truncated"],
    }
    if history_seq is not None:
        result["history_seq"] = history_seq
    if created_at is not None:
        result["created_at"] = created_at
    duration_ms = payload.get("duration_ms")
    if duration_ms is not None:
        if (
            not isinstance(duration_ms, (int, float))
            or isinstance(duration_ms, bool)
            or not math.isfinite(duration_ms)
            or duration_ms < 0
        ):
            raise KimiApiError("journal_error", "本地请求 journal 的 duration_ms 不合法。")
        result["duration_ms"] = duration_ms
    if run_id is not None:
        result["run_id"] = run_id
    return result


def _chat_sync(
    prompt: str,
    conversation_id: str,
    request_id: str,
    timeout_ms: int,
    attachments: list[dict[str, str]],
) -> dict[str, Any]:
    deadline = time.monotonic() + (timeout_ms / 1000)
    session_key, label = _session_identity(TARGET_INSTANCE, TARGET_MODEL_REF, conversation_id)
    lock_descriptor = _claim_session(session_key)
    token = ""
    try:
        provider, _, model_id = TARGET_MODEL_REF.partition("/")
        payload_fingerprint = _idempotency_key(
            TARGET_INSTANCE,
            TARGET_MODEL_REF,
            conversation_id,
            request_id,
            prompt,
            attachments,
        )
        identity_digest = _journal_identity_digest(
            TARGET_INSTANCE,
            TARGET_MODEL_REF,
            conversation_id,
            request_id,
        )
        marker = _journal_marker(identity_digest)
        journal_path = _journal_path(identity_digest)
        active_path = _active_pointer_path(TARGET_INSTANCE, TARGET_MODEL_REF, conversation_id)
        journal = _load_journal(
            journal_path,
            instance=TARGET_INSTANCE,
            model_ref=TARGET_MODEL_REF,
            conversation_id=conversation_id,
            request_id=request_id,
            payload_fingerprint=payload_fingerprint,
            marker=marker,
        )
        _guard_conversation_active(
            active_path,
            instance=TARGET_INSTANCE,
            model_ref=TARGET_MODEL_REF,
            conversation_id=conversation_id,
            request_id=request_id,
            journal_digest=identity_digest,
            journal=journal,
        )
        if journal is not None and journal["stage"] in ACTIVE_JOURNAL_STAGES:
            _write_active_pointer(
                active_path,
                instance=TARGET_INSTANCE,
                model_ref=TARGET_MODEL_REF,
                conversation_id=conversation_id,
                request_id=request_id,
                journal_digest=identity_digest,
            )
        if journal is not None and journal["stage"] in TERMINAL_JOURNAL_STAGES:
            return _validated_cached_result(
                journal["final"],
                provider=provider,
                model_id=model_id,
                conversation_id=conversation_id,
                request_id=request_id,
                image_count=len(attachments),
            )

        registry = farm.load_registry(farm.default_registry_path())
        record = farm.get_record(registry, TARGET_INSTANCE)
        token = farm.lookup_secret(TARGET_INSTANCE) or ""
        if not token:
            raise KimiApiError("gateway_error", "实例凭据不可用。")
        confirmed_provider, confirmed_model = _confirm_model(
            record,
            token,
            deadline,
            require_images=bool(attachments),
        )
        if confirmed_provider != provider or confirmed_model != model_id:
            raise KimiApiError("model_mismatch", "模型目录返回了意外的 Kimi K3 引用。")

        if journal is None:
            session_created = _ensure_session(
                record,
                token,
                session_key,
                label,
                provider,
                model_id,
                deadline,
            )
            journal = {
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "instance": TARGET_INSTANCE,
                "model_ref": TARGET_MODEL_REF,
                "conversation_id": conversation_id,
                "request_id": request_id,
                "payload_fingerprint": payload_fingerprint,
                "baseline": 0,
                "marker": marker,
                "stage": "prepared",
                "run_id": None,
                "session_created": session_created,
                "final": None,
                "created_at": time.time(),
            }
            _write_journal(journal_path, journal)
        else:
            session_created = journal["session_created"]
            existing = _find_session(record, token, session_key, label, deadline)
            if existing is None:
                raise KimiApiError(
                    "recovery_pending",
                    "请求 journal 已存在，但专用会话暂不可读；未再次调用 agent。",
                )
            _require_session_model(existing, provider, model_id)

        if journal["stage"] == "prepared":
            agent_params: dict[str, Any] = {
                "message": prompt,
                "sessionKey": session_key,
                "deliver": False,
                "timeout": max(1, math.ceil(_remaining_ms(deadline) / 1000)),
                "inputProvenance": {"kind": "external_user", "sourceTool": marker},
                "idempotencyKey": payload_fingerprint,
            }
            if attachments:
                agent_params["attachments"] = attachments
                agent_params["agentId"] = AGENT_ID
                agent_params["provider"] = provider
                agent_params["model"] = model_id
            _write_active_pointer(
                active_path,
                instance=TARGET_INSTANCE,
                model_ref=TARGET_MODEL_REF,
                conversation_id=conversation_id,
                request_id=request_id,
                journal_digest=identity_digest,
            )
            journal["stage"] = "submit_started"
            try:
                _write_journal(journal_path, journal)
            except Exception:
                _clear_active_pointer(active_path)
                raise
            try:
                submitted = _gateway_json(
                    record,
                    token,
                    "agent",
                    agent_params,
                    deadline,
                    expect_final=True,
                )
            except KimiApiError as exc:
                if exc.code in HANDLER_REJECTION_CODES:
                    journal["stage"] = "prepared"
                    journal["run_id"] = None
                    _write_journal(journal_path, journal)
                    _clear_active_pointer(active_path)
                    raise
                journal["stage"] = "recovering"
                _write_journal(journal_path, journal)
            else:
                status = submitted.get("status") if isinstance(submitted, dict) else None
                candidate = submitted.get("runId") if isinstance(submitted, dict) else None
                try:
                    run_id = _validate_run_id(candidate)
                except KimiApiError:
                    run_id = None
                journal["run_id"] = run_id
                if status == "ok":
                    try:
                        final = _extract_agent_final(
                            submitted,
                            provider=provider,
                            model_id=model_id,
                            conversation_id=conversation_id,
                            request_id=request_id,
                            session_created=session_created,
                            image_count=len(attachments),
                        )
                    except KimiApiError as exc:
                        code = "protocol_error" if exc.code == "journal_error" else exc.code
                        final = _terminal_error_response(
                            code,
                            farm.redact(str(exc)),
                            provider=provider,
                            model_id=model_id,
                            conversation_id=conversation_id,
                            request_id=request_id,
                            run_id=run_id,
                            session_created=session_created,
                            image_count=len(attachments),
                            recovered_from="direct",
                            created_at=math.floor(time.time()),
                        )
                        journal["stage"] = "failed"
                    else:
                        journal["run_id"] = final["run_id"]
                        journal["stage"] = "final"
                    journal["final"] = final
                    _write_journal(journal_path, journal)
                    _clear_active_pointer(active_path)
                    return final
                if status in {"error", "aborted"}:
                    final = _terminal_error_response(
                        "model_error",
                        f"Kimi K3 agent 以 {status} 终态结束。",
                        provider=provider,
                        model_id=model_id,
                        conversation_id=conversation_id,
                        request_id=request_id,
                        run_id=run_id,
                        session_created=session_created,
                        image_count=len(attachments),
                        recovered_from="direct",
                        finish_reason=status,
                        created_at=math.floor(time.time()),
                    )
                    journal["stage"] = "failed"
                    journal["final"] = final
                    _write_journal(journal_path, journal)
                    _clear_active_pointer(active_path)
                    return final
                journal["stage"] = "accepted" if status == "accepted" and run_id else "recovering"
                _write_journal(journal_path, journal)

        final = _poll_history_final(
            record,
            token,
            session_key,
            deadline,
            baseline=journal["baseline"],
            marker=marker,
            provider=provider,
            model_id=model_id,
            conversation_id=conversation_id,
            request_id=request_id,
            run_id=journal.get("run_id"),
            session_created=session_created,
            image_count=len(attachments),
            recovered_from="history",
        )
        if final is None:
            journal["stage"] = "recovering"
            _write_journal(journal_path, journal)
            raise KimiApiError(
                "recovery_pending",
                "请求可能已提交，历史中尚无可验证终态；未再次调用 agent，请用相同 request_id 重试。",
            )
        journal["stage"] = "final" if final.get("ok") is True else "failed"
        journal["final"] = final
        _write_journal(journal_path, journal)
        _clear_active_pointer(active_path)
        return final
    finally:
        token = ""
        _release_session(session_key, lock_descriptor)


async def kimi_k3_chat(
    prompt: str,
    conversation_id: str = "",
    request_id: str = "",
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    approved: bool = False,
    images: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Send text and optional native images to fixed Kimi K3; return its final visible text.

    Each image is ``{"data": base64_or_data_url, "mime_type": optional,
    "filename": optional}``. Supported formats are JPEG, PNG, WEBP, GIF, HEIC,
    and HEIF. At most four images, 5,000,000 bytes each and 12,000,000 bytes total.
    """
    if approved is not True:
        return error_response(
            "approval_required",
            "调用远程 Kimi K3 需要用户对该输入明确授权（approved=true）。",
        )
    normalized_request = ""
    normalized_conversation = ""
    try:
        clean_prompt, clean_conversation, clean_request, clean_timeout, clean_images = _validate_inputs(
            prompt,
            conversation_id,
            request_id,
            timeout_ms,
            images,
        )
        normalized_request = clean_request
        normalized_conversation = clean_conversation
        return await asyncio.to_thread(
            _chat_sync,
            clean_prompt,
            clean_conversation,
            clean_request,
            clean_timeout,
            clean_images,
        )
    except KimiApiError as exc:
        return error_response(
            exc.code,
            farm.redact(str(exc)),
            request_id=normalized_request,
            conversation_id=normalized_conversation,
        )
    except farm.FarmError as exc:
        return error_response(
            "gateway_error",
            "OpenClaw 本地适配器调用失败。",
            request_id=normalized_request,
            conversation_id=normalized_conversation,
        )
    except Exception as exc:  # pragma: no cover - defensive MCP boundary
        return error_response(
            "protocol_error",
            f"本地 Kimi K3 MCP 失败：{type(exc).__name__}",
            request_id=normalized_request,
            conversation_id=normalized_conversation,
        )


def build_mcp(api_name: str = "kimi_k3_api") -> FastMCP:
    """Build one numbered facade while preserving the stable protocol tool name."""
    normalized_name = _validate_identifier(api_name, "api_name", max_bytes=128)
    server = FastMCP(normalized_name)
    server.add_tool(
        kimi_k3_chat,
        name="kimi_k3_chat",
        title=normalized_name,
    )
    return server


mcp = build_mcp()


def main() -> int:
    parser = argparse.ArgumentParser(description="Restricted OpenClaw Kimi K3 MCP server")
    parser.add_argument("--instance", required=True, help="registered OpenClaw instance ID")
    parser.add_argument("--model-ref", required=True, help="fixed provider/model reference")
    parser.add_argument(
        "--api-name",
        default="kimi_k3_api",
        help="user-facing MCP server and tool title",
    )
    args = parser.parse_args()
    configure(args.instance, args.model_ref)
    build_mcp(args.api_name).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
