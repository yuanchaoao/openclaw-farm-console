#!/usr/bin/env python3
"""Send a local UTF-8 prompt file through an OpenClaw Gateway chat session."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

import openclaw_farm as farm


PAIRING_REQUEST = re.compile(
    r"(?:scope upgrade pending approval|pairing required).*?requestId:\s*([0-9a-fA-F-]{36})",
    re.IGNORECASE | re.DOTALL,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("instance_id")
    parser.add_argument("message_file")
    parser.add_argument("--session-key")
    parser.add_argument("--registry", default=str(farm.default_registry_path()))
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--deliver", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--approved-write", action="store_true")
    return parser


def load_message(path_value: str) -> tuple[Path, str, str]:
    path = Path(path_value).expanduser().resolve(strict=True)
    if not path.is_file() or path.is_symlink():
        raise SystemExit("message file must be a non-symlink regular file")
    size = path.stat().st_size
    if size > 1536 * 1024:
        raise SystemExit("message file exceeds the 1.5 MiB Gateway safety limit")
    try:
        message = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit("message file must be UTF-8 text") from exc
    if not message.strip():
        raise SystemExit("message file is empty")
    digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
    return path, message, digest


def gateway_result(
    record: dict[str, Any], token: str, method: str, params: dict[str, Any], timeout_ms: int
) -> tuple[int, str]:
    completed = farm.gateway_call(record, method, params, timeout_ms, token)
    output = completed.stdout if completed.returncode == 0 else completed.stderr or completed.stdout
    return completed.returncode, farm.redact(output.strip(), token)


def resolve_session_key(
    record: dict[str, Any], token: str, requested: str | None, timeout_ms: int
) -> str:
    if requested:
        return requested
    code, output = gateway_result(
        record,
        token,
        "sessions.list",
        {
            "limit": 20,
            "includeGlobal": True,
            "includeUnknown": True,
            "includeDerivedTitles": True,
            "includeLastMessage": False,
        },
        timeout_ms,
    )
    if code != 0:
        raise SystemExit(f"unable to list Gateway sessions: {output.splitlines()[0] if output else 'unknown error'}")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise SystemExit("Gateway sessions.list returned invalid JSON") from exc
    sessions = payload.get("sessions") if isinstance(payload, dict) else None
    if not isinstance(sessions, list) or not sessions:
        raise SystemExit("Gateway has no visible chat session")
    keys = [row.get("key") for row in sessions if isinstance(row, dict) and isinstance(row.get("key"), str)]
    if len(keys) != 1:
        print(json.dumps({"status": "session_selection_required", "session_keys": keys}, ensure_ascii=False))
        raise SystemExit(3)
    return keys[0]


def main() -> int:
    args = build_parser().parse_args()
    if args.timeout_ms < 1_000 or args.timeout_ms > 600_000:
        raise SystemExit("--timeout-ms must be between 1000 and 600000")
    path, message, digest = load_message(args.message_file)
    registry = farm.load_registry(Path(args.registry).expanduser())
    record = farm.get_record(registry, args.instance_id)
    token = farm.lookup_secret(args.instance_id)
    if not token:
        raise SystemExit("system keyring has no control credential for this instance")
    session_key = resolve_session_key(record, token, args.session_key, args.timeout_ms)
    summary = {
        "instance": args.instance_id,
        "session_key": session_key,
        "message_file": str(path),
        "message_bytes": len(message.encode("utf-8")),
        "message_sha256": digest,
    }
    if args.dry_run:
        print(json.dumps({"status": "ready", **summary}, ensure_ascii=False))
        return 0
    if not args.approved_write:
        raise SystemExit("chat.send requires --approved-write")
    idempotency_key = f"openclaw-file-{digest[:40]}"
    code, output = gateway_result(
        record,
        token,
        "chat.send",
        {
            "sessionKey": session_key,
            "message": message,
            "deliver": bool(args.deliver),
            "timeoutMs": args.timeout_ms,
            "idempotencyKey": idempotency_key,
        },
        args.timeout_ms,
    )
    token = ""
    message = ""
    if code != 0:
        match = PAIRING_REQUEST.search(output)
        if match:
            print(
                json.dumps(
                    {
                        "status": "scope_upgrade_required",
                        "request_id": match.group(1),
                        "requested_scope": "operator.write",
                        "next": "approve this exact request, then rerun the identical command",
                        **summary,
                    },
                    ensure_ascii=False,
                )
            )
            return 4
        first_line = output.splitlines()[0] if output else "unknown Gateway error"
        print(json.dumps({"status": "error", "error": first_line, **summary}, ensure_ascii=False))
        return code or 1
    try:
        response = json.loads(output)
    except json.JSONDecodeError:
        response = {"raw_ack": output[:500]}
    print(json.dumps({"status": "sent", "ack": response, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
