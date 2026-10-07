#!/usr/bin/env python3
"""Build reproducible source + installer archives, without local runtime/data."""
from __future__ import annotations
import argparse
import ast
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'control.py', 'install.command', 'install.cmd', 'README.md', 'LICENSE',
              'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes'}
TREES = {'app', 'docs', 'examples', 'relay', 'scripts', 'tests', '.github'}
IGNORED = {'__pycache__', 'node_modules', '.git', '.venv', '.DS_Store'}


def version():
    for node in ast.parse((ROOT / 'control.py').read_text(encoding='utf-8')).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'VERSION' for t in node.targets):
            return ast.literal_eval(node.value)
    raise RuntimeError('Missing application version')


def release_files():
    paths = []
    for path in ROOT.rglob('*'):
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            if relative.parts[0] in TREES: raise RuntimeError('Symlink in release source: ' + str(relative))
            continue
        if not path.is_file() or any(part in IGNORED for part in relative.parts): continue
        if path.suffix in {'.pyc', '.pyo', '.log', '.pid'}: continue
        allowed = str(relative) in ROOT_FILES or relative.parts[0] in TREES
        allowed |= relative.as_posix() in {'runtime/node/package.json', 'runtime/node/package-lock.json'}
        if allowed: paths.append((relative.as_posix(), path))
    return sorted(paths)


def mode(name):
    return 0o755 if name.endswith(('.sh', '.command')) or name in {'control.py', 'scripts/build_release.py'} else 0o644


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    v = version()
    prefix = 'openclaw-farm-console-' + v
    files = release_files()
    if len(files) < 100: raise RuntimeError('Release source appears incomplete')
    for platform in ('macos', 'linux-x64'):
        with (output / f'{prefix}-{platform}.tar.gz').open('wb') as stream:
            with gzip.GzipFile(filename='', fileobj=stream, mode='wb', mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w') as archive:
                    for name, path in files:
                        data = path.read_bytes()
                        info = tarfile.TarInfo(prefix + '/' + name)
                        info.size, info.mode, info.mtime = len(data), mode(name), 0
                        info.uid = info.gid = 0
                        archive.addfile(info, io.BytesIO(data))
    with zipfile.ZipFile(output / f'{prefix}-windows-x64.zip', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in files:
            info = zipfile.ZipInfo(prefix + '/' + name, (2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (mode(name) | 0o100000) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    assets = sorted(output.glob(prefix + '*'))
    sums = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in assets}
    (output / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in sums.items()), encoding='utf-8')
    (output / 'release-manifest.json').write_text(json.dumps({
        'version': v, 'sourceFileCount': len(files), 'archives': sums,
        'runtime': {'node': '22.14.0', 'python': '3.12.10', 'openclaw': '2026.4.2'},
        'validation': 'Final native acceptance was not completed at the owner\'s request. See docs/validation.md for actual earlier results; platform support is not fully verified.',
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'version': v, 'files': len(files), 'assets': list(sums)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    build(parser.parse_args().output)
