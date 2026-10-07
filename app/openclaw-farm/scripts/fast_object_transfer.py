#!/usr/bin/env python3
"""Fast resumable transfer through a protected S3-compatible object store."""

from __future__ import annotations

import argparse
import concurrent.futures
import getpass
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.parse import urlsplit

from keychain_store import KeychainError, keychain_request
import private_storage as storage

OBJECT_STORE_SERVICE = "openclaw-object-store"
PROFILE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")


def validate_profile_name(value: str) -> str:
    if not PROFILE_NAME.fullmatch(value):
        raise SystemExit("invalid object-store profile name")
    return value


def validate_profile_payload(payload: dict[str, Any]) -> dict[str, str]:
    required = ("endpoint", "access_key_id", "secret_access_key", "bucket")
    if any(not isinstance(payload.get(name), str) or not payload[name].strip() for name in required):
        raise SystemExit("object-store profile is incomplete")
    values = {name: str(payload[name]).strip() for name in required}
    parsed = urlsplit(values["endpoint"])
    if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment:
        raise SystemExit("object-store endpoint must be a credential-free HTTPS origin")
    if any(character.isspace() for name in ("access_key_id", "secret_access_key") for character in values[name]):
        raise SystemExit("object-store credentials must not contain whitespace")
    return values



def profile_attributes(profile: str) -> list[str]:
    return ["service", OBJECT_STORE_SERVICE, "profile", validate_profile_name(profile)]


def lookup_profile(profile: str) -> dict[str, str] | None:
    try:
        value = keychain_request("get", profile_attributes(profile))
        return validate_profile_payload(json.loads(value)) if value else None
    except KeychainError as exc:
        raise SystemExit(str(exc)) from None
    except (ValueError, TypeError):
        raise SystemExit("系统凭据存储中的对象存储配置格式无效。") from None


def store_profile(profile: str, payload: dict[str, Any]) -> None:
    values = validate_profile_payload(payload)
    try:
        keychain_request("set", profile_attributes(profile), json.dumps(values, separators=(",", ":")))
    except KeychainError as exc:
        raise SystemExit(str(exc)) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    configure = subparsers.add_parser("configure", help="store a protected object-store profile")
    configure.add_argument("--profile", default="default")
    configure.add_argument("--json-stdin", action="store_true")
    configure.add_argument("--replace", action="store_true")
    configure.add_argument("--approved-write", action="store_true")

    status = subparsers.add_parser("status", help="show a sanitized object-store profile")
    status.add_argument("--profile", default="default")

    upload = subparsers.add_parser("upload", help="resume a multipart upload and make a remote prompt")
    upload.add_argument("--profile", default="default")
    upload.add_argument("--source", required=True)
    upload.add_argument("--expected-sha256")
    upload.add_argument("--bucket")
    upload.add_argument("--key", required=True)
    upload.add_argument("--state")
    upload.add_argument("--workers", type=int, default=20)
    upload.add_argument("--part-mib", type=int, default=5)
    upload.add_argument("--content-type")
    upload.add_argument("--remote-path", required=True)
    upload.add_argument("--prompt-output", required=True)
    upload.add_argument("--presign-seconds", type=int, default=172800)
    upload.add_argument("--remote-jobs", type=int, default=20)
    upload.add_argument("--remote-chunk-mib", type=int, default=64)
    upload.add_argument("--approved-write", action="store_true")

    delete = subparsers.add_parser("delete", help="delete one verified temporary object")
    delete.add_argument("--profile", default="default")
    delete.add_argument("--bucket")
    delete.add_argument("--key", required=True)
    delete.add_argument("--expected-bytes", type=int, required=True)
    delete.add_argument("--expected-sha256", required=True)
    delete.add_argument("--approved-delete", action="store_true")
    return parser


def load_boto() -> tuple[Any, Any, type[BaseException]]:
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config  # type: ignore[import-not-found]
        from botocore.exceptions import ClientError  # type: ignore[import-not-found]
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "boto3 is required; run with `uv run --with boto3 python3 scripts/fast_object_transfer.py ...`"
        ) from exc
    return boto3, Config, ClientError


def make_client(profile: dict[str, str], workers: int) -> tuple[Any, type[BaseException]]:
    boto3, config_type, client_error = load_boto()
    client = boto3.client(
        "s3",
        endpoint_url=profile["endpoint"],
        aws_access_key_id=profile["access_key_id"],
        aws_secret_access_key=profile["secret_access_key"],
        region_name="auto",
        config=config_type(
            signature_version="s3v4",
            connect_timeout=15,
            read_timeout=600,
            max_pool_connections=max(workers + 2, 8),
            retries={"max_attempts": 8, "mode": "adaptive"},
        ),
    )
    return client, client_error


def command_configure(args: argparse.Namespace) -> int:
    profile_name = validate_profile_name(args.profile)
    current = lookup_profile(profile_name)
    if not args.approved_write:
        raise SystemExit("configure requires --approved-write")
    if current is not None and not args.replace:
        raise SystemExit("profile already exists; use --replace for an approved rotation")
    if args.json_stdin:
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as exc:
            raise SystemExit("stdin is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise SystemExit("stdin profile must be a JSON object")
    else:
        payload = {
            "endpoint": input("Endpoint (HTTPS): ").strip(),
            "bucket": input("Default bucket: ").strip(),
            "access_key_id": getpass.getpass("Access key ID: ").strip(),
            "secret_access_key": getpass.getpass("Secret access key: ").strip(),
        }
    store_profile(profile_name, payload)
    stored = lookup_profile(profile_name)
    if stored is None:
        raise SystemExit("profile verification failed after storage")
    print(json.dumps({"profile": profile_name, "endpoint": stored["endpoint"], "bucket": stored["bucket"], "credential_present": True}, ensure_ascii=False))
    return 0


def command_status(args: argparse.Namespace) -> int:
    profile_name = validate_profile_name(args.profile)
    profile = lookup_profile(profile_name)
    if profile is None:
        print(json.dumps({"profile": profile_name, "credential_present": False}, ensure_ascii=False))
        return 1
    print(json.dumps({"profile": profile_name, "endpoint": profile["endpoint"], "bucket": profile["bucket"], "credential_present": True}, ensure_ascii=False))
    return 0


def is_not_found(exc: BaseException) -> bool:
    response = getattr(exc, "response", {})
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    code = response.get("Error", {}).get("Code")
    return status == 404 or code in {"404", "NoSuchKey", "NotFound"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    storage.private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        storage.private_fchmod(descriptor, Path(temporary))
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        storage.protect(path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def load_remote_parts(client: Any, bucket: str, key: str, upload_id: str) -> dict[int, str]:
    parts: dict[int, str] = {}
    marker = 0
    while True:
        response = client.list_parts(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            PartNumberMarker=marker,
            MaxParts=1000,
        )
        for row in response.get("Parts", []):
            parts[int(row["PartNumber"])] = str(row["ETag"])
        if not response.get("IsTruncated"):
            break
        marker = int(response["NextPartNumberMarker"])
    return parts


def write_remote_prompt(
    path: Path,
    *,
    url: str,
    remote_path: str,
    expected_sha256: str,
    expected_bytes: int,
    expires: int,
    jobs: int = 20,
    chunk_mib: int = 64,
) -> None:
    if not remote_path.startswith("/") or "\n" in remote_path or "\r" in remote_path:
        raise ValueError("remote path must be a single-line absolute path")
    if jobs < 1 or jobs > 64:
        raise ValueError("remote jobs must be between 1 and 64")
    if chunk_mib < 5 or chunk_mib > 1024:
        raise ValueError("remote chunk size must be between 5 and 1024 MiB")
    script_path = remote_path.rsplit("/", 1)[0] + f"/download_object_{expected_sha256[:8]}.sh"
    log_path = remote_path + ".r2.runner.log"
    for value in (url, remote_path, expected_sha256, script_path, log_path):
        if "'" in value:
            raise ValueError("single quote is not supported in generated shell values")
    script = r'''#!/bin/sh
set -eu
umask 077
URL='__URL__'
TARGET='__TARGET__'
EXPECTED_BYTES=__EXPECTED_BYTES__
EXPECTED_SHA256='__EXPECTED_SHA256__'
JOBS=__JOBS__
CHUNK_BYTES=__CHUNK_BYTES__
PART_DIR="${TARGET}.r2.parts"
TMP="${TARGET}.r2.part"
LOG="${TARGET}.r2.download.log"
MANIFEST="${PART_DIR}/manifest.txt"

if [ -L "$TMP" ]; then
echo "拒绝使用符号链接临时文件：$TMP" >&2
exit 20
fi

if [ -f "$TARGET" ]; then
CURRENT_BYTES=$(stat -c %s "$TARGET")
if [ "$CURRENT_BYTES" -eq "$EXPECTED_BYTES" ]; then
CURRENT_SHA256=$(sha256sum "$TARGET" | awk '{print $1}')
if [ "$CURRENT_SHA256" = "$EXPECTED_SHA256" ]; then
echo "ALREADY_COMPLETE=YES"
echo "TARGET=$TARGET"
echo "BYTES=$CURRENT_BYTES"
echo "SHA256=$CURRENT_SHA256"
exit 0
fi
fi
fi

AVAILABLE_KB=$(df -Pk "$(dirname "$TARGET")" | tail -n 1 | awk '{print $4}')
REQUIRED_KB=$(( (EXPECTED_BYTES + 1073741823) / 1024 ))
if [ "$AVAILABLE_KB" -lt "$REQUIRED_KB" ]; then
echo "空间不足：需要至少 ${REQUIRED_KB} KiB，当前 ${AVAILABLE_KB} KiB" >&2
exit 21
fi

mkdir -p "$PART_DIR"
: > "$MANIFEST"
INDEX=0
START=0
while [ "$START" -lt "$EXPECTED_BYTES" ]; do
END=$((START + CHUNK_BYTES - 1))
if [ "$END" -ge "$EXPECTED_BYTES" ]; then
END=$((EXPECTED_BYTES - 1))
fi
printf '%03d %s %s\n' "$INDEX" "$START" "$END" >> "$MANIFEST"
INDEX=$((INDEX + 1))
START=$((END + 1))
done

truncate -s "$EXPECTED_BYTES" "$TMP"
export URL PART_DIR LOG
xargs -n 3 -P "$JOBS" sh -c '
set -u
INDEX="$1"
START="$2"
END="$3"
OUT="${PART_DIR}/${INDEX}.part"
DONE="${PART_DIR}/${INDEX}.done"
if [ -f "$DONE" ]; then
exit 0
fi
EXPECTED=$((END - START + 1))
ATTEMPT=0
while [ "$ATTEMPT" -lt 20 ]; do
HAVE=0
if [ -f "$OUT" ]; then
HAVE=$(stat -c %s "$OUT")
fi
if [ "$HAVE" -eq "$EXPECTED" ]; then
exit 0
fi
if [ "$HAVE" -gt "$EXPECTED" ]; then
echo "分段过长：${INDEX}" >&2
exit 22
fi
NEXT=$((START + HAVE))
curl --silent --show-error --location --fail --connect-timeout 30 --max-time 1800 --header "Range: bytes=${NEXT}-${END}" "$URL" >> "$OUT" 2>> "$LOG" || true
HAVE=$(stat -c %s "$OUT" 2>/dev/null || printf 0)
if [ "$HAVE" -eq "$EXPECTED" ]; then
exit 0
fi
if [ "$HAVE" -gt "$EXPECTED" ]; then
echo "服务端未正确执行 Range：${INDEX}" >&2
exit 23
fi
ATTEMPT=$((ATTEMPT + 1))
sleep 2
done
echo "分段重试耗尽：${INDEX}" >&2
exit 24
' sh < "$MANIFEST"

while read -r INDEX START END; do
OUT="${PART_DIR}/${INDEX}.part"
DONE="${PART_DIR}/${INDEX}.done"
if [ -f "$DONE" ]; then
continue
fi
EXPECTED=$((END - START + 1))
ACTUAL=$(stat -c %s "$OUT")
if [ "$ACTUAL" -ne "$EXPECTED" ]; then
echo "分段长度不符：${INDEX}" >&2
exit 25
fi
python3 -c 'import os,shutil,sys; src=open(sys.argv[2],"rb"); dst=open(sys.argv[3],"r+b"); dst.seek(int(sys.argv[1])); shutil.copyfileobj(src,dst,4*1024*1024); dst.flush(); os.fsync(dst.fileno()); src.close(); dst.close()' "$START" "$OUT" "$TMP"
: > "$DONE"
rm -- "$OUT"
done < "$MANIFEST"

ACTUAL_BYTES=$(stat -c %s "$TMP")
ACTUAL_SHA256=$(sha256sum "$TMP" | awk '{print $1}')
if [ "$ACTUAL_BYTES" -ne "$EXPECTED_BYTES" ] || [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
find "$PART_DIR" -type f -name '*.done' -delete
echo "最终校验失败；已保留临时文件，重新运行脚本会重新获取各段。" >&2
exit 26
fi

BACKUP=''
if [ -e "$TARGET" ]; then
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="${TARGET}.bak.${STAMP}"
mv -- "$TARGET" "$BACKUP"
fi
mv -- "$TMP" "$TARGET"
rm -r -- "$PART_DIR"
echo "DOWNLOAD_COMPLETE=YES"
echo "TARGET=$TARGET"
echo "BYTES=$ACTUAL_BYTES"
echo "SHA256=$ACTUAL_SHA256"
echo "BACKUP=$BACKUP"
'''
    replacements = {
        "__URL__": url,
        "__TARGET__": remote_path,
        "__EXPECTED_BYTES__": str(expected_bytes),
        "__EXPECTED_SHA256__": expected_sha256,
        "__JOBS__": str(jobs),
        "__CHUNK_BYTES__": str(chunk_mib * 1024 * 1024),
    }
    for marker, value in replacements.items():
        script = script.replace(marker, value)
    content = f"""请直接部署并运行下面的分段续传脚本，不要改写其内容，也不要把下载链接复述到回复中。链接有效期 {expires // 3600} 小时。

脚本保存位置：{script_path}
正式目标：{remote_path}
预期字节数：{expected_bytes}
预期 SHA-256：{expected_sha256}

把以下代码块原样保存为脚本文件：

```sh
{script}```

保存后执行：

```sh
chmod 700 '{script_path}'
nohup '{script_path}' > '{log_path}' 2>&1 &
```

立即回复后台 PID 和日志路径。任务完成后只报告正式路径、字节数、SHA-256、备份路径和 DOWNLOAD_COMPLETE；聊天超时不得终止后台任务。脚本使用 {jobs} 路 Range 下载、{chunk_mib}MiB 分段、失败分段续传、最终 SHA-256 校验及同目录原子替换，不需要安装 cloudflared、ngrok、frp 或 aria2。
"""
    storage.private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        storage.private_fchmod(descriptor, Path(temporary))
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        storage.protect(path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def command_upload(args: argparse.Namespace) -> int:
    if not args.approved_write:
        raise SystemExit("upload requires --approved-write")
    if args.workers < 1 or args.workers > 64:
        raise SystemExit("workers must be between 1 and 64")
    source = Path(args.source).expanduser().resolve(strict=True)
    if not source.is_file():
        raise SystemExit("source is not a regular file")
    source_size = source.stat().st_size
    print(f"SOURCE_BYTES={source_size}", flush=True)
    print("HASHING_SOURCE=START", flush=True)
    actual_sha256 = sha256_file(source)
    expected_sha256 = (args.expected_sha256 or actual_sha256).lower()
    if not SHA256.fullmatch(expected_sha256) or actual_sha256 != expected_sha256:
        raise SystemExit("source SHA-256 mismatch")
    print("HASHING_SOURCE=PASS", flush=True)
    profile = lookup_profile(args.profile)
    if profile is None:
        raise SystemExit(f"object-store profile is missing: {args.profile}")
    bucket = args.bucket or profile["bucket"]
    content_type = args.content_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    client, client_error = make_client(profile, args.workers)

    try:
        existing = client.head_object(Bucket=bucket, Key=args.key)
    except client_error as exc:
        if not is_not_found(exc):
            raise
    else:
        metadata = existing.get("Metadata", {})
        if int(existing["ContentLength"]) != source_size or metadata.get("sha256") != expected_sha256:
            raise SystemExit("object key already exists with different content")
        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": args.key},
            ExpiresIn=args.presign_seconds,
        )
        write_remote_prompt(
            Path(args.prompt_output),
            url=url,
            remote_path=args.remote_path,
            expected_sha256=expected_sha256,
            expected_bytes=source_size,
            expires=args.presign_seconds,
            jobs=args.remote_jobs,
            chunk_mib=args.remote_chunk_mib,
        )
        print("OBJECT_ALREADY_COMPLETE=YES", flush=True)
        print(f"PROMPT_OUTPUT={args.prompt_output}", flush=True)
        return 0

    part_size = args.part_mib * 1024 * 1024
    if part_size < 5 * 1024 * 1024:
        raise SystemExit("part size must be at least 5 MiB")
    part_count = math.ceil(source_size / part_size)
    if part_count > 10_000:
        raise SystemExit("multipart upload would exceed 10,000 parts; increase --part-mib")
    state_path = Path(args.state).expanduser() if args.state else (
        storage.user_data_root() / "data" / "object-transfers" / f"{args.profile}-{expected_sha256[:16]}.json"
    )
    state: dict[str, Any]
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        invariants = {
            "profile": args.profile,
            "endpoint": profile["endpoint"],
            "bucket": bucket,
            "key": args.key,
            "source": str(source),
            "source_size": source_size,
            "source_sha256": expected_sha256,
            "part_size": part_size,
            "content_type": content_type,
        }
        if any(state.get(name) != value for name, value in invariants.items()):
            raise SystemExit("resume state does not match this transfer")
        upload_id = str(state["upload_id"])
        parts = load_remote_parts(client, bucket, args.key, upload_id)
        state["parts"] = {str(number): etag for number, etag in parts.items()}
        atomic_json(state_path, state)
        print(f"RESUME_PARTS={len(parts)}", flush=True)
    else:
        response = client.create_multipart_upload(
            Bucket=bucket,
            Key=args.key,
            ContentType=content_type,
            Metadata={"sha256": expected_sha256, "source-bytes": str(source_size)},
        )
        upload_id = str(response["UploadId"])
        parts: dict[int, str] = {}
        state = {
            "version": 1,
            "profile": args.profile,
            "endpoint": profile["endpoint"],
            "bucket": bucket,
            "key": args.key,
            "source": str(source),
            "source_size": source_size,
            "source_sha256": expected_sha256,
            "part_size": part_size,
            "content_type": content_type,
            "upload_id": upload_id,
            "parts": {},
        }
        atomic_json(state_path, state)
        print("MULTIPART_CREATED=YES", flush=True)

    def upload_part(number: int) -> tuple[int, str, int]:
        offset = (number - 1) * part_size
        length = min(part_size, source_size - offset)
        with source.open("rb") as handle:
            handle.seek(offset)
            body = handle.read(length)
        if len(body) != length:
            raise RuntimeError("short local read")
        response = client.upload_part(
            Bucket=bucket,
            Key=args.key,
            UploadId=upload_id,
            PartNumber=number,
            Body=body,
        )
        return number, str(response["ETag"]), length

    missing = [number for number in range(1, part_count + 1) if number not in parts]
    completed_bytes = sum(
        min(part_size, source_size - (number - 1) * part_size) for number in parts
    )
    initial_completed_bytes = completed_bytes
    start = time.monotonic()
    finished_this_run = 0
    progress_step = max(1, part_count // 100)
    print(f"TOTAL_PARTS={part_count}", flush=True)
    print(f"MISSING_PARTS={len(missing)}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(upload_part, number): number for number in missing}
        for future in concurrent.futures.as_completed(futures):
            number, etag, length = future.result()
            parts[number] = etag
            completed_bytes += length
            finished_this_run += 1
            state["parts"] = {str(index): parts[index] for index in sorted(parts)}
            atomic_json(state_path, state)
            elapsed = max(time.monotonic() - start, 0.001)
            newly_uploaded = max(completed_bytes - initial_completed_bytes, 0)
            rate = newly_uploaded / elapsed
            remaining = source_size - completed_bytes
            eta = remaining / rate if rate > 0 else 0
            if (
                finished_this_run == 1
                or finished_this_run % progress_step == 0
                or completed_bytes == source_size
            ):
                print(
                    "PROGRESS "
                    f"parts={len(parts)}/{part_count} "
                    f"bytes={completed_bytes}/{source_size} "
                    f"percent={completed_bytes * 100 / source_size:.2f} "
                    f"rate_mib_s={rate / 1048576:.3f} eta_seconds={eta:.0f}",
                    flush=True,
                )

    ordered = [{"PartNumber": number, "ETag": parts[number]} for number in range(1, part_count + 1)]
    client.complete_multipart_upload(
        Bucket=bucket,
        Key=args.key,
        UploadId=upload_id,
        MultipartUpload={"Parts": ordered},
    )
    head = client.head_object(Bucket=bucket, Key=args.key)
    if int(head["ContentLength"]) != source_size:
        raise SystemExit("completed object size mismatch")
    if head.get("Metadata", {}).get("sha256") != expected_sha256:
        raise SystemExit("completed object metadata SHA-256 mismatch")
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": args.key},
        ExpiresIn=args.presign_seconds,
    )
    write_remote_prompt(
        Path(args.prompt_output),
        url=url,
        remote_path=args.remote_path,
        expected_sha256=expected_sha256,
        expected_bytes=source_size,
        expires=args.presign_seconds,
        jobs=args.remote_jobs,
        chunk_mib=args.remote_chunk_mib,
    )
    state["completed"] = True
    state["completed_at"] = int(time.time())
    atomic_json(state_path, state)
    print("MULTIPART_COMPLETE=YES", flush=True)
    print("REMOTE_OBJECT_SIZE=PASS", flush=True)
    print("REMOTE_OBJECT_METADATA_SHA256=PASS", flush=True)
    print(f"PROMPT_OUTPUT={args.prompt_output}", flush=True)
    return 0


def command_delete(args: argparse.Namespace) -> int:
    if not args.approved_delete:
        raise SystemExit("delete requires --approved-delete")
    expected_sha256 = args.expected_sha256.lower()
    if not SHA256.fullmatch(expected_sha256) or args.expected_bytes < 0:
        raise SystemExit("expected object identity is invalid")
    profile = lookup_profile(args.profile)
    if profile is None:
        raise SystemExit(f"object-store profile is missing: {args.profile}")
    bucket = args.bucket or profile["bucket"]
    client, client_error = make_client(profile, 2)
    try:
        head = client.head_object(Bucket=bucket, Key=args.key)
    except client_error as exc:
        if is_not_found(exc):
            raise SystemExit("temporary object is already absent") from exc
        raise
    metadata = head.get("Metadata", {})
    if int(head["ContentLength"]) != args.expected_bytes or metadata.get("sha256") != expected_sha256:
        raise SystemExit("temporary object identity mismatch; refusing delete")
    client.delete_object(Bucket=bucket, Key=args.key)
    try:
        client.head_object(Bucket=bucket, Key=args.key)
    except client_error as exc:
        if not is_not_found(exc):
            raise
    else:
        raise SystemExit("temporary object still exists after delete")
    print(json.dumps({"deleted": True, "bucket": bucket, "key": args.key, "bytes": args.expected_bytes, "sha256": expected_sha256}, ensure_ascii=False))
    return 0


def main() -> int:
    args = build_parser().parse_args()
    handlers = {
        "configure": command_configure,
        "status": command_status,
        "upload": command_upload,
        "delete": command_delete,
    }
    return int(handlers[args.command](args))


if __name__ == "__main__":
    raise SystemExit(main())
