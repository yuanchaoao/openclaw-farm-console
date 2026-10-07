import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function userDataRoot(env = process.env, osPlatform = platform(), home = homedir()) {
  if (env.OPENCLAW_HOME) return path.resolve(env.OPENCLAW_HOME);
  if (osPlatform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'OpenClaw Farm Console');
  if (osPlatform === 'darwin') return path.join(home, 'Library', 'Application Support', 'OpenClaw Farm Console');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'openclaw-farm-console');
}
export const CONFIG_FILE = process.env.OPENCLAW_CONFIG_FILE || path.join(userDataRoot(), 'config', 'local.json');
export async function readLocalConfig(file = CONFIG_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
const int = (value, label, minimum = 1, maximum = 65535) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw Error(`${label}必须是 ${minimum}–${maximum} 范围内的整数`);
  return number;
};
export function normalizeSetup(input, env = process.env) {
  const relay = input.relay || {}, bridge = input.bridge || {};
  const legacy = String(env.OPENCLAW_ORACLE_SECONDARY_HOST || env.OPENCLAW_ORACLE_HOST || '').split('@');
  const host = String(relay.host ?? (env.OPENCLAW_RELAY_HOST || legacy.at(-1) || '')).trim();
  const user = String(relay.user ?? (env.OPENCLAW_RELAY_USER || (legacy.length > 1 ? legacy[0] : ''))).trim();
  if (host && (!/^[A-Za-z0-9_.:\[\]-]+$/.test(host) || host.startsWith('-'))) throw Error('中继主机应填写域名或 IP 地址');
  if (user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw Error('SSH 用户名格式无效');
  const range = relay.portRange || [env.OPENCLAW_BRIDGE_PORT_MIN || 19900, env.OPENCLAW_BRIDGE_PORT_MAX || 20080];
  if (!Array.isArray(range) || range.length !== 2) throw Error('文件桥端口范围需要起止两个端口');
  const portRange = range.map(n => int(n, '文件桥端口', 1024));
  // Client restrictions enumerate ports on one OpenSSH authorized_keys line.
  // Keep that line below OpenSSH's 8 KiB limit, including the key and comment.
  if (portRange[0] > portRange[1] || portRange[1] - portRange[0] > 255) throw Error('文件桥端口范围无效（最多 256 个端口）');
  const identityFile = String(relay.identityFile ?? (env.OPENCLAW_RELAY_KEY || env.OPENCLAW_ORACLE_KEY || path.join(homedir(), '.ssh', 'openclaw_farm_relay')));
  if (identityFile.includes('\0') || !path.isAbsolute(identityFile)) throw Error('SSH 私钥需要填写本机绝对路径');
  const workspace = String(bridge.workspace ?? (env.OPENCLAW_BRIDGE_WORKSPACE || '/home/node/.openclaw/workspace'));
  // These bytes are reused in readable, exactly approved Linux maintenance commands.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(workspace) || workspace.split('/').includes('..')) throw Error('远端工作区需要绝对路径，仅支持英文、数字、下划线、点和连字符');
  return {
    consolePort: int(input.consolePort ?? (env.OPENCLAW_UI_PORT || 4317), '管理台端口', 1024),
    relay: { host, user, sshPort: int(relay.sshPort ?? (env.OPENCLAW_RELAY_SSH_PORT || 22), 'SSH 端口'), identityFile, portRange },
    bridge: { podPort: int(bridge.podPort ?? (env.OPENCLAW_BRIDGE_POD_PORT || 18081), '远端文件桥端口', 1024), workspace },
    setupComplete: input.setupComplete === true
  };
}
export function setupEnvironment(setup) {
  return {
    OPENCLAW_UI_PORT: String(setup.consolePort),
    OPENCLAW_RELAY_HOST: setup.relay.host, OPENCLAW_RELAY_USER: setup.relay.user,
    OPENCLAW_RELAY_SSH_PORT: String(setup.relay.sshPort), OPENCLAW_RELAY_KEY: setup.relay.identityFile,
    OPENCLAW_BRIDGE_PORT_MIN: String(setup.relay.portRange[0]), OPENCLAW_BRIDGE_PORT_MAX: String(setup.relay.portRange[1]),
    OPENCLAW_BRIDGE_POD_PORT: String(setup.bridge.podPort), OPENCLAW_BRIDGE_WORKSPACE: setup.bridge.workspace
  };
}
export async function persistSetup(setup, file = CONFIG_FILE) {
  // Read immediately before writing: installers may have updated runtime paths.
  const latest = await readLocalConfig(file);
  const merged = { ...latest, ...setup, environment: { ...(latest.environment || {}), ...setupEnvironment(setup) } };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(merged, null, 2) + '\n', {mode:0o600,flag:'wx'}); await rename(temporary,file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return merged;
}
export function staticFilePath(root, requestPath, pathApi = path) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const target = pathApi.resolve(root, decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, ''));
  const relative = pathApi.relative(root, target);
  return relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative) ? null : target;
}
export function requireRelayConfig(setup) {
  if (!setup.relay.host || !setup.relay.user) throw Object.assign(Error('请先完成首次配置，填写中继主机和 SSH 用户'), {code:'RELAY_SETUP_REQUIRED'});
}
