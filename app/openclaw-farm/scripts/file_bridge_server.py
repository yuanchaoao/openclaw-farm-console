#!/usr/bin/env python3
"""Loopback-only, workspace-confined OpenClaw file bridge.

The server intentionally has no dependency outside the Python standard library.
Authentication comes from an owner-only JSON secret file, never argv or a URL.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import shutil
import stat
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO


VERSION = "2.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
RESERVED_TOP_LEVEL = {
    ".openclaw-file-bridge",
    ".openclaw-file-bridge-state",
    ".openclaw-file-bridge-backups",
}
RESERVED_COMPONENT_PREFIXES = (".openclaw-upload.", ".openclaw-write.")


class BridgeError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.safe_message = message


@dataclass(frozen=True)
class TokenGrant:
    token: str
    scopes: frozenset[str]


@dataclass(frozen=True)
class Limits:
    json_bytes: int
    chunk_bytes: int
    read_bytes: int
    download_bytes: int
    file_bytes: int
    entries: int
    workers: int
    socket_timeout: float


@dataclass(frozen=True)
class Settings:
    root: Path
    state_dir: Path
    backup_dir: Path
    tokens: tuple[TokenGrant, ...]
    enable_write: bool
    enable_delete: bool
    limits: Limits
    audit_log: Path
    root_device: int


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_secret_file(path: Path) -> tuple[TokenGrant, ...]:
    try:
        details = path.lstat()
    except FileNotFoundError as exc:
        raise SystemExit("secret file must be a regular non-symlink file") from exc
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise SystemExit("secret file must be a regular non-symlink file")
    if details.st_uid != os.geteuid():
        raise SystemExit("secret file must be owned by the bridge identity")
    mode = stat.S_IMODE(details.st_mode)
    if mode & 0o077:
        raise SystemExit("secret file must not be accessible by group or others")
    if details.st_size > 256 * 1024:
        raise SystemExit("secret file exceeds 256 KiB")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_dev, opened.st_ino) != (details.st_dev, details.st_ino):
                raise SystemExit("secret file changed during validation")
            raw = handle.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise SystemExit("secret file exceeds 256 KiB")
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit("secret file is not valid JSON") from exc
    rows = payload.get("tokens") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not rows:
        raise SystemExit("secret file must contain a non-empty tokens array")
    grants: list[TokenGrant] = []
    seen_tokens: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit("invalid token grant")
        token = row.get("token")
        scopes = row.get("scopes")
        if not isinstance(token, str) or len(token) < 32 or len(token) > 4096:
            raise SystemExit("bridge tokens must contain at least 32 characters")
        if not token.isascii() or not token.isprintable() or any(ch.isspace() for ch in token):
            raise SystemExit("bridge tokens must be printable ASCII without whitespace")
        if len(set(token)) < 8:
            raise SystemExit("bridge tokens have insufficient character diversity")
        if token in seen_tokens:
            raise SystemExit("duplicate bridge token grants are not allowed")
        seen_tokens.add(token)
        if not isinstance(scopes, list) or not scopes:
            raise SystemExit("every token grant needs at least one scope")
        normalized = frozenset(str(scope).lower() for scope in scopes)
        if not normalized <= {"read", "write", "delete"}:
            raise SystemExit("unknown bridge token scope")
        grants.append(TokenGrant(token=token, scopes=normalized))
    return tuple(grants)


def validate_relative(value: Any, *, allow_root: bool = True) -> PurePosixPath:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise BridgeError(400, "invalid_path", "path must be a non-empty relative string")
    if "\x00" in value or "\\" in value or ":" in value:
        raise BridgeError(400, "invalid_path", "path syntax is not allowed")
    if value.startswith("/") or value.startswith("//"):
        raise BridgeError(400, "invalid_path", "absolute paths are not allowed")
    pure = PurePosixPath(value)
    parts = tuple(part for part in pure.parts if part not in {"", "."})
    if any(part == ".." for part in parts):
        raise BridgeError(400, "invalid_path", "path traversal is not allowed")
    if any(part in RESERVED_TOP_LEVEL or part.startswith(RESERVED_COMPONENT_PREFIXES) for part in parts):
        raise BridgeError(403, "reserved_path", "that path is reserved by the bridge")
    if not parts:
        if allow_root:
            return PurePosixPath(".")
        raise BridgeError(400, "invalid_path", "workspace root is not a valid target")
    return PurePosixPath(*parts)


def checked_path(settings: Settings, value: Any, *, allow_missing: bool = False, allow_root: bool = True) -> tuple[PurePosixPath, Path]:
    relative = validate_relative(value, allow_root=allow_root)
    current = settings.root
    parts = () if str(relative) == "." else relative.parts
    for index, part in enumerate(parts):
        candidate = current / part
        is_last = index == len(parts) - 1
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if allow_missing and is_last:
                return relative, candidate
            raise BridgeError(404, "not_found", "path does not exist")
        if stat.S_ISLNK(info.st_mode):
            raise BridgeError(400, "symlink_forbidden", "symlinks are not allowed")
        if info.st_dev != settings.root_device:
            raise BridgeError(400, "mount_boundary", "nested mounts are not allowed")
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            raise BridgeError(400, "hardlink_forbidden", "hard-linked files are not allowed")
        if not is_last and not stat.S_ISDIR(info.st_mode):
            raise BridgeError(400, "not_directory", "a parent path is not a directory")
        current = candidate
    return relative, current


def create_directory_path(settings: Settings, value: Any, *, parents: bool) -> tuple[PurePosixPath, Path]:
    relative = validate_relative(value, allow_root=False)
    current = settings.root
    for index, part in enumerate(relative.parts):
        candidate = current / part
        is_last = index == len(relative.parts) - 1
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if not parents and not is_last:
                raise BridgeError(404, "parent_not_found", "parent directory does not exist")
            os.mkdir(candidate, mode=0o700)
            info = candidate.lstat()
        else:
            if is_last:
                raise BridgeError(409, "already_exists", "target already exists")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise BridgeError(400, "unsafe_directory", "directory path contains a non-directory or symlink")
        if info.st_dev != settings.root_device:
            raise BridgeError(400, "mount_boundary", "nested mounts are not allowed")
        current = candidate
    return relative, current


def file_metadata(settings: Settings, relative: PurePosixPath, path: Path, *, include_hash: bool = False) -> dict[str, Any]:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_dev != settings.root_device:
        raise BridgeError(400, "unsafe_file", "file type is not allowed")
    if stat.S_ISDIR(info.st_mode):
        kind = "dir"
    elif stat.S_ISREG(info.st_mode):
        if info.st_nlink > 1:
            raise BridgeError(400, "hardlink_forbidden", "hard-linked files are not allowed")
        kind = "file"
    else:
        raise BridgeError(400, "special_file", "special files are not allowed")
    result: dict[str, Any] = {
        "name": path.name if str(relative) != "." else ".",
        "path": relative.as_posix(),
        "type": kind,
        "size": info.st_size,
        "mtime": info.st_mtime,
    }
    if include_hash and kind == "file":
        result["sha256"] = sha256_file(path)
    return result


def verify_prior(path: Path, expected: Any) -> None:
    if not path.exists():
        if expected not in {None, "", "absent"}:
            raise BridgeError(409, "precondition_failed", "target no longer matches expected state")
        return
    if not path.is_file():
        raise BridgeError(409, "precondition_failed", "existing target is not a regular file")
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected.lower()):
        raise BridgeError(428, "precondition_required", "expected_sha256 is required before overwrite")
    if not hmac.compare_digest(sha256_file(path), expected.lower()):
        raise BridgeError(409, "precondition_failed", "target no longer matches expected hash")


def safe_backup(settings: Settings, relative: PurePosixPath, path: Path) -> str | None:
    if not path.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    destination = settings.backup_dir / stamp / Path(relative.as_posix())
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_dir():
        shutil.copytree(path, destination, symlinks=False)
    else:
        shutil.copy2(path, destination, follow_symlinks=False)
        destination.chmod(0o600)
    return str(destination.relative_to(settings.state_dir))


def atomic_bytes(settings: Settings, relative: PurePosixPath, target: Path, data: bytes, expected: Any) -> tuple[int, str, str | None]:
    if len(data) > settings.limits.file_bytes:
        raise BridgeError(413, "file_too_large", "file exceeds configured size limit")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    checked_path(settings, str(relative.parent), allow_root=True)
    verify_prior(target, expected)
    backup = safe_backup(settings, relative, target)
    temporary = target.parent / f".openclaw-write.{secrets.token_hex(16)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        digest = sha256_file(temporary)
        os.replace(temporary, target)
        fsync_directory(target.parent)
        return len(data), digest, backup
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def load_upload(settings: Settings, upload_id: str) -> tuple[dict[str, Any], Path]:
    if not UPLOAD_ID_RE.fullmatch(upload_id):
        raise BridgeError(400, "invalid_upload", "invalid upload id")
    metadata_path = settings.state_dir / "uploads" / f"{upload_id}.json"
    if not metadata_path.is_file() or metadata_path.is_symlink():
        raise BridgeError(404, "upload_not_found", "upload session does not exist")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BridgeError(500, "upload_state_error", "upload state is unavailable") from exc
    if not isinstance(metadata, dict) or metadata.get("version") != 1:
        raise BridgeError(500, "upload_state_error", "upload state is invalid")
    try:
        relative = validate_relative(metadata.get("path"), allow_root=False)
    except BridgeError as exc:
        raise BridgeError(500, "upload_state_error", "upload state is invalid") from exc
    target = settings.root.joinpath(*relative.parts)
    expected_part = target.parent / f".openclaw-upload.{upload_id}.part"
    total_size = metadata.get("total_size")
    digest = metadata.get("sha256")
    prior = metadata.get("expected_sha256")
    if (
        metadata.get("target_path") != str(target)
        or metadata.get("part_path") != str(expected_part)
        or not isinstance(total_size, int)
        or isinstance(total_size, bool)
        or total_size < 0
        or total_size > settings.limits.file_bytes
        or not isinstance(digest, str)
        or not SHA256_RE.fullmatch(digest)
        or (
            prior is not None
            and prior not in ("", "absent")
            and (not isinstance(prior, str) or not SHA256_RE.fullmatch(prior))
        )
    ):
        raise BridgeError(500, "upload_state_error", "upload state is invalid")
    return metadata, metadata_path


def validate_upload_info(settings: Settings, details: os.stat_result) -> None:
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or details.st_dev != settings.root_device
    ):
        raise BridgeError(409, "upload_incomplete", "upload staging file is unsafe")


def upload_part_info(settings: Settings, path: Path) -> os.stat_result:
    try:
        details = path.lstat()
    except FileNotFoundError as exc:
        raise BridgeError(409, "upload_incomplete", "upload staging file is unavailable") from exc
    if stat.S_ISLNK(details.st_mode):
        raise BridgeError(409, "upload_incomplete", "upload staging file is unsafe")
    validate_upload_info(settings, details)
    return details


def save_upload_metadata(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + f".{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


class BridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], settings: Settings) -> None:
        self.settings = settings
        self.worker_slots = threading.BoundedSemaphore(settings.limits.workers)
        self.audit_lock = threading.Lock()
        super().__init__(address, handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpenClawFileBridge"
    sys_version = ""

    @property
    def bridge(self) -> BridgeHTTPServer:
        return self.server  # type: ignore[return-value]

    @property
    def settings(self) -> Settings:
        return self.bridge.settings

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.server.settings.limits.socket_timeout)  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def version_string(self) -> str:
        return "OpenClawFileBridge"

    def _request_id(self) -> str:
        supplied = self.headers.get("X-Request-ID", "")
        return supplied if re.fullmatch(r"[A-Za-z0-9._-]{8,128}", supplied) else uuid.uuid4().hex

    def _audit(self, request_id: str, status: int, path: str = "") -> None:
        safe_path = path if len(path) <= 4096 and "\x00" not in path else "<invalid>"
        row = json.dumps(
            {"time": utc_now(), "request_id": request_id, "method": self.command, "status": status, "path": safe_path},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self.bridge.audit_lock:
            descriptor = os.open(self.settings.audit_log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                handle.write(row + "\n")

    def _json(self, status: int, payload: dict[str, Any], request_id: str, path: str = "") -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Request-ID", request_id)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        # Finish operation bookkeeping before the client can consume the whole
        # response and start its next request. HTTP thread cleanup is not work.
        self._audit(request_id, status, path)
        self._release_worker_slot()
        self.wfile.write(body)

    def _release_worker_slot(self) -> None:
        if getattr(self, "_worker_slot_acquired", False):
            self._worker_slot_acquired = False
            self.bridge.worker_slots.release()

    def _error(self, error: BridgeError, request_id: str, path: str = "") -> None:
        self._json(error.status, {"ok": False, "error": {"code": error.code, "message": error.safe_message}, "request_id": request_id}, request_id, path)

    def _authenticate(self, scope: str) -> None:
        supplied = self.headers.get("X-OpenClaw-Token", "")
        matched: TokenGrant | None = None
        for grant in self.settings.tokens:
            if hmac.compare_digest(supplied, grant.token):
                matched = grant
        if matched is None:
            raise BridgeError(401, "unauthorized", "authentication failed")
        if scope not in matched.scopes:
            raise BridgeError(403, "scope_denied", "credential does not grant this capability")
        if scope == "write" and not self.settings.enable_write:
            raise BridgeError(403, "write_disabled", "bridge is running in read-only mode")
        if scope == "delete" and not self.settings.enable_delete:
            raise BridgeError(403, "delete_disabled", "delete capability is disabled")

    def _query(self) -> tuple[str, dict[str, list[str]]]:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, max_num_fields=32)
        except ValueError as exc:
            raise BridgeError(400, "invalid_query", "request query is invalid") from exc
        return parsed.path, query

    def _single_query(self, query: dict[str, list[str]], name: str, default: str | None = None) -> str:
        values = query.get(name)
        if values is None:
            if default is None:
                raise BridgeError(400, "missing_parameter", f"missing query parameter: {name}")
            return default
        if len(values) != 1:
            raise BridgeError(400, "ambiguous_parameter", f"query parameter must appear once: {name}")
        return values[0]

    def _content_length(self, limit: int) -> int:
        if self.headers.get("Transfer-Encoding"):
            raise BridgeError(400, "unsupported_framing", "Transfer-Encoding is not supported")
        raw_values = self.headers.get_all("Content-Length") or []
        if len(raw_values) != 1 or "," in raw_values[0]:
            raise BridgeError(411, "content_length_required", "one Content-Length header is required")
        try:
            length = int(raw_values[0])
        except ValueError as exc:
            raise BridgeError(400, "invalid_content_length", "Content-Length is invalid") from exc
        if length < 0 or length > limit:
            raise BridgeError(413, "body_too_large", "request body exceeds configured limit")
        return length

    def _read_exact(self, length: int) -> bytes:
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                raise BridgeError(400, "truncated_body", "request body ended early")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _body_json(self) -> dict[str, Any]:
        length = self._content_length(self.settings.limits.json_bytes)
        try:
            payload = json.loads(self._read_exact(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BridgeError(400, "invalid_json", "request body is not valid UTF-8 JSON") from exc
        if not isinstance(payload, dict):
            raise BridgeError(400, "invalid_json", "request JSON must be an object")
        return payload

    def _dispatch(self) -> tuple[int, str]:
        request_id = self._request_id()
        path_for_audit = ""
        self._worker_slot_acquired = self.bridge.worker_slots.acquire(blocking=False)
        if not self._worker_slot_acquired:
            error = BridgeError(503, "busy", "bridge concurrency limit reached")
            self._error(error, request_id)
            return error.status, ""
        try:
            route, query = self._query()
            if route in {"/health", "/v1/health"}:
                self._authenticate("read")
                self._json(200, {"ok": True, "version": VERSION}, request_id)
                return 200, ""
            if route in {"/capabilities", "/v1/capabilities"}:
                self._authenticate("read")
                self._json(200, {
                    "ok": True,
                    "version": VERSION,
                    "capabilities": {"read": True, "write": self.settings.enable_write, "delete": self.settings.enable_delete, "resumable_upload": True, "range_download": True},
                    "limits": {
                        "json_bytes": self.settings.limits.json_bytes,
                        "chunk_bytes": self.settings.limits.chunk_bytes,
                        "read_bytes": self.settings.limits.read_bytes,
                        "download_bytes": self.settings.limits.download_bytes,
                        "file_bytes": self.settings.limits.file_bytes,
                        "entries": self.settings.limits.entries,
                        "workers": self.settings.limits.workers,
                    },
                }, request_id)
                return 200, ""
            if self.command == "GET":
                return self._handle_get(route, query, request_id)
            if self.command == "POST":
                return self._handle_post(route, request_id)
            if self.command == "PUT":
                return self._handle_put(route, request_id)
            if self.command == "DELETE":
                return self._handle_delete(route, request_id)
            raise BridgeError(405, "method_not_allowed", "HTTP method is not allowed")
        except BridgeError as exc:
            self._error(exc, request_id, path_for_audit)
            return exc.status, path_for_audit
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self._audit(request_id, 499, path_for_audit)
            return 499, path_for_audit
        except Exception:
            error = BridgeError(500, "internal_error", "request failed")
            self._error(error, request_id, path_for_audit)
            return 500, path_for_audit
        finally:
            self._release_worker_slot()

    def _handle_get(self, route: str, query: dict[str, list[str]], request_id: str) -> tuple[int, str]:
        self._authenticate("read")
        if route in {"/list", "/v1/list"}:
            raw_path = self._single_query(query, "path", ".")
            relative, path = checked_path(self.settings, raw_path)
            if not path.is_dir():
                raise BridgeError(400, "not_directory", "path is not a directory")
            entries: list[dict[str, Any]] = []
            for child in sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())):
                if child.name in RESERVED_TOP_LEVEL or child.name.startswith(RESERVED_COMPONENT_PREFIXES):
                    continue
                if len(entries) >= self.settings.limits.entries:
                    raise BridgeError(413, "too_many_entries", "directory exceeds configured entry limit")
                child_relative = relative / child.name if str(relative) != "." else PurePosixPath(child.name)
                entries.append(file_metadata(self.settings, child_relative, child))
            self._json(200, {"ok": True, "path": relative.as_posix(), "entries": entries}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        if route in {"/stat", "/v1/stat"}:
            raw_path = self._single_query(query, "path")
            relative, path = checked_path(self.settings, raw_path)
            result = file_metadata(self.settings, relative, path, include_hash=True)
            self._json(200, {"ok": True, "stat": result}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        if route in {"/read", "/v1/read"}:
            raw_path = self._single_query(query, "path")
            try:
                requested = int(
                    self._single_query(query, "max_bytes", str(self.settings.limits.read_bytes))
                )
            except ValueError as exc:
                raise BridgeError(400, "invalid_limit", "max_bytes must be an integer") from exc
            if requested < 0 or requested > self.settings.limits.read_bytes:
                raise BridgeError(413, "read_limit", "requested text read exceeds configured limit")
            relative, path = checked_path(self.settings, raw_path)
            if not path.is_file():
                raise BridgeError(400, "not_file", "path is not a regular file")
            data = path.read_bytes()[:requested]
            self._json(200, {"ok": True, "content": data.decode("utf-8", "replace"), "bytes": len(data), "truncated": path.stat().st_size > len(data)}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        if route in {"/download", "/v1/download"}:
            raw_path = self._single_query(query, "path")
            relative, path = checked_path(self.settings, raw_path)
            if not path.is_file():
                raise BridgeError(400, "not_file", "path is not a regular file")
            size = path.stat().st_size
            if size > self.settings.limits.download_bytes:
                raise BridgeError(413, "download_limit", "file exceeds configured download limit")
            start, end = 0, size - 1
            range_header = self.headers.get("Range")
            status = 200
            if range_header:
                match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header.strip())
                if not match:
                    raise BridgeError(416, "invalid_range", "only one byte range is supported")
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else size - 1
                if start < 0 or end < start or start >= size or end >= size:
                    raise BridgeError(416, "invalid_range", "requested byte range is not satisfiable")
                status = 206
            length = 0 if size == 0 else end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", f'"sha256:{sha256_file(path)}"')
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("X-Request-ID", request_id)
            if length == 0:
                self._audit(request_id, status, relative.as_posix())
                self._release_worker_slot()
            self.end_headers()
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    if remaining == 0:
                        self._audit(request_id, status, relative.as_posix())
                        self._release_worker_slot()
                    self.wfile.write(chunk)
            if remaining:
                self._audit(request_id, status, relative.as_posix())
            return status, relative.as_posix()
        match = re.fullmatch(r"/v1/uploads/([0-9a-f]{32})", route)
        if match:
            metadata, _metadata_path = load_upload(self.settings, match.group(1))
            part = Path(metadata["part_path"])
            details = upload_part_info(self.settings, part)
            self._json(200, {"ok": True, "upload_id": match.group(1), "path": metadata["path"], "offset": details.st_size, "total_size": metadata["total_size"], "sha256": metadata["sha256"]}, request_id, metadata["path"])
            return 200, metadata["path"]
        raise BridgeError(404, "not_found", "endpoint does not exist")

    def _handle_post(self, route: str, request_id: str) -> tuple[int, str]:
        if route == "/v1/uploads":
            self._authenticate("write")
            body = self._body_json()
            relative, target = checked_path(self.settings, body.get("path"), allow_missing=True, allow_root=False)
            try:
                total_size = int(body.get("total_size"))
            except (TypeError, ValueError) as exc:
                raise BridgeError(400, "invalid_size", "total_size must be an integer") from exc
            digest = str(body.get("sha256", "")).lower()
            if total_size < 0 or total_size > self.settings.limits.file_bytes:
                raise BridgeError(413, "file_too_large", "file exceeds configured size limit")
            if not SHA256_RE.fullmatch(digest):
                raise BridgeError(400, "invalid_sha256", "sha256 must contain 64 lowercase hex characters")
            verify_prior(target, body.get("expected_sha256"))
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            upload_id = secrets.token_hex(16)
            part = target.parent / f".openclaw-upload.{upload_id}.part"
            descriptor = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.close(descriptor)
            metadata = {
                "version": 1,
                "path": relative.as_posix(),
                "target_path": str(target),
                "part_path": str(part),
                "total_size": total_size,
                "sha256": digest,
                "expected_sha256": body.get("expected_sha256"),
                "created_at": utc_now(),
            }
            metadata_path = self.settings.state_dir / "uploads" / f"{upload_id}.json"
            save_upload_metadata(metadata_path, metadata)
            self._json(201, {"ok": True, "upload_id": upload_id, "path": relative.as_posix(), "offset": 0, "total_size": total_size}, request_id, relative.as_posix())
            return 201, relative.as_posix()

        match = re.fullmatch(r"/v1/uploads/([0-9a-f]{32})/commit", route)
        if match:
            self._authenticate("write")
            body = self._body_json()
            metadata, metadata_path = load_upload(self.settings, match.group(1))
            relative, target = checked_path(self.settings, metadata["path"], allow_missing=True, allow_root=False)
            part = Path(metadata["part_path"])
            before = upload_part_info(self.settings, part)
            if before.st_size != metadata["total_size"]:
                raise BridgeError(409, "upload_incomplete", "upload size is incomplete")
            digest = sha256_file(part)
            after = upload_part_info(self.settings, part)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            ):
                raise BridgeError(409, "upload_incomplete", "upload staging file changed during verification")
            if not hmac.compare_digest(digest, metadata["sha256"]):
                raise BridgeError(409, "hash_mismatch", "uploaded content does not match expected SHA-256")
            if body.get("sha256") not in {None, "", digest}:
                raise BridgeError(409, "hash_mismatch", "commit SHA-256 does not match upload")
            verify_prior(target, metadata.get("expected_sha256"))
            backup = safe_backup(self.settings, relative, target)
            os.replace(part, target)
            fsync_directory(target.parent)
            metadata_path.unlink(missing_ok=True)
            self._json(200, {"ok": True, "path": relative.as_posix(), "size": target.stat().st_size, "sha256": digest, "backup": backup}, request_id, relative.as_posix())
            return 200, relative.as_posix()

        is_delete_route = route in {"/delete", "/v1/delete"}
        self._authenticate("delete" if is_delete_route else "write")
        body = self._body_json()
        if route in {"/move", "/v1/move", "/copy", "/v1/copy"}:
            source_relative, source = checked_path(self.settings, body.get("src"), allow_root=False)
            destination_relative, destination = checked_path(self.settings, body.get("dst"), allow_missing=True, allow_root=False)
            if destination.exists():
                raise BridgeError(409, "already_exists", "destination already exists")
            if source.is_dir() and destination_relative.parts[: len(source_relative.parts)] == source_relative.parts:
                raise BridgeError(400, "self_copy", "directory cannot be copied or moved into itself")
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if route in {"/move", "/v1/move"}:
                os.replace(source, destination)
            elif source.is_dir():
                shutil.copytree(source, destination, symlinks=False)
            else:
                shutil.copy2(source, destination, follow_symlinks=False)
                destination.chmod(0o600)
            fsync_directory(destination.parent)
            self._json(200, {"ok": True, "src": source_relative.as_posix(), "dst": destination_relative.as_posix()}, request_id, destination_relative.as_posix())
            return 200, destination_relative.as_posix()
        if route in {"/mkdir", "/v1/mkdir"}:
            relative, target = create_directory_path(
                self.settings,
                body.get("path"),
                parents=bool(body.get("parents", True)),
            )
            fsync_directory(target.parent)
            self._json(200, {"ok": True, "path": relative.as_posix()}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        raw_path = body.get("path", "")
        relative, target = checked_path(
            self.settings,
            raw_path,
            allow_missing=route in {"/write", "/v1/write"},
            allow_root=False,
        )
        if route in {"/write", "/v1/write"}:
            content = body.get("content")
            if not isinstance(content, str):
                raise BridgeError(400, "invalid_content", "content must be a string")
            size, digest, backup = atomic_bytes(self.settings, relative, target, content.encode("utf-8"), body.get("expected_sha256"))
            self._json(200, {"ok": True, "path": relative.as_posix(), "size": size, "sha256": digest, "backup": backup}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        if route in {"/delete", "/v1/delete"}:
            if body.get("confirm") != relative.as_posix():
                raise BridgeError(400, "confirmation_required", "confirm must exactly match the relative path")
            if target.is_dir():
                if not bool(body.get("recursive", False)):
                    raise BridgeError(400, "recursive_required", "directory deletion requires recursive=true")
                backup = safe_backup(self.settings, relative, target)
                shutil.rmtree(target)
            else:
                verify_prior(target, body.get("expected_sha256"))
                backup = safe_backup(self.settings, relative, target)
                target.unlink()
            fsync_directory(target.parent)
            self._json(200, {"ok": True, "path": relative.as_posix(), "backup": backup}, request_id, relative.as_posix())
            return 200, relative.as_posix()
        raise BridgeError(404, "not_found", "endpoint does not exist")

    def _handle_put(self, route: str, request_id: str) -> tuple[int, str]:
        self._authenticate("write")
        match = re.fullmatch(r"/v1/uploads/([0-9a-f]{32})", route)
        if not match:
            raise BridgeError(404, "not_found", "endpoint does not exist")
        metadata, _metadata_path = load_upload(self.settings, match.group(1))
        part = Path(metadata["part_path"])
        raw_offset = self.headers.get("X-Upload-Offset", "")
        try:
            offset = int(raw_offset)
        except ValueError as exc:
            raise BridgeError(400, "invalid_offset", "X-Upload-Offset must be an integer") from exc
        upload_part_info(self.settings, part)
        descriptor = os.open(part, os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0))
        try:
            details = os.fstat(descriptor)
            validate_upload_info(self.settings, details)
            current = details.st_size
            if offset != current:
                raise BridgeError(409, "offset_mismatch", f"expected upload offset {current}")
            length = self._content_length(self.settings.limits.chunk_bytes)
            if current + length > metadata["total_size"]:
                raise BridgeError(413, "upload_overflow", "chunk exceeds declared total size")
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise BridgeError(400, "truncated_body", "request body ended early")
                os.write(descriptor, chunk)
                remaining -= len(chunk)
            os.fsync(descriptor)
            new_offset = os.fstat(descriptor).st_size
        finally:
            os.close(descriptor)
        self._json(200, {"ok": True, "upload_id": match.group(1), "path": metadata["path"], "offset": new_offset, "total_size": metadata["total_size"]}, request_id, metadata["path"])
        return 200, metadata["path"]

    def _handle_delete(self, route: str, request_id: str) -> tuple[int, str]:
        self._authenticate("write")
        match = re.fullmatch(r"/v1/uploads/([0-9a-f]{32})", route)
        if not match:
            raise BridgeError(404, "not_found", "endpoint does not exist")
        metadata, metadata_path = load_upload(self.settings, match.group(1))
        part = Path(metadata["part_path"])
        if part.exists() or part.is_symlink():
            upload_part_info(self.settings, part)
            part.unlink()
        metadata_path.unlink(missing_ok=True)
        self._json(200, {"ok": True, "upload_id": match.group(1), "aborted": True}, request_id, metadata["path"])
        return 200, metadata["path"]

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("value must be a positive finite number")
    return parsed


def prepare_private_directory(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise SystemExit(f"{label} must not be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    details = path.lstat()
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != os.geteuid():
        raise SystemExit(f"{label} must be an owner-controlled directory")
    path.chmod(0o700)
    return path


def prepare_audit_log(path: Path) -> Path:
    if path.is_symlink() or path.parent.is_symlink() or not path.parent.is_dir():
        raise SystemExit("audit log path is unsafe")
    parent_details = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent_details.st_mode)
        or parent_details.st_uid != os.geteuid()
        or stat.S_IMODE(parent_details.st_mode) & 0o022
    ):
        raise SystemExit("audit log parent must be owner-controlled")
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_nlink != 1
            or details.st_uid != os.geteuid()
        ):
            raise SystemExit("audit log must be an owner-controlled regular file")
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18081)
    parser.add_argument("--root", required=True)
    parser.add_argument("--state-dir")
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--audit-log")
    parser.add_argument("--enable-write", action="store_true")
    parser.add_argument("--enable-delete", action="store_true")
    parser.add_argument("--allow-root-for-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--allow-unisolated-for-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--max-json-bytes", type=positive_int, default=1024 * 1024)
    parser.add_argument("--max-chunk-bytes", type=positive_int, default=16 * 1024 * 1024)
    parser.add_argument("--max-read-bytes", type=positive_int, default=1024 * 1024)
    parser.add_argument("--max-download-bytes", type=positive_int, default=64 * 1024 * 1024 * 1024)
    parser.add_argument("--max-file-bytes", type=positive_int, default=64 * 1024 * 1024 * 1024)
    parser.add_argument("--max-entries", type=positive_int, default=5000)
    parser.add_argument("--max-workers", type=positive_int, default=8)
    parser.add_argument("--socket-timeout", type=positive_float, default=30.0)
    return parser


def build_settings(args: argparse.Namespace) -> Settings:
    if not is_loopback(args.host):
        raise SystemExit("file bridge refuses non-loopback bind addresses")
    if os.geteuid() == 0 and not args.allow_root_for_test:
        raise SystemExit("file bridge refuses to run as root")
    root_input = Path(args.root).expanduser()
    if root_input.is_symlink():
        raise SystemExit("workspace root must not be a symlink")
    try:
        root = root_input.resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise SystemExit("workspace root does not exist") from exc
    if not root.is_dir():
        raise SystemExit("workspace root must be a regular directory")
    if not os.path.ismount(root) and not args.allow_unisolated_for_test:
        raise SystemExit("workspace root must be an isolated mount; use a bind-mounted workspace volume")
    state_input = Path(args.state_dir).expanduser() if args.state_dir else root / ".openclaw-file-bridge-state"
    state_dir = prepare_private_directory(
        Path(os.path.abspath(os.fspath(state_input))), "state directory"
    )
    uploads = prepare_private_directory(state_dir / "uploads", "upload state directory")
    backup_dir = prepare_private_directory(state_dir / "backups", "backup directory")
    audit_input = Path(args.audit_log).expanduser() if args.audit_log else state_dir / "audit.jsonl"
    audit_log = prepare_audit_log(Path(os.path.abspath(os.fspath(audit_input))))
    if args.enable_delete and not args.enable_write:
        raise SystemExit("delete capability requires write capability")
    limits = Limits(
        json_bytes=args.max_json_bytes,
        chunk_bytes=args.max_chunk_bytes,
        read_bytes=args.max_read_bytes,
        download_bytes=args.max_download_bytes,
        file_bytes=args.max_file_bytes,
        entries=args.max_entries,
        workers=args.max_workers,
        socket_timeout=args.socket_timeout,
    )
    return Settings(
        root=root,
        state_dir=state_dir,
        backup_dir=backup_dir,
        tokens=validate_secret_file(Path(args.secret_file).expanduser()),
        enable_write=args.enable_write,
        enable_delete=args.enable_delete,
        limits=limits,
        audit_log=audit_log,
        root_device=root.stat().st_dev,
    )


def main() -> int:
    args = build_parser().parse_args()
    settings = build_settings(args)
    server = BridgeHTTPServer((args.host, args.port), Handler, settings)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
