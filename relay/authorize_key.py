#!/usr/bin/env python3
"""Register a runtime-supplied public key on the selected Linux relay account."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import stat
import tempfile


def authorize(public_key, path, kind, port, start, end):
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?', public_key):
        raise ValueError('Use a complete Ed25519 public key line.')
    if not 1024 <= start <= end <= 65535 or end - start > 255:
        raise ValueError('Invalid port range.')
    if kind == 'instance' and not start <= port <= end:
        raise ValueError('The instance port must be within the configured range.')
    options = f'restrict,port-forwarding,permitlisten="localhost:{port}"' if kind == 'instance' else (
        'restrict,port-forwarding,permitlisten="localhost:0",' + ','.join(f'permitopen="localhost:{n}"' for n in range(start, end + 1)))
    os.umask(0o077)
    if path.parent.is_symlink():
        raise ValueError('The SSH directory must not be a symlink.')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    blob = public_key.split()[1]

    def same_key(line):
        if line.lstrip().startswith('#'):
            return False
        try:
            fields = shlex.split(line)
        except ValueError:
            return False
        return any(x == 'ssh-ed25519' and fields[i + 1] == blob for i, x in enumerate(fields[:-1]))

    lock_fd = os.open(path.with_name('.authorized_keys.openclaw.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'a+b') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if path.is_symlink() or (path.exists() and not stat.S_ISREG(path.stat().st_mode)):
            raise ValueError('authorized_keys must be a regular file.')
        existed = path.exists()
        before = path.read_bytes() if existed else b''
        preserved = ''.join(line for line in before.decode().splitlines(keepends=True) if not same_key(line))
        if preserved and not preserved.endswith(('\n', '\r')):
            preserved += '\n'
        after = (preserved + options + ' ' + public_key + '\n').encode()
        if after == before:
            return {'ok': True, 'changed': False}
        backup_name = None
        if existed:
            fd, backup_name = tempfile.mkstemp(prefix='authorized_keys.openclaw-backup-', dir=path.parent)
            with os.fdopen(fd, 'wb') as backup:
                backup.write(before)
                backup.flush()
                os.fsync(backup.fileno())
        fd, temporary = tempfile.mkstemp(prefix='.authorized_keys.openclaw-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(after)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {'ok': True, 'changed': True, 'backupCreated': backup_name is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-key-file', required=True)
    parser.add_argument('--kind', choices=('client', 'instance'), required=True)
    parser.add_argument('--port', type=int, default=19900)
    parser.add_argument('--port-min', type=int, default=19900)
    parser.add_argument('--port-max', type=int, default=20080)
    parser.add_argument('--authorized-keys', type=Path, default=Path.home() / '.ssh' / 'authorized_keys')
    args = parser.parse_args()
    print(json.dumps(authorize(Path(args.public_key_file).read_text().strip(), args.authorized_keys,
                               args.kind, args.port, args.port_min, args.port_max)))


if __name__ == '__main__':
    main()
