"""Exercise the Windows bootstrap APIs without PowerShell module discovery."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

HELPER = Path(__file__).resolve().parents[1] / 'scripts/install/windows_runtime.ps1'


def ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == 'nt', 'Requires native Windows PowerShell/.NET')
class WindowsBootstrapTests(unittest.TestCase):
    def test_hash_and_zip_work_without_modules_in_unicode_path(self):
        value = b'isolated-pinned-runtime-fixture\x00\xff'
        with tempfile.TemporaryDirectory(prefix='中文 bootstrap ') as directory:
            root = Path(directory)
            archive, output = root / 'runtime.zip', root / '解压 data'
            with zipfile.ZipFile(archive, 'w') as handle:
                handle.writestr('nested/uv.exe', value)
            expected = hashlib.sha256(archive.read_bytes()).hexdigest()
            command = f"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PSModulePath = ''
$PSModuleAutoLoadingPreference = 'None'
. {ps_literal(HELPER)}
$taskActual = Get-TaskFileSha256 -Path {ps_literal(archive)}
if ($taskActual -ne '{expected}') {{ throw 'SHA256 mismatch' }}
Expand-TaskRuntimeZip -ArchivePath {ps_literal(archive)} -DestinationPath {ps_literal(output)}
[Console]::WriteLine('{{"ok":true}}')
"""
            encoded = base64.b64encode(command.encode('utf-16-le')).decode('ascii')
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive',
                                     '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
                                    text=True, encoding='utf-8', capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'ok': True})
            self.assertEqual((output / 'nested/uv.exe').read_bytes(), value)


if __name__ == '__main__':
    unittest.main()
