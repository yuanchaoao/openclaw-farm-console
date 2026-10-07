#!/bin/sh
# Bootstrap a checksum-pinned private runtime; works without system Python/Node.
set -eu
umask 077
TASK_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case $(uname -s) in
  Darwin) TASK_ROOT=${OPENCLAW_HOME:-"$HOME/Library/Application Support/OpenClaw Farm Console"}; TASK_SYSTEM=apple-darwin ;;
  Linux) TASK_ROOT=${OPENCLAW_HOME:-"${XDG_DATA_HOME:-$HOME/.local/share}/openclaw-farm-console"}; TASK_SYSTEM=unknown-linux-musl ;;
  *) printf '%s\n' 'Use install.ps1 on Windows. Supported Unix systems: macOS and desktop Linux.' >&2; exit 1 ;;
esac
TASK_PREV=
for TASK_ARG in "$@"; do
  if [ "$TASK_PREV" = home ]; then TASK_ROOT=$TASK_ARG; TASK_PREV=; fi
  case "$TASK_ARG" in --home) TASK_PREV=home ;; --home=*) TASK_ROOT=${TASK_ARG#--home=} ;; esac
done
case $(uname -m) in arm64|aarch64) TASK_ARCH=aarch64 ;; x86_64|amd64) TASK_ARCH=x86_64 ;; *) printf '%s\n' 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
TASK_ASSET=uv-$TASK_ARCH-$TASK_SYSTEM.tar.gz
case "$TASK_ASSET" in
 uv-aarch64-apple-darwin.tar.gz) TASK_SHA=3f61099e261e449527141dbf125629fab33ad696468c8c90cebbac40185a306c ;;
 uv-x86_64-apple-darwin.tar.gz) TASK_SHA=76638fdcfa91357858771551a1c88de1f7c3b270b33ab1866f8a0618d9e442d8 ;;
 uv-x86_64-unknown-linux-musl.tar.gz) TASK_SHA=06b891ef144bd8390fecb150838f0ff8a34ccaeecf9d744d97945d02ec7389c0 ;;
 uv-aarch64-unknown-linux-musl.tar.gz) TASK_SHA=3cb3c891f56891f0027f0287980014930b18875c9396c1d8a19d607b0a6049d9 ;;
esac
mkdir -p "$TASK_ROOT/runtime/tools" "$TASK_ROOT/cache" "$TASK_ROOT/runtime/python-base"
TASK_ARCHIVE="$TASK_ROOT/cache/$TASK_ASSET"
TASK_WORK=$(mktemp -d "$TASK_ROOT/cache/bootstrap.XXXXXX")
trap 'rm -rf "$TASK_WORK"' EXIT HUP INT TERM
TASK_UV="$TASK_ROOT/runtime/tools/uv"
TASK_UV_VERSION=$("$TASK_UV" --version 2>/dev/null || true)
case "$TASK_UV_VERSION" in 'uv 0.8.22'|'uv 0.8.22 '*) TASK_NEEDS_UV=no ;; *) TASK_NEEDS_UV=yes ;; esac
if [ ! -x "$TASK_UV" ] || [ "$TASK_NEEDS_UV" = yes ]; then
  TASK_URL=https://github.com/astral-sh/uv/releases/download/0.8.22/$TASK_ASSET
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --retry-all-errors --continue-at - --connect-timeout 20 --max-time 1200 --output "$TASK_ARCHIVE" "$TASK_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget --continue --tries=3 --timeout=90 -O "$TASK_ARCHIVE" "$TASK_URL"
  else printf '%s\n' 'Install curl or wget to download the private runtime.' >&2; exit 1; fi
  if command -v shasum >/dev/null 2>&1; then TASK_ACTUAL=$(shasum -a 256 "$TASK_ARCHIVE" | cut -d ' ' -f 1)
  elif command -v sha256sum >/dev/null 2>&1; then TASK_ACTUAL=$(sha256sum "$TASK_ARCHIVE" | cut -d ' ' -f 1)
  else printf '%s\n' 'A SHA-256 verification utility is required.' >&2; exit 1; fi
  [ "$TASK_ACTUAL" = "$TASK_SHA" ] || { rm -f "$TASK_ARCHIVE"; printf '%s\n' 'Runtime checksum mismatch. Download was not executed.' >&2; exit 1; }
  tar -xzf "$TASK_ARCHIVE" -C "$TASK_WORK"
  cp "$TASK_WORK/uv-$TASK_ARCH-$TASK_SYSTEM/uv" "$TASK_UV"
  chmod 700 "$TASK_UV"
fi
export UV_PYTHON_INSTALL_DIR="$TASK_ROOT/runtime/python-base"
export UV_PYTHON_BIN_DIR="$TASK_ROOT/runtime/tools"
export UV_CACHE_DIR="$TASK_ROOT/cache/uv"
export UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-1200}"
if ! "$TASK_UV" python find 3.12.10 --managed-python --no-python-downloads --no-config >/dev/null 2>&1; then
  "$TASK_UV" python install 3.12.10 --no-config
fi
TASK_PYTHON=$("$TASK_UV" python find 3.12.10 --managed-python --no-config)
"$TASK_PYTHON" "$TASK_SOURCE/control.py" install "$@"
