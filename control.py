#!/usr/bin/env python3
"""Install and operate a private, portable OpenClaw Farm Console."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
import webbrowser
import zipfile
from xml.sax.saxutils import escape

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE / 'scripts' / 'install'))
sys.path.insert(0, str(SOURCE / 'app' / 'openclaw-farm' / 'scripts'))
import private_storage as storage

VERSION = '1.0.0'
NODE_VERSION = '22.14.0'
PYTHON_VERSION = '3.12.10'
UV_VERSION = '0.8.22'
LABEL = 'com.openclaw.farm.console'
TASK_NAME = 'OpenClawFarmConsole'
NODE_HASHES = {
    'darwin-arm64': 'e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42',
    'darwin-x64': '6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250',
    'linux-arm64': '8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0',
    'linux-x64': '9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2',
    'win-arm64': '2d71f5f9b2fffa33baa108c07d74b0d24e0c3dd8f441d567772ae0e3dd4b1a22',
    'win-x64': '55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217',
}


def app_root(home=None):
    if home: return Path(home).expanduser().absolute()
    if (SOURCE / 'installation.json').is_file(): return SOURCE
    return storage.user_data_root()


def read_json(path, default=None):
    try: return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        if default is not None: return default
        raise RuntimeError('尚未安装，请先运行对应系统的安装入口。') from None


def settings(root):
    return read_json(root / 'config/local.json')


def environment(root):
    values = settings(root)
    env = os.environ.copy()
    env.update({key: str(value) for key, value in values.get('environment', {}).items()})
    env['OPENCLAW_HOME'] = str(root)
    env['OPENCLAW_CONFIG_FILE'] = str(root / 'config/local.json')
    env['OPENCLAW_CONFIG_DIR'] = str(root / 'config')
    env['OPENCLAW_INSTALLATION_ID'] = str(read_json(root / 'installation.json').get('id', ''))
    if 'consolePort' in values: env['OPENCLAW_UI_PORT'] = str(values['consolePort'])
    relay = values.get('relay') or {}
    for field, key in [('host','OPENCLAW_RELAY_HOST'), ('user','OPENCLAW_RELAY_USER'),
                       ('sshPort','OPENCLAW_RELAY_SSH_PORT'), ('identityFile','OPENCLAW_RELAY_KEY')]:
        if relay.get(field) is not None: env[key] = str(relay[field])
    if relay.get('host') and relay.get('user'):
        env['OPENCLAW_ORACLE_HOST'] = f"{relay['user']}@{relay['host']}"
    if relay.get('identityFile'): env['OPENCLAW_ORACLE_KEY'] = str(relay['identityFile'])
    ports = relay.get('portRange') or []
    if len(ports) == 2:
        env['OPENCLAW_BRIDGE_PORT_MIN'], env['OPENCLAW_BRIDGE_PORT_MAX'] = map(str, ports)
    bridge = values.get('bridge') or {}
    for field, key in [('podPort','OPENCLAW_BRIDGE_POD_PORT'), ('workspace','OPENCLAW_BRIDGE_WORKSPACE')]:
        if bridge.get(field) is not None: env[key] = str(bridge[field])
    env['PATH'] = os.pathsep.join([str(Path(values['node']).parent), str(Path(values['python']).parent), env.get('PATH', '')])
    # Credentials are fetched from the native store on demand, never launch config.
    return values, env


def console_url(root):
    values = settings(root)
    port = int(values.get('consolePort') or values.get('environment', {}).get('OPENCLAW_UI_PORT') or 4317)
    return f'http://127.0.0.1:{port}'


def live_status(root):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(console_url(root) + '/api/local-status', timeout=2) as response:
            data = json.load(response)
        identity = read_json(root / 'installation.json').get('id')
        return data if data.get('service') == 'openclaw-farm-console' and data.get('installationId') == identity else None
    except (OSError, ValueError, RuntimeError): return None


def port_busy(root):
    port = int(console_url(root).rsplit(':',1)[1])
    with socket.socket() as connection:
        connection.settimeout(.5)
        return connection.connect_ex(('127.0.0.1', port)) == 0


def run(command, **kwargs):
    result = subprocess.run(command, **kwargs)
    if result.returncode: raise RuntimeError('安装或启动步骤失败；请查看上述组件错误。')
    return result


def download(url, destination, sha256=None):
    destination = Path(destination)
    storage.private_directory(destination.parent)
    if destination.is_file() and sha256 and hashlib.sha256(destination.read_bytes()).hexdigest() == sha256:
        return destination
    partial = destination.with_suffix(destination.suffix + '.partial')
    for attempt in range(3):
        try:
            offset = partial.stat().st_size if partial.is_file() else 0
            headers = {'User-Agent': 'OpenClaw-Farm-Console/' + VERSION}
            if offset: headers['Range'] = f'bytes={offset}-'
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=90) as response:
                # A server ignoring Range must replace, rather than append, the response.
                resumed = offset and response.status == 206
                if resumed and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                    raise RuntimeError('下载服务器返回了错误的续传范围。')
                with partial.open('ab' if resumed else 'wb') as target:
                    shutil.copyfileobj(response, target, length=1024*1024)
            if sha256 and hashlib.sha256(partial.read_bytes()).hexdigest() != sha256:
                partial.unlink(missing_ok=True)
                raise RuntimeError('下载文件的 SHA-256 不匹配，未执行该文件。')
            os.replace(partial, destination)
            storage.protect(destination)
            return destination
        except (OSError, RuntimeError):
            # Preserve partial bytes across transient interruption and the next install run.
            if attempt == 2: raise
            time.sleep(1 + attempt)
    raise RuntimeError('下载失败。')


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    def safe(name):
        candidate = (destination / name).resolve()
        if candidate != destination and destination not in candidate.parents:
            raise RuntimeError('运行时压缩包包含不安全的路径。')
    if str(archive).endswith('.zip'):
        with zipfile.ZipFile(archive) as handle:
            for member in handle.infolist(): safe(member.filename)
            handle.extractall(destination)
    else:
        with tarfile.open(archive, 'r:gz') as handle:
            for member in handle.getmembers():
                safe(member.name)
                if member.issym(): safe(str(Path(member.name).parent / member.linkname))
                if member.islnk(): safe(member.linkname)
                if member.isdev() or member.isfifo(): raise RuntimeError('运行时压缩包包含特殊文件。')
            if hasattr(tarfile, 'data_filter'): handle.extractall(destination, filter='data')
            else: handle.extractall(destination)


def host_arch():
    machine = platform.machine().lower()
    if sys.platform == 'win32':
        machine = os.environ.get('PROCESSOR_ARCHITEW6432', os.environ.get('PROCESSOR_ARCHITECTURE', machine)).lower()
    if machine in ('aarch64', 'arm64'): return 'arm64'
    if machine in ('x86_64', 'amd64'): return 'x64'
    raise RuntimeError('支持 x64 和 ARM64 桌面系统。')


def python_request():
    # The pinned standalone release has x64 Windows Python. Windows 11 ARM64
    # runs it under its supported x64 emulation, alongside native ARM64 Node.
    if sys.platform == 'win32' and host_arch() == 'arm64':
        return f'cpython-{PYTHON_VERSION}-windows-x86_64-none'
    return PYTHON_VERSION


def uv_asset():
    arch = 'aarch64' if host_arch() == 'arm64' else 'x86_64'
    suffix = {'darwin':'apple-darwin.tar.gz', 'win32':'pc-windows-msvc.zip'}.get(sys.platform, 'unknown-linux-musl.tar.gz')
    return f'uv-{arch}-{suffix}'


def bootstrap_uv(root):
    path = root / 'runtime/tools' / ('uv.exe' if os.name == 'nt' else 'uv')
    if path.is_file():
        check = subprocess.run([str(path), '--version'], capture_output=True, text=True)
        if check.returncode == 0 and check.stdout.split()[:2] == ['uv', UV_VERSION]: return path
    name = uv_asset()
    checksums = read_json(SOURCE / 'scripts/install/uv-checksums.json')
    checksum = checksums.get(name)
    if not checksum: raise RuntimeError('此平台缺少固定运行时校验值。')
    archive = download(f'https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{name}', root / 'cache' / name, checksum)
    with tempfile.TemporaryDirectory(dir=root / 'cache') as directory:
        safe_extract(archive, directory)
        binaries = list(Path(directory).rglob('uv.exe' if os.name == 'nt' else 'uv'))
        if len(binaries) != 1: raise RuntimeError('uv 压缩包结构不正确。')
        storage.private_directory(path.parent)
        shutil.copy2(binaries[0], path)
        if os.name != 'nt': path.chmod(0o700)
    return path


def bootstrap_node(root):
    system = {'darwin':'darwin', 'win32':'win'}.get(sys.platform, 'linux')
    key = system + '-' + host_arch()
    name = f'node-v{NODE_VERSION}-{key}'
    binary = root / 'runtime/node-bin' / ('node.exe' if os.name == 'nt' else 'bin/node')
    if binary.is_file():
        result = subprocess.run([str(binary), '--version'], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip() == 'v' + NODE_VERSION: return binary
    extension = '.zip' if os.name == 'nt' else '.tar.gz'
    archive = download(f'https://nodejs.org/dist/v{NODE_VERSION}/{name}{extension}', root / 'cache' / (name + extension), NODE_HASHES[key])
    with tempfile.TemporaryDirectory(dir=root / 'cache') as directory:
        safe_extract(archive, directory)
        source = Path(directory) / name
        if not source.is_dir(): raise RuntimeError('Node.js 压缩包结构不正确。')
        target = root / 'runtime/node-bin'
        if target.exists(): shutil.rmtree(target)
        shutil.copytree(source, target, symlinks=True)
    return binary


def launcher(root):
    values = settings(root)
    return [values['python'], str(root / 'control.py')]


def service_suffix(root):
    identity = read_json(root / 'installation.json').get('id')
    if not identity: raise RuntimeError('缺少安装标记，未操作后台服务。')
    return hashlib.sha256(str(identity).encode()).hexdigest()[:12]


def service_label(root): return LABEL + '.' + service_suffix(root)
def service_task(root): return TASK_NAME + '-' + service_suffix(root)
def service_unit(root): return 'openclaw-farm-console-' + service_suffix(root) + '.service'


def unit_paths(root):
    if sys.platform == 'darwin': return [Path.home() / 'Library/LaunchAgents' / (service_label(root) + '.plist')]
    if sys.platform == 'win32':
        return [Path(os.environ.get('APPDATA', str(Path.home() / 'AppData/Roaming'))) / 'Microsoft/Windows/Start Menu/Programs/Startup' / (service_task(root) + '.cmd')]
    config = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
    return [config / 'systemd/user' / service_unit(root), config / 'autostart' / ('openclaw-farm-console-' + service_suffix(root) + '.desktop')]


def install_background(root):
    command = launcher(root) + ['serve']
    logs = root / 'logs'
    mode = 'managed-process'
    if sys.platform == 'darwin':
        path = unit_paths(root)[0]
        path.parent.mkdir(parents=True, exist_ok=True)
        item = {'Label':service_label(root), 'ProgramArguments':command, 'WorkingDirectory':str(root),
                'EnvironmentVariables':{'HOME':str(Path.home()), 'PATH':os.environ.get('PATH','/usr/bin:/bin')},
                'RunAtLoad':True, 'KeepAlive':True, 'ThrottleInterval':10, 'ProcessType':'Interactive', 'Umask':0o077,
                'StandardOutPath':str(logs / 'console.log'), 'StandardErrorPath':str(logs / 'console-error.log')}
        with path.open('wb') as handle: plistlib.dump(item, handle)
        storage.protect(path)
        mode = 'launchd'
    elif os.name == 'nt':
        sid = storage._windows_sid()
        xml = f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{escape(sid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>{escape(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>{escape(command[0])}</Command><Arguments>{escape(subprocess.list2cmdline(command[1:]))}</Arguments><WorkingDirectory>{escape(str(root))}</WorkingDirectory></Exec></Actions></Task>'''
        path = root / 'config/background-task.xml'
        path.write_text(xml, encoding='utf-16')
        storage.protect(path)
        result = subprocess.run(['schtasks.exe','/Create','/TN',service_task(root),'/XML',str(path),'/F'], capture_output=True)
        if result.returncode == 0: mode = 'scheduled-task'
        else:
            path = unit_paths(root)[0]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nstart "" /b ' + subprocess.list2cmdline(command).replace('%','%%') + '\r\n', encoding='utf-8')
            storage.protect(path)
            mode = 'startup-process'
    else:
        systemd, desktop = unit_paths(root)
        # systemd's quoting is distinct from shell quoting; protect spaces and percent specifiers.
        quote = lambda value: '"' + str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%') + '"'
        systemd.parent.mkdir(parents=True, exist_ok=True)
        systemd.write_text('[Unit]\nDescription=OpenClaw Farm Console\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=' + ' '.join(map(quote,command)) + '\nWorkingDirectory=' + quote(root) + '\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n')
        storage.protect(systemd)
        systemctl = shutil.which('systemctl')
        usable = systemctl and subprocess.run([systemctl,'--user','show-environment'],capture_output=True).returncode == 0
        if usable:
            run([systemctl,'--user','daemon-reload'], capture_output=True)
            run([systemctl,'--user','enable',service_unit(root)], capture_output=True)
            mode = 'systemd'
        else:
            desktop.parent.mkdir(parents=True, exist_ok=True)
            desktop.write_text('[Desktop Entry]\nType=Application\nName=OpenClaw Farm Console\nExec=' + ' '.join(map(quote,command)) + '\nTerminal=false\nX-GNOME-Autostart-enabled=true\n')
            storage.protect(desktop)
            mode = 'desktop-autostart'
    values = read_json(root / 'installation.json')
    values['backgroundMode'] = mode
    storage.write_json(root / 'installation.json', values)
    return mode


def background_start(root):
    mode = read_json(root / 'installation.json').get('backgroundMode')
    if mode == 'launchd':
        target = f'gui/{os.getuid()}/{service_label(root)}'
        existing = subprocess.run(['/bin/launchctl','print',target],capture_output=True)
        if existing.returncode:
            run(['/bin/launchctl','bootstrap',f'gui/{os.getuid()}',str(unit_paths(root)[0])], capture_output=True)
        else: run(['/bin/launchctl','kickstart',target], capture_output=True)
    elif mode == 'systemd': run(['systemctl','--user','start',service_unit(root)],capture_output=True)
    elif mode == 'scheduled-task': run(['schtasks.exe','/Run','/TN',service_task(root)],capture_output=True)
    else:
        values, env = environment(root)
        old = read_json(root / 'data/console-process.json', {})
        if storage.owned_process(old): return
        with (root / 'logs/launcher.log').open('ab') as log:
            subprocess.Popen(launcher(root) + ['serve'], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             cwd=root, env=env, **storage.detached_options())


def start(root):
    if live_status(root): return console_url(root)
    if port_busy(root): raise RuntimeError('管理台端口由其他程序占用；请在 config/local.json 更改 consolePort。')
    background_start(root)
    for _ in range(60):
        if live_status(root): return console_url(root)
        time.sleep(.25)
    raise RuntimeError('管理台未能启动，请查看应用目录 logs 中的日志。')


def stop(root):
    marker = read_json(root / 'installation.json', {})
    if not marker.get('id'): raise RuntimeError('缺少本应用安装标记，未停止其他服务。')
    mode = marker.get('backgroundMode')
    if mode == 'launchd': subprocess.run(['/bin/launchctl','bootout',f'gui/{os.getuid()}/{service_label(root)}'],capture_output=True)
    elif mode == 'systemd': subprocess.run(['systemctl','--user','stop',service_unit(root)],capture_output=True)
    elif mode == 'scheduled-task': subprocess.run(['schtasks.exe','/End','/TN',service_task(root)],capture_output=True)
    storage.stop_owned(read_json(root / 'data/console-process.json', {}))
    # Forward processes are independent; stop only private PID records whose identity is still exact.
    adapter = root / 'data/farm-adapter'
    if adapter.exists():
        for path in adapter.glob('relay-forward-*.json'):
            if storage.is_private(path): storage.stop_owned(read_json(path, {}))
    if live_status(root): raise RuntimeError('服务仍在运行，未宣称停止成功。')


def serve(root):
    values, env = environment(root)
    storage.private_directory(root / 'data')
    with storage.file_lock(root / 'data/console-process.lock', timeout=0):
        command = [values['node'],str(root / 'app/console/server.mjs')]
        check = subprocess.run([values['node'],str(root / 'app/openclaw-farm/scripts/gateway_client.mjs'),'--check-sdk'],
                               env=env,capture_output=True,text=True,timeout=30)
        if check.returncode: raise RuntimeError('客户端 SDK 自检失败，请重新运行安装程序。')
        with (root / 'logs/console.log').open('ab') as stdout, (root / 'logs/console-error.log').open('ab') as stderr:
            process = subprocess.Popen(command,env=env,cwd=root / 'app/console',stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
            record = storage.process_identity(process.pid,command)
            storage.write_json(root / 'data/console-process.json',record)
            try: return process.wait()
            finally:
                storage.stop_owned(record)


def mcp(root):
    values, env = environment(root)
    # Preserve stdio verbatim: no startup messages on stdout.
    return subprocess.call([values['python'],str(root / 'app/openclaw-farm/scripts/openclaw_mcp_server.py')],env=env,cwd=root)


def install(root, port=None, no_start=False, no_autostart=False):
    if sys.version_info < (3,10): raise RuntimeError('安装需要 Python 3.10+；请使用系统对应的安装脚本，它会自动准备 Python。')
    if root.exists() and not (root / 'installation.json').exists():
        # Bootstrap reserves only cache/runtime; refuse unrelated directory contents.
        if set(path.name for path in root.iterdir()) - {'runtime','cache'}:
            raise RuntimeError('目标目录含有其他文件且没有安装标记，未覆盖。')
    storage.private_directory(root)
    for name in ['runtime','config','data','logs','cache','backups']: storage.private_directory(root / name)
    if not (root / 'installation.json').exists():
        # Ownership is durable before downloads, so an interrupted install is resumable.
        storage.write_json(root / 'installation.json', {'id':str(uuid.uuid4()), 'version':VERSION, 'installing':True})
    if (root / 'installation.json').exists():
        old_marker = read_json(root / 'installation.json')
        storage.write_json(root / 'installation.json', {**old_marker,'installing':True,'uninstallPending':False})
        old_python = read_json(root / 'config/local.json', {}).get('python')
        if not old_marker.get('uninstalled') and old_python and Path(old_python).is_file():
            run([old_python,str(root / 'control.py'),'stop'],capture_output=True)
        backup = root / 'backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
        storage.private_directory(backup)
        for name in ['config','app']:
            if (root / name).exists(): shutil.copytree(root / name,backup / name,symlinks=True)
    uv = bootstrap_uv(root)
    node = bootstrap_node(root)
    uv_env = os.environ.copy()
    uv_env.update({'UV_PYTHON_INSTALL_DIR':str(root / 'runtime/python-base'),
                   'UV_PYTHON_BIN_DIR':str(root / 'runtime/tools'), 'UV_CACHE_DIR':str(root / 'cache/uv')})
    uv_env.setdefault('UV_HTTP_TIMEOUT', '1200')
    request = python_request()
    existing = subprocess.run([str(uv),'python','find',request,'--managed-python','--no-python-downloads','--no-config'],env=uv_env,capture_output=True,text=True)
    if existing.returncode: run([str(uv),'python','install',request,'--no-config'],env=uv_env)
    base = run([str(uv),'python','find',request,'--managed-python','--no-config'],env=uv_env,capture_output=True,text=True).stdout.strip()
    python = root / 'runtime/python' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists(): run([str(uv),'venv',str(root / 'runtime/python'),'--python',base,'--no-config'],env=uv_env)
    storage.private_directory(root / 'cache/wheels')
    sync_command = [str(uv),'--quiet','pip','sync','--python',str(python),str(SOURCE / 'scripts/requirements-lock.txt'),'--require-hashes','--find-links',str(root / 'cache/wheels'),'--no-config']
    # Validate and reuse complete caches without asking a slow index for the same
    # pinned wheels again. Missing cached assets fall back to the online sources.
    cached = subprocess.run(sync_command + ['--offline','--no-index'],env=uv_env,capture_output=True,text=True)
    if cached.returncode: run(sync_command,env=uv_env)
    if SOURCE != root:
        shutil.copytree(SOURCE / 'app',root / 'app',dirs_exist_ok=True,symlinks=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        shutil.copytree(SOURCE / 'scripts',root / 'scripts',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(SOURCE / 'control.py',root / 'control.py')
    sdk = root / 'runtime/node'
    sdk.mkdir(exist_ok=True)
    if SOURCE != root:
        for name in ['package.json','package-lock.json']: shutil.copy2(SOURCE / 'runtime/node' / name,sdk / name)
    npm = node.parent / 'node_modules/npm/bin/npm-cli.js' if os.name == 'nt' else node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    npm_env = os.environ.copy()
    npm_env['PATH'] = str(node.parent) + os.pathsep + npm_env.get('PATH','')
    npm_env['npm_config_cache'] = str(root / 'cache/npm')
    npm_env.setdefault('npm_config_fetch_timeout', '1200000')
    npm_env.setdefault('npm_config_fetch_retries', '3')
    # The upstream SDK may resolve git-backed dependencies; install pinned lock without lifecycle scripts.
    run([str(node),str(npm),'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=sdk,env=npm_env)
    previous = read_json(root / 'config/local.json', {})
    env = dict(previous.get('environment') or {})
    env.update({'OPENCLAW_HOME':str(root), 'OPENCLAW_UI_DATA_DIR':str(root / 'data'),
                'OPENCLAW_INSTANCES_FILE':str(root / 'data/instances.json'),
                'OPENCLAW_FARM_SCRIPT':str(root / 'app/openclaw-farm/scripts/openclaw_farm.py'),
                'OPENCLAW_PYTHON_BIN':str(python), 'OPENCLAW_NODE_BIN':str(node),
                'OPENCLAW_PACKAGE_ROOT':str(sdk / 'node_modules/openclaw'),
                'OPENCLAW_KEYCHAIN_BIN':str(root / 'app/openclaw-farm/scripts/keychain_store.py'),
                'OPENCLAW_ADAPTER_STATE_DIR':str(root / 'data/farm-adapter'),
                'OPENCLAW_FILE_BRIDGE_INSTALL_MODE':'bundled'})
    chosen_port = port or previous.get('consolePort') or env.get('OPENCLAW_UI_PORT') or 4317
    if not 1 <= int(chosen_port) <= 65535: raise RuntimeError('管理台端口无效。')
    env['OPENCLAW_UI_PORT'] = str(chosen_port)
    config = {**previous,'node':str(node),'python':str(python),'environment':env,'consolePort':int(chosen_port)}
    storage.write_json(root / 'config/local.json',config)
    registry = root / 'data/instances.json'
    if not registry.exists(): storage.write_json(registry,{'schema_version':2,'default':None,'instances':{}})
    policy = root / 'config/permission-repair-policy.json'
    if not policy.exists():
        # Existing permission repairs remain opt-in. No remote credentials are imported.
        storage.write_json(policy,{'enabled':False,'instances':{}})
    old = read_json(root / 'installation.json', {})
    storage.write_json(root / 'installation.json', {**old,'id':old.get('id') or str(uuid.uuid4()), 'version':VERSION,'uninstalled':False,'installing':False,'uninstallPending':False,
                        'installedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'nodeVersion':NODE_VERSION,'pythonVersion':PYTHON_VERSION,'sdkVersion':'2026.4.2'})
    if not no_autostart:
        install_background(root)
    else:
        storage.write_json(root / 'installation.json', {**read_json(root / 'installation.json'), 'backgroundMode': 'managed-process'})
    create_shortcuts(root)
    # Native backend availability is an explicit status; a locked desktop must not create a plaintext substitute.
    result = subprocess.run([str(python),str(root / 'app/openclaw-farm/scripts/keychain_store.py'),'probe'],capture_output=True,text=True)
    if result.returncode: print('系统凭据存储当前不可用；登记令牌前请解锁钥匙串或启用桌面 Secret Service。',file=sys.stderr)
    run([str(node),str(root / 'app/openclaw-farm/scripts/gateway_client.mjs'),'--check-sdk'],env=environment(root)[1],capture_output=True)
    if not no_start: print('管理台已启动：' + start(root))
    print('安装完成：' + str(root))


def create_shortcuts(root):
    command = launcher(root)
    if os.name == 'nt':
        for title,action in [('打开管理台','open'),('启动管理台','start'),('停止管理台','stop'),('查看运行状态','status')]:
            (root / (title + '.cmd')).write_text('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n' + subprocess.list2cmdline(command + [action]).replace('%','%%') + '\r\n',encoding='utf-8')
    else:
        for title,action in [('打开管理台','open'),('启动管理台','start'),('停止管理台','stop'),('查看运行状态','status')]:
            path = root / (title + ('.command' if sys.platform == 'darwin' else '.sh'))
            path.write_text('#!/bin/sh\nexec ' + shlex.join(command + [action]) + '\n')
            path.chmod(0o700)


def defer_windows_uninstall(root, marker, purge):
    # Windows locks the running Python executable. A private external helper waits
    # for this exact process to exit before removing its runtime or application.
    directory = storage.private_directory(Path(tempfile.mkdtemp(prefix='openclaw-uninstall-')))
    script = directory / 'cleanup.ps1'
    shutil.copy2(SOURCE / 'scripts/install/windows_cleanup.ps1', script)
    storage.protect(script)
    request = directory / 'request.json'
    paths = [str(root)] if purge else [str(root / name) for name in ['app','runtime','cache']]
    storage.write_json(request, {'parentPid':os.getpid(), 'root':str(root), 'installationId':marker['id'], 'paths':paths, 'purge':purge})
    shell = shutil.which('powershell.exe') or shutil.which('pwsh.exe')
    if not shell: raise RuntimeError('缺少 Windows PowerShell，尚未删除运行时；请从安装入口重新运行卸载。')
    with (directory / 'cleanup.log').open('ab') as log:
        subprocess.Popen([shell,'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script),'-RequestPath',str(request)],
                         stdin=subprocess.DEVNULL,stdout=log,stderr=log,**storage.detached_options())
    return directory / 'result.json'


def uninstall(root, purge=False):
    marker = read_json(root / 'installation.json', {})
    if not marker.get('id'): raise RuntimeError('缺少安装标记，未删除文件。')
    stop(root)
    mode = marker.get('backgroundMode')
    if mode == 'systemd': subprocess.run(['systemctl','--user','disable',service_unit(root)],capture_output=True)
    if mode == 'scheduled-task': subprocess.run(['schtasks.exe','/Delete','/TN',service_task(root),'/F'],capture_output=True)
    if mode not in ('managed-process', None):
        for path in unit_paths(root): path.unlink(missing_ok=True)
    if mode == 'systemd': subprocess.run(['systemctl','--user','daemon-reload'],capture_output=True)
    # Keep configuration, registries and native credentials unless purge is explicitly requested.
    if purge:
        values, env = environment(root)
        registry = read_json(root / 'data/instances.json',{'instances':{}})
        helper = str(root / 'app/openclaw-farm/scripts/keychain_store.py')
        for instance in registry.get('instances',{}):
            attributes = [{'instance':instance}] + [{'instance':instance,'scope':scope} for scope in ['read','write','delete','all']]
            for index, attrs in enumerate(attributes):
                service = 'openclaw-farm' if index == 0 else 'openclaw-file-bridge'
                account = json.dumps(attrs,sort_keys=True,ensure_ascii=True,separators=(',',':'))
                request = json.dumps({'action':'delete','service':service,'account':account})
                result = subprocess.run([values['python'],helper],input=request,text=True,capture_output=True,env=env)
                if result.returncode: raise RuntimeError('系统凭据未能删除，保留了数据供恢复；请解锁后重试 purge。')
    if sys.platform == 'win32':
        storage.write_json(root / 'installation.json', {**marker,'uninstalled':True,'backgroundMode':None,'uninstallPending':True})
        result = defer_windows_uninstall(root, marker, purge)
        print('卸载清理将在当前程序退出后完成。状态记录：' + str(result))
        return
    if purge:
        shutil.rmtree(root)
    else:
        for name in ['app','runtime','cache']:
            if (root / name).exists(): shutil.rmtree(root / name)
        # Keep control.py + marker as a recovery entry, but advertise uninstalled accurately.
        storage.write_json(root / 'installation.json',{**marker,'uninstalled':True,'backgroundMode':None})
    print('已卸载。' + ('' if purge else '配置、登记和系统凭据已保留。'))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Portable OpenClaw Farm Console')
    parser.add_argument('action',nargs='?',default='status',choices=['install','start','status','stop','open','uninstall','mcp','farm','serve'])
    parser.add_argument('--home',help='Private application data directory (useful for isolated tests)')
    parser.add_argument('--port',type=int,help='Console loopback port for installation')
    parser.add_argument('--no-start',action='store_true',help='Install without starting the console')
    parser.add_argument('--no-autostart',action='store_true',help='Use a detached managed process without registering login startup')
    parser.add_argument('--purge',action='store_true',help='Explicitly delete native credentials and retained user data on uninstall')
    actual_argv = list(sys.argv[1:] if argv is None else argv)
    farm_arguments = []
    if 'farm' in actual_argv:
        position = actual_argv.index('farm')
        farm_arguments, actual_argv = actual_argv[position + 1:], actual_argv[:position + 1]
    args = parser.parse_args(actual_argv)
    root = app_root(args.home)
    if args.action == 'install': install(root,args.port,args.no_start,args.no_autostart)
    elif args.action == 'serve': return serve(root)
    elif args.action == 'mcp': return mcp(root)
    elif args.action == 'farm':
        values, env = environment(root)
        return subprocess.call([values['python'],str(root / 'app/openclaw-farm/scripts/openclaw_farm.py'),*farm_arguments],env=env,cwd=root)
    elif args.action in ('start','open'):
        url = start(root)
        print('管理台已运行：' + url)
        if args.action == 'open': webbrowser.open(url)
    elif args.action == 'stop': stop(root); print('管理台已停止。')
    elif args.action == 'uninstall': uninstall(root,args.purge)
    else:
        status = live_status(root) if (root / 'config/local.json').is_file() else None
        print(json.dumps(status,ensure_ascii=False,indent=2) if status else '管理台当前未运行。')
    return 0

if __name__ == '__main__':
    try: raise SystemExit(main())
    except KeyboardInterrupt: raise SystemExit(130)
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        raise SystemExit(1)
