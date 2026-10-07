// Generate Python for the user's Linux relay; only public data is embedded.
// An optional argv path supports isolated fixtures. Production uses ~/.ssh.
export function buildOracleAuthorizationScript({ publicKey, port, portRange = [19900, 20080], client = false }) {
  if (typeof publicKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?$/.test(publicKey)) {
    throw new Error("SSH 公钥格式不正确，请完整复制 ssh-ed25519 开头的一行");
  }
  if (!Array.isArray(portRange) || portRange.length !== 2 || !portRange.every(n => Number.isInteger(n) && n >= 1024 && n <= 65535) || portRange[0] > portRange[1] || portRange[1] - portRange[0] > 255) throw new Error("文件桥端口范围无效");
  if (!Number.isInteger(port) || port < portRange[0] || port > portRange[1]) throw new Error("文件桥端口无效");
  const options = client
    ? `restrict,port-forwarding,permitlisten="localhost:0",${Array.from({length:portRange[1]-portRange[0]+1},(_,index)=>`permitopen="localhost:${portRange[0]+index}"`).join(',')}`
    : `restrict,port-forwarding,permitlisten="localhost:${port}"`;
  return `PUBLIC_KEY = ${JSON.stringify(publicKey)}\nRELAY_PORT = ${port}\nOPTIONS = ${JSON.stringify(options)}\n` + String.raw`
from pathlib import Path
import fcntl
import json
import os
import shlex
import stat
import sys
import tempfile

os.umask(0o077)
path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / '.ssh' / 'authorized_keys'
if path.parent.is_symlink():
    raise SystemExit('SSH directory must not be a symlink')
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
blob = PUBLIC_KEY.split()[1]
entry = f'{OPTIONS} {PUBLIC_KEY}'

def same_public_key(line):
    if line.lstrip().startswith('#'):
        return False
    try:
        fields = shlex.split(line, comments=False)
    except ValueError:
        return False
    return any(field == 'ssh-ed25519' and fields[index + 1] == blob
               for index, field in enumerate(fields[:-1]))

lock_path = path.with_name('.authorized_keys.openclaw.lock')
lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
with os.fdopen(lock_fd, 'a+b') as lock:
    os.fchmod(lock.fileno(), 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    if path.is_symlink():
        raise SystemExit('authorized_keys must not be a symlink')
    existed = path.exists()
    if existed and not stat.S_ISREG(path.stat().st_mode):
        raise SystemExit('authorized_keys must be a regular file')
    original = path.read_bytes() if existed else b''
    lines = original.decode('utf-8').splitlines(keepends=True)
    preserved = ''.join(line for line in lines if not same_public_key(line))
    if preserved and not preserved.endswith(('\n', '\r')):
        preserved += '\n'
    updated = (preserved + entry + '\n').encode('utf-8')
    changed = updated != original
    if changed:
        # Preserve the exact prior bytes before touching the live authorization.
        if existed:
            backup_fd, backup_name = tempfile.mkstemp(prefix='authorized_keys.openclaw-backup-', dir=path.parent)
            with os.fdopen(backup_fd, 'wb') as backup:
                os.fchmod(backup.fileno(), 0o600)
                backup.write(original)
                backup.flush()
                os.fsync(backup.fileno())
        temporary_fd, temporary_name = tempfile.mkstemp(prefix='.authorized_keys.openclaw-', dir=path.parent)
        try:
            with os.fdopen(temporary_fd, 'wb') as temporary:
                os.fchmod(temporary.fileno(), 0o600)
                temporary.write(updated)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
    else:
        os.chmod(path, 0o600)
    print(json.dumps({'ok': True, 'changed': changed, 'port': RELAY_PORT, 'backupCreated': changed and existed}))
`;
}
