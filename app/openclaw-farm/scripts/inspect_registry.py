#!/usr/bin/env python3
"""Read an OpenClaw Farm registry without emitting credential values."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
import private_storage as storage


SENSITIVE = re.compile(
    r"(?:token|secret|password|passwd|credential|private|cookie|auth|api.?key|access.?key|session)",
    re.IGNORECASE,
)
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
SECRET_VALUE = re.compile(r"^(?:sk-|gh[pousr]_|Bearer[ :]|\w+://[^/]*@)", re.IGNORECASE)
SAFE_TEXT_KEYS = {
    "id",
    "instance_id",
    "instanceid",
    "name",
    "label",
    "status",
    "state",
}
SAFE_BOOL_KEYS = {"active", "enabled", "default", "is_default", "suspended"}
HOST_KEYS = {"host", "hostname", "relay", "relay_host", "oracle_host"}
SAFE_URL_KEYS = {"gateway_url", "web_url", "control_url"}
BRIDGE_TEXT_KEYS = {"status", "transport", "workspace", "version", "relay_user", "local_host"}
BRIDGE_HOST_KEYS = {"relay_host"}
BRIDGE_URL_KEYS = {"base_url"}


def registry_candidates(explicit: str | None) -> list[Path]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_file = os.environ.get("OPENCLAW_INSTANCES_FILE")
    if env_file:
        candidates.append(Path(env_file).expanduser())
    farm_home = os.environ.get("OPENCLAW_FARM_HOME")
    if farm_home:
        candidates.append(Path(farm_home).expanduser() / "instances.json")
    candidates.append(storage.user_data_root() / "data" / "instances.json")
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            unique.append(candidate)
            seen.add(key)
    return unique


def safe_identifier(value: Any) -> str | None:
    if isinstance(value, (str, int)):
        text = str(value)
        compact_high_entropy = len(text) >= 24 and re.fullmatch(r"[A-Za-z0-9_+/=-]+", text)
        if IDENTIFIER.fullmatch(text) and not SECRET_VALUE.search(text) and (not compact_high_entropy or UUID.fullmatch(text)):
            return text
    return None


def looks_high_entropy(value: str) -> bool:
    return bool(len(value) >= 24 and re.fullmatch(r"[A-Za-z0-9_+/=-]+", value))


def safe_key_name(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", value):
        return None
    if SENSITIVE.search(value) or SECRET_VALUE.search(value) or looks_high_entropy(value):
        return None
    return value


def safe_adapter_name(value: Any) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9._+-]{0,63}", value):
        return value
    return None


def safe_text(value: Any, limit: int = 128) -> str | None:
    if not isinstance(value, str) or len(value) > limit:
        return None
    if any(ch in value for ch in "\r\n\t"):
        return None
    if SECRET_VALUE.search(value) or looks_high_entropy(value):
        return None
    if not re.fullmatch(r"[\w .:/@()+-]+", value, re.UNICODE):
        return None
    return value


def safe_host(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 255:
        return None
    parsed = urlsplit(value if "://" in value else f"//{value}")
    host = parsed.hostname
    if host and re.fullmatch(r"[A-Za-z0-9._:-]+", host):
        return host
    return None


def safe_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        return None
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    if not re.fullmatch(r"[A-Za-z0-9._:-]+", parsed.hostname):
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", ""))


def safe_port(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 1 <= value <= 65535:
        return value
    if isinstance(value, str) and value.isdigit():
        number = int(value)
        if 1 <= number <= 65535:
            return number
    return None


def sanitize_bridge(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    result: dict[str, Any] = {}
    for key, value in raw.items():
        key_text = str(key)
        key_norm = key_text.lower().replace("-", "_")
        if SENSITIVE.search(key_norm):
            continue
        if key_norm in BRIDGE_TEXT_KEYS:
            sanitized = safe_text(value, limit=4096 if key_norm == "workspace" else 128)
            if sanitized is not None:
                result[key_text] = sanitized
        elif key_norm in BRIDGE_HOST_KEYS:
            host = safe_host(value)
            if host is not None:
                result[key_text] = host
        elif key_norm in BRIDGE_URL_KEYS:
            url = safe_url(value)
            if url is not None:
                result[key_text] = url
        elif "port" in key_norm:
            port = safe_port(value)
            if port is not None:
                result[key_text] = port
    return result or None


def sanitize_entry(raw: Any, registry_key: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if registry_key and safe_identifier(registry_key):
        result["registry_key"] = registry_key
    if not isinstance(raw, dict):
        result["schema"] = type(raw).__name__
        return result

    for key, value in raw.items():
        key_text = str(key)
        key_norm = key_text.lower().replace("-", "_")
        if SENSITIVE.search(key_norm):
            continue
        if key_norm == "control_adapter":
            adapter = safe_adapter_name(value)
            if adapter is not None:
                result[key_text] = adapter
        elif key_norm in SAFE_TEXT_KEYS:
            sanitized = safe_identifier(value) if key_norm in {"id", "instance_id", "instanceid"} else safe_text(value)
            if sanitized is not None:
                result[key_text] = sanitized
        elif key_norm in SAFE_BOOL_KEYS and isinstance(value, bool):
            result[key_text] = value
        elif "port" in key_norm:
            port = safe_port(value)
            if port is not None:
                result[key_text] = port
        elif key_norm in HOST_KEYS:
            host = safe_host(value)
            if host is not None:
                result[key_text] = host
        elif key_norm in SAFE_URL_KEYS:
            url = safe_url(value)
            if url is not None:
                result[key_text] = url
        elif key_norm == "file_bridge":
            bridge = sanitize_bridge(value)
            if bridge is not None:
                result[key_text] = bridge
    if not result:
        result["schema_keys"] = sorted(
            sanitized for key in raw if (sanitized := safe_key_name(str(key))) is not None
        )
    return result


def extract_entries(payload: Any) -> tuple[Any, list[dict[str, Any]], list[str]]:
    top_keys: list[str] = []
    default: Any = None
    raw_entries: Any = payload
    if isinstance(payload, dict):
        top_keys = sorted(
            sanitized for key in payload if (sanitized := safe_key_name(str(key))) is not None
        )
        default = payload.get("default") or payload.get("default_instance") or payload.get("defaultInstance")
        if "instances" in payload:
            raw_entries = payload["instances"]
        else:
            raw_entries = {
                key: value
                for key, value in payload.items()
                if key not in {"default", "default_instance", "defaultInstance"}
            }

    entries: list[dict[str, Any]] = []
    if isinstance(raw_entries, dict):
        for key, value in raw_entries.items():
            if safe_identifier(str(key)) is None:
                continue
            entries.append(sanitize_entry(value, str(key)))
    elif isinstance(raw_entries, list):
        entries = [sanitize_entry(value) for value in raw_entries]
    else:
        entries = [{"schema": type(raw_entries).__name__}]
    return default, entries, top_keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", help="Explicit registry JSON path")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON")
    args = parser.parse_args()

    candidates = registry_candidates(args.registry)
    registry = next((path for path in candidates if path.is_file()), None)
    if registry is None:
        result = {
            "found": False,
            "message": "No OpenClaw Farm instance registry was found.",
            "checked": [str(path) for path in candidates],
        }
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(result["message"])
            for path in candidates:
                print(f"- {path}")
        return 2

    try:
        if registry.stat().st_size > 8 * 1024 * 1024:
            print(f"Registry is larger than the 8 MiB inspection limit: {registry}", file=sys.stderr)
            return 3
        payload = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"Could not parse registry {registry}: {exc}", file=sys.stderr)
        return 3

    default, entries, top_keys = extract_entries(payload)
    result = {
        "found": True,
        "registry": str(registry.resolve()),
        "default": safe_identifier(default) or ("<configured>" if default is not None else None),
        "count": len(entries),
        "top_level_keys": top_keys,
        "instances": entries,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"Registry: {result['registry']}")
        print(f"Instances: {result['count']}")
        if result["default"]:
            print(f"Default: {result['default']}")
        for entry in entries:
            print("- " + json.dumps(entry, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
