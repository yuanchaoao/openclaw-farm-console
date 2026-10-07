#!/bin/sh
# Run on the chosen Linux relay. Changes are scoped to one SSH account.
set -eu
user=${1:-}
case "$user" in ''|-*|*[!A-Za-z0-9_.-]*) echo 'Usage: sudo sh prepare.sh SSH_USER [--apply]' >&2; exit 2;; esac
command -v python3 >/dev/null || { echo 'Install Python 3 before preparing the relay.' >&2; exit 1; }
sshd=$(command -v sshd || true)
[ -n "$sshd" ] || sshd=/usr/sbin/sshd
[ -x "$sshd" ] || { echo 'Install the OpenSSH server before preparing the relay.' >&2; exit 1; }
id "$user" >/dev/null
"$sshd" -t
if [ "${2:-}" != --apply ]; then
  printf 'SSH configuration valid. To enable loopback forwarding for %s, rerun with --apply.\n' "$user"
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo 'The --apply option requires root.' >&2; exit 1; }
# Drop-ins are used only when the server already includes them.
if ! awk '!/^#/ && tolower($1)=="include" && $0 ~ /sshd_config.d/ {found=1} END {exit !found}' /etc/ssh/sshd_config; then
  echo 'This SSH server does not include sshd_config.d. Add AllowTcpForwarding yes and GatewayPorts no within a Match User block manually.' >&2
  exit 1
fi
mkdir -p /etc/ssh/sshd_config.d
file=/etc/ssh/sshd_config.d/50-openclaw-farm-${user}.conf
[ ! -L "$file" ] || { echo 'Refusing a symlink SSH configuration.' >&2; exit 1; }
temporary=$(mktemp /etc/ssh/sshd_config.d/.openclaw-config-XXXXXX)
trap 'rm -f "$temporary"' EXIT HUP INT TERM
printf 'Match User %s\n    AllowTcpForwarding yes\n    GatewayPorts no\n    PermitListen localhost:*\nMatch all\n' "$user" > "$temporary"
chmod 600 "$temporary"
existed=0
backup=''
if [ -e "$file" ]; then
  [ -f "$file" ] || { echo 'SSH configuration must be a regular file.' >&2; exit 1; }
  if cmp -s "$temporary" "$file"; then
    printf 'Relay forwarding is already configured for %s. Register public keys separately.\n' "$user"
    exit 0
  fi
  backup=$(mktemp "${file}.backup-XXXXXX")
  cp -p "$file" "$backup"
  chmod 600 "$backup"
  existed=1
fi
mv "$temporary" "$file"
if ! "$sshd" -t; then
  if [ "$existed" = 1 ]; then cp -p "$backup" "$file"; else rm -f "$file"; fi
  exit 1
fi
if command -v systemctl >/dev/null; then
  if systemctl is-active --quiet sshd; then systemctl reload sshd; else systemctl reload ssh; fi
else
  echo 'Configuration validated. Reload the running OpenSSH service using this server’s service manager.'
fi
printf 'Relay ready for %s. Register client and per-instance public keys separately.\n' "$user"
[ -z "$backup" ] || printf 'Prior configuration preserved in %s\n' "$backup"
