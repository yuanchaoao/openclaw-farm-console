"""Private user storage, locks and managed processes on desktop platforms."""
from __future__ import annotations
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time


def portable_stdio():
    """Use UTF-8 for Windows pipes as required by JSON, MCP and the console."""
    if sys.platform != 'win32': return
    os.environ.setdefault('PYTHONUTF8', '1')
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            try: stream.reconfigure(encoding='utf-8')
            except (OSError, ValueError): pass


portable_stdio()


def user_data_root(platform=None, environ=None, home=None):
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    if environ.get('OPENCLAW_HOME'):
        return Path(environ['OPENCLAW_HOME']).expanduser().absolute()
    if platform == 'darwin':
        return home / 'Library' / 'Application Support' / 'OpenClaw Farm Console'
    if platform == 'win32':
        return Path(environ.get('LOCALAPPDATA', str(home / 'AppData' / 'Local'))) / 'OpenClaw Farm Console'
    return Path(environ.get('XDG_DATA_HOME', str(home / '.local' / 'share'))) / 'openclaw-farm-console'


def _windows_api():
    from ctypes import wintypes
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    ppointer = ctypes.POINTER(pointer)
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(wintypes.LPWSTR)]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ppointer, ctypes.POINTER(wintypes.DWORD)]
    adv.GetSecurityDescriptorDacl.argtypes = [pointer, ctypes.POINTER(wintypes.BOOL), ppointer, ctypes.POINTER(wintypes.BOOL)]
    adv.GetSecurityDescriptorOwner.argtypes = [pointer, ppointer, ctypes.POINTER(wintypes.BOOL)]
    adv.GetAce.argtypes = [pointer, wintypes.DWORD, ppointer]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    return adv, kernel


def _windows_sid():
    # Current-token SID, not a localized user name. Lazy import keeps POSIX clean.
    from ctypes import wintypes
    adv, kernel = _windows_api()
    token = wintypes.HANDLE()
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise OSError('Cannot inspect current Windows token')
    try:
        length = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
        buf = ctypes.create_string_buffer(length.value)
        if not adv.GetTokenInformation(token, 1, buf, length, ctypes.byref(length)):
            raise OSError('Cannot inspect Windows token user')
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        output = wintypes.LPWSTR()
        if not adv.ConvertSidToStringSidW(ctypes.c_void_p(sid), ctypes.byref(output)):
            raise OSError('Cannot read Windows SID')
        try:
            return output.value
        finally:
            kernel.LocalFree(output)
    finally:
        kernel.CloseHandle(token)


def windows_private(path):
    from ctypes import wintypes
    adv, kernel = _windows_api()
    sd = ctypes.c_void_p()
    # Elevated Windows Server tokens may default new files to the Administrators
    # group owner. Author the current user owner as well as the protected DACL.
    current = _windows_sid()
    text = 'O:' + current + 'D:P(A;;FA;;;' + current + ')(A;;FA;;;SY)'
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, ctypes.byref(sd), None):
        raise OSError('Cannot construct private Windows ACL')
    try:
        present, defaulted = wintypes.BOOL(), wintypes.BOOL()
        dacl = ctypes.c_void_p()
        if not adv.GetSecurityDescriptorDacl(sd, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise OSError('Cannot inspect private Windows ACL')
        owner = ctypes.c_void_p()
        if not adv.GetSecurityDescriptorOwner(sd, ctypes.byref(owner), ctypes.byref(defaulted)):
            raise OSError('Cannot inspect private Windows owner')
        adv.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        code = adv.SetNamedSecurityInfoW(str(path), 1, 0x80000005, owner, None, dacl, None)
        if code:
            raise OSError(code, 'Cannot protect Windows file ACL')
    finally:
        kernel.LocalFree(sd)


def windows_is_private(path):
    from ctypes import wintypes
    adv, kernel = _windows_api()
    dacl, owner, sd = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    adv.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                                        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                                        ctypes.POINTER(ctypes.c_void_p)]
    code = adv.GetNamedSecurityInfoW(str(path), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(sd))
    if code or not dacl.value:
        if sd.value: kernel.LocalFree(sd)
        return False
    try:
        current = _windows_sid()
        owner_text = wintypes.LPWSTR()
        if not adv.ConvertSidToStringSidW(owner, ctypes.byref(owner_text)):
            return False
        try:
            if owner_text.value != current: return False
        finally:
            kernel.LocalFree(owner_text)
        # ACL header is BYTE revision, BYTE, WORD size, WORD ace-count, WORD.
        header = ctypes.string_at(dacl, 8)
        count = int.from_bytes(header[4:6], 'little')
        for index in range(count):
            ace = ctypes.c_void_p()
            if not adv.GetAce(dacl, index, ctypes.byref(ace)):
                return False
            head = ctypes.string_at(ace, 8)
            if head[0] != 0:  # Only ordinary allow ACEs are authored here.
                return False
            sid_string = wintypes.LPWSTR()
            if not adv.ConvertSidToStringSidW(ctypes.c_void_p(ace.value + 8), ctypes.byref(sid_string)):
                return False
            try:
                if sid_string.value not in (current, 'S-1-5-18'):
                    return False
            finally:
                kernel.LocalFree(sid_string)
        return count > 0
    finally:
        kernel.LocalFree(sd)


def protect(path, mode=None):
    path = Path(path)
    if path.is_symlink():
        raise OSError('Refusing symbolic link for private storage')
    if os.name == 'nt':
        windows_private(path)
    else:
        path.chmod(mode if mode is not None else (0o700 if path.is_dir() else 0o600))


def private_directory(path):
    path = Path(path)
    if path.is_symlink(): raise OSError('Refusing symbolic link directory')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    protect(path, 0o700)
    return path


def is_private(path, metadata=None):
    path = Path(path)
    if path.is_symlink(): return False
    metadata = metadata or path.stat()
    if os.name == 'nt': return windows_is_private(path)
    return metadata.st_uid == os.getuid() and not (stat.S_IMODE(metadata.st_mode) & 0o077)


def private_fchmod(descriptor, path=None):
    if os.name == 'nt':
        if path is not None: protect(path)
    else:
        os.fchmod(descriptor, 0o600)


def fsync_directory(path):
    if os.name == 'nt': return
    descriptor = os.open(path, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def write_json(path, value):
    path = Path(path)
    private_directory(path.parent)
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    temporary = Path(name)
    try:
        protect(temporary)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        protect(path)
        fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def lock_descriptor(descriptor):
    if os.name == 'nt':
        import msvcrt
        if os.fstat(descriptor).st_size == 0: os.write(descriptor, b'\0')
        os.lseek(descriptor, 0, os.SEEK_SET)
        try: msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        except OSError as exc: raise BlockingIOError('Storage is busy') from exc
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock_descriptor(descriptor):
    if os.name == 'nt':
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_UN)


@contextlib.contextmanager
def file_lock(path, timeout=18):
    path = Path(path)
    private_directory(path.parent)
    if path.is_symlink(): raise OSError('Refusing symbolic link lock')
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    protect(path)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                lock_descriptor(descriptor)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise
                time.sleep(.1)
        yield descriptor
    finally:
        try: unlock_descriptor(descriptor)
        except OSError: pass
        os.close(descriptor)


def detached_options():
    if os.name == 'nt':
        return {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS}
    return {'start_new_session': True}


def process_identity(pid, command):
    import psutil
    process = psutil.Process(pid)
    return {'pid': pid, 'created': process.create_time(), 'command': list(command)}


def owned_process(record):
    if not isinstance(record, dict) or not record.get('pid'): return None
    import psutil
    try:
        process = psutil.Process(int(record['pid']))
        if abs(process.create_time() - float(record['created'])) > .001: return None
        if process.cmdline() != record['command']: return None
        if process.username() != psutil.Process().username(): return None
        return process
    except (KeyError, TypeError, ValueError, psutil.Error):
        return None


def stop_owned(record, timeout=5):
    process = owned_process(record)
    if not process: return False
    import psutil
    process.terminate()
    try: process.wait(timeout=timeout)
    except psutil.TimeoutExpired:
        # Recheck PID identity before escalation.
        process = owned_process(record)
        if process:
            process.kill()
            process.wait(timeout=timeout)
    return True
