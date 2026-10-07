// The probe runs on Oracle, not on the Mac: a local -L process can remain
// alive after the Pod -> Oracle reverse listener has disappeared.
export function oracleBridgeHealthProbeScript(port, token) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('文件桥端口无效');
  if (!/^[A-Za-z0-9._-]{20,512}$/.test(token)) throw Error('文件桥凭据无效');
  return [
    'import http.client, json, sys',
    `port = ${port}`,
    `token = ${JSON.stringify(token)}`,
    'try:',
    '    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=4)',
    '    connection.request("GET", "/health", headers={"X-OpenClaw-Token": token})',
    '    response = connection.getresponse()',
    '    body = response.read(4096)',
    '    if response.status != 200 or json.loads(body).get("ok") is not True:',
    '        raise ValueError("unexpected health response")',
    'except ConnectionRefusedError:',
    '    print("OPENCLAW_ORACLE_LISTENER_ABSENT", file=sys.stderr)',
    '    sys.exit(11)',
    'except (OSError, ValueError, TypeError, AttributeError):',
    '    print("OPENCLAW_ORACLE_LISTENER_UNHEALTHY", file=sys.stderr)',
    '    sys.exit(12)',
    'finally:',
    '    try: connection.close()',
    '    except NameError: pass',
  ].join('\n') + '\n';
}

export function oracleBridgeProbeStatus(error) {
  const message = String(error?.message || error || '');
  if (message.includes('OPENCLAW_ORACLE_LISTENER_ABSENT')) return 'absent';
  if (message.includes('OPENCLAW_ORACLE_LISTENER_UNHEALTHY')) return 'unhealthy';
  return 'unknown';
}
