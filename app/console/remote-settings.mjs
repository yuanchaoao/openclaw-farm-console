// Linux instance commands remain readable for byte-for-byte exec approval.
export function configureBridgeCommand(command, options = {}) {
  const workspace=options.workspace || process.env.OPENCLAW_BRIDGE_WORKSPACE || '/home/node/.openclaw/workspace';
  const port=Number(options.podPort || process.env.OPENCLAW_BRIDGE_POD_PORT || 18081);
  if(!/^\/[A-Za-z0-9_./-]+$/.test(workspace) || workspace.split('/').includes('..') || !Number.isInteger(port) || port<1024 || port>65535)throw Error('远端文件桥工作区或端口配置无效');
  // Some composed commands include already-configured helper steps. Protect
  // their paths so a workspace beneath the default path is never rewritten
  // twice, and add a listening port only once.
  const literalMarker='\u0000OPENCLAW_WORKSPACE_LITERAL\u0000',patternMarker='\u0000OPENCLAW_WORKSPACE_PATTERN\u0000';
  const workspacePattern=workspace.replace(/\./g,'[.]');
  let prepared=command;
  if(workspace.includes('/home/node/.openclaw/workspace'))prepared=prepared.replaceAll(workspace,literalMarker);
  if(workspacePattern.includes('/home/node/[.]openclaw/workspace'))prepared=prepared.replaceAll(workspacePattern,patternMarker);
  return prepared
    .replaceAll('/home/node/.openclaw/workspace',workspace)
    .replaceAll('/home/node/[.]openclaw/workspace',workspacePattern)
    .replaceAll('/home/node/.ssh/openclaw_tunnel',"' + str(Path.home()) + '/.ssh/openclaw_tunnel")
    .replace(/127\.0\.0\.1:18081\b/g,`127.0.0.1:${port}`)
    .replace(/\("127\.0\.0\.1",18081\)/g,`("127.0.0.1",${port})`)
    .replace(/(nohup python3 "\$(?:D|BRIDGE_DIR)\/server\.py")(?! --port\b)/g,`$1 --port ${port}`)
    .replaceAll(literalMarker,workspace).replaceAll(patternMarker,workspacePattern);
}
