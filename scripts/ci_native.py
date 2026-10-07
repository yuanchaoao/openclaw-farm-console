#!/usr/bin/env python3
"""Native install/test/update/uninstall gate. All instances and relays are fixtures."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

SOURCE = Path(__file__).resolve().parents[1]


def run(command, *, env=None, payload=None, timeout=1800, capture=False):
    result = subprocess.run(command, cwd=SOURCE, env=env, input=payload, text=True, encoding='utf-8',
                            capture_output=capture, timeout=timeout)
    if result.returncode:
        if capture:
            print(result.stdout[-12000:]); print(result.stderr[-12000:], file=sys.stderr)
        raise RuntimeError('Native validation command failed: ' + Path(str(command[0])).name)
    return result


def main(home, reports, existing=False):
    reports.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['OPENCLAW_HOME'] = str(home)
    env['OPENCLAW_UI_PORT'] = '14317'
    env['PYTHONUNBUFFERED'] = '1'
    env['PYTHONUTF8'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    if sys.platform == 'win32':
        entry = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                 '-File', str(SOURCE / 'scripts/install/install.ps1'), '--home', str(home), '--port', '14317', '--no-start', '--no-autostart']
    else:
        entry = ['bash', str(SOURCE / 'scripts/install/install.sh'), '--home', str(home), '--port', '14317', '--no-start', '--no-autostart']
    if not existing: run(entry, env=env)
    config = json.loads((home / 'config/local.json').read_text(encoding='utf-8'))
    identity = json.loads((home / 'installation.json').read_text(encoding='utf-8'))['id']
    python, node = config['python'], config['node']
    env.update(config.get('environment', {}))
    env['OPENCLAW_HOME'] = str(home)
    env['PYTHON_BIN'] = python
    env['OPENCLAW_PYTHON_BIN'] = python
    env['OPENCLAW_PACKAGE_ROOT'] = str(home / 'runtime/node/node_modules/openclaw')
    env['PATH'] = os.pathsep.join([str(Path(node).parent), str(Path(python).parent), env.get('PATH', '')])
    run([python, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], env=env, timeout=600)
    run([python, '-m', 'unittest', 'discover', '-s', 'app/openclaw-farm/scripts/tests', '-p', 'test_*.py'], env=env, timeout=600)

    def js_test(path):
        with tempfile.TemporaryDirectory(prefix='openclaw-js-ci-') as directory:
            local = {**env, 'OPENCLAW_HOME': directory, 'OPENCLAW_UI_DATA_DIR': str(Path(directory) / 'data'),
                     'OPENCLAW_CONFIG_FILE': str(Path(directory) / 'config/local.json'),
                     'OPENCLAW_INSTANCES_FILE': str(Path(directory) / 'data/instances.json')}
            run([node, '--test', str(path)], env=local, timeout=240, capture=True)
        return path.name

    with ThreadPoolExecutor(max_workers=4) as executor:
        js_files = list(executor.map(js_test, sorted((SOURCE / 'app/macos').glob('test-*.mjs'))))
    payload = {'account': 'native-ci-' + identity, 'value': uuid.uuid4().hex + uuid.uuid4().hex, 'installationId': identity}
    for phase in ['before-upgrade', 'after-upgrade']:
        run([python, str(SOURCE / 'tests/release_acceptance.py'), '--home', str(home), '--phase', phase,
             '--report', str(reports / (phase + '.json'))], env=env, payload=json.dumps(payload), timeout=180)
        if phase == 'before-upgrade': run(entry, env=env)
    run([python, str(home / 'control.py'), 'uninstall', '--home', str(home)], env=env, timeout=90)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        marker = json.loads((home / 'installation.json').read_text(encoding='utf-8'))
        if marker.get('uninstalled') and not marker.get('uninstallPending') and not (home / 'runtime').exists() and not (home / 'app').exists(): break
        time.sleep(.5)
    else: raise RuntimeError('Uninstall did not finish deleting its own runtime/application')
    assert (home / 'config/local.json').is_file() and (home / 'data/ci-retained.json').is_file()
    assert marker['id'] == identity
    summary = {'passed': True, 'platform': sys.platform, 'jsTestFiles': len(js_files),
               'installedEntry': True, 'upgrade': True, 'uninstall': True, 'retainedUserData': True,
               'scope': 'Native installed desktop client; synthetic Gateway and real isolated file-bridge HTTP fixtures.'}
    (reports / 'native-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())) / '中文 路径' / '应用 data')
    parser.add_argument('--reports', type=Path, default=SOURCE / 'reports')
    parser.add_argument('--existing', action='store_true', help='Reuse a freshly installed isolated runtime for local iteration')
    args = parser.parse_args()
    main(args.home, args.reports, args.existing)
