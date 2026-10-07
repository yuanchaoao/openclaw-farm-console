#!/usr/bin/env python3
"""Original Farm tools plus Gateway sessions for MCP/R2 file delivery."""

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
    # mcp 1.29 leaves this generic forward reference unresolved until first
    # settings access, which emits a noisy warning on every STDIO startup.
    # Rebuild it once after FastMCP is imported; this does not alter behavior.
    from mcp.server.fastmcp.server import Settings as FastMCPSettings

    FastMCPSettings.model_rebuild()
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by installation checks
    raise SystemExit("Python package 'mcp' is required; install scripts/requirements.txt") from exc

import openclaw_farm as farm


mcp = FastMCP("openclaw")


def resolve(instance: str) -> tuple[str, dict[str, Any]]:
    registry = farm.load_registry(farm.default_registry_path())
    instances = {key: record for key, record in (registry.get("instances") or {}).items()
                 if isinstance(record, dict) and not record.get("console_archived_at")}
    instance_id = instance or registry.get("default") or ""
    if not instance_id:
        if len(instances) == 1:
            instance_id = next(iter(instances))
        else:
            raise farm.FarmError("没有指定实例，注册表也没有唯一默认实例。")
    return instance_id, farm.get_record(registry, instance_id)


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def failure(exc: Exception, *, file_error: bool = False) -> str:
    prefix = "openclaw file error" if file_error else "openclaw error"
    if isinstance(exc, farm.FarmError):
        return f"[{prefix}] {exc}"
    return f"[{prefix}] {type(exc).__name__}"


def gateway_json(instance: str, method: str, params: dict[str, Any]) -> str:
    """Use only the selected instance's Gateway credential, never its file bridge."""
    instance_id, record = resolve(instance)
    token = farm.lookup_secret(instance_id)
    if not token:
        raise farm.FarmError("该实例缺少 Gateway 凭据，请先登记。")
    try:
        result = farm.gateway_call(record, method, params, 30_000, token)
        if result.returncode:
            raise farm.FarmError(farm.redact((result.stderr or result.stdout).strip(), token))
        # Preserve real download URLs for the requesting user; never expose the
        # Gateway credential if the remote result happens to contain it.
        return encoded(json.loads(farm.redact(result.stdout, token)))
    except farm.FarmError as exc:
        raise farm.FarmError(farm.redact(str(exc), token)) from None


@mcp.tool()
def openclaw_sessions_list(instance: str = "", limit: int = 20) -> str:
    """List this instance's Gateway sessions without an SSH key or file bridge."""
    try:
        if not 1 <= limit <= 100:
            raise farm.FarmError("会话数量必须在 1 到 100 之间。")
        return gateway_json(instance, "sessions.list", {"limit": limit, "includeGlobal": True,
            "includeUnknown": True, "includeDerivedTitles": True, "includeLastMessage": False})
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_chat_history(session_key: str, instance: str = "", limit: int = 20) -> str:
    """Read remote replies, including existing R2 file links. No bridge is required."""
    try:
        if not session_key.strip() or len(session_key) > 512 or not 1 <= limit <= 100:
            raise farm.FarmError("请指定有效会话，消息数量为 1 到 100。")
        return gateway_json(instance, "chat.history", {"sessionKey": session_key, "limit": limit})
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_chat_send(message: str, session_key: str, idempotency_key: str,
                       instance: str = "", approved: bool = False) -> str:
    """Send an authorized request to this remote instance, e.g. prepare the named
    file using its existing R2 setup. Requires user authorization; does not set up
    R2 or SSH. An acknowledgement is not completion: read chat history for results.
    Reuse the same idempotency_key when retrying the same request.
    """
    if not approved:
        return "[openclaw error] chat.send requires approved=true after user authorization"
    try:
        if not message.strip() or len(message.encode("utf-8")) > 1536 * 1024:
            raise farm.FarmError("消息不能为空或超过 1.5 MiB。")
        if not session_key.strip() or len(session_key) > 512 or not idempotency_key.strip() or len(idempotency_key) > 256:
            raise farm.FarmError("请提供有效会话和请求编号；重试时复用原请求编号。")
        return gateway_json(instance, "chat.send", {"sessionKey": session_key, "message": message,
            "idempotencyKey": idempotency_key, "deliver": False, "timeoutMs": 30_000})
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_exec_approve(request_id: str, instance: str, approved: bool = False) -> str:
    """Approve one exact, user-authorized execution request on an explicit instance.

    Use the complete request UUID from this task. This grants allow-once only;
    it cannot approve device pairing or change the remote execution policy.
    """
    if approved is not True:
        return "[openclaw error] exec approval requires approved=true after user authorization"
    try:
        if not isinstance(instance, str) or not instance.strip():
            raise farm.FarmError("执行批准必须明确指定实例，不能使用默认实例。")
        if not isinstance(request_id, str) or not re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            request_id,
        ):
            raise farm.FarmError("执行批准必须提供当前任务的完整请求 UUID，不能使用缩写。")
        return gateway_json(instance, "exec.approval.resolve", {
            "id": request_id, "decision": "allow-once",
        })
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_list_instances() -> str:
    """List sanitized OpenClaw instances and file-bridge availability."""
    try:
        registry = farm.load_registry(farm.default_registry_path())
        rows = []
        for instance_id, record in sorted(registry.get("instances", {}).items()):
            if isinstance(record, dict) and not record.get("console_archived_at"):
                rows.append(farm.safe_record(record, farm.lookup_secret(instance_id) is not None))
        return encoded({"default": registry.get("default"), "count": len(rows), "instances": rows})
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_run_bash(cmd: str, instance: str = "", approved: bool = False, timeout: float = 120) -> str:
    """Run a remote shell command after the user explicitly approves the exact command."""
    if not approved:
        return "[openclaw error] remote command requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.remote_exec(instance_id, record, cmd, timeout))
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_read_file(path: str, instance: str = "") -> str:
    """Read a remote file, preferring the authenticated file bridge."""
    try:
        instance_id, record = resolve(instance)
        return farm.remote_read_file(instance_id, record, path)
    except Exception as exc:
        return failure(exc)


@mcp.tool()
def openclaw_file_list(path: str = ".", instance: str = "") -> str:
    """List files in the selected OpenClaw workspace."""
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.bridge_list(instance_id, record, path))
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_stat(path: str, instance: str = "") -> str:
    """Return remote metadata, including SHA-256 for a regular file."""
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.bridge_stat(instance_id, record, path))
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_read(path: str, max_bytes: int = 1048576, instance: str = "") -> str:
    """Read a bounded UTF-8 text file from the OpenClaw workspace."""
    try:
        instance_id, record = resolve(instance)
        return farm.bridge_read(instance_id, record, path, max_bytes)
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_write(
    path: str,
    content: str,
    instance: str = "",
    expected_sha256: str = "",
    approved: bool = False,
) -> str:
    """Atomically write text after confirmation; require prior SHA-256 when overwriting."""
    if not approved:
        return "[openclaw file error] write requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.bridge_write(instance_id, record, path, content, expected_sha256 or None))
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_upload(
    local_path: str,
    remote_path: str,
    instance: str = "",
    expected_remote_sha256: str = "",
    overwrite: bool = False,
    approved: bool = False,
) -> str:
    """Resume interrupted uploads and verify the file after explicit confirmation."""
    if not approved:
        return "[openclaw file error] upload requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(
            farm.bridge_upload(
                instance_id,
                record,
                local_path,
                remote_path,
                expected_remote_sha256=expected_remote_sha256 or None,
                overwrite=overwrite,
            )
        )
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_download(
    remote_path: str,
    local_path: str,
    instance: str = "",
    overwrite: bool = False,
    approved: bool = False,
) -> str:
    """Resume interrupted downloads and verify the final size and SHA-256."""
    if overwrite and not approved:
        return "[openclaw file error] local overwrite requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(
            farm.bridge_download(
                instance_id,
                record,
                remote_path,
                local_path,
                overwrite=overwrite,
            )
        )
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_move(src: str, dst: str, instance: str = "", approved: bool = False) -> str:
    """Move or rename a remote file/directory after explicit confirmation."""
    if not approved:
        return "[openclaw file error] move requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.bridge_mutation(instance_id, record, "/v1/move", {"src": src, "dst": dst}))
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_copy(src: str, dst: str, instance: str = "", approved: bool = False) -> str:
    """Copy a remote file/directory after explicit confirmation."""
    if not approved:
        return "[openclaw file error] copy requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(farm.bridge_mutation(instance_id, record, "/v1/copy", {"src": src, "dst": dst}))
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_delete(
    path: str,
    recursive: bool = False,
    instance: str = "",
    expected_sha256: str = "",
    approved: bool = False,
) -> str:
    """Delete a remote target after exact user confirmation; backups remain server-side."""
    if not approved:
        return "[openclaw file error] delete requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(
            farm.bridge_mutation(
                instance_id,
                record,
                "/v1/delete",
                {
                    "path": path,
                    "recursive": recursive,
                    "confirm": path,
                    "expected_sha256": expected_sha256 or None,
                },
                delete=True,
            )
        )
    except Exception as exc:
        return failure(exc, file_error=True)


@mcp.tool()
def openclaw_file_mkdir(path: str, instance: str = "", approved: bool = False) -> str:
    """Create a directory after explicit confirmation."""
    if not approved:
        return "[openclaw file error] mkdir requires approved=true after explicit user confirmation"
    try:
        instance_id, record = resolve(instance)
        return encoded(
            farm.bridge_mutation(instance_id, record, "/v1/mkdir", {"path": path, "parents": True})
        )
    except Exception as exc:
        return failure(exc, file_error=True)


if __name__ == "__main__":
    mcp.run()
