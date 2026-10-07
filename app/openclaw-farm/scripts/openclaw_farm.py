#!/usr/bin/env python3
"""Protected local adapter for managed OpenClaw Gateway instances."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from keychain_store import KeychainError, backend_name, keychain_request
import private_storage as storage


INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SENSITIVE_KEY = re.compile(
    r"(?:token|secret|password|passwd|credential|private|cookie|auth|api.?key|access.?key|session.?token)",
    re.IGNORECASE,
)
SECRET_VALUE = re.compile(r"(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{10,})", re.IGNORECASE)
READ_ONLY_METHODS = {
    "health",
    "status",
    "system-presence",
    "agent.wait",
    "agents.list",
    "channels.status",
    "chat.history",
    "commands.list",
    "device.pair.list",
    "exec.approval.waitDecision",
    "models.list",
    "sessions.describe",
    "sessions.list",
    "sessions.preview",
    "sessions.usage",
    "skills.detail",
    "skills.search",
    "skills.status",
    "tools.catalog",
    "tools.effective",
}
SECRET_SERVICE = "openclaw-farm"
BRIDGE_SECRET_SERVICE = "openclaw-file-bridge"
BRIDGE_TRANSPORTS = {"direct_http", "ssh_relay"}
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
WRITE_COMMANDS = {
    "file-write",
    "file-upload",
    "file-move",
    "file-copy",
    "file-mkdir",
}


class FarmError(KeychainError):
    """A safe, user-displayable adapter error."""


class GatewayTimeoutError(FarmError):
    """The local Gateway SDK helper exceeded its bounded wall-clock timeout."""


def default_registry_path() -> Path:
    configured = os.environ.get("OPENCLAW_INSTANCES_FILE")
    return Path(configured).expanduser() if configured else storage.user_data_root() / "data" / "instances.json"


def validate_instance_id(value: str) -> str:
    if not INSTANCE_ID.fullmatch(value):
        raise FarmError("实例 ID 格式不合法。")
    return value


def normalize_urls(raw_url: str, instance_id: str) -> tuple[str, str, str]:
    """Return a credential-free gateway URL, web URL, and hostname."""
    validate_instance_id(instance_id)
    candidate = raw_url.strip()
    if "://" not in candidate:
        candidate = "https://" + candidate
    parsed = urlsplit(candidate)
    if parsed.scheme.lower() not in {"https", "http", "wss", "ws"}:
        raise FarmError("实例地址必须使用 HTTPS/WSS（本地调试可使用 HTTP/WS）。")
    if parsed.username or parsed.password or not parsed.hostname:
        raise FarmError("实例地址不得包含用户名、密码或空主机名。")

    segments = [segment for segment in parsed.path.split("/") if segment]
    if segments and segments[-1] == "chat":
        segments.pop()
    if segments != [instance_id]:
        raise FarmError("实例地址路径与实例 ID 不一致。")

    netloc = parsed.netloc
    gateway_scheme = "wss" if parsed.scheme.lower() in {"https", "wss"} else "ws"
    web_scheme = "https" if gateway_scheme == "wss" else "http"
    gateway_url = urlunsplit((gateway_scheme, netloc, f"/{instance_id}/", "", ""))
    web_url = urlunsplit((web_scheme, netloc, f"/{instance_id}/chat", "", ""))
    return gateway_url, web_url, parsed.hostname.lower()


def ensure_private_directory(path: Path) -> None:
    try:
        storage.private_directory(path)
    except OSError as exc:
        raise FarmError("无法建立当前用户的私有存储目录。") from exc


def load_registry(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 2, "instances": {}}
    if path.is_symlink():
        raise FarmError(f"拒绝读取符号链接注册表：{path}")
    if path.stat().st_size > 8 * 1024 * 1024:
        raise FarmError("注册表超过 8 MiB，拒绝读取。")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FarmError(f"注册表无法解析：{type(exc).__name__}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("instances"), dict):
        raise FarmError("注册表结构不合法。")
    payload.setdefault("schema_version", 1)
    return payload


def timestamp() -> str:
    return datetime.now().astimezone().strftime("%Y%m%dT%H%M%S.%f%z")


def backup_registry(path: Path) -> Path:
    backup_dir = path.parent / "backups"
    ensure_private_directory(backup_dir)
    stamp = timestamp()
    if path.exists():
        destination = backup_dir / f"{path.name}.{stamp}.bak"
        shutil.copy2(path, destination, follow_symlinks=False)
        storage.protect(destination)
        return destination

    destination = backup_dir / f"{path.name}.absent.{stamp}.txt"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(destination, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"Target did not exist before initial creation: {path}\n")
        handle.flush()
        os.fsync(handle.fileno())
    return destination


def write_registry(path: Path, payload: dict[str, Any]) -> Path:
    ensure_private_directory(path.parent)
    backup = backup_registry(path)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        storage.private_fchmod(fd, temporary)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        storage.protect(path)
        storage.fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return backup



def openclaw_package_root() -> Path:
    configured = os.environ.get("OPENCLAW_PACKAGE_ROOT")
    if configured:
        root = Path(configured).expanduser().resolve()
        if not (root / "dist" / "plugin-sdk" / "testing.js").is_file():
            raise FarmError("OpenClaw 客户端 SDK 路径无效，请重新安装本地连接依赖。")
        return root
    executable = shutil.which("openclaw")
    if not executable:
        raise FarmError("未配置 OpenClaw 客户端 SDK；请运行本地安装程序。")
    resolved = Path(executable).resolve()
    for candidate in (resolved.parent, *resolved.parents):
        package_json = candidate / "package.json"
        if package_json.is_file():
            try:
                metadata = json.loads(package_json.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if metadata.get("name") == "openclaw":
                return candidate
    raise FarmError("无法定位已安装的 OpenClaw SDK。")


def adapter_state_dir() -> Path:
    path = Path(os.environ.get("OPENCLAW_ADAPTER_STATE_DIR", str(storage.user_data_root() / "data" / "farm-adapter")))
    ensure_private_directory(path)
    return path


def keyring_attributes(instance_id: str, service: str = SECRET_SERVICE, scope: str | None = None) -> list[str]:
    attributes = ["service", service, "instance", validate_instance_id(instance_id)]
    if scope:
        if scope not in {"read", "write", "delete", "all"}:
            raise FarmError("文件桥凭据范围不合法。")
        attributes.extend(["scope", scope])
    return attributes


def lookup_keyring_secret(instance_id: str, service: str = SECRET_SERVICE, scope: str | None = None) -> str | None:
    try:
        return keychain_request("get", keyring_attributes(instance_id, service, scope))
    except KeychainError as exc:
        raise FarmError(str(exc)) from None


def lookup_secret(instance_id: str) -> str | None:
    return lookup_keyring_secret(instance_id)


def store_keyring_secret(instance_id: str, token: str, service: str = SECRET_SERVICE, scope: str | None = None) -> None:
    validate_token(token)
    try:
        keychain_request("set", keyring_attributes(instance_id, service, scope), token)
    except KeychainError as exc:
        raise FarmError(str(exc)) from None


def store_secret(instance_id: str, token: str) -> None:
    store_keyring_secret(instance_id, token)


def lookup_bridge_secret(instance_id: str, scope: str) -> str | None:
    # A token may be stored under the narrowest label that describes its grant.
    # Prefer an exact match, then accept only labels that are at least as broad
    # as the requested operation.  This keeps one read+write token usable for
    # resumable uploads without weakening delete isolation.
    fallback_scopes = {
        "read": ("read", "all", "write", "delete"),
        "write": ("write", "all", "delete"),
        "delete": ("delete", "all"),
    }
    for candidate in fallback_scopes.get(scope, (scope, "all")):
        token = lookup_keyring_secret(instance_id, BRIDGE_SECRET_SERVICE, candidate)
        if token:
            return token
    return None


def validate_token(token: str) -> str:
    if len(token) < 20 or len(token) > 4096:
        raise FarmError("令牌长度异常，请粘贴完整令牌。")
    if not token.isascii() or not token.isprintable() or any(character.isspace() for character in token):
        raise FarmError("令牌包含空格、换行或非 ASCII 字符。")
    return token


def read_token(source: str, instance_id: str) -> str:
    if source == "gui" and sys.platform == "darwin":
        completed = subprocess.run(
            ["/usr/bin/osascript", "-e", 'text returned of (display dialog "请输入 OpenClaw Token" default answer "" with hidden answer buttons {"取消", "导入"} default button "导入")'],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        if completed.returncode != 0:
            raise FarmError("已取消令牌导入。")
        return validate_token(completed.stdout.rstrip("\r\n"))
    if source == "gui":
        zenity = shutil.which("zenity")
        if not zenity:
            raise FarmError("本机没有 zenity，请改用终端隐藏输入。")
        completed = subprocess.run(
            [
                zenity,
                "--password",
                "--title=OpenClaw Farm 安全注册",
                f"--text=请粘贴 {instance_id} 的令牌（不会显示字符）",
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if completed.returncode != 0:
            raise FarmError("已取消令牌导入。")
        token = completed.stdout.rstrip("\r\n")
    elif source == "stdin":
        token = sys.stdin.read().rstrip("\r\n")
    else:
        token = getpass.getpass(f"Token for {instance_id}: ")
    if not token:
        raise FarmError("没有收到令牌。")
    return validate_token(token)


def contains_sensitive_params(value: Any) -> bool:
    if isinstance(value, dict):
        return any(SENSITIVE_KEY.search(str(key)) or contains_sensitive_params(item) for key, item in value.items())
    if isinstance(value, list):
        return any(contains_sensitive_params(item) for item in value)
    if isinstance(value, str):
        return bool(SECRET_VALUE.search(value))
    return False


def redact(text: str, token: str | None = None) -> str:
    sanitized = text
    if token:
        sanitized = sanitized.replace(token, "[REDACTED]")
    return SECRET_VALUE.sub("[REDACTED]", sanitized)


def gateway_call(
    record: dict[str, Any],
    method: str,
    params: dict[str, Any],
    timeout_ms: int,
    token: str,
    *,
    expect_final: bool = False,
    outer_timeout_ms: int | None = None,
) -> subprocess.CompletedProcess[str]:
    if contains_sensitive_params(params):
        raise FarmError("RPC 参数疑似包含凭据；请改用受保护密钥导入。")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms < 1:
        raise FarmError("Gateway 超时必须是正整数毫秒。")
    if outer_timeout_ms is not None and (
        isinstance(outer_timeout_ms, bool)
        or not isinstance(outer_timeout_ms, int)
        or outer_timeout_ms < 1
    ):
        raise FarmError("Gateway 外层超时必须是正整数毫秒。")
    if expect_final and method != "agent":
        raise FarmError("expect_final 只允许用于受限的 agent 调用。")
    node = os.environ.get("OPENCLAW_NODE_BIN") or shutil.which("node")
    helper = Path(__file__).resolve().with_name("gateway_client.mjs")
    if not node or not helper.is_file():
        raise FarmError("本机缺少 Node.js 或 Gateway SDK 助手。")
    gateway_url = record.get("gateway_url")
    if not isinstance(gateway_url, str):
        raise FarmError("注册表缺少 gateway_url。")
    env = os.environ.copy()
    env["OPENCLAW_GATEWAY_URL"] = gateway_url
    env["OPENCLAW_GATEWAY_TOKEN"] = token
    env["OPENCLAW_PACKAGE_ROOT"] = str(openclaw_package_root())
    env["OPENCLAW_STATE_DIR"] = str(adapter_state_dir())
    env.pop("OPENCLAW_GATEWAY_PASSWORD", None)
    request = {"method": method, "params": params, "timeoutMs": timeout_ms}
    if expect_final:
        request["expectFinal"] = True
    try:
        return subprocess.run(
            [node, str(helper)],
            input=json.dumps(request, ensure_ascii=False, separators=(",", ":")),
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            timeout=(outer_timeout_ms / 1000)
            if outer_timeout_ms is not None
            else (timeout_ms / 1000) + 15,
        )
    except subprocess.TimeoutExpired as exc:
        raise GatewayTimeoutError("Gateway SDK 助手调用超时。") from exc


def gateway_http_tool(
    record: dict[str, Any],
    token: str,
    tool: str,
    args: dict[str, Any],
    *,
    timeout: float = 120,
    session_key: str | None = None,
) -> dict[str, Any]:
    if contains_sensitive_params(args):
        raise FarmError("远端工具参数疑似包含凭据，已拒绝发送。")
    web_url = record.get("web_url")
    if not isinstance(web_url, str):
        raise FarmError("注册表缺少 web_url。")
    parsed = urlsplit(web_url)
    base_path = parsed.path.rsplit("/chat", 1)[0]
    endpoint = urlunsplit((parsed.scheme, parsed.netloc, base_path + "/tools/invoke", "", ""))
    body = json.dumps(
        {"tool": tool, "args": args, "sessionKey": session_key or "agent:main:openclaw-control-ui:diagnostic-" + __import__("uuid").uuid4().hex},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "Accept": "application/json",
        },
    )
    try:
        with HTTP_OPENER.open(request, timeout=timeout) as response:
            raw = response.read(16 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(1024 * 1024).decode("utf-8", "replace"))
            error = payload.get("error") if isinstance(payload, dict) else None
            message = error.get("message") if isinstance(error, dict) else None
        except Exception:
            message = None
        raise FarmError(
            f"Gateway 工具调用失败（HTTP {exc.code}）：{redact(message or 'request failed', token)}"
        ) from exc
    if len(raw) > 16 * 1024 * 1024:
        raise FarmError("Gateway 工具响应超过 16 MiB。")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FarmError("Gateway 工具返回了无效 JSON。") from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise FarmError("Gateway 工具返回失败。")
    return payload


def remote_exec(instance_id: str, record: dict[str, Any], command: str, timeout: float = 120) -> dict[str, Any]:
    token = lookup_secret(instance_id)
    if not token:
        raise FarmError("系统密钥环中没有该实例的控制凭据。")
    try:
        return gateway_http_tool(record, token, "exec", {"command": command, "timeout": timeout}, timeout=timeout + 10)
    finally:
        token = ""


def remote_read_file(instance_id: str, record: dict[str, Any], path: str) -> str:
    if isinstance(record.get("file_bridge"), dict):
        return bridge_read(instance_id, record, path)
    token = lookup_secret(instance_id)
    if not token:
        raise FarmError("系统密钥环中没有该实例的控制凭据。")
    try:
        payload = gateway_http_tool(record, token, "read", {"path": path}, timeout=120)
    finally:
        token = ""
    result = payload.get("result")
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        for key in ("content", "text", "output"):
            if isinstance(result.get(key), str):
                return result[key]
    return json.dumps(result, ensure_ascii=False, indent=2)


def build_record(instance_id: str, raw_url: str, status_value: str) -> dict[str, Any]:
    gateway_url, web_url, host = normalize_urls(raw_url, instance_id)
    return {
        "id": instance_id,
        "name": instance_id,
        "status": status_value,
        "host": host,
        "gateway_url": gateway_url,
        "web_url": web_url,
        "control_adapter": "openclaw-sdk-least-privilege",
        "credential_ref": {
            "backend": backend_name(),
            "attributes": {"service": SECRET_SERVICE, "instance": instance_id},
        },
    }


def safe_record(record: dict[str, Any], credential_present: bool | None = None) -> dict[str, Any]:
    allowed = ("id", "name", "status", "host", "gateway_url", "web_url", "control_adapter")
    result = {key: record[key] for key in allowed if key in record}
    bridge = record.get("file_bridge")
    if isinstance(bridge, dict):
        result["file_bridge"] = safe_bridge_record(bridge)
    if credential_present is not None:
        result["credential_present"] = credential_present
    return result


def safe_bridge_record(bridge: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "status",
        "transport",
        "base_url",
        "workspace",
        "local_host",
        "local_port",
        "pod_port",
        "relay_host",
        "relay_user",
        "relay_port",
        "relay_key",
        "version",
    )
    return {key: bridge[key] for key in allowed if key in bridge}


def normalize_bridge_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise FarmError("文件桥地址必须是无凭据的 HTTP(S) URL。")
    if parsed.query or parsed.fragment:
        raise FarmError("文件桥地址不得包含查询串或片段。")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise FarmError("明文 HTTP 文件桥只能绑定本机回环地址。")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def bridge_config_from_args(args: argparse.Namespace) -> dict[str, Any]:
    if args.transport not in BRIDGE_TRANSPORTS:
        raise FarmError("不支持的文件桥传输方式。")
    bridge: dict[str, Any] = {
        "status": "configured_unverified",
        "transport": args.transport,
        "workspace": args.workspace,
        "version": "2",
        "credential_refs": {
            scope: {
                "backend": backend_name(),
                "attributes": {
                    "service": BRIDGE_SECRET_SERVICE,
                    "instance": args.instance_id,
                    "scope": scope,
                },
            }
            for scope in ("read", "write", "delete", "all")
        },
    }
    if args.transport == "direct_http":
        if not args.base_url:
            raise FarmError("direct_http 文件桥必须提供 --base-url。")
        bridge["base_url"] = normalize_bridge_url(args.base_url)
    else:
        required = {
            "local_port": args.local_port,
            "relay_host": args.relay_host,
            "relay_user": args.relay_user,
            "relay_port": args.relay_port,
                "relay_ssh_port": args.relay_ssh_port,
            "relay_key": args.relay_key,
        }
        missing = [name for name, value in required.items() if value in {None, ""}]
        if missing:
            raise FarmError("ssh_relay 文件桥缺少：" + ", ".join(missing))
        for key in ("local_port", "relay_port", "relay_ssh_port", "pod_port"):
            value = getattr(args, key)
            if not isinstance(value, int) or not 1 <= value <= 65535:
                raise FarmError(f"{key} 必须是有效端口。")
        bridge.update(
            {
                "base_url": f"http://127.0.0.1:{args.local_port}",
                "local_host": "127.0.0.1",
                "local_port": args.local_port,
                "pod_port": args.pod_port,
                "relay_host": args.relay_host,
                "relay_user": args.relay_user,
                "relay_port": args.relay_port,
                "relay_ssh_port": args.relay_ssh_port,
                "relay_key": str(Path(args.relay_key).expanduser()),
            }
        )
    return bridge


def get_record(registry: dict[str, Any], instance_id: str) -> dict[str, Any]:
    validate_instance_id(instance_id)
    record = registry["instances"].get(instance_id)
    if not isinstance(record, dict):
        raise FarmError(f"注册表中没有实例：{instance_id}")
    if record.get("console_archived_at"):
        raise FarmError("该实例已从管理列表移出；已停止检查和安装，历史记录仍保留。")
    return record


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


HTTP_OPENER = urllib.request.build_opener(NoRedirect)


def get_bridge_record(record: dict[str, Any]) -> dict[str, Any]:
    bridge = record.get("file_bridge")
    if not isinstance(bridge, dict):
        raise FarmError("该实例尚未配置文件桥。")
    transport = bridge.get("transport")
    if transport not in BRIDGE_TRANSPORTS:
        raise FarmError("注册表中的文件桥传输方式不受支持。")
    base_url = bridge.get("base_url")
    if not isinstance(base_url, str):
        raise FarmError("文件桥缺少 base_url。")
    normalize_bridge_url(base_url)
    return bridge


def port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        return connection.connect_ex((host, port)) == 0


def forward_state_path(bridge):
    return adapter_state_dir() / f"relay-forward-{int(bridge['local_port'])}.json"


def managed_forward_record(bridge):
    path = forward_state_path(bridge)
    if not path.exists() or not storage.is_private(path):
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        expected = {key: bridge.get(key) for key in ("relay_host", "relay_user", "relay_port", "local_port", "relay_key")}
        return record if record.get("bridge") == expected else None
    except (OSError, ValueError):
        return None


def ensure_local_bridge_forward(bridge: dict[str, Any]) -> None:
    if bridge.get("transport") != "ssh_relay":
        return
    local_port = int(bridge["local_port"])
    if port_open("127.0.0.1", local_port):
        return
    lock_path = adapter_state_dir() / f"relay-forward-{local_port}.lock"
    try:
        with storage.file_lock(lock_path):
            if port_open("127.0.0.1", local_port):
                return
            old = managed_forward_record(bridge)
            if old:
                storage.stop_owned(old)
            key = Path(str(bridge["relay_key"])).expanduser().resolve()
            if not key.is_file() or not storage.is_private(key):
                raise FarmError("文件桥中继私钥不存在，或未仅授权当前用户读取。")
            ssh = shutil.which("ssh")
            if not ssh:
                raise FarmError("缺少 OpenSSH 客户端；请安装系统 OpenSSH 客户端后重试。")
            command = [ssh, "-N", "-p", str(int(bridge.get("relay_ssh_port") or 22)),
                       "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
                       "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
                       "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=yes"]
            bind_interface = os.environ.get("OPENCLAW_RELAY_BIND_INTERFACE", "").strip()
            if bind_interface:
                if os.name == "nt" or bind_interface not in {name for _, name in socket.if_nameindex()}:
                    raise FarmError("SSH 直连接口不可用。")
                command.extend(["-o", f"BindInterface={bind_interface}"])
            command.extend(["-i", str(key), "-L",
                            f"127.0.0.1:{local_port}:127.0.0.1:{int(bridge['relay_port'])}",
                            f"{bridge['relay_user']}@{bridge['relay_host']}"])
            # Do not use SSH -f: keep a verifiable managed child on every OS.
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, **storage.detached_options())
            record = storage.process_identity(process.pid, command)
            record["bridge"] = {key: bridge.get(key) for key in ("relay_host", "relay_user", "relay_port", "local_port", "relay_key")}
            storage.write_json(forward_state_path(bridge), record)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise FarmError("SSH 转发未建立；请检查中继授权、公钥和已确认的主机指纹。")
                if port_open("127.0.0.1", local_port):
                    return
                time.sleep(.1)
            storage.stop_owned(record)
            raise FarmError("建立文件桥 SSH 转发超时。")
    except BlockingIOError as exc:
        raise FarmError("同端口 SSH 转发正在建立，请稍后重试。") from exc


def bridge_url(bridge: dict[str, Any], route: str, params: dict[str, Any] | None = None) -> str:
    base = normalize_bridge_url(str(bridge["base_url"]))
    query = urllib.parse.urlencode(params or {})
    return base + route + ("?" + query if query else "")


def parse_bridge_http_error(exc: urllib.error.HTTPError, token: str | None = None) -> FarmError:
    try:
        raw = exc.read(1024 * 1024).decode("utf-8", "replace")
        payload = json.loads(raw)
        error = payload.get("error") if isinstance(payload, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        if isinstance(message, str):
            return FarmError(f"文件桥 HTTP {exc.code} ({code or 'error'})：{redact(message, token)}")
    except Exception:
        pass
    return FarmError(f"文件桥 HTTP {exc.code}。")


def bridge_open(
    instance_id: str,
    record: dict[str, Any],
    scope: str,
    method: str,
    route: str,
    *,
    params: dict[str, Any] | None = None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 120,
) -> Any:
    bridge = get_bridge_record(record)
    ensure_local_bridge_forward(bridge)
    token = lookup_bridge_secret(instance_id, scope)
    if not token:
        raise FarmError(f"系统密钥环中没有该实例的文件桥 {scope} 凭据。")
    request_headers = {"X-OpenClaw-Token": token, "Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        bridge_url(bridge, route, params),
        data=data,
        method=method,
        headers=request_headers,
    )
    try:
        # A detached SSH forward can exit between the listener check above and
        # the HTTP request. Recreate it once for reads, but never replay writes:
        # the remote side might have committed them before the connection broke.
        retry_read = bridge.get("transport") == "ssh_relay" and method.upper() in {"GET", "HEAD"} and data is None
        for attempt in range(2 if retry_read else 1):
            try:
                return HTTP_OPENER.open(request, timeout=timeout)
            except urllib.error.HTTPError as exc:
                raise parse_bridge_http_error(exc, token) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt == 0 and retry_read and not port_open("127.0.0.1", int(bridge["local_port"])):
                    ensure_local_bridge_forward(bridge)
                    continue
                raise FarmError(f"文件桥连接失败：{type(exc).__name__}") from exc
    finally:
        token = ""


def bridge_json(
    instance_id: str,
    record: dict[str, Any],
    scope: str,
    method: str,
    route: str,
    *,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 120,
) -> dict[str, Any]:
    data = None
    headers: dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
        headers["Content-Length"] = str(len(data))
    with bridge_open(
        instance_id,
        record,
        scope,
        method,
        route,
        params=params,
        data=data,
        headers=headers,
        timeout=timeout,
    ) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise FarmError("文件桥 JSON 响应超过 4 MiB。")
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FarmError("文件桥返回了无效 JSON。") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise FarmError("文件桥返回了失败结果。")
    return result


def bridge_health(instance_id: str, record: dict[str, Any]) -> dict[str, Any]:
    return bridge_json(instance_id, record, "read", "GET", "/v1/capabilities", timeout=10)


def bridge_list(instance_id: str, record: dict[str, Any], path: str = ".") -> dict[str, Any]:
    return bridge_json(instance_id, record, "read", "GET", "/v1/list", params={"path": path})


def bridge_stat(instance_id: str, record: dict[str, Any], path: str) -> dict[str, Any]:
    return bridge_json(instance_id, record, "read", "GET", "/v1/stat", params={"path": path})


def bridge_read(instance_id: str, record: dict[str, Any], path: str, max_bytes: int = 1024 * 1024) -> str:
    result = bridge_json(
        instance_id,
        record,
        "read",
        "GET",
        "/v1/read",
        params={"path": path, "max_bytes": max_bytes},
    )
    content = result.get("content")
    if not isinstance(content, str):
        raise FarmError("文件桥文本响应缺少 content。")
    return content


def bridge_write(
    instance_id: str,
    record: dict[str, Any],
    path: str,
    content: str,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    return bridge_json(
        instance_id,
        record,
        "write",
        "POST",
        "/v1/write",
        payload={"path": path, "content": content, "expected_sha256": expected_sha256},
    )


def bridge_mutation(
    instance_id: str,
    record: dict[str, Any],
    route: str,
    payload: dict[str, Any],
    *,
    delete: bool = False,
) -> dict[str, Any]:
    return bridge_json(instance_id, record, "delete" if delete else "write", "POST", route, payload=payload)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def local_absolute_path(value: str) -> Path:
    """Return an absolute local path without following its final component."""
    expanded = Path(value).expanduser()
    if expanded.is_symlink():
        raise FarmError("拒绝使用符号链接形式的本地路径。")
    absolute = Path(os.path.abspath(os.fspath(expanded)))
    if absolute.is_symlink():
        raise FarmError("拒绝使用符号链接形式的本地路径。")
    return absolute


def open_download_part(path: Path, *, append: bool, expected_size: int):
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    flags |= os.O_APPEND if append else os.O_TRUNC
    descriptor = os.open(path, flags, 0o600)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
            raise FarmError("下载暂存目标必须是单一链接的普通文件。")
        if details.st_size != expected_size:
            raise FarmError("下载暂存文件在续传开始前发生变化。")
        return os.fdopen(descriptor, "ab" if append else "wb")
    except Exception:
        os.close(descriptor)
        raise


def upload_state_dir() -> Path:
    path = adapter_state_dir() / "uploads"
    ensure_private_directory(path)
    return path


def upload_state_path(instance_id: str, local: Path, remote_path: str, size: int, digest: str) -> Path:
    key = hashlib.sha256(
        f"{instance_id}\0{local}\0{remote_path}\0{size}\0{digest}".encode("utf-8")
    ).hexdigest()
    return upload_state_dir() / f"{key}.json"


def save_private_json(path: Path, payload: dict[str, Any]) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        storage.private_fchmod(fd, temporary)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def bridge_upload(
    instance_id: str,
    record: dict[str, Any],
    local_path: str,
    remote_path: str,
    *,
    expected_remote_sha256: str | None = None,
    overwrite: bool = False,
    chunk_size: int = 8 * 1024 * 1024,
    resume: bool = True,
) -> dict[str, Any]:
    local = local_absolute_path(local_path)
    if not local.is_file():
        raise FarmError(f"本地文件不存在或不是普通文件：{local}")
    if chunk_size < 64 * 1024 or chunk_size > 16 * 1024 * 1024:
        raise FarmError("上传分块必须介于 64 KiB 与 16 MiB 之间。")
    size = local.stat().st_size
    digest = file_sha256(local)
    expected = expected_remote_sha256
    if expected and not SHA256.fullmatch(expected):
        raise FarmError("expected_remote_sha256 格式不合法。")
    try:
        remote = bridge_stat(instance_id, record, remote_path).get("stat", {})
    except FarmError as exc:
        if "404" not in str(exc):
            raise
        remote = None
    if isinstance(remote, dict):
        current_hash = remote.get("sha256")
        if not overwrite and not expected:
            raise FarmError("远端目标已存在；覆盖前必须明确 --overwrite 或提供预期 SHA-256。")
        expected = expected or (current_hash if isinstance(current_hash, str) else None)

    state_path = upload_state_path(instance_id, local, remote_path, size, digest)
    upload_id: str | None = None
    offset = 0
    if resume and state_path.is_file() and not state_path.is_symlink():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            candidate = state.get("upload_id")
            if isinstance(candidate, str):
                status = bridge_json(instance_id, record, "read", "GET", f"/v1/uploads/{candidate}")
                upload_id = candidate
                offset = int(status.get("offset", 0))
        except Exception:
            upload_id = None
            offset = 0
    if upload_id is None:
        started = bridge_json(
            instance_id,
            record,
            "write",
            "POST",
            "/v1/uploads",
            payload={
                "path": remote_path,
                "total_size": size,
                "sha256": digest,
                "expected_sha256": expected,
            },
        )
        upload_id = str(started["upload_id"])
        offset = int(started.get("offset", 0))
        save_private_json(
            state_path,
            {
                "instance": instance_id,
                "local_path": str(local),
                "remote_path": remote_path,
                "size": size,
                "sha256": digest,
                "upload_id": upload_id,
            },
        )

    with local.open("rb") as handle:
        handle.seek(offset)
        while offset < size:
            chunk = handle.read(min(chunk_size, size - offset))
            if not chunk:
                raise FarmError("本地文件在上传期间意外结束。")
            with bridge_open(
                instance_id,
                record,
                "write",
                "PUT",
                f"/v1/uploads/{upload_id}",
                data=chunk,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(len(chunk)),
                    "X-Upload-Offset": str(offset),
                },
                timeout=300,
            ) as response:
                result = json.loads(response.read(1024 * 1024).decode("utf-8"))
            new_offset = int(result.get("offset", -1))
            if new_offset != offset + len(chunk):
                raise FarmError("文件桥返回的上传偏移不一致。")
            offset = new_offset
    committed = bridge_json(
        instance_id,
        record,
        "write",
        "POST",
        f"/v1/uploads/{upload_id}/commit",
        payload={"sha256": digest},
        timeout=600,
    )
    state_path.unlink(missing_ok=True)
    return {
        "ok": True,
        "local": str(local),
        "remote": remote_path,
        "size": size,
        "sha256": digest,
        "uploaded": offset,
        "backup": committed.get("backup"),
    }


def bridge_download(
    instance_id: str,
    record: dict[str, Any],
    remote_path: str,
    local_path: str,
    *,
    overwrite: bool = False,
    resume: bool = True,
) -> dict[str, Any]:
    remote = bridge_stat(instance_id, record, remote_path).get("stat")
    if not isinstance(remote, dict) or remote.get("type") != "file":
        raise FarmError("远端路径不是普通文件。")
    size = int(remote["size"])
    digest = str(remote["sha256"])
    local = local_absolute_path(local_path)
    local.parent.mkdir(parents=True, exist_ok=True)
    backup: str | None = None
    if local.is_symlink():
        raise FarmError("拒绝使用符号链接形式的本地目标。")
    if local.exists() and not local.is_file():
        raise FarmError("本地目标已存在且不是普通文件。")
    if local.exists() and not overwrite:
        raise FarmError("本地目标已存在；如需覆盖请明确使用 --overwrite。")
    part = local.with_name(local.name + ".openclaw.part")
    if part.is_symlink():
        raise FarmError("拒绝使用符号链接形式的下载暂存文件。")
    if part.exists() and (not part.is_file() or part.stat().st_nlink != 1):
        raise FarmError("下载暂存目标必须是单一链接的普通文件。")
    offset = part.stat().st_size if resume and part.is_file() and not part.is_symlink() else 0
    if offset > size:
        part.unlink(missing_ok=True)
        offset = 0
    if size == 0 and not part.exists():
        with open_download_part(part, append=False, expected_size=0):
            pass
    if offset < size:
        headers = {"Range": f"bytes={offset}-"} if offset else None
        with bridge_open(
            instance_id,
            record,
            "read",
            "GET",
            "/v1/download",
            params={"path": remote_path},
            headers=headers,
            timeout=600,
        ) as response, open_download_part(part, append=bool(offset), expected_size=offset) as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
    if part.is_symlink() or not part.is_file() or part.stat().st_nlink != 1:
        raise FarmError("下载暂存目标不再是安全的普通文件。")
    if part.stat().st_size != size:
        raise FarmError("下载后的文件大小与远端不一致，已保留 .part 以便续传。")
    actual = file_sha256(part)
    if not hmac.compare_digest(actual, digest):
        raise FarmError("下载后的 SHA-256 与远端不一致，已保留 .part。")
    if local.is_symlink() or (local.exists() and not local.is_file()):
        raise FarmError("本地目标在下载期间变成了不安全的路径。")
    if local.exists():
        backup_path = local.with_name(local.name + f".bak.{timestamp()}")
        os.replace(local, backup_path)
        backup = str(backup_path)
    os.replace(part, local)
    return {
        "ok": True,
        "remote": remote_path,
        "local": str(local),
        "size": size,
        "sha256": digest,
        "backup": backup,
    }


def command_register(args: argparse.Namespace) -> int:
    instance_id = validate_instance_id(args.instance_id)
    path = Path(args.registry).expanduser()
    registry = load_registry(path)
    existing = registry["instances"].get(instance_id)
    if isinstance(existing, dict) and existing.get("console_archived_at"):
        raise FarmError("该实例已从管理列表移出，不能由旧窗口自动重新登记。")
    raw_url = args.url or (existing.get("gateway_url") if isinstance(existing, dict) else None)
    if not raw_url:
        raise FarmError("首次注册必须提供实例 URL。")

    if args.metadata_only:
        record = build_record(instance_id, raw_url, "pending_credential")
        registry["instances"][instance_id] = record
        backup = write_registry(path, registry)
        print(json.dumps({"instance": safe_record(record, False), "backup": str(backup)}, ensure_ascii=False, indent=2))
        return 0

    current_secret = lookup_secret(instance_id)
    if current_secret and not args.replace:
        raise FarmError("该实例已有受保护凭据；如需轮换，请明确使用 --replace。")

    source = "gui" if args.gui else "stdin" if args.token_stdin else "tty"
    token = read_token(source, instance_id)
    record = build_record(instance_id, raw_url, "credential_stored")
    if isinstance(existing, dict) and existing.get("gateway_url") == record["gateway_url"]:
        record = {**existing, **record}
    store_secret(instance_id, token)

    health_verified = False
    health_error: str | None = None
    if not args.skip_health:
        completed = gateway_call(record, "health", {}, args.timeout, token)
        health_verified = completed.returncode == 0
        if not health_verified:
            combined = (completed.stderr or completed.stdout).strip()
            health_error = redact(combined, token).splitlines()[0][:240] if combined else "health check failed"
        if health_verified:
            record["status"] = "active"
        elif health_error and "pairing required" in health_error.lower():
            record["status"] = "pairing_required"
        else:
            record["status"] = "registered_unverified"

    registry["instances"][instance_id] = record
    backup = write_registry(path, registry)
    result: dict[str, Any] = {
        "instance": safe_record(record, True),
        "health_verified": health_verified,
        "backup": str(backup),
    }
    if health_error:
        result["health_error"] = health_error
    print(json.dumps(result, ensure_ascii=False, indent=2))
    token = ""
    return 0 if health_verified or args.skip_health else 4


def command_list(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    rows = []
    for instance_id, record in sorted(registry["instances"].items()):
        if isinstance(record, dict) and not record.get("console_archived_at"):
            rows.append(safe_record(record, lookup_secret(instance_id) is not None))
    print(json.dumps({"count": len(rows), "instances": rows}, ensure_ascii=False, indent=2))
    return 0


def command_status(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(json.dumps(safe_record(record, lookup_secret(args.instance_id) is not None), ensure_ascii=False, indent=2))
    return 0


def command_call(args: argparse.Namespace) -> int:
    if args.method not in READ_ONLY_METHODS and not args.allow_write:
        raise FarmError("该方法不在只读白名单内；获批远端变更后才可使用 --allow-write。")
    try:
        params = json.loads(args.params_json)
    except json.JSONDecodeError as exc:
        raise FarmError("--params-json 不是合法 JSON。") from exc
    if not isinstance(params, dict):
        raise FarmError("--params-json 顶层必须是对象。")
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    token = lookup_secret(args.instance_id)
    if not token:
        raise FarmError("系统密钥环中没有该实例的凭据。")
    completed = gateway_call(record, args.method, params, args.timeout, token)
    output = completed.stdout if completed.returncode == 0 else completed.stderr or completed.stdout
    print(redact(output.rstrip(), token))
    token = ""
    return completed.returncode


def gateway_failure_info(completed: subprocess.CompletedProcess, token: str) -> dict[str, Any]:
    text = redact((completed.stderr or completed.stdout or "").strip(), token)
    result: dict[str, Any] = {"health_error": text.splitlines()[0][:240] if text else "Gateway health check failed"}
    for line in reversed(text.splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if not isinstance(data, dict) or data.get("code") != "PAIRING_REQUIRED":
            continue
        result["health_error"] = "pairing required"
        result["error_code"] = "PAIRING_REQUIRED"
        for key, pattern in [("requestId", r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"), ("deviceId", r"[0-9a-fA-F]{64}")]:
            if isinstance(data.get(key), str) and re.fullmatch(pattern, data[key]):
                result[key] = data[key]
        break
    return result


def command_verify(args: argparse.Namespace) -> int:
    path = Path(args.registry).expanduser()
    registry = load_registry(path)
    record = get_record(registry, args.instance_id)
    no_save = getattr(args, "no_save", False)
    if no_save:
        record = dict(record)
    token = lookup_secret(args.instance_id)
    if not token:
        raise FarmError("系统密钥环中没有该实例的凭据。")
    completed = gateway_call(record, "health", {}, args.timeout, token)
    combined = completed.stderr or completed.stdout
    health_verified = completed.returncode == 0
    record["control_adapter"] = "openclaw-sdk-least-privilege"
    if health_verified:
        record["status"] = "active"
    elif "pairing required" in combined.lower():
        record["status"] = "pairing_required"
    else:
        record["status"] = "registered_unverified"
    backup = "" if no_save else str(write_registry(path, registry))
    result: dict[str, Any] = {
        "instance": safe_record(record, True),
        "health_verified": health_verified,
        "backup": backup,
    }
    if not health_verified:
        result.update(gateway_failure_info(completed, token))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    token = ""
    return completed.returncode


def command_chat_url(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    web_url = record.get("web_url")
    if not isinstance(web_url, str):
        raise FarmError("注册表缺少 web_url。")
    print(web_url)
    return 0


def command_bridge_configure(args: argparse.Namespace) -> int:
    path = Path(args.registry).expanduser()
    registry = load_registry(path)
    record = get_record(registry, args.instance_id)
    bridge = bridge_config_from_args(args)
    record["file_bridge"] = bridge
    registry["schema_version"] = max(int(registry.get("schema_version", 1)), 2)
    backup = write_registry(path, registry)
    print(
        json.dumps(
            {
                "instance": args.instance_id,
                "file_bridge": safe_bridge_record(bridge),
                "backup": str(backup),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_bridge_secret(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    # Credentials must be durable before remote installation creates bridge metadata.
    existing = lookup_keyring_secret(args.instance_id, BRIDGE_SECRET_SERVICE, args.scope)
    if existing and not args.replace:
        raise FarmError("该文件桥范围已有受保护凭据；轮换时请明确使用 --replace。")
    source = "gui" if args.gui else "stdin" if args.token_stdin else "tty"
    token = read_token(source, args.instance_id)
    store_keyring_secret(args.instance_id, token, BRIDGE_SECRET_SERVICE, args.scope)
    token = ""
    print(
        json.dumps(
            {"instance": args.instance_id, "scope": args.scope, "credential_present": True},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_bridge_status(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    bridge = get_bridge_record(record)
    credentials = {
        scope: lookup_keyring_secret(args.instance_id, BRIDGE_SECRET_SERVICE, scope) is not None
        for scope in ("read", "write", "delete", "all")
    }
    print(
        json.dumps(
            {
                "instance": args.instance_id,
                "file_bridge": safe_bridge_record(bridge),
                "credentials": credentials,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_bridge_health(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(json.dumps(bridge_health(args.instance_id, record), ensure_ascii=False, indent=2))
    return 0


def command_bridge_reconnect(args: argparse.Namespace) -> int:
    if not args.approved_reconnect:
        raise FarmError('本地转发重建需要 --approved-reconnect。')
    from bridge_forward_recovery import recover_forward
    registry = load_registry(Path(args.registry).expanduser())
    result = recover_forward(args.instance_id, registry, sys.modules[__name__])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def require_write_approval(args: argparse.Namespace, *, delete: bool = False) -> None:
    if delete:
        if not getattr(args, "approved_delete", False):
            raise FarmError("删除操作需要在用户确认后显式传入 --approved-delete。")
    elif not getattr(args, "approved_write", False):
        raise FarmError("写操作需要在用户确认后显式传入 --approved-write。")


def command_file_list(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(json.dumps(bridge_list(args.instance_id, record, args.path), ensure_ascii=False, indent=2))
    return 0


def command_file_stat(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(json.dumps(bridge_stat(args.instance_id, record, args.path), ensure_ascii=False, indent=2))
    return 0


def command_file_read(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(bridge_read(args.instance_id, record, args.path, args.max_bytes))
    return 0


def command_file_write(args: argparse.Namespace) -> int:
    require_write_approval(args)
    if args.content_stdin:
        content = sys.stdin.read()
    elif args.content_file:
        source = Path(args.content_file).expanduser()
        if not source.is_file() or source.is_symlink():
            raise FarmError("--content-file 必须指向本地普通文件。")
        content = source.read_text(encoding="utf-8")
    else:
        raise FarmError("请使用 --content-stdin 或 --content-file 提供正文。")
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(
        json.dumps(
            bridge_write(args.instance_id, record, args.path, content, args.expected_sha256),
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_file_upload(args: argparse.Namespace) -> int:
    require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_upload(
        args.instance_id,
        record,
        args.local_path,
        args.remote_path,
        expected_remote_sha256=args.expected_remote_sha256,
        overwrite=args.overwrite,
        chunk_size=args.chunk_size,
        resume=not args.no_resume,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_file_download(args: argparse.Namespace) -> int:
    if args.overwrite:
        require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_download(
        args.instance_id,
        record,
        args.remote_path,
        args.local_path,
        overwrite=args.overwrite,
        resume=not args.no_resume,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_file_move(args: argparse.Namespace) -> int:
    require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_mutation(args.instance_id, record, "/v1/move", {"src": args.src, "dst": args.dst})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_file_copy(args: argparse.Namespace) -> int:
    require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_mutation(args.instance_id, record, "/v1/copy", {"src": args.src, "dst": args.dst})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_file_delete(args: argparse.Namespace) -> int:
    require_write_approval(args, delete=True)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_mutation(
        args.instance_id,
        record,
        "/v1/delete",
        {
            "path": args.path,
            "recursive": args.recursive,
            "confirm": args.path,
            "expected_sha256": args.expected_sha256,
        },
        delete=True,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_file_mkdir(args: argparse.Namespace) -> int:
    require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = bridge_mutation(
        args.instance_id,
        record,
        "/v1/mkdir",
        {"path": args.path, "parents": args.parents},
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_run_bash(args: argparse.Namespace) -> int:
    require_write_approval(args)
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    result = remote_exec(args.instance_id, record, args.command, args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_read_remote_file(args: argparse.Namespace) -> int:
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    print(remote_read_file(args.instance_id, record, args.path))
    return 0


def command_pairing_approve_via_responses(args: argparse.Namespace) -> int:
    """Ask the instance's own main agent to approve one exact Mac pairing request.

    The Gateway credential never leaves this process.  The caller must still
    verify Gateway health afterwards; an HTTP response is only an acknowledgement.
    """
    request_id = str(args.request_id).lower()
    device_id = str(args.device_id).lower()
    if not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", request_id):
        raise FarmError("配对申请编号格式不合法。")
    if not re.fullmatch(r"[0-9a-f]{64}", device_id):
        raise FarmError("Mac 设备编号格式不合法。")
    registry = load_registry(Path(args.registry).expanduser())
    record = get_record(registry, args.instance_id)
    token = lookup_secret(args.instance_id)
    if not token:
        raise FarmError("系统密钥环中没有该实例的控制凭据。")
    web_url = record.get("web_url")
    if not isinstance(web_url, str):
        raise FarmError("注册表缺少 web_url。")
    parsed = urlsplit(web_url)
    base_path = parsed.path.rsplit("/chat", 1)[0]
    endpoint = urlunsplit((parsed.scheme, parsed.netloc, base_path + "/v1/responses", "", ""))
    prompt = (
        "这是本机管理台的一键连接任务。请查询当前 Gateway 的设备配对待处理列表；"
        f"仅当申请编号 {request_id} 的 deviceId 与 {device_id} 完全一致时，"
        "使用正式设备批准接口批准该申请原有权限范围。不得批准其他申请，不得扩大权限。"
        "批准后再次查询，并只返回 APPROVED、NOT_FOUND 或 IDENTITY_MISMATCH。"
    )
    body = json.dumps({"model": "openclaw:main", "input": prompt, "stream": False,
                       "user": "openclaw-farm-console-pairing"}, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
        "Accept": "application/json",
        "x-openclaw-session-key": "agent:main:openclaw-farm-pairing:" + request_id,
    })
    try:
        with HTTP_OPENER.open(request, timeout=args.timeout) as response:
            response.read(2 * 1024 * 1024 + 1)
            status = response.status
    except urllib.error.HTTPError as exc:
        raise FarmError(f"自动配对入口返回 HTTP {exc.code}。") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FarmError(f"自动配对入口暂不可达：{type(exc).__name__}") from exc
    finally:
        token = ""
    print(json.dumps({"accepted": 200 <= status < 300, "request_id": request_id}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=str(default_registry_path()), help="受保护实例注册表路径")
    subparsers = parser.add_subparsers(dest="command", required=True)

    register = subparsers.add_parser("register", help="登记实例并安全导入凭据")
    register.add_argument("--instance-id", required=True)
    register.add_argument("--url", help="网页或 WSS 地址；查询串和片段不会入库")
    source = register.add_mutually_exclusive_group()
    source.add_argument("--gui", action="store_true", help="使用桌面隐藏输入框")
    source.add_argument("--token-stdin", action="store_true", help="从受保护的标准输入读取；不得使用普通日志管道")
    register.add_argument("--metadata-only", action="store_true", help="只登记元数据，凭据状态标为待导入")
    register.add_argument("--replace", action="store_true", help="明确轮换已有密钥环凭据")
    register.add_argument("--skip-health", action="store_true")
    register.add_argument("--timeout", type=int, default=10_000, metavar="MS", help="Gateway 超时，单位毫秒")
    register.set_defaults(handler=command_register)

    listing = subparsers.add_parser("list", help="列出脱敏后的实例")
    listing.set_defaults(handler=command_list)

    status_parser = subparsers.add_parser("status", help="查看一个实例和凭据存在状态")
    status_parser.add_argument("instance_id")
    status_parser.set_defaults(handler=command_status)

    call = subparsers.add_parser("call", help="调用官方 OpenClaw Gateway RPC")
    call.add_argument("instance_id")
    call.add_argument("method")
    call.add_argument("--params-json", default="{}")
    call.add_argument("--timeout", type=int, default=10_000, metavar="MS", help="Gateway 超时，单位毫秒")
    call.add_argument("--allow-write", action="store_true")
    call.set_defaults(handler=command_call)

    verify = subparsers.add_parser("verify", help="用已保存凭据验证健康状态并更新本地状态")
    verify.add_argument("instance_id")
    verify.add_argument("--timeout", type=int, default=10_000, metavar="MS", help="Gateway 超时，单位毫秒")
    verify.add_argument("--no-save", action="store_true", help="只返回健康检查结果，不写入注册表或创建备份")
    verify.set_defaults(handler=command_verify)

    chat_url = subparsers.add_parser("chat-url", help="输出不含凭据的网页地址")
    chat_url.add_argument("instance_id")
    chat_url.set_defaults(handler=command_chat_url)

    bridge_configure = subparsers.add_parser("bridge-configure", help="登记文件桥传输和端口映射")
    bridge_configure.add_argument("instance_id")
    bridge_configure.add_argument("--transport", choices=sorted(BRIDGE_TRANSPORTS), required=True)
    bridge_configure.add_argument("--base-url")
    bridge_configure.add_argument("--workspace", default="/home/node/.openclaw/workspace")
    bridge_configure.add_argument("--local-port", type=int)
    bridge_configure.add_argument("--pod-port", type=int, default=18081)
    bridge_configure.add_argument("--relay-host")
    bridge_configure.add_argument("--relay-user", default="ubuntu")
    bridge_configure.add_argument("--relay-ssh-port", type=int, default=22)
    bridge_configure.add_argument("--relay-port", type=int)
    bridge_configure.add_argument("--relay-key")
    bridge_configure.set_defaults(handler=command_bridge_configure)

    bridge_secret = subparsers.add_parser("bridge-secret", help="通过隐藏输入导入文件桥范围凭据")
    bridge_secret.add_argument("instance_id")
    bridge_secret.add_argument("--scope", choices=("read", "write", "delete", "all"), default="all")
    secret_source = bridge_secret.add_mutually_exclusive_group()
    secret_source.add_argument("--gui", action="store_true")
    secret_source.add_argument("--token-stdin", action="store_true")
    bridge_secret.add_argument("--replace", action="store_true")
    bridge_secret.set_defaults(handler=command_bridge_secret)

    bridge_status = subparsers.add_parser("bridge-status", help="查看脱敏后的文件桥配置和凭据状态")
    bridge_status.add_argument("instance_id")
    bridge_status.set_defaults(handler=command_bridge_status)

    bridge_health_parser = subparsers.add_parser("bridge-health", help="检查文件桥能力与限制")
    bridge_health_parser.add_argument("instance_id")
    bridge_health_parser.set_defaults(handler=command_bridge_health)

    bridge_reconnect = subparsers.add_parser('bridge-reconnect', help='重建当前实例独占的本地转发并检查文件桥')
    bridge_reconnect.add_argument('instance_id')
    bridge_reconnect.add_argument('--approved-reconnect', action='store_true')
    bridge_reconnect.set_defaults(handler=command_bridge_reconnect)

    file_list = subparsers.add_parser("file-list", help="列出远端工作区目录")
    file_list.add_argument("instance_id")
    file_list.add_argument("path", nargs="?", default=".")
    file_list.set_defaults(handler=command_file_list)

    file_stat = subparsers.add_parser("file-stat", help="读取远端文件或目录元数据")
    file_stat.add_argument("instance_id")
    file_stat.add_argument("path")
    file_stat.set_defaults(handler=command_file_stat)

    file_read = subparsers.add_parser("file-read", help="读取远端小型文本文件")
    file_read.add_argument("instance_id")
    file_read.add_argument("path")
    file_read.add_argument("--max-bytes", type=int, default=1024 * 1024)
    file_read.set_defaults(handler=command_file_read)

    file_write = subparsers.add_parser("file-write", help="写入远端文本文件")
    file_write.add_argument("instance_id")
    file_write.add_argument("path")
    content_source = file_write.add_mutually_exclusive_group(required=True)
    content_source.add_argument("--content-stdin", action="store_true")
    content_source.add_argument("--content-file")
    file_write.add_argument("--expected-sha256")
    file_write.add_argument("--approved-write", action="store_true")
    file_write.set_defaults(handler=command_file_write)

    file_upload = subparsers.add_parser("file-upload", help="可续传地上传本地文件")
    file_upload.add_argument("instance_id")
    file_upload.add_argument("local_path")
    file_upload.add_argument("remote_path")
    file_upload.add_argument("--expected-remote-sha256")
    file_upload.add_argument("--overwrite", action="store_true")
    file_upload.add_argument("--chunk-size", type=int, default=8 * 1024 * 1024)
    file_upload.add_argument("--no-resume", action="store_true")
    file_upload.add_argument("--approved-write", action="store_true")
    file_upload.set_defaults(handler=command_file_upload)

    file_download = subparsers.add_parser("file-download", help="可续传地下载远端文件")
    file_download.add_argument("instance_id")
    file_download.add_argument("remote_path")
    file_download.add_argument("local_path")
    file_download.add_argument("--overwrite", action="store_true")
    file_download.add_argument("--no-resume", action="store_true")
    file_download.add_argument("--approved-write", action="store_true")
    file_download.set_defaults(handler=command_file_download)

    file_move = subparsers.add_parser("file-move", help="移动或重命名远端文件/目录")
    file_move.add_argument("instance_id")
    file_move.add_argument("src")
    file_move.add_argument("dst")
    file_move.add_argument("--approved-write", action="store_true")
    file_move.set_defaults(handler=command_file_move)

    file_copy = subparsers.add_parser("file-copy", help="复制远端文件/目录")
    file_copy.add_argument("instance_id")
    file_copy.add_argument("src")
    file_copy.add_argument("dst")
    file_copy.add_argument("--approved-write", action="store_true")
    file_copy.set_defaults(handler=command_file_copy)

    file_delete = subparsers.add_parser("file-delete", help="删除远端文件/目录")
    file_delete.add_argument("instance_id")
    file_delete.add_argument("path")
    file_delete.add_argument("--recursive", action="store_true")
    file_delete.add_argument("--expected-sha256")
    file_delete.add_argument("--approved-delete", action="store_true")
    file_delete.set_defaults(handler=command_file_delete)

    file_mkdir = subparsers.add_parser("file-mkdir", help="创建远端目录")
    file_mkdir.add_argument("instance_id")
    file_mkdir.add_argument("path")
    file_mkdir.add_argument("--parents", action=argparse.BooleanOptionalAction, default=True)
    file_mkdir.add_argument("--approved-write", action="store_true")
    file_mkdir.set_defaults(handler=command_file_mkdir)

    run_bash = subparsers.add_parser("run-bash", help="通过 Gateway 结构化工具执行远端命令")
    run_bash.add_argument("instance_id")
    run_bash.add_argument("command")
    run_bash.add_argument("--timeout", type=float, default=120, metavar="SECONDS", help="HTTP 工具调用超时，单位秒")
    run_bash.add_argument("--approved-write", action="store_true")
    run_bash.set_defaults(handler=command_run_bash)

    read_remote = subparsers.add_parser("read-remote-file", help="优先通过文件桥读取远端文件")
    read_remote.add_argument("instance_id")
    read_remote.add_argument("path")
    read_remote.set_defaults(handler=command_read_remote_file)

    pairing_approve = subparsers.add_parser("pairing-approve-via-responses", help="通过实例主 agent 批准一个已核验的 Mac 配对申请")
    pairing_approve.add_argument("instance_id")
    pairing_approve.add_argument("request_id")
    pairing_approve.add_argument("device_id")
    pairing_approve.add_argument("--timeout", type=float, default=45, metavar="SECONDS")
    pairing_approve.set_defaults(handler=command_pairing_approve_via_responses)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except FarmError as exc:
        print(f"openclaw-farm: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
