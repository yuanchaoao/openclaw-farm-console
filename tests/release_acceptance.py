#!/usr/bin/env python3
"""Exercise an installed console on the current OS, using no real instances."""
from __future__ import annotations
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import urllib.request
from unittest.mock import patch

TOOLS = {
    'openclaw_sessions_list', 'openclaw_chat_history', 'openclaw_chat_send',
    'openclaw_exec_approve', 'openclaw_list_instances', 'openclaw_run_bash',
    'openclaw_read_file', 'openclaw_file_list', 'openclaw_file_stat',
    'openclaw_file_read', 'openclaw_file_write', 'openclaw_file_upload',
    'openclaw_file_download', 'openclaw_file_move', 'openclaw_file_copy',
    'openclaw_file_delete', 'openclaw_file_mkdir',
}


def load_control(home):
    spec = importlib.util.spec_from_file_location('installed_control', home / 'control.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def mcp_check(home, env):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(command=sys.executable, args=[str(home / 'control.py'), 'mcp', '--home', str(home)], env=env)
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            found = {tool.name for tool in (await session.list_tools()).tools}
            assert found == TOOLS, 'MCP tool set differs from the published 17 tools'
            result = await session.call_tool('openclaw_list_instances', {})
            assert not result.isError, 'Read-only MCP instance listing failed'


def run(home, phase, payload, report):
    control = load_control(home)
    values, env = control.environment(home)
    checks = {}
    marker = control.read_json(home / 'installation.json')
    assert marker.get('id') and not marker.get('uninstalled')
    assert ' ' in str(home) and '中文' in str(home), 'Path fixture must include spaces and Chinese'
    checks['chineseAndSpacePath'] = True
    assert values['consolePort'] != 4317
    checks['customPort'] = True
    helper = home / 'app/openclaw-farm/scripts/keychain_store.py'

    def credential(action, value=None):
        request = {'action': action, 'service': 'openclaw-farm-console-ci', 'account': payload['account']}
        if value is not None: request['value'] = value
        result = subprocess.run([sys.executable, str(helper)], input=json.dumps(request), capture_output=True, text=True, encoding='utf-8', env=env)
        assert result.returncode == 0, 'Native credential operation failed (no plaintext fallback permitted)'
        return json.loads(result.stdout)

    if phase == 'before-upgrade':
        credential('set', payload['value'])
    actual = credential('get')
    assert actual.get('value') == payload['value'], 'Native credential round trip / upgrade retention failed'
    checks['nativeCredentialStore'] = True
    if phase == 'after-upgrade':
        assert marker['id'] == payload['installationId'], 'Upgrade changed installation identity'
        checks['upgradeIdentity'] = True
    url = control.start(home)
    assert url.endswith(':' + str(values['consolePort']))
    assert control.live_status(home), 'Console identity health check failed'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def http(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url + path, data=data, headers={'Content-Type': 'application/json', 'Origin': url})
        with opener.open(request, timeout=20) as response:
            assert response.status == 200
            return response.read()

    html = http('/connections.html').decode()
    assets = set(re.findall(r'(?:src|href)=["\'](/[^"\']+\.(?:css|js)(?:\?[^"\']*)?)["\']', html))
    assert len(assets) >= 3, 'Missing page resources'
    for asset in assets: assert len(http(asset)) > 100
    checks['pageResources'] = True
    if phase == 'before-upgrade':
        setup = {'consolePort': values['consolePort'], 'relay': {
            'host': 'relay.example.test', 'user': 'bridge', 'sshPort': 2222,
            'identityFile': str(home / 'config/隔离 密钥'), 'portRange': [19900, 20080],
        }, 'bridge': {'podPort': 18790, 'workspace': '/home/node/.openclaw/workspace'}}
        # Save the wizard without pretending a nonexistent relay passed connectivity.
        http('/api/setup', {'config': setup, 'complete': False})
        control.storage.write_json(home / 'data/ci-retained.json', {'fixture': 'upgrade-retention', 'id': marker['id']})
    saved = control.settings(home)
    assert saved['relay']['host'] == 'relay.example.test' and saved['relay']['sshPort'] == 2222
    assert control.read_json(home / 'data/ci-retained.json')['id'] == marker['id']
    checks['configurationAndTaskRetention'] = True
    setup_response = json.loads(http('/api/setup'))
    assert not setup_response.get('configured'), 'An unverified relay cannot be marked configured'
    checks['wizardDoesNotFakeRelaySuccess'] = True
    with patch.object(control.webbrowser, 'open', return_value=True) as opened:
        assert control.main(['open', '--home', str(home)]) == 0
        assert opened.call_args.args[0].startswith(url)
    checks['openAction'] = True
    asyncio.run(asyncio.wait_for(mcp_check(home, env), timeout=60))
    checks['mcpInitializeAnd17Tools'] = True
    control.stop(home)
    assert control.live_status(home) is None
    control.start(home)
    assert control.live_status(home)
    control.stop(home)
    checks['stopRestart'] = True
    if phase == 'after-upgrade':
        credential('delete')
        assert credential('get').get('value') is None
        checks['credentialDelete'] = True
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'platform': platform.system(), 'architecture': platform.machine(),
        'phase': phase, 'passed': True, 'checks': checks, 'mcpToolCount': len(TOOLS),
        'installationId': marker['id'], 'testedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'limitations': ['No production instance or relay was modified.', 'Remote Linux bridge and Gateway fixtures are tested separately.']},
        ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'phase': phase, 'passed': True, 'checks': len(checks)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--phase', choices=['before-upgrade', 'after-upgrade'], required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    run(args.home, args.phase, json.load(sys.stdin), args.report)
