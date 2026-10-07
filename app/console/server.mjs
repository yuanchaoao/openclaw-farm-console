import {bridgeInstallSteps} from './maintenance-command.mjs';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { CONFIG_FILE, userDataRoot, readLocalConfig, normalizeSetup, setupEnvironment, persistSetup, staticFilePath, requireRelayConfig } from "./local-config.mjs";
import {configureBridgeCommand} from "./remote-settings.mjs";
import { buildClientAuthorizationScript } from "./relay-setup.mjs";
import { createWorkPool, concurrencyLimit } from "./concurrency.mjs";
import { createServer as createTcpServer } from "node:net";
import { access, lstat } from "node:fs/promises";
import { approveMaintenanceExec } from "./exec-approval.mjs";
import { maintenanceResults, waitForMaintenance, parseBridgeInstallResult, maintenanceMarkerPresent,maintenanceRequestDigest } from "./maintenance-results.mjs";
import { bridgeProgramInstall } from "./bridge-installer.mjs";
import { buildOracleAuthorizationScript } from "./oracle-authorization.mjs";
import { sendMaintenanceRequest } from "./maintenance-send.mjs";
import { readBridgeCredential, buildBridgeDeleteRepair, bridgeProcessStopSteps } from "./bridge-auth-repair.mjs";
import { ensureInternalPermissions } from "./permission-repair.mjs";
import { assessMaintenanceRecovery, verifiedFailedTurnEnded,verifiedRejectedTurnEnded,verifiedSettledInstallTurn,verifiedLegacyDownloadFailure,verifiedPhaseForContinuation } from "./maintenance-recovery.mjs";
import {bridgePortClaims,exclusivelyClaimed} from './bridge-port-claims.mjs';
import {existingBridgeProbeCommand,parseExistingBridgeProbe,parseBridgeRestartPublicKey,shouldRenewExistingBridgeProbe} from './bridge-existing-probe.mjs';
import {executionCommandFingerprint,executionProbeCommand,parseExecutionProbe} from './bridge-execution-probe.mjs';
import { validateBridgeOperations as validateFiles } from "./bridge-validation.mjs";
import { PairingCoordinator } from "./pairing-coordinator.mjs";
import { openJobStore, publicJob } from "./connection-job-store.mjs";
import { getPerformanceProfile } from "./performance-profile.mjs";
import {isArchived,requireActiveRecord,archiveRecord,archiveJob} from './instance-lifecycle.mjs';
import {checkBridgeWithRecovery,resumeVerifiedBridgePhase,shouldRepairExistingBridgeRoute} from './bridge-health-recovery.mjs';
import {isBatchEligibleInstance,requireInstanceAuthorization} from './instance-usage-policy.mjs';
import {oracleBridgeHealthProbeScript,oracleBridgeProbeStatus} from './oracle-bridge-liveness.mjs';

const HOST = "127.0.0.1";
let setupConfig = normalizeSetup(await readLocalConfig());
Object.assign(process.env, setupEnvironment(setupConfig));
const PORT = setupConfig.consolePort;
const PROJECT_ROOT = resolve(import.meta.dirname);
const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const DATA_ROOT = process.env.OPENCLAW_UI_DATA_DIR || join(userDataRoot(), "data");
const THREADS_FILE = join(DATA_ROOT, "threads.json");
const INSTANCES_FILE = process.env.OPENCLAW_INSTANCES_FILE || join(userDataRoot(), "data", "instances.json");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const FARM_SCRIPT = process.env.OPENCLAW_FARM_SCRIPT || resolve(PROJECT_ROOT, "../openclaw-farm/scripts/openclaw_farm.py");
const PYTHON_BIN = process.env.OPENCLAW_PYTHON_BIN || "python3";
const FARM_SKILL = resolve(dirname(FARM_SCRIPT), "../SKILL.md");
let RELAY_DESTINATION = setupConfig.relay.user && setupConfig.relay.host ? `${setupConfig.relay.user}@${setupConfig.relay.host}` : "";
let RELAY_KEY = setupConfig.relay.identityFile;
const queues = new Map();
const performanceProfile = getPerformanceProfile();
const gatewayPool = createWorkPool(concurrencyLimit(process.env.OPENCLAW_GATEWAY_CONCURRENCY, performanceProfile.gatewayConcurrency, 32));
const sshPool = createWorkPool(concurrencyLimit(process.env.OPENCLAW_SSH_CONCURRENCY, performanceProfile.sshConcurrency, 10));
const healthPool = createWorkPool(6);
const bridgeBatches = new Map();
const bridgePortReservations = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function readRegistry() {
  try {
    return JSON.parse(await readFile(INSTANCES_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { schema_version: 2, instances: {} };
    throw error;
  }
}

async function readInstances() {
  const raw = await readRegistry();
  return Object.values(raw.instances || {}).filter(item=>!isArchived(item)).map((item) => {
    const result = {
    id: item.id,
    name: item.name || item.id,
    status: item.status || "unknown",
    webUrl: item.web_url,
    hasCredential: item.status !== "pending_credential",
    fileBridge: item.file_bridge
      ? {
          status: item.file_bridge.status || "configured",
          transport: item.file_bridge.transport || "unknown",
          version: item.file_bridge.version || "unknown"
        }
      : null
    };
    return {...result,batchEligible:isBatchEligibleInstance(result),protectedName:!isBatchEligibleInstance(result)};
  });
}

async function readAuthorizedInstance(instanceId, options = {}) {
  const instance = (await readInstances()).find((item) => item.id === instanceId);
  if (!instance) throw new Error("实例不存在或尚未注册");
  return requireInstanceAuthorization(instance, options);
}

function normalizeInstanceName(value, instanceId) {
  if (typeof value !== "string") throw new Error("备注名必须是文字");
  const name = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("备注名不能包含控制字符");
  if (Array.from(name).length > 40) throw new Error("备注名不能超过 40 个字");
  return name || instanceId;
}

async function updateInstanceName(instanceId, requestedName) {
  return enqueue("registry-mutations", () => updateInstanceNameRaw(instanceId, requestedName));
}

async function updateInstanceNameRaw(instanceId, requestedName) {
  const registry = await readRegistry();
  const instance = requireActiveRecord(registry,instanceId);
  const name = normalizeInstanceName(requestedName, instanceId);
  instance.name = name;
  const fileInfo = await stat(INSTANCES_FILE);
  const tempFile = join(dirname(INSTANCES_FILE), `.instances.${randomUUID()}.tmp`);
  try {
    await writeFile(tempFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: fileInfo.mode & 0o777 });
    await rename(tempFile, INSTANCES_FILE);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
  return name;
}

async function archiveInstance(instanceId) {
  return enqueue('registry-mutations',async()=>{
    const registry=await readRegistry();
    const archivedAt=archiveRecord(registry,instanceId);
    const archiveDir=join(DATA_ROOT,'archives',`instance-removal-${instanceId}-${archivedAt}`);
    await mkdir(archiveDir,{recursive:true,mode:0o700});
    const related=[...connectionJobs.values()].filter(job=>job.instanceId===instanceId);
    // Keep audit history, but not credentials or remote command bodies.
    await writeFile(join(archiveDir,'event.json'),JSON.stringify({instanceId,archivedAt,reason:'user_removed_from_ui',jobs:related.map(publicJob)},null,2),{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const temporary=join(dirname(INSTANCES_FILE),`.instances.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary,JSON.stringify(registry,null,2)+'\n',{mode:0o600});
      await rename(temporary,INSTANCES_FILE);
    } catch(error) {await unlink(temporary).catch(()=>{});throw error;}
    for(const job of related)archiveJob(job,archivedAt);
    pairingCoordinator.records.delete(instanceId);
    activeConnectionJobs.delete(instanceId);
    await jobStore.save();
    return {instanceId,archivedAt,archived:true};
  });
}

async function readThreads() {
  try {
    return JSON.parse(await readFile(THREADS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeThreads(threads) {
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  const temp = `${THREADS_FILE}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(threads, null, 2), { mode: 0o600 });
  await rename(temp, THREADS_FILE);
}

function redactText(value) {
  return String(value)
    .replace(/(?:sk-[A-Za-z0-9_-]{10,}|fb_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]+)/g, "[REDACTED]")
    .replace(/'fb_'(?:'[A-Za-z0-9]+')+/g, "[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED]");
}

function chineseError(value) {
  const text = redactText(value?.message || value || "").trim();
  const localIssue = text.split(/\r?\n/).find((line) => /钥匙串|客户端 SDK|中继私钥/.test(line));
  if (localIssue) return localIssue.replace(/^.*?(?=[\u3400-\u9fff])/, "").slice(0, 240);
  if (/pairing required/i.test(text)) return "Gateway 需要完成配对。";
  if (/EROFS|read-only file system/i.test(text)) return "无法写入：目标目录是只读的。";
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(text)) return "操作失败：当前程序没有所需权限。";
  if (/ENOENT|no such file or directory/i.test(text)) return "操作失败：找不到所需文件或目录。";
  if (/ECONNREFUSED|connection refused/i.test(text)) return "连接被拒绝，请检查服务或隧道是否在线。";
  if (/URLError|ENOTFOUND|name or service not known/i.test(text)) return "无法连接远端服务，请检查网络或隧道。";
  if (/ETIMEDOUT|timed? out|timeout/i.test(text)) return "连接超时，请稍后重试。";
  if (/spawn.*codex|codex.*ENOENT/i.test(text)) return "未找到本机 Codex 命令行工具。";
  if (/JSON|unexpected token/i.test(text)) return "服务返回的数据格式异常。";
  const exitCode = text.match(/(?:exit code|退出码)\s*(\d+)/i)?.[1];
  if (exitCode) return `操作失败，退出码 ${exitCode}。`;
  if (/fetch failed|network error|socket hang up/i.test(text)) return "网络连接失败，请检查连接状态。";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
  if (/[\u3400-\u9fff]/.test(firstLine)) {
    return firstLine.replace(/^openclaw-farm:\s*/i, "OpenClaw：").slice(0, 240);
  }
  return "操作失败，请稍后重试或检查连接状态。";
}

function sanitizeFarmResult(value) {
  if (Array.isArray(value)) return value.map(sanitizeFarmResult);
  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^(token|secret|private_key|api_key|credential_ref|credential_refs)$/i.test(key)) continue;
      clean[key] = sanitizeFarmResult(child);
    }
    return clean;
  }
  return typeof value === "string" ? redactText(value) : value;
}

function compactJson(value) {
  const content = JSON.stringify(value, null, 2);
  return content.length > 6000 ? `${content.slice(0, 6000)}\n…内容已截断` : content;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function collectTextValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectTextValues(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectTextValues(item, output));
  return output.join("\n");
}

function actionMessage(action, result) {
  if (action === "instance_status") {
    const bridge = result.file_bridge;
    return [
      `实例：${result.name || result.id || "未知"}`,
      `状态：${result.status || "未知"}`,
      `控制凭据：${result.credential_present === false ? "缺失" : "已登记"}`,
      `文件桥：${bridge?.status || "未配置"}`
    ].join("\n");
  }
  if (action === "file_list") {
    const entries = result.entries || result.result?.entries || result.items;
    if (Array.isArray(entries)) {
      if (!entries.length) return "工作区目录为空。";
      const lines = entries.slice(0, 100).map((item) => {
        const name = String(item.name || item.path || "未命名").replace(/[\r\n]/g, " ");
        const kind = item.type || item.kind || (item.is_dir ? "directory" : "file");
        const size = Number.isFinite(item.size) ? ` · ${item.size} B` : "";
        return `${kind === "directory" || kind === "dir" ? "[目录]" : "[文件]"} ${name}${size}`;
      });
      if (entries.length > 100) lines.push(`…另有 ${entries.length - 100} 项`);
      return lines.join("\n");
    }
  }
  if (action === "bridge_health") return `文件桥检查完成：\n${compactJson(result)}`;
  if (action === "gateway_sessions") return `Gateway 会话状态：\n${compactJson(result)}`;
  return compactJson(result);
}

async function runFarmAction(instanceId, action, pathValue = ".") {
  const commands = {
    instance_status: ["status", instanceId],
    bridge_health: ["bridge-health", instanceId],
    file_list: ["file-list", instanceId, pathValue],
    gateway_sessions: ["call", instanceId, "sessions.list"]
  };
  const args = commands[action];
  if (!args) throw new Error("不支持的快捷操作");
  if (typeof pathValue !== "string" || pathValue.length > 1024 || pathValue.includes("\0")) {
    throw new Error("文件路径无效");
  }
  const output = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PYTHON_BIN, [FARM_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), 35_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) rejectPromise(new Error("快捷操作返回内容过大"));
      else if (signal === "SIGTERM") rejectPromise(new Error("快捷操作超时"));
      else if (code !== 0) rejectPromise(new Error(redactText(stderr.trim() || `快捷操作退出码 ${code}`)));
      else resolvePromise(stdout.trim());
    });
  });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = { output };
  }
  const result = sanitizeFarmResult(parsed);
  return { action, result, message: actionMessage(action, result) };
}

async function runFarmCommand(...params) {
  const args = params[0];
  const invoke = () => ["call", "verify"].includes(args[0])
    ? (args[0] === "verify" || ["health","status"].includes(args[2]) ? healthPool : gatewayPool).run(() => runFarmCommandRaw(...params))
    : runFarmCommandRaw(...params);
  if (["register", "bridge-configure"].includes(args[0]) || (args[0] === "verify" && !args.includes("--no-save"))) {
    return enqueue("registry-mutations", invoke);
  }
  return invoke();
}

async function runFarmCommandRaw(args, stdinValue = "", acceptedCodes = [0], timeoutMs = 45_000, sanitizeOutput = true) {
  // Check inside the queue, immediately before spawning, so stale windows and
  // queued recovery steps cannot dispatch work after a UI removal.
  const target=args[0]==='register'?args[args.indexOf('--instance-id')+1]:args[1];
  if(/^ins_[a-z0-9]+$/i.test(target || '')) {
    const registry=await readRegistry();
    if(isArchived(registry.instances?.[target]))requireActiveRecord(registry,target);
  }
  const output = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PYTHON_BIN, [FARM_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGTERM") rejectPromise(new Error("操作超时或返回内容过大"));
      else if (!acceptedCodes.includes(code)) {
        const rawError = stderr.trim() || stdout.trim() || `操作退出码 ${code}`;
        let errorCode='FARM_COMMAND_FAILED', message=rawError;
        if(/Exec approval registration failed/i.test(rawError)){errorCode='REMOTE_INTERNAL_APPROVAL_BLOCKED';message='远端内部执行审批客户端未通过配对核验';}
        else if(/unknown requestId/i.test(rawError)){errorCode='EXEC_APPROVAL_EXPIRED';message='该申请已不在当前待批准队列，请核验原执行结果';}
        else if(/pairing required/i.test(rawError)){errorCode='PAIRING_REQUIRED';message='当前 Gateway 操作需要核验设备或权限配对';}
        else if(/timed? out|timeout|gateway closed|ECONNRESET/i.test(rawError)){errorCode='TRANSIENT_CONNECTION';message='Gateway 连接暂时中断或超时';}
        rejectPromise(Object.assign(new Error(redactText(message)),{code:errorCode,...(errorCode==='REMOTE_INTERNAL_APPROVAL_BLOCKED'?{approvalKind:'remote_internal'}:{})}));
      }
      else resolvePromise(stdout.trim());
    });
    child.stdin.end(stdinValue);
  });
  try {
    const parsed = JSON.parse(output);
    return sanitizeOutput ? sanitizeFarmResult(parsed) : parsed;
  } catch {
    return { output: sanitizeOutput ? redactText(output) : output };
  }
}

function parseInstanceId(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) throw new Error("实例链接无效");
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("请输入完整的 OpenClaw 实例链接");
  }
  if (!['https:', 'wss:'].includes(parsed.protocol)) throw new Error("实例链接必须使用 HTTPS 或 WSS");
  const instanceId = parsed.pathname.split("/").find((part) => /^ins_[a-z0-9]+$/i.test(part));
  if (!instanceId) throw new Error("链接中没有找到实例 ID");
  return instanceId;
}

async function registerConnection(body) {
  const instanceId = parseInstanceId(body.url);
  if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 512) {
    throw new Error("Token 格式不正确");
  }
  const args = [
    "register", "--instance-id", instanceId,
    "--url", body.url.trim(),
    "--token-stdin"
  ];
  if (body.replace === true) args.push("--replace");
  if (body.deferHealth === true) args.push("--skip-health");
  const result = await runFarmCommand(args, `${body.token}\n`, [0, 4], 120_000);
  const name = normalizeInstanceName(body.name || "", instanceId);
  if (name !== instanceId) await updateInstanceName(instanceId, name);
  const status = result?.instance?.status || "registered_unverified";
  const message = status === "pairing_required"
    ? "注册成功，凭据已保存；Gateway 正在等待配对。"
    : status === "registered_unverified"
      ? "注册成功，凭据已保存；Gateway 暂未验通。"
      : "注册并检查完成，凭据已安全保存。";
  return { instanceId, name, status, message, result };
}

async function configureBridgeConnection(body) {
  const instances = await readInstances();
  if (!instances.some((item) => item.id === body.instanceId)) throw new Error("实例不存在或尚未注册");
  if (typeof body.baseUrl !== "string" || body.baseUrl.length > 2048) throw new Error("文件桥地址无效");
  if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 512) {
    throw new Error("文件桥 Token 格式不正确");
  }
  const workspace = typeof body.workspace === "string" && body.workspace.trim()
    ? body.workspace.trim()
    : setupConfig.bridge.workspace;
  await runFarmCommand([
    "bridge-configure", body.instanceId,
    "--transport", "direct_http",
    "--base-url", body.baseUrl.trim(),
    "--workspace", workspace
  ]);
  const secretArgs = ["bridge-secret", body.instanceId, "--scope", "all", "--token-stdin"];
  if (body.replace === true) secretArgs.push("--replace");
  const result = await runFarmCommand(secretArgs, `${body.token}\n`);
  return { instanceId: body.instanceId, result };
}

function validateBridgeToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{20,512}$/.test(value)) {
    throw new Error("文件桥 Token 格式不正确");
  }
  return value;
}

async function nextBridgePort(instanceId, { probeRelay = runSsh } = {}) {
  return enqueue("bridge-port-allocation", async () => {
    const registry = await readRegistry();
    const claims=bridgePortClaims(registry,[...connectionJobs.values()],bridgePortReservations);
    const reserved=bridgePortReservations.get(instanceId);
    if(reserved >= setupConfig.relay.portRange[0] && reserved <= setupConfig.relay.portRange[1] && exclusivelyClaimed(claims,instanceId,reserved))return reserved;
    const used = new Set(claims.keys());
    for (const port of bridgePortReservations.values()) used.add(port);
    for (const item of Object.values(registry.instances || {})) {
      for (const key of ["local_port", "relay_port"]) if (item.file_bridge?.[key]) used.add(Number(item.file_bridge[key]));
    }
    for (let port = setupConfig.relay.portRange[1]; port >= setupConfig.relay.portRange[0]; port -= 1) {
      if (used.has(port)) continue;
      const available = await new Promise((done) => {
        const probe = createTcpServer();
        probe.once("error", () => done(false));
        probe.listen(port, HOST, () => probe.close(() => done(true)));
      });
      if (available) {
        // A different computer may already own this relay port. Reserve only a
        // free 中继服务器 listener as well as a free client listener.
        const probe=`import socket\ns=socket.socket()\ns.settimeout(2)\nraise SystemExit(1 if s.connect_ex(('127.0.0.1',${port}))==0 else 0)\n`;
        try {await probeRelay(['-p',String(setupConfig.relay.sshPort),'-T','-i',RELAY_KEY,'-o','BatchMode=yes','-o','ConnectTimeout=10',RELAY_DESTINATION,'python3 -'],probe);}
        catch(error){if(/退出码 1$/.test(error.message))continue;throw error;}
        bridgePortReservations.set(instanceId, port);
        return port;
      }
    }
    throw new Error("没有可分配的文件桥端口");
  });
}

async function assertRelayReady(selectedSetup = setupConfig) {
  requireRelayConfig(selectedSetup);
  let info;
  try { info = await lstat(selectedSetup.relay.identityFile); } catch {
    throw Object.assign(new Error("文件桥尚缺此电脑 的 中继服务器 SSH 认证。MCP 控制连接不受影响；文件桥安装尚未完成。"), { code: "RELAY_SETUP_REQUIRED" });
  }
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077))) {
    throw Object.assign(new Error("文件桥的中继私钥必须是仅当前用户可读的普通文件，请检查权限。"), { code: "RELAY_SETUP_REQUIRED" });
  }
}

let relayAuthPromise = null;
let relayVerifiedUntil = 0;
async function assertRelayAuthorized(runner = runSsh) {
  // All instances use this same client-to-relay identity. Share the short preflight;
  // actual key updates and forwarding still perform their own SSH authentication.
  if (runner !== runSsh) return verifyRelayAuthorization(runner);
  if (Date.now() < relayVerifiedUntil) return;
  if (!relayAuthPromise) {
    relayAuthPromise = verifyRelayAuthorization(runner).then(() => { relayVerifiedUntil = Date.now()+60_000; }).finally(() => {relayAuthPromise=null;});
  }
  return relayAuthPromise;
}

async function verifyRelayAuthorization(runner) {
  requireRelayConfig(setupConfig);
  try {
    await runner(["-p", String(setupConfig.relay.sshPort), "-T", "-i", RELAY_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", RELAY_DESTINATION, "true"]);
  } catch (error) {
    if (/Permission denied|publickey|no authentication/i.test(String(error.message))) {
      throw Object.assign(new Error("此电脑 的 SSH 密钥已创建，但 中继服务器 尚未接受它。请先在原电脑或 中继服务器 控制台执行为此电脑 准备的公钥授权文件，再继续安装文件桥。"), { code: "RELAY_SETUP_REQUIRED" });
    }
    throw error;
  }
}

function relayConfigArgs(instanceId, port) {
  const at = RELAY_DESTINATION.indexOf("@");
  return ["bridge-configure", instanceId, "--transport", "ssh_relay",
    "--local-port", String(port), "--pod-port", String(setupConfig.bridge.podPort),
    "--relay-host", at >= 0 ? RELAY_DESTINATION.slice(at + 1) : RELAY_DESTINATION,
    "--relay-user", setupConfig.relay.user, "--relay-ssh-port", String(setupConfig.relay.sshPort),
    "--relay-port", String(port), "--relay-key", RELAY_KEY,
    "--workspace", setupConfig.bridge.workspace];
}

async function createBridgePrompt(body) {
  const instances = await readInstances();
  if (!instances.some((item) => item.id === body.instanceId)) throw new Error("实例不存在或尚未注册");
  const token = validateBridgeToken(body.token);
  const port = await nextBridgePort(body.instanceId);
  const secretPayload = JSON.stringify({ tokens: [{ token, scopes: ["read", "write", "delete"] }] });
  const prompt = configureBridgeCommand([
    "请使用 exec 工具一次性执行下面全部命令。不要改写源码；执行完只返回校验、健康检查结果和最后打印的 SSH 公钥。",
    "",
    "BRIDGE_DIR='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
    "mkdir -p ~/.ssh \"$BRIDGE_DIR\"",
    "chmod 700 ~/.ssh \"$BRIDGE_DIR\"",
    "if [ ! -f ~/.ssh/openclaw_tunnel ]; then",
    "  ssh-keygen -t ed25519 -f ~/.ssh/openclaw_tunnel -N \"\" -C \"openclaw-tunnel\"",
    "fi",
    "chmod 600 ~/.ssh/openclaw_tunnel",
    "echo '=== 获取并校验文件桥程序 ==='",
    ...await bridgeProgramInstall("BRIDGE_DIR"),
    "echo \"文件桥程序已保存到：$BRIDGE_DIR/server.py\"",
    "umask 077",
    "cat > \"$BRIDGE_DIR/secrets.json\" << 'JSONEOF'",
    secretPayload,
    "JSONEOF",
    "chmod 600 \"$BRIDGE_DIR/secrets.json\"",
    "BRIDGE_EXTRA_ARGS=''",
    "if [ \"$(id -u)\" = '0' ]; then BRIDGE_EXTRA_ARGS=\"$BRIDGE_EXTRA_ARGS --allow-root-for-test\"; fi",
    "if ! python3 -c 'import os,sys; raise SystemExit(0 if os.path.ismount(sys.argv[1]) else 1)' /home/node/.openclaw/workspace; then BRIDGE_EXTRA_ARGS=\"$BRIDGE_EXTRA_ARGS --allow-unisolated-for-test\"; fi",
    "pkill -f 'openclaw-file-bridge/server' 2>/dev/null || true",
    "sleep 1",
    "nohup python3 \"$BRIDGE_DIR/server.py\" \\",
    "  --root /home/node/.openclaw/workspace \\",
    "  --secret-file \"$BRIDGE_DIR/secrets.json\" \\",
    "  --enable-write \\",
    "  --enable-delete \\",
    "  $BRIDGE_EXTRA_ARGS \\",
    "  > \"$BRIDGE_DIR/server.log\" 2>&1 &",
    "BRIDGE_OK=0",
    "for WAIT in 1 2 3 4 5 6 7 8 9 10; do",
    `  if curl -fsS -H 'X-OpenClaw-Token: ${token}' http://127.0.0.1:18081/health; then BRIDGE_OK=1; break; fi`,
    "  sleep 1",
    "done",
    "if [ \"$BRIDGE_OK\" != '1' ]; then",
    "  echo '文件桥启动失败，下面是原因：'",
    "  tail -n 40 \"$BRIDGE_DIR/server.log\" 2>/dev/null || true",
    "  exit 1",
    "fi",
    "echo '=== 文件桥健康检查 ==='",
    "echo '文件桥已正常运行'",
    "echo",
    "echo '=== SSH 公钥（完整复制回管理台）==='",
    "cat ~/.ssh/openclaw_tunnel.pub"
  ].join("\n"));
  return { instanceId: body.instanceId, port, prompt };
}

function runSsh(args, stdinValue = "") {
  return sshPool.run(async () => {
    for(let attempt=0;attempt<4;attempt++) {
      try { return await runSshRaw(args, stdinValue); }
      catch(error) {
        // A saturated relay can close a management connection without stderr,
        // which surfaces only as ssh exit 255. Treat that like the other
        // transient handshake failures, with the shared-relay backoff policy.
        if(attempt===3 || !/timed? out|timeout|Connection (?:reset|closed)|kex_exchange_identification|连接超时|中继服务器 操作退出码 255/i.test(error.message))throw error;
        await new Promise(resolve => setTimeout(resolve,15_000*(2**attempt)));
      }
    }
  });
}

function runSshRaw(args, stdinValue = "") {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("ssh", args.includes("-p") ? args : ["-p", String(setupConfig.relay.sshPort), ...args], { cwd: PROJECT_ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGTERM") rejectPromise(new Error("中继服务器 连接超时"));
      else if (code !== 0) rejectPromise(new Error(stderr.trim() || `中继服务器 操作退出码 ${code}`));
      else resolvePromise(true);
    });
    child.stdin.end(stdinValue);
  });
}

async function checkOracleBridgeListener(port, token) {
  try {
    await runSsh(['-T','-i',RELAY_KEY,'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new',RELAY_DESTINATION,'python3 -'], oracleBridgeHealthProbeScript(port, token));
    return 'healthy';
  } catch (error) {
    const status = oracleBridgeProbeStatus(error);
    if (status !== 'unknown') return status;
    throw Object.assign(Error('无法核验 中继服务器 文件桥监听端口：' + error.message), {code:'RELAY_PROBE_FAILED'});
  }
}

async function requireOracleBridgeListener(port, token) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await checkOracleBridgeListener(port, token);
    if (status === 'healthy') return;
    if (status === 'unhealthy') throw Object.assign(Error('中继服务器 端口已有监听，但文件桥健康或凭据核验失败，禁止覆盖其他隧道'), {code:'RELAY_LISTENER_UNHEALTHY'});
    if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Object.assign(Error('中继服务器 未出现此实例的文件桥监听端口，不能判定隧道已建立'), {code:'RELAY_LISTENER_ABSENT'});
}

async function authorizeBridge(body) {
  await assertRelayReady();
  const instances = await readInstances();
  if (!instances.some((item) => item.id === body.instanceId)) throw new Error("实例不存在或尚未注册");
  if (body.confirm !== true) throw new Error("请先确认本次 中继服务器 公钥授权");
  const token = validateBridgeToken(body.token);
  const hasRequestedPort = body.port !== null && body.port !== undefined && body.port !== "";
  const port = hasRequestedPort ? Number(body.port) : await nextBridgePort(body.instanceId);
  if (!Number.isInteger(port) || port < setupConfig.relay.portRange[0] || port > setupConfig.relay.portRange[1]) throw new Error("文件桥端口无效，请重新生成第一段提示词");
  const publicKey = typeof body.publicKey === "string"
    ? body.publicKey.trim().replace(/^ssh-ed2519\s+/, "ssh-ed25519 ")
    : "";
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?$/.test(publicKey)) {
    throw new Error("SSH 公钥格式不正确，请完整复制 ssh-ed25519 开头的一行");
  }

  const remoteScript = buildOracleAuthorizationScript({ publicKey, port, portRange: setupConfig.relay.portRange });
  try {
    await enqueue("oracle-authorized-keys", () => runSsh(["-i", RELAY_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", RELAY_DESTINATION, "python3 -"], remoteScript));
  } catch(error) {
    // A restarted relay can briefly close new management handshakes while an
    // already registered restricted bridge key remains valid. Let the actual
    // reverse-tunnel command prove authorization instead of blocking here.
    if(!/Connection (?:closed|reset)|kex_exchange_identification|timed? out|timeout/i.test(String(error.message)))throw error;
  }

  // bridge-health starts the portable managed local forward after the Pod's
  // reverse tunnel passes its real relay health check. Never use ssh -f here.
  await runFarmCommand(relayConfigArgs(body.instanceId, port));
  const repairPrompt = configureBridgeCommand([
    "请使用 exec 工具一次性执行下面全部命令。不要解释。请先自动修复文件桥，再建立或复用隧道，最后只返回验证结果。",
    "",
    "BRIDGE_DIR='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
    "if [ ! -f \"$BRIDGE_DIR/server.py\" ] || [ ! -f \"$BRIDGE_DIR/secrets.json\" ]; then echo '文件桥程序或配置缺失，请回管理台重新执行第一段提示词'; exit 1; fi",
    "BRIDGE_EXTRA_ARGS=''",
    "if [ \"$(id -u)\" = '0' ]; then BRIDGE_EXTRA_ARGS=\"$BRIDGE_EXTRA_ARGS --allow-root-for-test\"; fi",
    "if ! python3 -c 'import os,sys; raise SystemExit(0 if os.path.ismount(sys.argv[1]) else 1)' /home/node/.openclaw/workspace; then BRIDGE_EXTRA_ARGS=\"$BRIDGE_EXTRA_ARGS --allow-unisolated-for-test\"; fi",
    `if ! curl -fsS -H 'X-OpenClaw-Token: ${token}' http://127.0.0.1:18081/health >/dev/null 2>&1; then`,
    "  pkill -f 'openclaw-file-bridge/server' 2>/dev/null || true",
    "  sleep 1",
    "  nohup python3 \"$BRIDGE_DIR/server.py\" \\",
    "    --root /home/node/.openclaw/workspace \\",
    "    --secret-file \"$BRIDGE_DIR/secrets.json\" \\",
    "    --enable-write \\",
    "    --enable-delete \\",
    "    $BRIDGE_EXTRA_ARGS \\",
    "    > \"$BRIDGE_DIR/server.log\" 2>&1 &",
    "fi",
    "BRIDGE_OK=0",
    "for WAIT in 1 2 3 4 5 6 7 8 9 10; do",
    `  if curl -fsS -H 'X-OpenClaw-Token: ${token}' http://127.0.0.1:18081/health >/dev/null 2>&1; then BRIDGE_OK=1; break; fi`,
    "  sleep 1",
    "done",
    "if [ \"$BRIDGE_OK\" != '1' ]; then",
    "  echo '文件桥仍未启动，原因如下：'",
    "  tail -n 40 \"$BRIDGE_DIR/server.log\" 2>/dev/null || true",
    "  exit 1",
    "fi",
    `if pgrep -af '^ssh .*localhost:${port}' >/dev/null; then`,
    "  echo 'SSH 隧道已经存在，直接复用'",
    "else",
    `  ssh -p ${setupConfig.relay.sshPort} -f -N \\`,
    "    -o ExitOnForwardFailure=yes \\",
    "    -o ServerAliveInterval=30 \\",
    "    -o ServerAliveCountMax=3 \\",
    "    -o StrictHostKeyChecking=accept-new \\",
    "    -i ~/.ssh/openclaw_tunnel \\",
    `    -R localhost:${port}:127.0.0.1:18081 \\`,
    `    ${shellSingleQuote(RELAY_DESTINATION)}`,
    "fi",
    "sleep 2",
    "echo '=== 文件桥 ==='",
    `curl -fsS -H 'X-OpenClaw-Token: ${token}' http://127.0.0.1:18081/health`,
    "echo",
    "echo '=== SSH 隧道 ==='",
    `pgrep -af '^ssh .*localhost:${port}' || true`
  ].join("\n"));
  await runFarmCommand(["bridge-secret", body.instanceId, "--scope", "all", "--token-stdin", "--replace"], `${token}\n`);

  return {
    instanceId: body.instanceId,
    port,
    prompt: repairPrompt,
    localForwardStarted: false,
    message: "中继服务器已授权，请粘贴第二段提示词建立隧道；检查文件桥时会启动本机转发。"
  };
}

async function preferredBridgePort(instanceId) {
  const registry = await readRegistry();
  const claims=bridgePortClaims(registry,[...connectionJobs.values()],bridgePortReservations);
  const bridgeText = JSON.stringify(registry.instances?.[instanceId]?.file_bridge || {});
  const ports = [...bridgeText.matchAll(/(?:localhost|127\.0\.0\.1):(\d{4,5})/g)]
    .map((match) => Number(match[1]))
    .filter((port) => port >= setupConfig.relay.portRange[0] && port <= setupConfig.relay.portRange[1]);
  return ports.find(port=>exclusivelyClaimed(claims,instanceId,port)) || nextBridgePort(instanceId);
}

function pairingState(checked, instanceId) {
  const error = String(checked?.health_error || "");
  if (checked?.error_code !== "PAIRING_REQUIRED" && !/pairing required|scope upgrade pending approval/i.test(error)) return null;
  const requestId = checked.requestId || error.match(/requestId["\s:=]+([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i)?.[1];
  return {
    instanceId, online: false, stage: "pairing_required",
    ...(requestId ? { requestId } : {}),
    ...(checked.deviceId ? { deviceId: checked.deviceId } : {}),
    message: "公司 Gateway 已响应；这台电脑 的管理设备正在等待配对批准。",
    detail: "请在对应的公司 OpenClaw 实例中批准这台电脑 的设备请求，然后重新检查。无需重新填写 Token。"
  };
}

function gatewayFailureKind(checked) {
  const error = String(checked?.health_error || "");
  if (checked?.health_verified === true) return "online";
  if (checked?.error_code === "PAIRING_REQUIRED" || /pairing required|scope upgrade pending approval/i.test(error)) return "pairing";
  if (/device[_ ]token[_ ]mismatch/i.test(error)) return "device";
  if (/gateway token mismatch|token_mismatch|invalid[_ ]token|token (?:is )?invalid/i.test(error)) return "token_mismatch";
  if (/token[_ ]expired|token (?:has |is )?expired/i.test(error)) return "token_expired";
  if (/unauthori[sz]ed|authentication failed/i.test(error)) return "auth";
  if (/keychain|钥匙串|credential.*(?:missing|not found)|凭据.*不存在/i.test(error)) return "credential_store";
  if (/timed? out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|abnormal closure|gateway closed|connection (?:closed|reset|refused)|network/i.test(error)) return "transient";
  return "unknown";
}

async function checkMcpDirectRaw(body) {
  const instances = await readInstances();
  const instance = instances.find((item) => item.id === body.instanceId);
  if (!instance) throw new Error("实例不存在或尚未注册");
  if (!instance.hasCredential) throw new Error("该实例缺少控制凭据，请先完成注册");
  let checked = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    checked = await runFarmCommand(["verify", instance.id, "--timeout", "30000", "--no-save"], "", [0, 1, 4], 40_000);
    if (gatewayFailureKind(checked) !== "transient" || attempt === 3) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  if (checked.health_verified !== true) {
    const healthError = String(checked.health_error || "");
    const pairing = pairingState(checked, instance.id);
    if (pairing) return pairing;
    const kind = gatewayFailureKind(checked);
    if (kind === "token_mismatch") throw new Error("当前实例的 Gateway Token 与远端不匹配。已保存的 Token 仍在钥匙串中；请填写此实例当前 Token，并勾选更新已登记实例的凭据后重新登记。本地无法自动取得远端的新 Token。");
    if (kind === "token_expired") throw new Error("远端明确报告 Token 已过期，请更新此实例 Token 后重新登记；本地无法自行签发远端凭据。");
    if (kind === "device") throw new Error("Gateway 设备凭据不匹配，请在对应远端检查这台电脑 的设备配对；无需反复重填 Gateway Token。");
    if (kind === "auth") throw new Error("远端拒绝认证，请核对此实例的 Token 和访问权限；尚不能判断为 Token 过期。");
    if (kind === "credential_store") throw new Error("无法读取本机保存的凭据，请检查钥匙串是否解锁及访问权限；这不代表远端 Token 已过期。");
    if (kind === "transient") throw new Error("已使用保存的凭据自动重连 3 次，Gateway 仍无法连接。请确认远端实例和网络正常，无需重新填写 Token。");
    throw new Error("MCP / Gateway 暂未通过健康检查，请点击 Codex 帮助查看原因");
  }
  return {
    instanceId: instance.id,
    online: true,
    message: "MCP / Gateway 已连接。文件桥由一键安装自动检查和配置。",
    detail: "Gateway health 已通过"
  };
}

const pairingCoordinator=new PairingCoordinator(checkMcpDirectRaw);
async function checkMcpDirect(body) {
  const checked=await pairingCoordinator.verify(body.instanceId);
  if(checked.online)for(const job of connectionJobs.values())if(job.instanceId===body.instanceId && job.approvalKind==='mac_pairing') {
    delete job.approval;job.approvalKind=null;job.blockerCode=null;
    if(job.status==='awaiting_approval'){job.status='blocked';job.nextAction='Mac 已在线，继续核验原文件桥任务';job.message=job.nextAction;}
    jobStore.save().catch(()=>{});
  }
  return checked;
}
setInterval(()=>pairingCoordinator.tick().catch(()=>{}),60000).unref();
const validateBridgeOperations=(instanceId,enableDelete)=>validateFiles(runFarmCommand,instanceId,enableDelete);

function newBridgeMaintenanceSession(instanceId) {
  if (!/^ins_[a-z0-9]+$/i.test(instanceId)) throw new Error("实例编号无效");
  // A fresh Gateway session key creates an isolated conversation on chat.send.
  // Keep this key for the entire job; never fall back to the default session.
  return `agent:main:openclaw-control-ui:filebridge-${instanceId.slice(4)}-${randomUUID()}`;
}

async function installBridgeViaMcp(body, onProgress = () => {}, resumeInstall = null, job = null) {
  if (body.confirm !== true) throw new Error("请先确认本次通过 MCP 写入远端配置");
  if (body.allowSharedWorkspace !== true) throw new Error("请先确认允许当前实例使用共享工作区兼容模式");
  const instances = await readInstances();
  const instance = instances.find((item) => item.id === body.instanceId);
  if (!instance) throw new Error("实例不存在或尚未注册");
  if (!instance.hasCredential) throw new Error("该实例缺少控制凭据，请先完成注册");

  onProgress("正在检查当前文件桥是否已经可用");
  let existingHealth = null, existingHealthError = "";
  try {
    existingHealth = await checkBridgeWithRecovery({instanceId:instance.id,configured:Boolean(instance.fileBridge),run:runFarmCommand,onProgress});
  } catch (error) {
    existingHealthError=String(error.message || "");
    onProgress("正在检查文件桥需要恢复的步骤");
  }
  if (/文件桥 HTTP 401/.test(existingHealthError)) {
    if(!job)throw Object.assign(Error('文件桥认证或隧道需核验，请从当前后台任务继续'),{code:'BRIDGE_AUTH_OR_ROUTE_MISMATCH'});
    await repairExistingBridgeRoute(job);
    return job.result;
  }
  // A configured service with a broken local connection must be diagnosed by
  // the same proven recovery path, never treated as a new installation.
  if(existingHealthError && instance.fileBridge && !resumeInstall && job) {
    await repairExistingBridgeRoute(job);
    return job.result;
  }
  const capabilities = existingHealth?.capabilities || {};
  const deleteReady = body.enableDelete === false || capabilities.delete === true;
  if (existingHealth?.ok === true && capabilities.read === true && capabilities.write === true && deleteReady) {
    onProgress("正在核对 MCP 及现有文件桥", {stage:"mcp_check"});
    const mcp = await checkMcpDirect({instanceId:instance.id});
    if (!mcp.online) return mcp;
    onProgress("正在验证现有文件桥目录读取", {stage:"verify"});
    await validateBridgeOperations(instance.id,body.enableDelete!==false);
    onProgress("实际读写及删除检查通过，现有文件桥可以直接复用");
    return {
      instanceId:instance.id, stage:"complete", alreadyConfigured:true, capabilities,
      message:"MCP 与文件桥均已验通，现有文件桥已复用。"
    };
  }

  {
    onProgress("正在自动检查 MCP，接通后继续安装文件桥", {stage:"mcp_check"});
    let mcp = await checkMcpDirect({instanceId:instance.id});
    if (!mcp.online && mcp.stage === "pairing_required" && mcp.requestId && mcp.deviceId) {
      onProgress("正在通过实例主 agent 自动核验并批准当前电脑 配对，无需复制提示词", {stage:"pairing_auto_approval"});
      let approvalError = "";
      try {
        await runFarmCommand(["pairing-approve-via-responses", instance.id, mcp.requestId, mcp.deviceId, "--timeout", "45"], "", [0], 55_000, false);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
        mcp = await checkMcpDirect({instanceId:instance.id});
        if (mcp.online) onProgress("当前电脑 配对已自动完成，继续安装文件桥", {stage:"bridge_install"});
      } catch (error) {
        approvalError = String(error?.message || "");
      }
      if (!mcp.online) {
        mcp.message = "远端尚未批准这台电脑，文件桥安装未开始。";
        mcp.detail = approvalError.includes("工具调用文本")
          ? "远端主 agent 只输出了批准命令，没有实际执行；请在该实例的 OpenClaw 控制台批准当前电脑 配对申请。"
          : "自动批准请求未得到实际 MCP 连通验证；请在该实例的 OpenClaw 控制台批准当前电脑 配对申请，再点击检查。";
        onProgress(mcp.detail, {stage:"pairing_required"});
      }
    }
    if (!mcp.online) return mcp;
    onProgress("MCP 已接通，自动继续文件桥安装", {stage:"bridge_install"});
  }

  // Reuse an existing healthy bridge without requiring unrelated relay credentials.
  // Check relay setup before any remote installation or port allocation.
  await assertRelayReady();
  onProgress("正在验证此电脑 的 中继服务器 SSH 登录权限");
  await assertRelayAuthorized();
  const port = await preferredBridgePort(instance.id);
  onProgress(`已确认实例隔离端口 ${port}`);
  if(resumeInstall && (!resumeInstall.maintenanceSession?.startsWith(`agent:main:openclaw-control-ui:filebridge-${instance.id.slice(4)}-`) || !/^[0-9a-f]{32}$/.test(resumeInstall.taskTag)))throw Error('恢复安装的实例或会话不匹配');
  const maintenanceSession = resumeInstall?.maintenanceSession || newBridgeMaintenanceSession(instance.id);
  if (!resumeInstall) {
    // An optional deployment setting can select a tool-capable maintenance
    // model. Otherwise the independent session uses its main agent's default.
    const maintenanceModel = String(body.maintenanceModel || process.env.OPENCLAW_MAINTENANCE_MODEL || '').trim();
    if (maintenanceModel.length > 200 || /[\u0000-\u001f]/.test(maintenanceModel)) throw Object.assign(Error('文件桥维护模型格式无效'), {code:'MAINTENANCE_MODEL_INVALID'});
    const created = await runFarmCommand(['call', instance.id, 'sessions.create', '--params-json', JSON.stringify({
      key:maintenanceSession, agentId:'main', label:`filebridge-${instance.id}-${maintenanceSession.slice(-8)}`, ...(maintenanceModel ? {model:maintenanceModel} : {})
    }), '--timeout','20000','--allow-write'], '', [0], 30000, false);
    if (created.sessionKey !== maintenanceSession && created.key !== maintenanceSession) {
      throw Object.assign(Error('远端未确认独立维护会话'), {code:'MAINTENANCE_SESSION_UNCONFIRMED'});
    }
    onProgress(maintenanceModel ? `独立维护会话已创建，执行模型 ${maintenanceModel}` : '独立维护会话已创建，使用主 agent 配置的模型');
  }
  onProgress(`本次安装将通过 MCP 新建独立会话：${maintenanceSession}`);
  const enableDelete = body.enableDelete !== false;
  const taskTag = resumeInstall?.taskTag || randomUUID().replaceAll("-", "");
  const scopes = enableDelete ? '["read","write","delete"]' : '["read","write"]';
  let token = `fb_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  try {token=await readBridgeCredential(instance.id);} catch(error) {
    if(!/not found|不存在|未登记|未配置|没有可用于|missing/i.test(String(error.message)))throw error;
    await runFarmCommand(['bridge-secret',instance.id,'--scope','all','--token-stdin'],token+'\n');
  }
    onProgress('维护凭据已保存到系统密钥库',{maintenanceSession,port,taskTag,credentialRef:`${instance.id}:file_bridge:all`});
  const tokenChunks = token.slice(3).match(/.{1,16}/g) || [];
  const remoteTokenExpression = `'fb_'${tokenChunks.map((chunk) => `'${chunk}'`).join("")}`;
  const rawInstallPrompt = configureBridgeCommand([
    `维护任务编号：${taskTag}`,
    "请使用 exec 工具一次性执行下面全部命令。不要解释，不要修改工作区中的业务文件；执行完只返回标记区块。",
    "",
    "set -eu",
    "D='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
    "mkdir -p \"$D\" ~/.ssh && chmod 700 \"$D\" ~/.ssh",
    ...await bridgeProgramInstall("D"),
    "umask 077",
    `T=${remoteTokenExpression}`,
    'export OPENCLAW_BRIDGE_SYNC_TOKEN="$T"',
    "python3 - <<'PY'",
    "import os,json,tempfile",
    "from pathlib import Path",
    "p=Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json')",
    "if p.is_symlink(): raise SystemExit('文件桥配置不应为符号链接')",
    "data=json.loads(p.read_text()) if p.exists() else {'tokens':[]}",
    "rows=data.get('tokens')",
    "if not isinstance(rows,list): raise SystemExit('文件桥授权格式不正确')",
    "token=os.environ['OPENCLAW_BRIDGE_SYNC_TOKEN']",
    `scopes=${scopes}`,
    "row=next((r for r in rows if isinstance(r,dict) and r.get('token')==token),None)",
    "if row is None: rows.append({'token':token,'scopes':scopes})",
    "else: row['scopes']=sorted(set(row.get('scopes',[]))|set(scopes))",
    "fd,name=tempfile.mkstemp(prefix='.secrets-',dir=p.parent)",
    "with os.fdopen(fd,'w') as f: os.fchmod(f.fileno(),0o600); json.dump(data,f); f.flush(); os.fsync(f.fileno())",
    "os.replace(name,p)",
    "PY",
    "if [ ! -s ~/.ssh/openclaw_tunnel ]; then ssh-keygen -q -t ed25519 -f ~/.ssh/openclaw_tunnel -N '' -C openclaw-tunnel; fi",
    "chmod 600 ~/.ssh/openclaw_tunnel \"$D/secrets.json\"",
    "A=''",
    "[ \"$(id -u)\" = 0 ] && A=\"$A --allow-root-for-test\"",
    "A=\"$A --allow-unisolated-for-test\"",
    ...bridgeProcessStopSteps(),
    `nohup python3 \"$D/server.py\" --root /home/node/.openclaw/workspace --secret-file \"$D/secrets.json\" --enable-write ${enableDelete ? "--enable-delete " : ""}$A >\"$D/server.log\" 2>&1 &`,
    "OK=0; for N in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -H \"X-OpenClaw-Token: $T\" http://127.0.0.1:18081/health >/dev/null 2>&1 && OK=1 && break; sleep 1; done",
    "if [ \"$OK\" != 1 ]; then echo '文件桥启动失败'; tail -n 40 \"$D/server.log\"; exit 1; fi",
    `echo OPENCLAW_${taskTag}_PUBKEY_BEGIN`,
    "cat ~/.ssh/openclaw_tunnel.pub",
    `echo OPENCLAW_${taskTag}_PUBKEY_END`,
    `echo OPENCLAW_${taskTag}_INSTALL_READY`
  ].join("\n"));

  const stagedInstall=bridgeInstallSteps(rawInstallPrompt,taskTag);
  const installPrompt=rawInstallPrompt;

  let currentRunId = "";
  const sendMaintenance = async (message, idempotencyKey) => {
    onProgress('即将发送维护步骤',{maintenanceSession,idempotencyKey,taskTag:message.match(/维护任务编号：([0-9a-f]{32})/)?.[1],commandDigest:createHash('sha256').update(message).digest('hex'),requestDigest:maintenanceRequestDigest(message),dispatchIntent:true});
    await jobStore.save();
    const sent = await sendMaintenanceRequest({
      instanceId:instance.id, sessionKey:maintenanceSession, message, idempotencyKey, onProgress,
      call:(method,params) => runFarmCommand([
        "call", instance.id, method, "--params-json", JSON.stringify(params),
        "--timeout", "20000", "--allow-write"
      ], "", [0], 35_000, false)
    });
    currentRunId = sent.runId || "";
    if(currentRunId)onProgress("远端任务已接收，正在确认执行状态", {remoteRunId:currentRunId,maintenanceSession,acknowledged:true});
    return sent.stage === "approval_required" ? sent.requestId : null;
  };

  const waitForText = (predicate, timeoutMs = 300000, expectedPrompt = installPrompt, recoverEmptyRun = false) => waitForMaintenance({
    predicate, timeoutMs, sessionKey:maintenanceSession, onProgress,
    requireSettledTurn:true,
    expectedPromptHash:createHash('sha256').update(expectedPrompt).digest('hex'),
    expectedRequestDigest:maintenanceRequestDigest(expectedPrompt),
    readRunStatus:async () => {
      if(!currentRunId)return null;
      const result=await runFarmCommand(["call",instance.id,"agent.wait","--params-json",JSON.stringify({runId:currentRunId,timeoutMs:1}),"--timeout","10000"],"",[0],20_000,false);
      return result.runId===currentRunId?result:null;
    },
    onStall:recoverEmptyRun ? async results => {
      if(!currentRunId || results.executionText.trim() || results.approval)return;
      const stopped=await runFarmCommand([
        'call',instance.id,'chat.abort','--params-json',JSON.stringify({sessionKey:maintenanceSession,runId:currentRunId}),
        '--timeout','15000','--allow-write'
      ],'', [0],25_000,false);
      if(stopped?.ok===true && [true,false].includes(stopped?.aborted)) {
        throw Object.assign(new Error('原维护运行没有执行命令，已确认结束并重试当前步骤。'),{code:'MAINTENANCE_STALLED_RETRY'});
      }
      throw Object.assign(new Error('无法确认空转运行已经结束，已停止重发以避免重复安装。'),{code:'MAINTENANCE_RUN_UNCONFIRMED'});
    } : undefined,
    approveExec:async approval => {
      try{return await approveMaintenanceExec({
      approval, instanceId:instance.id, sessionKey:maintenanceSession,
      expectedCommand:expectedPrompt.slice(expectedPrompt.indexOf("set -eu\n")),
      call:(method, params) => runFarmCommand([
        "call", instance.id, method, "--params-json", JSON.stringify(params),
        "--timeout", "30000", "--allow-write"
      ], "", [0], 45_000)
    });}catch(error){
      if(error.code==='EXEC_COMMAND_MISMATCH') {
        const denied=await runFarmCommand(['call',instance.id,'exec.approval.resolve','--params-json',JSON.stringify({id:approval.requestId,decision:'deny'}),'--timeout','15000','--allow-write'],'',[0],25000,false);
        if(denied.ok!==true)throw Object.assign(Error('改写命令尚未确认拒绝，停止重试'),{code:'EXEC_APPROVAL_BLOCKED'});
      }
      throw error;
    }},
    readHistory:() => runFarmCommand([
      "call", instance.id, "chat.history",
      "--params-json", JSON.stringify({sessionKey:maintenanceSession, limit:50}),
      "--timeout", "30000"
    ], "", [0], 45_000, false),
    onPause:message=>{throw Object.assign(new Error(message),{code:'MAINTENANCE_PAUSED'});}
  });

  let publicKey;
  for(let step=resumeInstall?.startStep || 0;step<stagedInstall.commands.length;step++) {
    const final=step===stagedInstall.commands.length-1;
    onProgress(['正在传送并校验文件桥程序','正在保存当前电脑的文件桥授权','正在准备反向隧道公钥','正在启动文件桥并验证实例本地服务'][step],{stage:'bridge_install',installStep:step,installStepCount:stagedInstall.commands.length});
    for(let attempt=0;attempt<3;attempt++){
    const attemptNumber=attempt+(resumeInstall && step===resumeInstall.startStep?resumeInstall.startAttempt:0);
    const downloadNote=process.env.OPENCLAW_FILE_BRIDGE_INSTALL_MODE==='r2'?'下载文件名固定为 file_bridge_server-4a20282d5ff26635.py，文件名仅用16位短哈希，禁止将校验用的64位SHA256补进下载文件名。':'';
    const stepPrompt=`维护任务编号：${taskTag}\n本次执行编号：${taskTag}-${step}-${attemptNumber}\n本次仅执行第 ${step+1}/${stagedInstall.commands.length} 步。使用 exec，不要传 host 参数。下面是已确认的安装命令，请逐字原样执行。${downloadNote}批准后仅返回工具结果，不继续其他步骤。\n${stagedInstall.commands[step]}`;
    const approvalRequestId=await sendMaintenance(stepPrompt,`bridge-install-${instance.id}-${taskTag}-step-${step}-attempt-${attemptNumber}`);
    if(approvalRequestId)return {instanceId:instance.id,stage:'approval_required',requestId:approvalRequestId,maintenanceSession,message:'本次安装需要核验远端权限'};
    try {await waitForText((_text,results)=>{
      if(final){publicKey=parseBridgeInstallResult(results,taskTag)?.publicKey;return Boolean(publicKey);}
      return new RegExp(`(?:^|\\s)STAGED_${step}(?=\\s|$)`).test(results.executionText) && !results.failure;
    },300000,stepPrompt,true);break;}
    catch(error){
      if(!['EXEC_COMMAND_MISMATCH','MAINTENANCE_STALLED_RETRY'].includes(error.code) || attempt===2)throw error;
      if(error.code==='EXEC_COMMAND_MISMATCH') {
        const ended=await runFarmCommand(['call',instance.id,'agent.wait','--params-json',JSON.stringify({runId:currentRunId,timeoutMs:10000}),'--timeout','15000'],'',[0],25000,false);
        if(ended.runId!==currentRunId || !['ok','error','completed','failed'].includes(ended.status))throw Object.assign(Error('改写命令已拒绝，原运行尚未确认结束'),{code:'MAINTENANCE_RUN_UNCONFIRMED'});
        onProgress(`第 ${step+1} 步被远端改写，已拒绝该命令并重传（${attempt+1}/2）`);
      } else onProgress(`第 ${step+1} 步没有产生执行记录，已结束空转并主动重试（${attempt+1}/2）`);
    }
    }
  }
  if (!publicKey) throw new Error("文件桥已执行安装，但维护会话没有返回完整 SSH 公钥");

  onProgress("远端文件桥已经启动，正在写入 中继服务器 公钥白名单", {stage:"tunnel"});
  await authorizeBridge({ instanceId: instance.id, token, port, publicKey, confirm: true });
  const listenerBefore = await checkOracleBridgeListener(port, token);
  if (listenerBefore === 'unhealthy') throw Object.assign(Error('中继服务器 端口已有监听，但文件桥健康或凭据核验失败，禁止覆盖其他隧道'), {code:'RELAY_LISTENER_UNHEALTHY'});
  if (listenerBefore === 'absent') {
    const tunnelTag = randomUUID().replaceAll("-", "");
    const tunnelPrompt = configureBridgeCommand([
      `维护任务编号：${tunnelTag}`,
      "请使用 exec 工具一次性执行下面命令。不要解释，执行完只返回隧道标记。",
      "set -eu",
      `ssh -p ${setupConfig.relay.sshPort} -f -N -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -i ~/.ssh/openclaw_tunnel -R localhost:${port}:127.0.0.1:18081 ${shellSingleQuote(RELAY_DESTINATION)}`,
      `echo OPENCLAW_${tunnelTag}_TUNNEL_READY`
    ].join("\n"));

    onProgress("中继服务器 端口尚无监听，正在请求建立 Pod 到 中继服务器 的反向隧道");
    const tunnelApprovalId = await sendMaintenance(tunnelPrompt, `bridge-tunnel-${instance.id}-${tunnelTag}`);
    if (tunnelApprovalId) {
      onProgress("隧道任务正在等待一次写权限批准，任务进度已保留");
      token = "";
      return {
        instanceId: instance.id,
        stage: "approval_required",
        requestId: tunnelApprovalId,
        maintenanceSession,
        message: "文件桥已安装，正在等待隧道写权限批准。批准后点击“继续配置”。"
      };
    }
    onProgress("远端已返回隧道启动标记，正在核验 中继服务器 实际监听与文件桥健康");
    await waitForText((_text, results) => maintenanceMarkerPresent(results, tunnelTag, "TUNNEL_READY"), 300_000, tunnelPrompt);
  } else onProgress("中继服务器 端口上的文件桥已通过实时健康检查，复用现有反向隧道");
  await requireOracleBridgeListener(port, token);

  const relayHost = RELAY_DESTINATION.includes("@") ? RELAY_DESTINATION.split("@").slice(1).join("@") : RELAY_DESTINATION;
  const relayUser = RELAY_DESTINATION.includes("@") ? RELAY_DESTINATION.split("@")[0] : setupConfig.relay.user;
  onProgress("隧道已建立，正在登记本机文件桥连接");
  await runFarmCommand([
    "bridge-configure", instance.id,
    "--transport", "ssh_relay",
    "--local-port", String(port),
    "--pod-port", String(setupConfig.bridge.podPort),
    "--relay-host", relayHost,
    "--relay-user", relayUser, "--relay-ssh-port", String(setupConfig.relay.sshPort),
    "--relay-port", String(port),
    "--relay-key", RELAY_KEY,
    "--workspace", setupConfig.bridge.workspace
  ]);
  let healthError = null, verifiedCapabilities = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    onProgress(`正在执行端到端文件桥健康检查（第 ${attempt}/3 次）`, {stage:"verify"});
    try {
      const verified = await runFarmCommand(["bridge-health", instance.id], "", [0], 45_000);
      if (verified?.ok !== true || !verified.capabilities?.read || !verified.capabilities?.write || (enableDelete && !verified.capabilities?.delete)) {
        throw new Error("文件桥未通过所需能力验证");
      }
      verifiedCapabilities = verified.capabilities;
      healthError = null;
      break;
    } catch (error) {
      healthError = error;
      if (/文件桥 HTTP 401/.test(String(error.message))) {
        if(!job)throw Object.assign(Error('文件桥认证或隧道需核验，请从当前后台任务继续'),{code:'BRIDGE_AUTH_OR_ROUTE_MISMATCH'});
        await repairExistingBridgeRoute(job);return job.result;
      }
      if (attempt < 3) {
        onProgress("连接刚建立时出现短暂中断，3 秒后自动复查");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
      }
    }
  }
  if (healthError) throw new Error("文件桥验通失败：" + chineseError(healthError));
  await validateBridgeOperations(instance.id,enableDelete);
  onProgress("端到端读写及删除检查通过，文件桥已在线");
  token = "";
  return {
    instanceId: instance.id,
    port,
    stage: "complete",
    maintenanceSession,
    capabilities: verifiedCapabilities,
    message: `MCP 与文件桥均已验通，中继服务器 端口为 ${port}。固定流程未调用 Codex。`
  };
}

const jobStore = await openJobStore(join(DATA_ROOT,"connection-jobs.json"));
const connectionJobs = jobStore.jobs;
for(const record of Object.values((await readRegistry()).instances || {}))if(isArchived(record)) {
  for(const job of connectionJobs.values())if(job.instanceId===record.id)archiveJob(job,record.console_archived_at);
}
await jobStore.save();
const activeConnectionJobs = new Map();
// Explicit access to a protected named instance is intentionally process-local.
// It applies only to the exact job authorized by the current UI request and is
// never serialized into the durable job store or the batch permission policy.
const permissionAuthorizedJobs = new WeakSet();
function authorizePermissionRepairForJob(job,body) {
  if(body.allowNamedInstance===true && body.allowInternalPermissionRepair===true)permissionAuthorizedJobs.add(job);
}

function appendConnectionJobLog(job, message) {
  const cleanMessage = redactText(String(message || "").replace(/\s+/g, " ").trim());
  if (!cleanMessage) return;
  job.logs ||= [];
  if (job.logs.at(-1)?.message !== cleanMessage) {
    job.logs.push({ at: Date.now(), message: cleanMessage });
    if (job.logs.length > 80) job.logs = job.logs.slice(-80);
  }
  job.message = cleanMessage;
  job.updatedAt = Date.now();
  jobStore.save().catch(error=>console.error("任务状态保存失败：",error.code || "IO_ERROR"));
}

async function startBridgeConnectionJob(body) {
  requireActiveRecord(await readRegistry(),body.instanceId);
  const latest=[...connectionJobs.values()].filter(j=>j.instanceId===body.instanceId).sort((a,b)=>b.createdAt-a.createdAt)[0];
  const forceNewAttempt=body.forceNewAttempt===true;
  if(forceNewAttempt && latest && !["blocked","failed"].includes(latest.status)) {
    throw new Error("当前维护任务尚未结束，不能创建重复执行");
  }
  if(forceNewAttempt && latest) {
    if(latest.maintenanceSession && latest.remoteRunId) {
      const aborted=await runFarmCommand(['call',body.instanceId,'chat.abort','--params-json',JSON.stringify({sessionKey:latest.maintenanceSession,runId:latest.remoteRunId}),'--timeout','15000','--allow-write'],'',[0],25000,false);
      if(aborted.ok!==true)throw Object.assign(Error('远端旧运行未确认终止，不能安全建立重复安装任务'),{code:'REMOTE_RUN_ABORT_UNCONFIRMED'});
      appendConnectionJobLog(latest,aborted.aborted===false?'远端确认旧运行已经结束':'已精确终止本任务占用的远端旧运行');
    }
    latest.status="superseded";
    latest.nextAction="已由用户明确要求建立新的安装任务";
    appendConnectionJobLog(latest,"旧任务长期无有效结果，已停止继续等待；正在建立新的独立维护会话");
    if(activeConnectionJobs.get(body.instanceId)===latest.id)activeConnectionJobs.delete(body.instanceId);
  }
  if(!forceNewAttempt && latest && (["blocked","awaiting_approval","waiting"].includes(latest.status) || latest.dispatchIntent && latest.status!=="complete")) {
    authorizePermissionRepairForJob(latest,body);
    resumeConnectionJob(latest).catch(error=>{latest.status='blocked';appendConnectionJobLog(latest,error.message);});
    return {jobId:latest.id,status:latest.status,reused:true};
  }
  const activeId = activeConnectionJobs.get(body.instanceId);
  const active = activeId ? connectionJobs.get(activeId) : null;
  if (active && ["queued", "running", "waiting"].includes(active.status)) {
    authorizePermissionRepairForJob(active,body);
    resumeConnectionJob(active);
    return { jobId: activeId, status: "running", reused: true };
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    parentJobId:latest?.id || null,
    instanceId: body.instanceId,
    status: "queued",
    stage: "starting",
    checkedAt:0, nextAction:"等待执行", enableDelete:body.enableDelete!==false,
    message: "正在检查现有连接并恢复未完成步骤……",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  authorizePermissionRepairForJob(job,body);
  appendConnectionJobLog(job, "后台任务已创建，正在排队连接当前实例");
  connectionJobs.set(jobId, job);
  activeConnectionJobs.set(body.instanceId, jobId);
  await jobStore.save();

  enqueue(body.instanceId, async () => {
    job.status="running";job.stage = "maintenance";
    appendConnectionJobLog(job, "维护会话正在执行，切换实例或刷新页面不会中断");
    const progress = (message, details) => {
      for(const key of ['stage','remoteRunId','maintenanceSession','idempotencyKey','commandDigest','requestDigest','port','credentialRef','taskTag','dispatchIntent','acknowledged'])if(details?.[key]!==undefined)job[key]=details[key];
      if (details?.remoteRunId) job.remoteRunId = details.remoteRunId;
      if (details?.maintenanceSession) job.maintenanceSession = details.maintenanceSession;
      if (details && "approval" in details) job.approval = details.approval;
      if (details?.waiting) {
        job.status = "waiting";
        job.stage = "waiting_result";
        Object.defineProperty(job, "resume", {value:details.resume,configurable:true,writable:true,enumerable:false});
      }
      appendConnectionJobLog(job, message);
    };
    try {return await installBridgeViaMcp(body,progress,null,job);}
    catch(error) {
      if(error.code!=='REMOTE_INTERNAL_APPROVAL_BLOCKED')throw error;
      await repairJobPermissions(job,progress);
      // The failed registration never started the command; require the original agent run to have ended as well.
      await requireOriginalRunEnded(job);
      return await installBridgeViaMcp(body,progress,null,job);
    }
  }).then((result) => {
    job.status = result.stage === "complete" ? "complete" : "awaiting_approval";
    job.checkedAt=Date.now();job.approvalKind=job.status === "complete" ? null : "mac_pairing";
    job.nextAction=job.status === "complete" ? "连接可用" : "重新检查当前电脑 配对申请";
    job.stage = result.stage || "complete";
    job.message = result.message || "配置完成";
    job.result = result;
    job.updatedAt = Date.now();
    appendConnectionJobLog(job, result.message || "文件桥任务已完成");
  }).catch((error) => {
    job.status = ['REMOTE_INTERNAL_APPROVAL_BLOCKED','EXEC_APPROVAL_BLOCKED','EXEC_APPROVAL_EXPIRED','MAINTENANCE_PAUSED','PERMISSION_REPAIR_BLOCKED','PERMISSION_POLICY_REQUIRED','REMOTE_INTERNAL_IDENTITY_UNVERIFIED','MAINTENANCE_RUN_UNCONFIRMED'].includes(error.code)?'blocked':'failed';
    job.blockerCode=error.code || 'INSTALL_FAILED';job.approvalKind=error.approvalKind || null;
    job.checkedAt=Date.now();job.nextAction=error.code==='REMOTE_INTERNAL_APPROVAL_BLOCKED'?'核对远端运行用户、状态目录及内部审批客户端公钥；证据不足时禁止批准':'检查原维护会话及实际文件桥状态';
    job.retryable = error.code !== "RELAY_SETUP_REQUIRED" && !String(error.code || "").startsWith("MAINTENANCE_") && !String(error.code || "").startsWith("MAINTENANCE_SEND_");
    job.stage = job.retryable ? "health_recheck" : "setup_required";
    const translated = error.code ? error.message : chineseError(error);
    job.error = /ConnectionResetError|RemoteDisconnected|ECONNRESET/i.test(translated)
      ? "文件桥连接被临时重置，自动复查后仍未恢复"
      : translated;
    job.message = job.error;
    job.updatedAt = Date.now();
    appendConnectionJobLog(job, `任务异常：${job.error}`);
  }).finally(() => {
    if (activeConnectionJobs.get(body.instanceId) === jobId) activeConnectionJobs.delete(body.instanceId);
    return jobStore.save();
  });

  // Durable results are retained until an explicit archive, regardless of age.
  return { jobId, status: "running", reused: false };
}

async function continueVerifiedBridgeSteps(job,decision,history) {
  if(!['INSTALL_READY','TUNNEL_READY'].includes(decision.phaseEvidence))return false;
  if(!Number.isInteger(job.port) || job.port<1024 || job.port>65535)throw Object.assign(Error('旧任务缺少可核验的隔离端口，不能推测端口继续安装'),{code:'RELAY_PORT_REVIEW_REQUIRED'});
  const instanceId=job.instanceId,sessionKey=job.maintenanceSession,port=job.port;
  const mcp=await checkMcpDirect({instanceId});if(!mcp.online)throw Object.assign(Error('当前电脑 仍需完成设备配对'),{code:'PAIRING_REQUIRED'});
  const call=(method,params)=>runFarmCommand(['call',instanceId,method,'--params-json',JSON.stringify(params),'--timeout','20000','--allow-write'],'',[0],35000,false);
  const token=await readBridgeCredential(instanceId);
  if(decision.phaseEvidence==='INSTALL_READY') {
    const publicKey=decision.verifiedPublicKey || parseBridgeInstallResult(history,job.taskTag)?.publicKey;
    if(!publicKey)throw Object.assign(Error('原安装结果缺少可核验的公钥，不能建立隧道'),{code:'PUBLIC_KEY_REVIEW_REQUIRED'});
    appendConnectionJobLog(job,`正在核对 中继服务器 受限公钥与端口 ${port}`);await jobStore.save();
    await authorizeBridge({instanceId,token,port,publicKey,confirm:true});
  }
  const listenerBefore=await checkOracleBridgeListener(port,token);
  if(listenerBefore==='unhealthy')throw Object.assign(Error('中继服务器 端口已有监听，但文件桥健康或凭据核验失败，禁止覆盖其他隧道'),{code:'RELAY_LISTENER_UNHEALTHY'});
  if(listenerBefore==='absent') {
    appendConnectionJobLog(job,'中继服务器 端口尚无监听，正在建立实际反向隧道');await jobStore.save();
    const tag=randomUUID().replaceAll('-','');
    const command=configureBridgeCommand([
      'set -eu',
      `ssh -p ${setupConfig.relay.sshPort} -f -N -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -i ~/.ssh/openclaw_tunnel -R localhost:${port}:127.0.0.1:18081 ${shellSingleQuote(RELAY_DESTINATION)}`,
      `echo OPENCLAW_${tag}_TUNNEL_READY`
    ].join('\n'));
    const idempotencyKey=`bridge-tunnel-${instanceId}-${tag}`;
    const message=`维护任务编号：${tag}\n请使用 exec 原样执行隧道命令。\n${command}`;
    Object.assign(job,{status:'running',stage:'tunnel',taskTag:tag,idempotencyKey,commandDigest:createHash('sha256').update(message).digest('hex'),requestDigest:maintenanceRequestDigest(message),dispatchIntent:true,acknowledged:false,remoteRunId:null,blockerCode:null,approvalKind:null,approval:null});
    appendConnectionJobLog(job,'已核验原安装成功，仅恢复缺失的反向隧道，不重新下载程序');await jobStore.save();
    const sent=await sendMaintenanceRequest({call,instanceId,sessionKey,message,idempotencyKey,onProgress:message=>appendConnectionJobLog(job,message)});
    if(!sent.runId)throw Object.assign(Error('隧道执行尚未获得确认，需要核验当前设备权限'),{code:'PAIRING_REQUIRED'});
    job.remoteRunId=sent.runId;job.acknowledged=true;await jobStore.save();
    await waitForMaintenance({sessionKey,timeoutMs:300000,expectedPromptHash:job.commandDigest,expectedRequestDigest:job.requestDigest,readHistory:()=>call('chat.history',{sessionKey,limit:50}),readRunStatus:()=>call('agent.wait',{runId:sent.runId,timeoutMs:1}),predicate:(_text,result)=>maintenanceMarkerPresent(result,tag,'TUNNEL_READY'),
      approveExec:approval=>approveMaintenanceExec({approval,instanceId,sessionKey,expectedCommand:command,call}),onProgress:message=>appendConnectionJobLog(job,message),onPause:message=>{throw Object.assign(Error(message),{code:'MAINTENANCE_PAUSED'});}});
  } else appendConnectionJobLog(job,'中继服务器 端口上的文件桥已通过实时健康检查，复用现有反向隧道');
  await requireOracleBridgeListener(port,token);
  const [relayUser,relayHost]=RELAY_DESTINATION.split('@');
  await runFarmCommand(['bridge-configure',instanceId,'--transport','ssh_relay','--local-port',String(port),'--pod-port',String(setupConfig.bridge.podPort),'--relay-host',relayHost,'--relay-user',relayUser,'--relay-ssh-port',String(setupConfig.relay.sshPort),'--relay-port',String(port),'--relay-key',RELAY_KEY,'--workspace',setupConfig.bridge.workspace]);
  const health=await runFarmCommand(['bridge-health',instanceId],'',[0],45000);
  if(!health.ok || !health.capabilities?.read || !health.capabilities?.write || (job.enableDelete!==false && !health.capabilities?.delete))throw Error('恢复隧道后文件桥能力尚未通过验收');
  await validateBridgeOperations(instanceId,job.enableDelete!==false);
  Object.assign(job,{status:'complete',stage:'complete',error:null,blockerCode:null,approvalKind:null,nextAction:'连接可用',result:{stage:'complete',instanceId,capabilities:health.capabilities,checkedAt:Date.now(),message:'已恢复缺失步骤，文件桥实际读写及删除验证通过'}});
  appendConnectionJobLog(job,job.result.message);return true;
}

async function installIntoExistingJob(job,resumeInstall=null) {
  job.status="running";job.blockerCode=null;job.approval=null;
  const progress=(message,details)=>{
    for(const key of ['stage','remoteRunId','maintenanceSession','idempotencyKey','commandDigest','requestDigest','port','credentialRef','taskTag','dispatchIntent','acknowledged'])if(details?.[key]!==undefined)job[key]=details[key];
    appendConnectionJobLog(job,message);
  };
  const body={instanceId:job.instanceId,confirm:true,allowSharedWorkspace:true,enableDelete:job.enableDelete!==false};
  let result;
  try{result=await installBridgeViaMcp(body,progress,resumeInstall,job);}catch(error){
    if(error.code!=='REMOTE_INTERNAL_APPROVAL_BLOCKED')throw error;
    await repairJobPermissions(job,progress);await requireOriginalRunEnded(job);
    result=await installBridgeViaMcp(body,progress,null,job);
  }
  job.result=result;job.status=result.stage==='complete'?'complete':'awaiting_approval';job.stage=result.stage;
  job.blockerCode=null;job.approvalKind=result.stage==='complete'?null:'mac_pairing';job.checkedAt=Date.now();job.nextAction=result.stage==='complete'?'连接可用':'核验当前配对申请';appendConnectionJobLog(job,result.message);
}

async function requireOriginalRunEnded(job) {
  if(!job.remoteRunId)throw Object.assign(Error('原安装运行编号缺失，权限已核验但仍需核对原执行结果'),{code:'MAINTENANCE_RUN_UNCONFIRMED'});
  const run=await runFarmCommand(['call',job.instanceId,'agent.wait','--params-json',JSON.stringify({runId:job.remoteRunId,timeoutMs:1}),'--timeout','15000'],'',[0],25000,false);
  if(run.runId===job.remoteRunId && ['timeout','ok','error','failed','completed'].includes(run.status)) {
    const history=await runFarmCommand(['call',job.instanceId,'chat.history','--params-json',JSON.stringify({sessionKey:job.maintenanceSession,limit:100}),'--timeout','15000'],'',[0],25000,false);
    const boundHistory={...history,sessionKey:job.maintenanceSession};
    if(verifiedFailedTurnEnded({job,history:boundHistory,run}) || verifiedRejectedTurnEnded({job,history:boundHistory,run})){appendConnectionJobLog(job,'已核对原安装命令返回错误或已被拒绝，确认未执行；可以恢复安装');return;}
    if(run.status==='timeout' && (verifiedSettledInstallTurn({job,history:boundHistory}) || verifiedLegacyDownloadFailure({job,history:boundHistory,run}))){
      const cancelled=await runFarmCommand(['call',job.instanceId,'chat.abort','--params-json',JSON.stringify({sessionKey:job.maintenanceSession,runId:job.remoteRunId}),'--timeout','15000','--allow-write'],'',[0],25000,false);
      if(cancelled.ok===true && cancelled.aborted===false){appendConnectionJobLog(job,'原运行缓存已过期；已核对实际命令全部结束且没有活动运行，仅继续缺失阶段');return;}
    }
    const evidence=maintenanceResults(boundHistory,{expectedPromptHash:job.commandDigest,expectedRequestDigest:job.requestDigest});
    if(evidence.approval && !evidence.approvalEnded){
      let expired=false;
      try {await runFarmCommand(['call',job.instanceId,'exec.approval.waitDecision','--params-json',JSON.stringify({id:evidence.approval.requestId}),'--timeout','5000'],'',[0],15000,false);}
      catch(error){expired=/approval[^\n]*(?:expired|not found)|(?:expired|unknown)[^\n]*approval/i.test(String(error.message));}
      if(expired && evidence.approval.command) {
        const fingerprint=executionCommandFingerprint(evidence.approval.command);
        const call=(method,params)=>runFarmCommand(['call',job.instanceId,method,'--params-json',JSON.stringify(params),'--timeout','20000','--allow-write'],'',[0],35000,false);
        const state=await call('chat.abort',{sessionKey:job.maintenanceSession,runId:job.remoteRunId});
        if(state.ok===true && state.aborted===false){
          if(job.endProbeFingerprint!==fingerprint)Object.assign(job,{endProbeFingerprint:fingerprint,endProbeTag:randomUUID().replaceAll('-',''),endProbeRunId:null});
          const tag=job.endProbeTag,command=executionProbeCommand(fingerprint,tag);
          const message=`只读核验旧维护命令是否仍在运行。仅原样 exec 执行下面的核验代码，不重新运行旧命令，不修改文件，只返回核验结果。\n${command}`;
          const commandDigest=createHash('sha256').update(message).digest('hex'),requestDigest=maintenanceRequestDigest(message);
          appendConnectionJobLog(job,'原批准已过期；正在只读核对原执行是否结束，不再显示旧批准编号');await jobStore.save();
          if(!job.endProbeRunId){const sent=await sendMaintenanceRequest({call,instanceId:job.instanceId,sessionKey:job.maintenanceSession,message,idempotencyKey:`execution-probe-${job.id}-${tag}`,onProgress:m=>appendConnectionJobLog(job,m)});job.endProbeRunId=sent.runId;await jobStore.save();}
          let checked;
          await waitForMaintenance({sessionKey:job.maintenanceSession,timeoutMs:120000,expectedPromptHash:commandDigest,expectedRequestDigest:requestDigest,
            readHistory:()=>call('chat.history',{sessionKey:job.maintenanceSession,limit:50}),readRunStatus:()=>call('agent.wait',{runId:job.endProbeRunId,timeoutMs:1}),
            approveExec:approval=>approveMaintenanceExec({approval,instanceId:job.instanceId,sessionKey:job.maintenanceSession,expectedCommand:command,call}),
            predicate:(_text,r)=>{checked=parseExecutionProbe(r,tag);return Boolean(checked);},onProgress:m=>appendConnectionJobLog(job,m),onPause:m=>{throw Object.assign(Error(m),{code:'MAINTENANCE_PAUSED'});}});
          if(checked.active===0){appendConnectionJobLog(job,'旧申请已失效且实际原执行已结束，可以接续安装');return;}
        }
      }
      throw Object.assign(Error(expired?'旧批准已失效，但尚未确认原执行结束；保留任务待核对':'原命令仍待批准，先核验当前申请，禁止重复安装'),{code:expired?'EXEC_APPROVAL_EXPIRED':'EXEC_APPROVAL_BLOCKED'});
    }
  }
  if(run.runId!==job.remoteRunId || !['ok','error','failed','completed'].includes(run.status))throw Object.assign(Error('原安装仍未确认结束，已保留任务，不重复安装'),{code:'MAINTENANCE_RUN_UNCONFIRMED'});
}
async function repairJobPermissions(job,onProgress=(message,details)=>{job.stage=details?.stage || job.stage;appendConnectionJobLog(job,message);}) {
  const policy=JSON.parse(await readFile(join(DATA_ROOT,'../config/permission-repair-policy.json'),'utf8'));
  if(permissionAuthorizedJobs.has(job) && !policy.instanceIds.includes(job.instanceId))policy.instanceIds=[...policy.instanceIds,job.instanceId];
  const call=(method,params)=>runFarmCommand(['call',job.instanceId,method,'--params-json',JSON.stringify(params),'--timeout','20000','--allow-write'],'',[0],35000,false);
  job.status='running';job.approvalKind='remote_internal';
  await ensureInternalPermissions({job,policy,call,save:()=>jobStore.save(),onProgress});
}

async function repairExistingBridgeRoute(job) {
  const instanceId=job.instanceId,mcp=await checkMcpDirect({instanceId});
  if(!mcp.online)throw Object.assign(Error('当前 MCP 尚未在线，保留文件桥配置'),{code:'PAIRING_REQUIRED'});
  const token=await readBridgeCredential(instanceId);
  const call=(method,params)=>runFarmCommand(['call',instanceId,method,'--params-json',JSON.stringify(params),'--timeout','20000','--allow-write'],'',[0],35000,false);
  const probeRequest=tag=>{
    const command=existingBridgeProbeCommand(tag);
    const message=`文件桥只读核验 ${tag}。请只用 exec 原样执行下面这个命令，不修改文件、不展示凭据，只返回实际核验输出。\n${command}`;
    return {command,message,commandDigest:createHash('sha256').update(message).digest('hex'),requestDigest:maintenanceRequestDigest(message)};
  };
  let verified=null;
  if(shouldRenewExistingBridgeProbe(job)) {
    // First inspect the old read-only attempt. A delayed result may already
    // prove the service is healthy; renewing must never trigger installation.
    if(job.routeProbeSession && /^[0-9a-f]{32}$/.test(job.routeProbeTag || '')) {
      const old=probeRequest(job.routeProbeTag);
      try {
        const history=await call('chat.history',{sessionKey:job.routeProbeSession,limit:50});
        verified=parseExistingBridgeProbe(history,{tag:job.routeProbeTag,token,commandDigest:old.commandDigest,requestDigest:old.requestDigest});
      } catch { /* A missing old history does not prevent a new read-only check. */ }
    }
    if(!verified) {
      Object.assign(job,{routeProbeSession:newBridgeMaintenanceSession(instanceId),routeProbeTag:randomUUID().replaceAll('-',''),routeProbeRunId:null,routeProbeVersion:6,routeProbeStartedAt:Date.now()});
      appendConnectionJobLog(job,'旧只读核验未见有效结果，已新建独立核验会话；不重装文件桥');
      await jobStore.save();
    }
  }
  const sessionKey=job.routeProbeSession,tag=job.routeProbeTag;
  const {command,message,commandDigest,requestDigest}=probeRequest(tag);
  job.status='running';job.stage='route_check';job.blockerCode=null;
  appendConnectionJobLog(job,'正在只读核对远端文件桥与本机凭据指纹；不发送 Token、不重装程序');await jobStore.save();
  if(!verified && !job.routeProbeRunId) {
    const sent=await sendMaintenanceRequest({call,instanceId,sessionKey,message,idempotencyKey:`bridge-probe-${instanceId}-${tag}`,onProgress:m=>appendConnectionJobLog(job,m)});
    if(!sent.runId)throw Object.assign(Error('只读核验尚未获得 Gateway 执行回执'),{code:'PAIRING_REQUIRED'});
    job.routeProbeRunId=sent.runId;await jobStore.save();
  }
  if(!verified)await waitForMaintenance({sessionKey,timeoutMs:120000,expectedPromptHash:commandDigest,expectedRequestDigest:requestDigest,
    readHistory:()=>call('chat.history',{sessionKey,limit:50}),readRunStatus:()=>call('agent.wait',{runId:job.routeProbeRunId,timeoutMs:1}),
    predicate:(_text,result)=>{verified=parseExistingBridgeProbe(result,{tag,token,commandDigest,requestDigest});return Boolean(verified);},
    approveExec:approval=>approveMaintenanceExec({approval,instanceId,sessionKey,expectedCommand:command,call}),
    onProgress:m=>appendConnectionJobLog(job,m),onPause:m=>{throw Object.assign(Error(m),{code:'MAINTENANCE_PAUSED'});}
  });
  if(!verified?.credentialMatches)throw Object.assign(Error('远端现有文件桥尚未接受此电脑 已保存的专用凭据；已停止重复安装'),{code:'BRIDGE_CREDENTIAL_UNSYNCED'});
  const currentHealth=await runFarmCommand(['bridge-health',instanceId],'',[0],45000).catch(()=>null);
  if(job.enableDelete!==false && currentHealth?.ok===true && currentHealth.capabilities?.delete!==true) {
    const repairTag=randomUUID().replaceAll('-','');
    const repairSession=newBridgeMaintenanceSession(instanceId);
    const repairCommand=buildBridgeDeleteRepair({token,taskTag:repairTag});
    const repairMessage=`维护任务编号：${repairTag}\n请使用 exec 原样执行下面的文件桥权限修复命令。只修改与 Mac 凭据指纹精确匹配的权限并重启现有文件桥，不输出凭据、不下载程序。\n${repairCommand}`;
    const repairDigest=createHash('sha256').update(repairMessage).digest('hex');
    const repairRequestDigest=maintenanceRequestDigest(repairMessage);
    appendConnectionJobLog(job,'已核对现有隧道与凭据，仅补齐文件桥删除权限并重启现有服务');await jobStore.save();
    const sent=await sendMaintenanceRequest({call,instanceId,sessionKey:repairSession,message:repairMessage,idempotencyKey:`bridge-delete-${instanceId}-${repairTag}`,onProgress:m=>appendConnectionJobLog(job,m)});
    if(!sent.runId)throw Object.assign(Error('删除权限修复未获得 Gateway 执行回执'),{code:'PAIRING_REQUIRED'});
    await waitForMaintenance({sessionKey:repairSession,timeoutMs:180000,allowExecutionRecovery:true,expectedPromptHash:repairDigest,expectedRequestDigest:repairRequestDigest,
      readHistory:()=>call('chat.history',{sessionKey:repairSession,limit:50}),readRunStatus:()=>call('agent.wait',{runId:sent.runId,timeoutMs:1}),
      predicate:(_text,result)=>maintenanceMarkerPresent(result,repairTag,'DELETE_READY'),
      approveExec:approval=>approveMaintenanceExec({approval,instanceId,sessionKey:repairSession,expectedCommand:repairCommand,call}),
      onProgress:m=>appendConnectionJobLog(job,m),onPause:m=>{throw Object.assign(Error(m),{code:'MAINTENANCE_PAUSED'});}
    });
  }
  let restartPublicKey='';
  if(!verified.serviceHealthy || !verified.publicKey) {
    const restartTag=randomUUID().replaceAll('-','');
    const restartCommand=configureBridgeCommand([
      'set -eu',
      "D='/home/node/.openclaw/workspace/.openclaw-file-bridge'",
      'test -f "$D/server.py" && test -f "$D/secrets.json"',
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      `if ! ssh-keygen -y -P "" -f ~/.ssh/openclaw_tunnel >/dev/null 2>&1; then for F in ~/.ssh/openclaw_tunnel ~/.ssh/openclaw_tunnel.pub; do [ ! -e "$F" ] || mv "$F" "$F.stale-${restartTag}"; done; ssh-keygen -q -t ed25519 -f ~/.ssh/openclaw_tunnel -N "" -C openclaw-tunnel; fi`,
      ...(!verified.serviceHealthy ? [
      "A='--allow-unisolated-for-test'",
      '[ "$(id -u)" != 0 ] || A="$A --allow-root-for-test"',
      "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(\"delete\" in r.get(\"scopes\",[]) for r in d.get(\"tokens\",[]) if isinstance(r,dict)) else 1)' \"$D/secrets.json\" && A=\"$A --enable-delete\" || true",
      ...bridgeProcessStopSteps(),
      'nohup python3 "$D/server.py" --root /home/node/.openclaw/workspace --secret-file "$D/secrets.json" --enable-write $A </dev/null >"$D/server.log" 2>&1 &',
      'echo "$!" >"$D/server.pid"',
      "T=$(python3 -c 'import json,sys; print(next(r[\"token\"] for r in json.load(open(sys.argv[1]))[\"tokens\"] if isinstance(r,dict) and isinstance(r.get(\"token\"),str)))' \"$D/secrets.json\")",
      'OK=0; for N in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 3 -H "X-OpenClaw-Token: $T" http://127.0.0.1:18081/v1/capabilities >/dev/null 2>&1 && OK=1 && break; sleep 1; done',
      '[ "$OK" = 1 ] || { echo "文件桥进程启动失败"; tail -n 40 "$D/server.log"; exit 1; }',
      ] : []),
      `echo OPENCLAW_${restartTag}_PUBKEY_BEGIN`,
      'ssh-keygen -y -P "" -f ~/.ssh/openclaw_tunnel',
      `echo OPENCLAW_${restartTag}_PUBKEY_END`,
      `echo OPENCLAW_${restartTag}_SERVICE_READY`
    ].join('\n'));
    const restartMessage=`维护任务编号：${restartTag}\n请使用 exec 原样执行下面的已有文件桥启动命令。不下载程序、不修改凭据、不输出凭据。\n${restartCommand}`;
    const restartDigest=createHash('sha256').update(restartMessage).digest('hex'),restartRequestDigest=maintenanceRequestDigest(restartMessage);
    appendConnectionJobLog(job,verified.serviceHealthy?'文件桥服务健康，正在修复缺失的隧道密钥':'已核验现有程序与凭据，正在启动停止的文件桥进程');await jobStore.save();
    const sent=await sendMaintenanceRequest({call,instanceId,sessionKey,message:restartMessage,idempotencyKey:`bridge-restart-${instanceId}-${restartTag}`,onProgress:m=>appendConnectionJobLog(job,m)});
    if(!sent.runId)throw Object.assign(Error('文件桥启动未获得 Gateway 执行回执'),{code:'PAIRING_REQUIRED'});
    await waitForMaintenance({sessionKey,timeoutMs:180000,expectedPromptHash:restartDigest,expectedRequestDigest:restartRequestDigest,
      readHistory:()=>call('chat.history',{sessionKey,limit:50}),readRunStatus:()=>call('agent.wait',{runId:sent.runId,timeoutMs:1}),
      predicate:(_text,result)=>{
        if(!maintenanceMarkerPresent(result,restartTag,'SERVICE_READY'))return false;
        restartPublicKey=parseBridgeRestartPublicKey(result.executionText,restartTag);
        return Boolean(restartPublicKey);
      },
      approveExec:approval=>approveMaintenanceExec({approval,instanceId,sessionKey,expectedCommand:restartCommand,call}),
      onProgress:m=>appendConnectionJobLog(job,m),onPause:m=>{throw Object.assign(Error(m),{code:'MAINTENANCE_PAUSED'});}
    });
  }
  // A healthy Pod with failed Mac authentication indicates stale/colliding relay
  // routing. A new free route avoids interfering with another computer's tunnel.
  // Reuse the instance's previously exclusive route after a stopped service.
  // Allocate a new 中继服务器 port only when the saved route is not exclusive.
  job.port=await preferredBridgePort(instanceId);
  job.maintenanceSession=sessionKey;await jobStore.save();
  appendConnectionJobLog(job,`远端现有文件桥已核验，仅建立新的实例独立隧道端口 ${job.port}`);
  return continueVerifiedBridgeSteps(job,{phaseEvidence:'INSTALL_READY',verifiedPublicKey:verified.publicKey || restartPublicKey},null);
}

async function resumeConnectionJob(job) {
  requireActiveRecord(await readRegistry(),job.instanceId);
  if(['running','queued'].includes(job.status))return;
  if(job.reviewing)return job.reviewing;
  const review=(async()=>{
    job.status='running';job.checkedAt=Date.now();
    const originalStage=job.stage;
    let healthFailure=null,bridgeConfigured=false;
    try {
      const record=requireActiveRecord(await readRegistry(),job.instanceId);
      bridgeConfigured=Boolean(record.file_bridge);
      const health=await checkBridgeWithRecovery({instanceId:job.instanceId,configured:bridgeConfigured,run:runFarmCommand,onProgress:(message,details)=>{job.stage=details?.stage || job.stage;appendConnectionJobLog(job,message);}});
      if(health.ok && health.capabilities?.read && health.capabilities?.write && (!job.enableDelete || health.capabilities?.delete)) {
        await validateBridgeOperations(job.instanceId,job.enableDelete!==false);
        const mcp=await checkMcpDirect({instanceId:job.instanceId});
        if(!mcp.online)throw Error('文件桥可用，MCP 尚待配对');
        Object.assign(job,{status:'complete',stage:'complete',error:null,blockerCode:null,approvalKind:null,nextAction:'连接可用',result:{stage:'complete',instanceId:job.instanceId,capabilities:health.capabilities,checkedAt:Date.now(),message:'实际文件桥读写及 MCP 检查通过，已复用现有服务'}});
        appendConnectionJobLog(job,job.result.message);return;
      }
    } catch(error) {job.stage=originalStage;healthFailure=error;}
    if(shouldRepairExistingBridgeRoute({configured:bridgeConfigured,healthFailure,routeProbeSession:job.routeProbeSession})) {
      try {if(await repairExistingBridgeRoute(job))return;}
      catch(error){job.status='blocked';job.blockerCode=error.code || 'ROUTE_REPAIR_FAILED';job.nextAction='继续核对远端文件桥与独立隧道';appendConnectionJobLog(job,error.message);return;}
    }
    // Read and reuse completed work before handling an old error or expired run.
    // A confirmed phase only advances to its missing tunnel/checking steps.
    if(job.maintenanceSession && job.taskTag) {
      try {
        const history=await runFarmCommand(['call',job.instanceId,'chat.history','--params-json',JSON.stringify({sessionKey:job.maintenanceSession,limit:100}),'--timeout','15000'],'',[0],25000,false);
        const phaseEvidence=verifiedPhaseForContinuation(job,{...history,sessionKey:job.maintenanceSession});
        if(phaseEvidence) {
          try {if(await resumeVerifiedBridgePhase({phaseEvidence,healthFailure,continueSteps:()=>continueVerifiedBridgeSteps(job,{phaseEvidence},history),repairRoute:()=>repairExistingBridgeRoute(job)}))return;}
          catch(error){job.status='blocked';job.blockerCode=error.code || 'RECOVERY_FAILED';job.nextAction='继续检查原恢复任务';appendConnectionJobLog(job,error.message);return;}
        }
        if(maintenanceMarkerPresent(history,job.taskTag,'INSTALL_READY')) {
          try {if(await repairExistingBridgeRoute(job))return;}
          catch(error){job.status='blocked';job.blockerCode=error.code || 'ROUTE_REPAIR_FAILED';job.nextAction='继续核对已安装文件桥';appendConnectionJobLog(job,error.message);return;}
        }
      }catch { /* The conservative original-run checks below remain in force. */ }
    }
    // Continue the unfinished migration phase after proving the acknowledged
    // execution ended. Completed download/credential phases are never replayed.
    const partial=job.idempotencyKey?.match(new RegExp(`^bridge-install-${job.instanceId}-([0-9a-f]{32})-step-([0-3])-attempt-(\\d+)$`));
    if(partial && job.stage==='bridge_install') {
      try {
        await requireOriginalRunEnded(job);
        const history=await runFarmCommand(['call',job.instanceId,'chat.history','--params-json',JSON.stringify({sessionKey:job.maintenanceSession,limit:100}),'--timeout','15000'],'',[0],25000,false);
        const evidence=maintenanceResults(history);
        if(maintenanceMarkerPresent(evidence,job.taskTag,'INSTALL_READY')){
          if(await continueVerifiedBridgeSteps(job,{phaseEvidence:'INSTALL_READY'},history))return;
        }
        const priorStep=Number(partial[2]);
        const done=!evidence.failure && new RegExp(`(?:^|\\s)STAGED_${priorStep}(?=\\s|$)`).test(evidence.executionText);
        const startStep=priorStep+(done?1:0);
        if(startStep>3)throw Object.assign(Error('最后安装步骤缺少有效公钥及自检结果，保留任务待核对'),{code:'PUBLIC_KEY_REVIEW_REQUIRED'});
        await repairJobPermissions(job);
        appendConnectionJobLog(job,`原执行已结束，从未完成的第 ${startStep+1}/4 步继续；复用已完成步骤`);
        await installIntoExistingJob(job,{maintenanceSession:job.maintenanceSession,taskTag:partial[1],startStep,startAttempt:Number(partial[3])+1});
      }catch(error){job.status='blocked';job.blockerCode=error.code || 'RECOVERY_FAILED';job.approvalKind=error.approvalKind || null;job.nextAction='核对原安装步骤后继续';appendConnectionJobLog(job,error.message);}
      return;
    }
    if(!job.maintenanceSession && !job.dispatchIntent) {
      try {
        const mcp=await checkMcpDirect({instanceId:job.instanceId});
        job.status='blocked';job.blockerCode=mcp.online?'PREINSTALL_READY':'PAIRING_REQUIRED';job.approvalKind=mcp.online?null:'mac_pairing';
        job.nextAction=mcp.online?'连接已恢复，继续安装':'重新核验此实例的 Mac 配对申请';appendConnectionJobLog(job,job.nextAction);
        if(mcp.online)await installIntoExistingJob(job);
      } catch(error){job.status='blocked';job.blockerCode=error.code || 'CONNECTION_CHECK_FAILED';job.approvalKind=error.approvalKind || null;job.nextAction=error.approvalKind==='remote_internal'?'核验并补齐权限后继续安装':'检查此实例连接及原任务';appendConnectionJobLog(job,error.message);}
      return;
    }
    if(job.maintenanceSession && ['REMOTE_INTERNAL_APPROVAL_BLOCKED','REMOTE_INTERNAL_IDENTITY_UNVERIFIED','PERMISSION_REPAIR_BLOCKED','MAINTENANCE_RUN_UNCONFIRMED','EXEC_APPROVAL_BLOCKED','MAINTENANCE_TOOL_FAILED','MAINTENANCE_PAUSED','EXEC_COMMAND_MISMATCH','MAINTENANCE_EXEC_FAILED','TRANSIENT_CONNECTION'].includes(job.blockerCode)) {
      try {
        try {await requireOriginalRunEnded(job);}
        catch(error) {
          if(!['REMOTE_INTERNAL_APPROVAL_BLOCKED','REMOTE_INTERNAL_IDENTITY_UNVERIFIED','PERMISSION_REPAIR_BLOCKED'].includes(error.code))throw error;
          await repairJobPermissions(job);await requireOriginalRunEnded(job);
        }
        job.approvalKind=null;job.nextAction='原执行已结束；主动从未完成步骤继续安装';appendConnectionJobLog(job,job.nextAction);
        await installIntoExistingJob(job);
      }catch(error){job.status='blocked';job.blockerCode=error.code || 'PERMISSION_REPAIR_BLOCKED';job.nextAction='继续核验权限和原任务';appendConnectionJobLog(job,error.message);}
      return;
    }
    if(job.maintenanceSession) {
      try {
        const history=await runFarmCommand(['call',job.instanceId,'chat.history','--params-json',JSON.stringify({sessionKey:job.maintenanceSession,limit:50}),'--timeout','15000'],'',[0],25000,false);
        let run=null;
        if(job.remoteRunId)try {run=await runFarmCommand(['call',job.instanceId,'agent.wait','--params-json',JSON.stringify({runId:job.remoteRunId,timeoutMs:1}),'--timeout','10000'],'',[0],20000,false);}catch{}
        const decision=assessMaintenanceRecovery({job:{...job,sessionKey:job.maintenanceSession,runId:job.remoteRunId},history,run});
        if(decision.phaseEvidence) {
          try {if(await continueVerifiedBridgeSteps(job,decision,history))return;}
          catch(error){job.status='blocked';job.blockerCode=error.code || 'RECOVERY_FAILED';job.approvalKind=error.approvalKind || null;job.nextAction='继续检查原恢复任务';appendConnectionJobLog(job,error.message);return;}
        }
        job.blockerCode=decision.blockerCode;job.approvalKind=decision.approvalKind;
        job.message=maintenanceResults(history).failure?.message || '原维护会话已核对，实际文件桥尚未验通；未重新发送安装请求。';
        job.recoveryAction=decision.nextAction;
        if(decision.canRetry){job.status='blocked';job.blockerCode='SAFE_RETRY_READY';job.nextAction='已确认原运行结束且未成功，可以创建新的执行尝试';appendConnectionJobLog(job,job.nextAction);return;}
        if(decision.approvalKind==='remote_internal') {
          try {
            const pairs=await runFarmCommand(['call',job.instanceId,'device.pair.list','--params-json','{}','--timeout','15000'],'',[0],25000,false);
            job.internalPendingCount=(pairs.pending || []).length;
            job.missingEvidence=['内部执行客户端的实际运行用户','实际状态目录','磁盘设备公钥与待批准申请公钥匹配','所需权限与既有授权匹配'];
            job.message+=' 当前 Gateway 待配对申请 '+job.internalPendingCount+' 条；不能仅凭 Linux 或 repair 标记自动批准。';
          }catch{job.missingEvidence=['无法读取当前 Gateway 设备列表','内部执行客户端身份及既有权限'];}
        }
      } catch {job.blockerCode='HISTORY_QUERY_FAILED';job.message='暂时无法核对原执行记录，已停止自动重装';}
    }
    job.status='blocked';job.nextAction=job.approvalKind==='remote_internal'?'在此实例提供内部客户端运行用户、状态目录、公钥及既有权限证据；无需重复批准 Mac':'核对原执行结果及缺失的隧道步骤';
    appendConnectionJobLog(job,job.message);
  })().finally(async()=>{delete job.reviewing;job.checkedAt=Date.now();await jobStore.save();});
  Object.defineProperty(job,'reviewing',{value:review,configurable:true});return review;
}

function readBridgeConnectionJob(jobId) {
  const job = connectionJobs.get(jobId);
  if (!job) throw new Error("后台任务已过期，请刷新状态；已完成的连接不会丢失");
  return job;
}

async function createBridgeBatch(body) {
  const instanceIds = Array.isArray(body.instanceIds) ? [...new Set(body.instanceIds)] : [];
  if (!body.confirm) throw new Error("请先确认批量登记文件桥凭据");
  if (!instanceIds.length || instanceIds.length > 20) throw new Error("请选择 1 到 20 个实例");
  const instances = await readInstances();
  const known = new Map(instances.map((item) => [item.id,item]));
  if (instanceIds.some((id) => !known.has(id))) throw new Error("批次中包含未注册实例");
  const protectedInstances=instanceIds.map(id=>known.get(id)).filter(item=>!isBatchEligibleInstance(item));
  if(protectedInstances.length)throw new Error(`批量操作只允许数字名称实例；已保护：${protectedInstances.map(item=>item.name).join('、')}`);

  const batchId = randomUUID();
  const rows = [];
  for (const instanceId of instanceIds) {
    const token = `sk-openclaw-bridge-${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const generated = await createBridgePrompt({ instanceId, token });
    await configureBridgeConnection({
      instanceId,
      baseUrl: `http://127.0.0.1:${generated.port}`,
      token,
      replace: true,
      workspace: setupConfig.bridge.workspace
    });
    rows.push({ instanceId, token, port: generated.port, prompt: generated.prompt });
  }
  bridgeBatches.set(batchId, { createdAt: Date.now(), rows });
  for (const [id, batch] of bridgeBatches) {
    if (Date.now() - batch.createdAt > 60 * 60 * 1000) bridgeBatches.delete(id);
  }
  return { batchId, items: rows.map(({ instanceId, port, prompt }) => ({ instanceId, port, prompt })) };
}

async function authorizeBridgeBatch(body) {
  const batch = bridgeBatches.get(body.batchId);
  if (!batch) throw new Error("批次已过期，请重新生成第一段提示词");
  if (!body.confirm) throw new Error("请先确认本次批量 中继服务器 公钥授权");
  const keys = new Map((Array.isArray(body.items) ? body.items : []).map((item) => [item.instanceId, item.publicKey]));
  if (keys.size !== batch.rows.length) throw new Error("请为每个实例粘贴 SSH 公钥");

  const completed = [];
  for (const row of batch.rows) {
    const result = await authorizeBridge({
      instanceId: row.instanceId,
      token: row.token,
      port: row.port,
      publicKey: keys.get(row.instanceId),
      confirm: true
    });
    completed.push({ instanceId: row.instanceId, port: row.port, prompt: result.prompt });
  }
  bridgeBatches.delete(body.batchId);
  return { items: completed, message: `已授权 ${completed.length} 个实例，请并行执行第二段提示词。` };
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function buildPrompt(instance, message, allowWrite) {
  return `读取并遵循本地配套技能 ${FARM_SKILL}；脚本路径为 ${FARM_SCRIPT}，Python 解释器为 ${PYTHON_BIN}；本次注入的 openclaw_farm MCP 提供远端工具。只操作 ${instance.id}；禁止切换实例或泄露凭据。
接入流程：登记实例 → 验通 MCP/Gateway → 通过独立维护会话安装文件桥 → 建立并检查安全隧道。用户已要求恢复这套原工作流，不得改成绕过文件桥的独立 R2 下载流程。文件桥安装和手动安装提示词共用本机配置的 OPENCLAW_FILE_BRIDGE_R2_URL，校验固定 SHA-256 后才安装；bundled 模式仅作为显式选择的备用，不恢复旧失效地址。
日常操作：文件桥在线后用文件工具读写工作区；复杂控制用 MCP/Gateway。R2 文件交付仍可按用户的具体请求使用，但不能把文件桥安装程序的链接当成业务文件下载链接。不得猜测桶名或伪造链接。MCP 与文件桥分别检查，MCP 在线不能代表文件桥已通。需要会话操作时使用 openclaw_sessions_list、openclaw_chat_send 和 openclaw_chat_history；chat.send 接收确认不代表远端工作完成。

权限：${allowWrite ? "本条已授权用户明确要求的必要写操作。" : "本条只读；需要写入、删除、上传或改变状态时，先要求用户勾选授权，禁止执行。"}
省额度：直接做事，不重复分析或无意义复查；简单结果尽量不超过 200 汉字，必要代码除外；计划不能冒充完成。
用户：${message}`;
}

function extractEvent(event, state) {
  if (event.thread_id) state.threadId = event.thread_id;
  if (event.type === "thread.started" && event.thread_id) state.threadId = event.thread_id;
  const item = event.item;
  if (item?.type === "agent_message" && typeof item.text === "string") state.messages.push(item.text);
  if (event.type === "agent_message" && typeof event.text === "string") state.messages.push(event.text);
  if (event.type === "error") state.errors.push(event.message || "Codex 运行失败");
}

async function runCodex(instance, message, allowWrite, model) {
  const threads = await readThreads();
  const previousThreadId = threads[instance.id]?.threadId;
  const outputFile = join(tmpdir(), `openclaw-farm-ui-${randomUUID()}.txt`);
  const prompt = buildPrompt(instance, message, allowWrite);
  const args = previousThreadId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", "-o", outputFile, previousThreadId, prompt]
    : ["exec", "--json", "--color", "never", "--skip-git-repo-check", "-s", "workspace-write", "-C", PROJECT_ROOT, "-o", outputFile, prompt];

  const selectedModel = typeof model === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(model)
    ? model
    : "";
  if (selectedModel) args.unshift("--model", selectedModel);
  const mcpEnvironment = Object.keys(process.env).filter((key) => key.startsWith("OPENCLAW_") && !/TOKEN|SECRET|PASSWORD/.test(key));
  args.unshift(
    "-c", `mcp_servers.openclaw_farm.command=${JSON.stringify(PYTHON_BIN)}`,
    "-c", `mcp_servers.openclaw_farm.args=${JSON.stringify([resolve(dirname(FARM_SCRIPT), "openclaw_mcp_server.py")])}`,
    "-c", `mcp_servers.openclaw_farm.env_vars=${JSON.stringify(mcpEnvironment)}`,
  );
  if (!allowWrite) {
    args.unshift("-c", `mcp_servers.openclaw_farm.enabled_tools=${JSON.stringify(["openclaw_list_instances", "openclaw_read_file", "openclaw_file_list", "openclaw_file_stat", "openclaw_file_read", "openclaw_sessions_list", "openclaw_chat_history"])}`);
  }

  const state = { threadId: previousThreadId || null, messages: [], errors: [], stderr: "" };
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          extractEvent(JSON.parse(line), state);
        } catch {
          // Keep the final response file as the source of truth.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (pending.trim()) {
        try {
          extractEvent(JSON.parse(pending), state);
        } catch {
          // Ignore non-JSON trailing output.
        }
      }
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(state.errors.at(-1) || state.stderr.trim() || `Codex 退出码 ${code}`));
    });
  });

  let finalResponse = state.messages.at(-1) || "";
  try {
    finalResponse = (await readFile(outputFile, "utf8")).trim() || finalResponse;
  } finally {
    await unlink(outputFile).catch(() => {});
  }
  if (!finalResponse) throw new Error("Codex 没有返回内容");

  if (state.threadId) {
    threads[instance.id] = {
      threadId: state.threadId,
      turnCount: (threads[instance.id]?.turnCount || 0) + 1,
      updatedAt: new Date().toISOString()
    };
    await writeThreads(threads);
  }
  return {
    message: finalResponse,
    threadId: state.threadId,
    turnCount: threads[instance.id]?.turnCount || 1
  };
}

function enqueue(instanceId, task) {
  const previous = queues.get(instanceId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const release = () => {
    if (queues.get(instanceId) === tracked) queues.delete(instanceId);
  };
  const tracked = run.then(release, release);
  queues.set(instanceId, tracked);
  return run;
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${HOST}`).pathname;
  const filePath = staticFilePath(PUBLIC_ROOT, requestPath);
  if (!filePath) { jsonResponse(res, 403, { error: "禁止访问" }); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch (error) {
    jsonResponse(res, error.code === "ENOENT" ? 404 : 500, { error: "页面不存在" });
  }
}

function requireLocalSetupRequest(req) {
  const localPort = server.address()?.port || PORT;
  if (![`${HOST}:${localPort}`,`localhost:${localPort}`].includes(req.headers.host)) throw Error("首次配置只能在本机管理台操作");
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw Error("首次配置只能在本机管理台操作");
}
async function runLocalCommand(executable, args, timeoutMs = 30000) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {stdio:['ignore','pipe','pipe']});
    let output = '', errorText = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {output += chunk; if(output.length > 65536)child.kill('SIGTERM');});
    child.stderr.on('data', chunk => {errorText += chunk;});
    child.on('error', error => {clearTimeout(timer);reject(error);});
    child.on('close', (code, signal) => {clearTimeout(timer); if(code === 0)done(output.trim()); else reject(Error(signal ? '本机操作超时' : redactText(errorText) || '本机操作失败'));});
  });
}
async function setupPublicKey() {
  await assertRelayReady();
  return runLocalCommand('ssh-keygen',['-y','-f',RELAY_KEY,'-P','']);
}
async function createSetupKey() {
  await mkdir(dirname(RELAY_KEY), {recursive:true,mode:0o700});
  // ssh-keygen cannot overwrite an existing key: inspect both path names first.
  const existing = await lstat(RELAY_KEY).catch(error => {if(error.code !== 'ENOENT')throw error;return null;});
  if(existing) {if(!existing.isFile() || existing.isSymbolicLink())throw Error('SSH 私钥路径类型不正确');return {created:false,publicKey:await setupPublicKey()};}
  if(await lstat(RELAY_KEY+'.pub').then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('该路径已有公钥文件，请选择新的密钥路径');
  await runLocalCommand('ssh-keygen',['-q','-t','ed25519','-f',RELAY_KEY,'-N','','-C','openclaw-farm-client']);
  return {created:true,publicKey:await setupPublicKey()};
}
function applySetup(setup) {
  setupConfig = setup;
  RELAY_DESTINATION = `${setup.relay.user}@${setup.relay.host}`;
  RELAY_KEY = setup.relay.identityFile;
  Object.assign(process.env, setupEnvironment(setup));
  relayVerifiedUntil = 0;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      jsonResponse(res,200,{config:setupConfig,configured:setupConfig.setupComplete,configFile:CONFIG_FILE,activePort:PORT});return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup') {
      requireLocalSetupRequest(req);
      const body=await readJsonBody(req);
      const setup=normalizeSetup(body.config || body);
      requireRelayConfig(setup);
      let registration=null;
      if(body.initialInstance?.url || body.initialInstance?.token)registration=await registerConnection({...body.initialInstance,deferHealth:true});
      if(body.complete === true) {
        await assertRelayReady(setup);
        await runSsh(['-p',String(setup.relay.sshPort),'-T','-i',setup.relay.identityFile,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',`${setup.relay.user}@${setup.relay.host}`,'python3 -c "print(1)"']);
      }
      const sameSettings=JSON.stringify({...setup,setupComplete:false}) === JSON.stringify({...setupConfig,setupComplete:false});
      setup.setupComplete=body.complete === true || (setupConfig.setupComplete && sameSettings);
      await enqueue('setup-config',()=>persistSetup(setup));
      applySetup(setup);
      jsonResponse(res,200,{ok:true,config:setup,registration,restartRequired:setup.consolePort !== PORT});return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/ssh-key') {
      requireLocalSetupRequest(req);
      const result=await enqueue('setup-ssh-key',createSetupKey);
      jsonResponse(res,200,{ok:true,...result});return;
    }
    if (req.method === 'GET' && url.pathname === '/api/setup/relay-authorization') {
      requireLocalSetupRequest(req);
      const publicKey=await setupPublicKey();
      jsonResponse(res,200,{publicKey,script:buildClientAuthorizationScript(publicKey,setupConfig.relay.portRange),user:setupConfig.relay.user,host:setupConfig.relay.host});return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/check-relay') {
      requireLocalSetupRequest(req);
      await assertRelayReady();await verifyRelayAuthorization(runSsh);
      const prerequisiteScript="import json,shutil,socket\nprint(json.dumps({'python':True,'ssh':bool(shutil.which('ssh'))}))\n";
      await runSsh(['-T','-i',RELAY_KEY,'-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',RELAY_DESTINATION,'python3 -'],prerequisiteScript);
      jsonResponse(res,200,{ok:true,message:'SSH 登录和中继 Python 已实际验通；各实例隧道仍由一键安装流程独立验收。'});return;
    }
    if (req.method === "GET" && url.pathname === "/api/performance") {
      jsonResponse(res, 200, {...performanceProfile,
        gatewayConcurrency:gatewayPool.limit, sshConcurrency:sshPool.limit,
        logicalCpus:performanceProfile.availableParallelism, memoryGiB:performanceProfile.totalMemoryGiB,
        gatewayActive:gatewayPool.active, gatewayQueued:gatewayPool.queued,
        sshActive:sshPool.active, sshQueued:sshPool.queued
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/local-status") {
      const exists = async (file) => Boolean(file) && await access(file).then(() => true, () => false);
      const sdk = await exists(process.env.OPENCLAW_PACKAGE_ROOT && join(process.env.OPENCLAW_PACKAGE_ROOT, "dist", "plugin-sdk", "testing.js"));
      const keychain = await exists(process.env.OPENCLAW_KEYCHAIN_BIN);
      let relayKey = false;
      try { await assertRelayReady(); relayKey = true; } catch { /* shown as a setup requirement */ }
      jsonResponse(res, 200, { ok: true, service: "openclaw-farm-console", platform: process.platform, installationId: process.env.OPENCLAW_INSTALLATION_ID || null, sdk, keychain, relayKey,
        transferMode: "mcp-bridge", installerSource: process.env.OPENCLAW_FILE_BRIDGE_INSTALL_MODE || "bundled", r2Verified: false,
        consoleUrl:`http://${HOST}:${PORT}`,instanceUsagePolicy:{batchNamePattern:"^[0-9]+$",namedInstancesRequireExplicitAuthorization:true},
        message: !sdk || !keychain ? "本地连接组件不完整，请重新运行安装程序。" : "连接流程：登记 → MCP → 文件桥 → 安全隧道。文件桥使用随安装包提供且经过校验的程序，完成情况以实际健康检查为准。" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/instances") {
      const [instances, threads] = await Promise.all([readInstances(), readThreads()]);
      const registry=await readRegistry();
      jsonResponse(res, 200, {
        instances: instances.map((item) => ({ ...item, turnCount: threads[item.id]?.turnCount || 0 })),
        archivedInstanceIds:Object.values(registry.instances || {}).filter(isArchived).map(item=>item.id)
      });
      return;
    }
    const archivePath=url.pathname.match(/^\/api\/instances\/(ins_[a-z0-9]+)\/archive$/i);
    if(req.method==='POST' && archivePath) {
      const result=await archiveInstance(archivePath[1]);
      jsonResponse(res,200,{ok:true,...result});return;
    }
    const instancePath = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
    if (req.method === "PATCH" && instancePath) {
      const instanceId = decodeURIComponent(instancePath[1]);
      const body = await readJsonBody(req);
      const name = await updateInstanceName(instanceId, body.name);
      jsonResponse(res, 200, { id: instanceId, name });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/actions") {
      const body = await readJsonBody(req);
      const instance = await readAuthorizedInstance(body.instanceId, body);
      const result = await enqueue(instance.id, () => runFarmAction(instance.id, body.action, body.path || "."));
      jsonResponse(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/gateway-chat") {
      const body = await readJsonBody(req);
      const instance = await readAuthorizedInstance(body.instanceId, body);
      const operation = String(body.operation || "");
      const sessionKey = typeof body.sessionKey === "string" && body.sessionKey.trim()
        ? body.sessionKey.trim()
        : "agent:main:main";
      if (sessionKey.length > 500 || sessionKey.includes("\0")) throw new Error("Gateway 会话标识无效");
      const result = await enqueue(`${instance.id}:gateway-chat`, async () => {
        const runGatewayChatCommand = async (args, timeoutMs) => {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              return await runFarmCommand(args, "", [0], timeoutMs);
            } catch (error) {
              lastError = error;
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
          throw lastError;
        };
        if (operation === "history") {
          return runGatewayChatCommand([
            "call", instance.id, "chat.history",
            "--params-json", JSON.stringify({ sessionKey, limit: 20 }),
            "--timeout", "60000"
          ], "", [0], 75_000);
        }
        if (operation === "send") {
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message || message.length > 12000) throw new Error("消息不能为空，且不能超过 12000 字");
          const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          return runGatewayChatCommand([
            "call", instance.id, "chat.send",
            "--params-json", JSON.stringify({ sessionKey, message, deliver: false, idempotencyKey }),
            "--timeout", "120000", "--allow-write"
          ], "", [0], 135_000);
        }
        throw new Error("不支持的 Gateway 聊天操作");
      });
      jsonResponse(res, 200, { ok: true, result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/files") {
      const body = await readJsonBody(req);
      const instance = await readAuthorizedInstance(body.instanceId, body);
      const operation = String(body.operation || "");
      const targetPath = typeof body.path === "string" ? body.path.trim() || "." : ".";
      if (targetPath.length > 2048 || targetPath.includes("\0") || targetPath.startsWith("/") || targetPath.split("/").includes("..")) {
        throw new Error("工作区路径无效，只允许使用工作区内的相对路径");
      }
      const result = await enqueue(instance.id, async () => {
        const currentFileStat = async (allowMissing = false) => {
          try {
            const result = await runFarmCommand(["file-stat", instance.id, targetPath], "", [0], 60_000);
            if (!result?.ok || !result.stat || typeof result.stat.type !== "string") throw new Error("无法核验文件当前版本");
            return result.stat;
          } catch (error) {
            if (allowMissing && /文件桥 HTTP 404 \(not_found\)/.test(String(error.message || ""))) return null;
            throw error;
          }
        };
        if (operation === "list") {
          const listed = await runFarmCommand(["file-list", instance.id, targetPath], "", [0], 60_000);
          const allEntries = Array.isArray(listed.entries) ? listed.entries : [];
          return { ...listed, entries: allEntries.slice(0, 1000), totalEntries: allEntries.length, truncated: allEntries.length > 1000 };
        }
        if (operation === "read") return runFarmCommand(["file-read", instance.id, targetPath, "--max-bytes", "1048576"], "", [0], 60_000);
        if (operation === "write") {
          if (targetPath === ".") throw new Error("不能把工作区根目录当作文件保存");
          if (typeof body.content !== "string" || Buffer.byteLength(body.content, "utf8") > 1024 * 1024) throw new Error("文本内容不能超过 1 MB");
          const stat = await currentFileStat(true);
          if (stat && (stat.type !== "file" || !/^[a-f0-9]{64}$/i.test(stat.sha256 || ""))) throw new Error("目标不是可安全覆盖的普通文件");
          const args = ["file-write", instance.id, targetPath, "--content-stdin", "--approved-write"];
          if (stat) args.push("--expected-sha256", stat.sha256);
          return runFarmCommand(args, body.content, [0], 90_000);
        }
        if (operation === "mkdir") {
          if (targetPath === ".") throw new Error("请输入新文件夹名称");
          return runFarmCommand(["file-mkdir", instance.id, targetPath, "--parents", "--approved-write"], "", [0], 60_000);
        }
        if (operation === "delete") {
          if (targetPath === ".") throw new Error("不能删除整个工作区根目录");
          const stat = await currentFileStat();
          const args = ["file-delete", instance.id, targetPath, "--approved-delete"];
          if (body.recursive === true) args.push("--recursive");
          if (stat.type === "file") {
            if (!/^[a-f0-9]{64}$/i.test(stat.sha256 || "")) throw new Error("无法核验文件当前版本，已停止删除");
            args.push("--expected-sha256", stat.sha256);
          }
          return runFarmCommand(args, "", [0], 90_000);
        }
        throw new Error("不支持的文件操作");
      });
      jsonResponse(res, 200, { ok: true, result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/status-lights") {
      const body = await readJsonBody(req);
      const requested = Array.isArray(body.instanceIds) ? [...new Set(body.instanceIds)].slice(0, 50) : [];
      const instances = await readInstances();
      const known = new Map(instances.map((item) => [item.id,item]));
      const statuses = {};
      const protectedInstanceIds=[];
      await Promise.all(requested.filter((id) => known.has(id)).map(async (instanceId) => {
        const instance=known.get(instanceId);
        if(!isBatchEligibleInstance(instance) && body.allowNamedInstance!==true){protectedInstanceIds.push(instanceId);return;}
        const [mcp, bridge] = await Promise.allSettled([
          checkMcpDirect({ instanceId }),
          healthPool.run(() => runFarmAction(instanceId, "bridge_health"))
        ]);
        statuses[instanceId] = {
          mcp: mcp.status === "fulfilled" && mcp.value?.online === true,
          bridge: bridge.status === "fulfilled"
        };
      }));
      jsonResponse(res, 200, { ok: true, statuses,protectedInstanceIds });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/register") {
      const body = await readJsonBody(req);
      const result = await registerConnection(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/mcp/check") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      const result = await checkMcpDirect(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/mcp/install-bridge") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      if (body.confirm !== true) throw new Error("请先确认本次通过 MCP 写入远端配置");
      if (body.allowSharedWorkspace !== true) throw new Error("请先确认允许当前实例使用共享工作区兼容模式");
      const result = await startBridgeConnectionJob(body);
      jsonResponse(res, 202, { ok: true, ...result });
      return;
    }
    const latestJobPath=url.pathname.match(/^\/api\/connections\/instances\/(ins_[a-z0-9]+)\/latest$/i);
    if(req.method==='GET' && latestJobPath) {
      if(isArchived((await readRegistry()).instances?.[latestJobPath[1]])) {
        jsonResponse(res,200,{ok:true,archived:true,job:null});return;
      }
      const job=[...connectionJobs.values()].filter(j=>j.instanceId===latestJobPath[1]).sort((a,b)=>b.createdAt-a.createdAt)[0];
      jsonResponse(res,200,{ok:true,job:job?publicJob(job):null});return;
    }
    const resumeJobPath = url.pathname.match(/^\/api\/connections\/jobs\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeJobPath) {
      const body=await readJsonBody(req);
      const job = readBridgeConnectionJob(decodeURIComponent(resumeJobPath[1]));
      requireActiveRecord(await readRegistry(),job.instanceId);
      await readAuthorizedInstance(job.instanceId,body);
      authorizePermissionRepairForJob(job,body);
      resumeConnectionJob(job).catch(error=>{job.status='blocked';appendConnectionJobLog(job,error.message);});
      jsonResponse(res, 200, {ok:true,jobId:job.id,status:job.status});
      return;
    }
    const connectionJobPath = url.pathname.match(/^\/api\/connections\/jobs\/([^/]+)$/);
    if (req.method === "GET" && connectionJobPath) {
      const job = readBridgeConnectionJob(decodeURIComponent(connectionJobPath[1]));
      jsonResponse(res, 200, { ok: true, job:publicJob(job) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/file-bridge") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      const result = await configureBridgeConnection(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/file-bridge/prompt") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      const result = await createBridgePrompt(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/file-bridge/authorize") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      const result = await authorizeBridge(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/file-bridge/batch-prompts") {
      const body = await readJsonBody(req);
      const result = await createBridgeBatch(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connections/file-bridge/batch-authorize") {
      const body = await readJsonBody(req);
      const result = await authorizeBridgeBatch(body);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      try {
        const cachePath = join(process.env.CODEX_HOME || join(process.env.HOME, ".codex"), "models_cache.json");
        const cache = JSON.parse(await readFile(cachePath, "utf8"));
        const models = Array.isArray(cache.models)
          ? cache.models
              .filter((model) => model.visibility === "list" && typeof model.slug === "string")
              .map((model) => ({ id: model.slug, name: model.display_name || model.slug }))
          : [];
        jsonResponse(res, 200, { models });
      } catch {
        jsonResponse(res, 200, { models: [] });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 12000) {
        jsonResponse(res, 400, { error: "消息不能为空，且不能超过 12000 字" });
        return;
      }
      const instance = await readAuthorizedInstance(body.instanceId,body);
      if (!instance.hasCredential) {
        jsonResponse(res, 409, { error: "该实例的凭据还未就绪，请先补齐凭据" });
        return;
      }
      const result = await enqueue(instance.id, () => runCodex(instance, message, body.allowWrite === true, body.model));
      jsonResponse(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reset-thread") {
      const body = await readJsonBody(req);
      await readAuthorizedInstance(body.instanceId,body);
      const threads = await readThreads();
      delete threads[body.instanceId];
      await writeThreads(threads);
      jsonResponse(res, 200, { ok: true, turnCount: 0 });
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error(chineseError(error));
    jsonResponse(res, error.code==='NAMED_INSTANCE_AUTHORIZATION_REQUIRED'?403:500, { error: chineseError(error),code:error.code || undefined });
  }
});

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? `本地端口 ${PORT} 已被占用，请通过“启动管理台”复用已有服务，或先停止占用程序。` : chineseError(error));
  process.exitCode = 1;
});

if (process.argv[1] && resolve(process.argv[1]) === join(PROJECT_ROOT, "server.mjs")) {
  server.listen(PORT, HOST, () => console.log(`OpenClaw Farm Console: http://${HOST}:${PORT}`));
}

export { server, redactText, chineseError, nextBridgePort, relayConfigArgs, buildPrompt, enqueue, pairingState, assertRelayAuthorized, gatewayFailureKind, newBridgeMaintenanceSession };
