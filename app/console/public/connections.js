function permissionStageLabel(stage) {
  return {local_forward_repair:'正在恢复当前实例的本地隧道',route_check:'正在核对现有文件桥和隧道端口',permission_check:"正在核验审批客户端身份与权限",permission_repair:"正在通过 MCP 补齐已授权的管理权限",permission_verify:"正在验证执行审批，随后继续文件桥安装"}[stage] || "";
}
function internalPermissionBlocked(flow) {
  return flow?.jobStatus === "blocked" && /^(REMOTE_INTERNAL_|PERMISSION_)/.test(flow.blockerCode || "");
}
function bridgeActionLabel(flow, healthy = false) {
  return internalPermissionBlocked(flow) ? "核验并补齐权限后继续安装" : healthy ? "检查连接 / 自动修复" : "一键安装文件桥";
}
const SELECTED_INSTANCE_KEY = "openclawFarm.selectedConnectionInstance";
const CONNECTION_MEMORY_KEY = "openclawFarm.connectionMemory.v1";
const NAMED_AUTH_SESSION_KEY = "openclawFarm.namedAuthorization.v1";
const NAMED_PERMISSION_AUTH_SESSION_KEY = "openclawFarm.namedPermissionAuthorization.v1";
function loadNamedAuthorizations() {
  try { return new Set(JSON.parse(sessionStorage.getItem(NAMED_AUTH_SESSION_KEY) || "[]")); }
  catch { return new Set(); }
}
const namedAuthorizations = loadNamedAuthorizations();
function loadNamedPermissionAuthorizations() {
  try { return new Set(JSON.parse(sessionStorage.getItem(NAMED_PERMISSION_AUTH_SESSION_KEY) || "[]")); }
  catch { return new Set(); }
}
const namedPermissionAuthorizations = loadNamedPermissionAuthorizations();
function saveNamedAuthorizations() {
  sessionStorage.setItem(NAMED_AUTH_SESSION_KEY, JSON.stringify([...namedAuthorizations]));
}
function saveNamedPermissionAuthorizations() {
  sessionStorage.setItem(NAMED_PERMISSION_AUTH_SESSION_KEY, JSON.stringify([...namedPermissionAuthorizations]));
}
function loadConnectionMemory() {
  try {
    const value = JSON.parse(localStorage.getItem(CONNECTION_MEMORY_KEY) || "{}");
    const flows = Object.fromEntries(Object.entries(value.flows || {}).map(([id,flow])=>[id,{jobId:flow.jobId || '',jobStatus:'unchecked'}]));
    return {statuses:{},flows};
  } catch {
    return { statuses: {}, flows: {} };
  }
}
const connectionMemory = loadConnectionMemory();
const state = {
  instances: [], selectedId: "", lastError: "",
  statuses: connectionMemory.statuses, flows: connectionMemory.flows,
  currentJobId: "", approvalPurpose: "", pollingJobs: new Set()
};
const $ = (id) => document.getElementById(id);

function namedInstanceAccess(instanceId=state.selectedId) {
  const instance=state.instances.find(item=>item.id===instanceId);
  return instance?.protectedName===true && namedAuthorizations.has(instanceId) && (instanceId!==state.selectedId || $("allowNamedInstance")?.checked===true);
}
function canUseInstance(instanceId=state.selectedId) {
  const instance=state.instances.find(item=>item.id===instanceId);
  return !!instance && (instance.protectedName!==true || namedInstanceAccess(instanceId));
}
function accessPayload(instanceId=state.selectedId) {return namedInstanceAccess(instanceId)?{allowNamedInstance:true}:{};}
function bridgeAccessPayload(instanceId=state.selectedId) {
  const payload=accessPayload(instanceId);
  if(namedInstanceAccess(instanceId) && namedPermissionAuthorizations.has(instanceId) && (instanceId!==state.selectedId || $("allowInternalPermissionRepair")?.checked===true)) {
    payload.allowInternalPermissionRepair=true;
  }
  return payload;
}
function syncNamedInstanceProtection() {
  const instance=state.instances.find(item=>item.id===state.selectedId),protectedName=instance?.protectedName===true;
  if ($("allowNamedInstance")) $("allowNamedInstance").checked=protectedName && namedAuthorizations.has(state.selectedId);
  if ($("allowInternalPermissionRepair")) $("allowInternalPermissionRepair").checked=protectedName && namedPermissionAuthorizations.has(state.selectedId);
  $("namedInstanceAuthorizationRow").hidden=!protectedName;
  $("namedPermissionAuthorizationRow").hidden=!protectedName;
  $("namedPairingPromptButton").hidden=!protectedName;
  const allowed=!!instance && (!protectedName || $("allowNamedInstance").checked);
  $("namedPairingPromptButton").disabled=!allowed || !instance?.hasCredential;
  $("checkMcpButton").disabled=!instance?.hasCredential || !allowed;
  const bridgeAllowed=allowed && (!protectedName || $("allowInternalPermissionRepair").checked);
  $("installBridgeButton").disabled=!bridgeAllowed;
  $("codexHelpButton").disabled=!instance?.hasCredential || !allowed;
  if(protectedName && !allowed)renderResult('这是受保护的命名实例。默认不会检查或调用；只有你明确勾选本次单独授权后才能操作。','info');
  else if(protectedName && !bridgeAllowed)renderResult('MCP 可以检查。若要一键安装并在需要时补齐内部执行权限，请勾选下方五项权限授权。','info');
}

function mountEfficiencyModeBadge() {
  if ($("efficiencyModeBadge")) return;
  const badge = document.createElement("div");
  badge.id = "efficiencyModeBadge";
  badge.textContent = "MCP 接通 → 安装文件桥 → 验证安全隧道";
  Object.assign(badge.style, {
    display: "inline-flex",
    marginTop: "12px",
    padding: "8px 12px",
    border: "1px solid rgba(73, 211, 167, .38)",
    borderRadius: "999px",
    background: "rgba(73, 211, 167, .10)",
    color: "#70e0bd",
    fontSize: "13px",
    fontWeight: "700",
    letterSpacing: ".02em"
  });
  $("selectedId")?.insertAdjacentElement("afterend", badge);
}

function saveConnectionMemory() {
  localStorage.setItem(CONNECTION_MEMORY_KEY, JSON.stringify({flows:Object.fromEntries(Object.entries(state.flows).map(([id,flow])=>[id,{jobId:flow.jobId || ""}]))}));
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  } catch {
    throw new Error("管理台后台未运行或连接已中断，请刷新页面后重试");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试");
  return data;
}

function renderResult(message, type = "") {
  if ($("allowShared")?.checked && /请先勾选共享工作区/.test(message)) {
    message = "共享工作区读写已允许，可继续安装文件桥。";
    type = "info";
  }
  $("resultBox").textContent = message;
  $("resultBox").style.whiteSpace = "pre-wrap";
  $("resultBox").className = `result ${type}`.trim();
  if (type === "error") {
    state.lastError = message;
    $("codexHelpButton").disabled = !state.selectedId;
  }
}

function setInstanceResult(instanceId, message, type = "") {
  if (instanceId) {
    state.flows[instanceId] = { ...(state.flows[instanceId] || {}), message, type, updatedAt: Date.now() };
    saveConnectionMemory();
  }
  if (!instanceId || state.selectedId === instanceId) renderResult(message, type);
}

function setResult(message, type = "") {
  setInstanceResult(state.selectedId, message, type);
}

function setStep(id, status) {
  const element = $(id);
  element.classList.remove("active", "done");
  if (status) element.classList.add(status);
}

function renderInstances() {
  $("instanceList").innerHTML = "";
  for (const instance of state.instances) {
    const button = document.createElement("button");
    button.className = `instance-button ${instance.id === state.selectedId ? "selected" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(instance.name || instance.id)}</strong><span>${escapeHtml(instance.id)}</span>`;
    button.addEventListener("click", () => selectInstance(instance.id));
    $("instanceList").append(button);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function selectInstance(instanceId, checkNow = true) {
  state.selectedId = instanceId;
  syncTokenEditor();
  $("execApprovalBox").classList.add("hidden");
  localStorage.setItem(SELECTED_INSTANCE_KEY, instanceId);
  const instance = state.instances.find((item) => item.id === instanceId);
  renderInstances();
  $("selectedTitle").textContent = instance?.name || instanceId;
  $("selectedId").textContent = instanceId;
  syncNamedInstanceProtection();
  applyLights();
  applySelectedProgress();
  restoreConnectionUi(instance);
  if (!state.flows[instanceId]?.message) {
    setResult(instance?.hasCredential
      ? "点击“一键安装文件桥”，自动检查 MCP、在主 agent 新会话安装、批准本次命令并接通隧道。"
      : "该实例缺少凭据，请先在上方登记。", instance?.hasCredential ? "" : "error");
  }
  syncLatestConnectionJob(instanceId).catch(error=>setInstanceResult(instanceId,error.message,"error"));
  if (checkNow && instance?.hasCredential && canUseInstance(instanceId)) {
    refreshStatuses().catch((error) => setResult(error.message, "error"));
  }
}

function applyLights() {
  const current = state.statuses[state.selectedId] || {};
  const flow = state.flows[state.selectedId] || {};
  $("remoteApprovalHelpButton").hidden = !(flow.jobStatus === "blocked" && flow.blockerCode === "REMOTE_INTERNAL_IDENTITY_UNVERIFIED");
  $("remoteApprovalHelpText").hidden = true;
  $("mcpLight").className = current.mcpStale ? "stale" : current.mcp === true ? "online" : current.mcp === false ? "offline" : "";
  const instance = state.instances.find((item) => item.id === state.selectedId);
  $("bridgeLight").className = current.bridgeStale ? "stale" : current.bridge === true ? "online" : current.bridge === false && instance?.fileBridge ? "offline" : "";
  if ($("statusFreshness")) $("statusFreshness").textContent = current.mcpStale || current.bridgeStale ? "灰灯为上次结果，正在等待本次检查" : "";
}

function applySelectedProgress() {
  const instance = state.instances.find((item) => item.id === state.selectedId);
  if (!instance) return;
  const current = state.statuses[state.selectedId] || {};
  const flow = state.flows[state.selectedId] || {};
  $("remoteApprovalHelpButton").hidden = !(flow.jobStatus === "blocked" && flow.blockerCode === "REMOTE_INTERNAL_IDENTITY_UNVERIFIED");
  $("remoteApprovalHelpText").hidden = true;
  setStep("stepRegistry", instance.hasCredential ? "done" : "active");
  const mcpReady=current.mcp && !current.mcpStale,bridgeReady=current.bridge && !current.bridgeStale;
  setStep("stepMcp", mcpReady ? "done" : "active");
  setStep("stepBridge", bridgeReady ? "done" : mcpReady ? "active" : "");
  setStep("stepTunnel", bridgeReady ? "done" : "");
  $("installBridgeButton").textContent = bridgeActionLabel(state.flows[state.selectedId], mcpReady && bridgeReady);
  const restartable=["blocked","failed"].includes(flow.jobStatus) && !!flow.jobId && !bridgeReady;
  $("restartBridgeButton").hidden=!restartable;
  $("restartBridgeButton").disabled=!restartable;
}

function restoreConnectionUi(instance) {
  const flow = state.flows[instance?.id] || {};
  state.approvalPurpose = flow.approvalPurpose || "";
  if (flow.approval?.prompt) {
    $("approvalText").textContent = flow.approval.text;
    $("approvalPrompt").value = flow.approval.prompt;
    $("copyApprovalButton").textContent = flow.approval.copyLabel || "复制批准提示词";
    $("resumeButton").textContent = flow.approval.resumeLabel || "已批准，继续配置";
    $("approvalBox").classList.remove("hidden");
  } else {
    $("approvalBox").classList.add("hidden");
  }
  if (flow.message) renderResult(flow.message, flow.type || "");
}

async function loadInstances(preserve = true) {
  const data = await api("/api/instances");
  state.instances = data.instances || [];
  for(const id of data.archivedInstanceIds || []){delete state.flows[id];delete state.statuses[id];}
  saveConnectionMemory();
  const savedId = localStorage.getItem(SELECTED_INSTANCE_KEY) || "";
  if (!state.instances.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.instances.some((item) => item.id === savedId) ? savedId : (state.instances[0]?.id || "");
  }
  renderInstances();
  if (state.selectedId) selectInstance(state.selectedId, false);
  else {
    for(const id of ['checkMcpButton','installBridgeButton','codexHelpButton'])$(id).disabled=true;
    $('selectedTitle').textContent='请选择实例';$('selectedId').textContent='';
    $('approvalBox').classList.add('hidden');$('execApprovalBox').classList.add('hidden');
    renderResult('当前管理列表为空，可登记实例。');
  }
  await refreshStatuses();
}

async function refreshStatuses() {
  return refreshInstanceStatus(state.selectedId);
}

async function refreshInstanceStatus(checkedId) {
  if (!checkedId) return null;
  if(!canUseInstance(checkedId)){if(checkedId===state.selectedId)syncNamedInstanceProtection();return null;}
  const data = await api("/api/status-lights", { method: "POST", body: JSON.stringify({ instanceIds: [checkedId],...accessPayload(checkedId) }) });
  state.statuses = { ...state.statuses, ...(data.statuses || {}) };
  if(data.statuses?.[checkedId])state.statuses[checkedId]={...data.statuses[checkedId],mcpStale:false,bridgeStale:false};
  const checkedStatus = state.statuses[checkedId] || {};
  const checkedFlow = state.flows[checkedId] || {};
  if (checkedStatus.mcp === true && checkedFlow.approvalPurpose === "mcp") {
    state.flows[checkedId] = {
      ...checkedFlow, approval: null, approvalPurpose: "", type: "success",
      message: "MCP 已实际连接成功，旧设备配对提示已清除，无需重复批准。"
    };
  }
  if (checkedStatus.bridge === true && checkedFlow.type === "error" && /文件桥|ConnectionReset|连接重置|连接失败/i.test(checkedFlow.message || "")) {
    state.flows[checkedId] = {
      ...state.flows[checkedId],
      type: "success",
      jobStatus: "complete",
      jobId: "",
      message: "文件桥已通过本次健康检查。"
    };
  }
  saveConnectionMemory();
  if (state.selectedId === checkedId) {
    applyLights();
    applySelectedProgress();
    if (state.flows[checkedId] !== checkedFlow) restoreConnectionUi(state.instances.find((item) => item.id === checkedId));
  }
  return state.statuses[checkedId] || null;
}

async function registerInstance() {
  const button = $("registerButton");
  button.disabled = true;
  setResult("正在安全登记并检查 Gateway……");
  try {
    const data = await api("/api/connections/register", {
      method: "POST",
      body: JSON.stringify({
        url: $("instanceUrl").value.trim(),
        token: $("gatewayToken").value,
        name: $("instanceName").value.trim(),
        replace: $("replaceCredential").checked
      })
    });
    state.selectedId = data.instanceId;
    await loadInstances(true);
    const requestId = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
    setResult(requestId ? `${data.message}\n配对申请：${requestId}` : data.message, data.status === "active" ? "success" : "");
  } catch (error) {
    setResult(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function checkMcp(targetInstanceId) {
  const instanceId = typeof targetInstanceId === "string" ? targetInstanceId : state.selectedId;
  if(!canUseInstance(instanceId)){if(instanceId===state.selectedId)syncNamedInstanceProtection();return;}
  const button = $("checkMcpButton");
  button.disabled = true;
  setInstanceResult(instanceId, "正在直接检查 MCP / Gateway，本步骤不消耗 Codex 额度……");
  try {
    const data = await api("/api/connections/mcp/check", { method: "POST", body: JSON.stringify({ instanceId,...accessPayload(instanceId) }) });
    if (data.stage === "pairing_required") {
      state.statuses[instanceId] = { ...(state.statuses[instanceId] || {}), mcp: false, mcpStale:false };
      saveConnectionMemory();
      if (state.selectedId === instanceId) { applyLights(); applySelectedProgress(); }
      showApproval(data, instanceId);
      return data;
    }
    if (data.online !== true) throw new Error(data.message || "MCP / Gateway 暂未通过健康检查");
    state.statuses[instanceId] = { ...(state.statuses[instanceId] || {}), mcp: true, mcpStale:false };
    state.flows[instanceId] = { ...(state.flows[instanceId] || {}), approval: null, approvalPurpose: "" };
    saveConnectionMemory();
    if (state.selectedId === instanceId) { applySelectedProgress(); applyLights(); $("approvalBox").classList.add("hidden"); }
    setInstanceResult(instanceId, data.message, "success");
    return data;
  } catch (error) {
    state.statuses[instanceId] = { ...(state.statuses[instanceId] || {}), mcp: false, mcpStale:false };
    saveConnectionMemory();
    if (state.selectedId === instanceId) applyLights();
    setInstanceResult(instanceId, error.message, "error");
  } finally {
    if(instanceId===state.selectedId)syncNamedInstanceProtection();else button.disabled=false;
  }
}

function showApproval(data, instanceId = state.selectedId) {
  const pairing = data.stage === "pairing_required";
  const approvalPurpose = pairing ? "mcp" : "bridge";
  const hasRequestId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.requestId || "");
  const deviceNote = data.deviceId ? `\n本机设备 ID：${data.deviceId}` : "";
  const prompt = pairing
    ? hasRequestId
      ? `请核对当前实例中这台电脑 的 OpenClaw Farm 设备配对申请，仅批准下列完整编号对应的申请。${deviceNote}\n\nopenclaw devices approve ${data.requestId}`
      : `这台电脑 需要设备配对，但 Gateway 没有返回申请编号。请在当前公司 OpenClaw 实例的设备配对列表中，核对并批准这台电脑 的待处理请求。${deviceNote}\n不要批准其他设备，也不要根据不完整编号执行批准命令。`
    : `请使用 exec 工具批准下面这条设备权限申请。不要解释，执行完只返回批准结果。\n\nopenclaw devices approve ${data.requestId}`;
  const approval = {
    text: `${pairing ? "这台电脑 需要在公司实例中完成设备配对" : data.message}${hasRequestId ? `\n申请编号：${data.requestId}` : "\nGateway 未返回申请编号，请按设备信息核对。"}${deviceNote}`,
    prompt, stage:data.stage, checkedAt:Number.isFinite(data.checkedAt)?data.checkedAt:Date.now(),leaseUntil:data.leaseUntil,
    copyLabel: pairing ? "复制设备配对说明" : "复制授权提示词",
    resumeLabel: pairing ? "已批准，重新检查 MCP" : "已批准，继续配置"
  };
  state.flows[instanceId] = { ...(state.flows[instanceId] || {}), approvalPurpose, approval };
  saveConnectionMemory();
  if (state.selectedId === instanceId) restoreConnectionUi(state.instances.find((item) => item.id === instanceId));
  setInstanceResult(instanceId, pairing
    ? "这不是故障：当前管理设备需要在 OpenClaw 中批准一次。复制下方提示词到对应实例，批准后回来重新检查 MCP。"
    : "正在等待远端权限批准。批准后点击“已批准，继续配置”。");
}

async function finishBridgeResult(data, instanceId = state.selectedId) {
  if (["approval_required","pairing_required"].includes(data.stage)) {
    state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobId: "", jobStatus: "approval_required" };
    showApproval(data, instanceId);
    return false;
  }
  if (data.stage !== "complete" && data.healthVerified !== true) {
    throw new Error("后台尚未确认文件桥验证通过，请继续查看任务状态。");
  }
  state.statuses[instanceId] = { mcp: true, bridge: true };
  state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobId: "", jobStatus: "complete", approval: null, approvalPurpose: "" };
  saveConnectionMemory();
  if (state.selectedId === instanceId) {
    setStep("stepBridge", "done"); setStep("stepTunnel", "done");
    applyLights(); applySelectedProgress(); $("approvalBox").classList.add("hidden");
  }
  setInstanceResult(instanceId, data.message || "文件桥已安装并通过真实健康检查。", "success");
  return true;
}

async function syncLatestConnectionJob(instanceId) {
  const response=await api(`/api/connections/instances/${encodeURIComponent(instanceId)}/latest`);
  const job=response.job ?? (response.status?response:null);
  if(!job){state.flows[instanceId]={jobId:'',jobStatus:'idle'};saveConnectionMemory();return;}
  if(job.instanceId && job.instanceId!==instanceId)throw Error('后台任务实例不匹配');
  const jobId=job.id || job.jobId;
  if(!jobId)return;
  // Read-only polling restores the current task. No remote request is sent here.
  await pollConnectionJob(jobId,instanceId);
}

async function pollConnectionJob(jobId, instanceId = state.selectedId) {
  const pollKey = `${instanceId}:${jobId}`;
  if (state.pollingJobs.has(pollKey)) return;
  state.pollingJobs.add(pollKey);
  state.currentJobId = jobId;
  try {
  for (let attempt = 0; attempt < 1800; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let job;
    try {
      const response = await api(`/api/connections/jobs/${encodeURIComponent(jobId)}`);
      job = response.job || response;
    } catch (error) {
      if (/后台任务已过期/.test(error.message)) {
        state.flows[instanceId] = {...(state.flows[instanceId] || {}), jobId:"",jobStatus:"interrupted"};
        setInstanceResult(instanceId, "服务已更新，旧后台任务记录已失效。点击继续安装将先检查现有文件桥。", "info");
        return;
      }
      setInstanceResult(instanceId, "暂时无法读取后台进度，已保留任务编号。点击继续跟踪可恢复。", "error");
      return;
    }

    if (state.selectedId === instanceId) {
      $("execApprovalBox").classList.toggle("hidden", !job.approval);
      $("execApprovalSession").textContent = job.approval?.sessionKey || "";
      $("execApprovalRequest").textContent = job.approval?.requestId || "";
      $("execApprovalStatus").textContent = job.approval?.error || "正在通过 MCP 批准本次安装命令，无需复制命令。";
      if(job.stage==='mcp_check')setStep("stepMcp","active");
      if(['route_check','permission_check','permission_repair','permission_verify','bridge_install','tunnel','verify'].includes(job.stage)){
        state.statuses[instanceId]={...(state.statuses[instanceId]||{}),mcp:true,mcpStale:false};
        applyLights();setStep("stepMcp","done");
        setStep("stepBridge",["tunnel","verify"].includes(job.stage)?"done":"active");
        setStep("stepTunnel",["tunnel","verify"].includes(job.stage)?"active":"");
      }
    }
    if (["waiting","blocked","awaiting_approval"].includes(job.status)) {
      const priorApproval=state.flows[instanceId]?.approval || null;
      state.flows[instanceId] = {...(state.flows[instanceId] || {}), jobId, jobStatus:job.status,blockerCode:job.blockerCode,approvalKind:job.approvalKind,checkedAt:job.checkedAt,nextAction:job.nextAction,approval:job.approval || priorApproval};
      const notices=[...new Set([job.message || "原任务已保留，请继续跟踪。",typeof job.nextAction==="string"?job.nextAction:job.nextAction?.label || ""].filter(Boolean))];
      setInstanceResult(instanceId, notices.join("\n"), "info");
      if (job.status === "awaiting_approval" || job.approvalKind === "mac_pairing" || job.blockerCode === "PAIRING_REQUIRED") {
        try { await renewPairing(instanceId); }
        catch (error) { setInstanceResult(instanceId, `当前配对申请核验失败：${error.message}`, "error"); }
      }
      if (state.selectedId === instanceId) $("installBridgeButton").textContent = internalPermissionBlocked(state.flows[instanceId]) ? bridgeActionLabel(state.flows[instanceId]) : "继续跟踪原安装任务";
      return;
    }
    if (job.status === "complete") {
      await finishBridgeResult(job.result || { message: job.message }, instanceId);
      return;
    }
    if (job.status === "failed") {
      state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobStatus: "failed", jobId, approval:null };
      saveConnectionMemory();
      const message=job.error || job.message || "文件桥安装未完成，请查看下方中文提示。";
      setInstanceResult(instanceId,message,"error");
      throw new Error(message);
    }
    state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobId, jobStatus: job.status || "running" };
    const liveLog = Array.isArray(job.logs) && job.logs.length
      ? job.logs.slice(-6).map((entry) => `${new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}  ${entry.message}`).join("\n")
      : (job.message || "文件桥正在后台执行，请勿重复点击。");
    setInstanceResult(instanceId, [permissionStageLabel(job.stage), `实时进度日志\n${liveLog}`].filter(Boolean).join("\n"));
  }

  setInstanceResult(instanceId, "后台任务仍在执行，原任务编号已保留。点击继续跟踪可恢复进度。", "info");
  } finally {
    state.pollingJobs.delete(pollKey);
  }
}

async function installBridge(forceNewAttempt=false) {
  const instanceId = state.selectedId;
  if(!instanceId){setResult("请先选择一个实例。","error");return;}
  if(!canUseInstance(instanceId)){syncNamedInstanceProtection();return;}
  const instance=state.instances.find(item=>item.id===instanceId);
  if(instance?.protectedName===true && !bridgeAccessPayload(instanceId).allowInternalPermissionRepair){
    setResult("请先明确授权当前命名实例本次文件桥任务所需的五项内部执行权限。","error");return;
  }
  if (!$("allowShared").checked) {
    setResult("请先勾选共享工作区读写兼容模式。该选项允许文件桥访问当前实例工作区。", "error");
    return;
  }
  const button = $("installBridgeButton");
  button.disabled = true;
  $("approvalBox").classList.add("hidden");
  setStep("stepMcp", "active");
  setInstanceResult(instanceId, "正在自动检查 MCP，随后在主 agent 新会话安装文件桥、处理批准并接通隧道……");
  try {
    const existing = state.flows[instanceId];
    if (!forceNewAttempt && existing?.jobId && !existing.approval && ["running", "waiting", "blocked", "awaiting_approval", "queued", "failed"].includes(existing.jobStatus)) {
      let resumed = false;
      try {
        await api(`/api/connections/jobs/${encodeURIComponent(existing.jobId)}/resume`, {method:"POST",body:JSON.stringify(bridgeAccessPayload(instanceId))});
        resumed = true;
      } catch (error) {
        if (!/后台任务已过期/.test(error.message)) throw error;
        state.flows[instanceId] = {...existing,jobId:"",jobStatus:"interrupted"};
        saveConnectionMemory();
      }
      if (resumed) { await pollConnectionJob(existing.jobId, instanceId); return; }
    }
    state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobId: "", jobStatus: "starting", approval: null, approvalPurpose: "" };
    saveConnectionMemory();
    const data = await api("/api/connections/mcp/install-bridge", {
      method: "POST",
      body: JSON.stringify({
        instanceId,
        confirm: true,
        allowSharedWorkspace: true,
        enableDelete: $("enableDelete").checked
        ,forceNewAttempt
        ,...bridgeAccessPayload(instanceId)
      })
    });
    if (data.jobId) {
      state.flows[instanceId] = { ...(state.flows[instanceId] || {}), jobId: data.jobId, jobStatus: "running" };
      saveConnectionMemory();
      setInstanceResult(instanceId, "文件桥已转入后台安装。切换实例或刷新页面也会继续保留进度。" );
      await pollConnectionJob(data.jobId, instanceId);
    } else {
      await finishBridgeResult(data, instanceId);
    }
  } catch (error) {
    const failureMessage = error.message || "文件桥安装失败";
    setInstanceResult(instanceId, failureMessage, "error");
    if (/后台任务已过期/.test(failureMessage)) {
      state.flows[instanceId] = {...(state.flows[instanceId] || {}),jobId:"",jobStatus:"interrupted"};
      setInstanceResult(instanceId, "旧后台任务记录已失效，请重新点击继续安装以检查现有连接。", "info");
      return;
    }
    // Keep the real failure visible. The separate help button remains available.
  } finally {
    syncNamedInstanceProtection();
  }
}

async function askCodex() {
  const button = $("codexHelpButton");
  button.disabled = true;
  $("codexAnswer").classList.remove("hidden");
  $("codexAnswer").textContent = "Codex 正在给出简短处理建议……";
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ instanceId: state.selectedId, allowWrite: false,...accessPayload(), message: `连接工作台固定流程报错：${state.lastError}\n请用中文短答解释原因，并只给下一步。不要直接修改远端。` })
    });
    $("codexAnswer").textContent = data.message || "Codex 没有返回内容。";
  } catch (error) {
    $("codexAnswer").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// Keep drafts only in memory, separated by instance. Never serialize tokens.
const tokenEditDrafts = new Map();
const tokenEditBusy = new Set();
const tokenEditMessages = new Map();
function syncTokenEditor() {
  const instance = state.instances.find(item => item.id === state.selectedId);
  $("tokenEditForm").classList.toggle("hidden", !instance);
  $("tokenEditTarget").textContent = instance ? `${instance.name || instance.id} · ${instance.id}` : "请选择实例";
  $("tokenEditValue").value = tokenEditDrafts.get(state.selectedId) || "";
  $("tokenEditSave").disabled = !instance || tokenEditBusy.has(state.selectedId);
  $("tokenEditValue").disabled = !instance || tokenEditBusy.has(state.selectedId);
  $("tokenEditStatus").textContent = tokenEditMessages.get(state.selectedId) || "";
}
$("tokenEditValue").addEventListener("input", () => {
  tokenEditDrafts.set(state.selectedId, $("tokenEditValue").value);
});
$("tokenEditForm").addEventListener("submit", async event => {
  event.preventDefault();
  const instanceId = state.selectedId;
  const instance = state.instances.find(item => item.id === instanceId);
  const token = $("tokenEditValue").value.trim();
  if (!instance || tokenEditBusy.has(instanceId)) return;
  tokenEditDrafts.set(instanceId, token);
  if (token.length < 20 || token.length > 512) {
    tokenEditMessages.set(instanceId, "请填写完整的 Gateway Token（20 至 512 个字符）。");
    syncTokenEditor(); return;
  }
  tokenEditBusy.add(instanceId);
  tokenEditMessages.set(instanceId, "正在保存并重新连接……");
  syncTokenEditor();
  try {
    await api("/api/connections/register", {method:"POST", body:JSON.stringify({
      url:instance.webUrl, name:instance.name, token, replace:true, deferHealth:true
    })});
    instance.hasCredential = true;
    tokenEditMessages.set(instanceId, "Token 已保存，连接结果见上方。");
    await checkMcp(instanceId);
  } catch (error) {
    const message = String(error.message).split(token).join("[已隐藏]");
    tokenEditMessages.set(instanceId, message);
    setInstanceResult(instanceId, message, "error");
  } finally {
    tokenEditBusy.delete(instanceId);
    syncTokenEditor();
  }
});

$("registerButton").addEventListener("click", registerInstance);
$("checkMcpButton").addEventListener("click", checkMcp);
$("installBridgeButton").addEventListener("click", ()=>installBridge(false));
$("restartBridgeButton").addEventListener("click", ()=>installBridge(true));
$("resumeButton").addEventListener("click", async () => {
  if (state.approvalPurpose === "mcp") {
    $("approvalBox").classList.add("hidden");
    await checkMcp();
    return;
  }
  await installBridge();
});
const pairingChecks=new Map();
async function renewPairing(instanceId){
 if(pairingChecks.has(instanceId))return pairingChecks.get(instanceId);
 const p=(async()=>{
  try{
   if(!canUseInstance(instanceId))throw Error('受保护的命名实例尚未获得本次单独授权');
   const data=await api('/api/connections/mcp/check',{method:'POST',body:JSON.stringify({instanceId,...accessPayload(instanceId)})});
   if(data.stage==='pairing_required'){showApproval(data,instanceId);return data;}
   if(data.online===true){state.flows[instanceId]={...(state.flows[instanceId]||{}),approval:null,approvalPurpose:''};saveConnectionMemory();if(state.selectedId===instanceId)$("approvalBox").classList.add('hidden');return data;}
   throw Error('未取得可核验的配对结果');
  }catch(error){if(state.flows[instanceId]?.approval)state.flows[instanceId].approval.checkedAt=0;saveConnectionMemory();throw error;}
 })().finally(()=>pairingChecks.delete(instanceId));pairingChecks.set(instanceId,p);return p;
}
$("copyApprovalButton").addEventListener("click", async () => {
 const instanceId=state.selectedId;
 try{
  const result=await renewPairing(instanceId);
  if(result.online){setInstanceResult(instanceId,'MCP 已连接，无需再次批准设备配对。','success');return;}
  const prompt=state.flows[instanceId]?.approval?.prompt;if(!prompt)throw Error('没有待复制的申请');
  try{await navigator.clipboard.writeText(prompt);$("copyApprovalButton").textContent='已复制（请在 4 分钟内处理）';}
  catch{if(state.selectedId===instanceId){$("approvalPrompt").focus();$("approvalPrompt").select();}setInstanceResult(instanceId,'请按 ⌘C 复制刚核验的提示词。','info');}
 }catch(error){setInstanceResult(instanceId,'配对核验失败，未复制旧编号：'+error.message,'error');}
});
async function verifyAndCopyPairing(instanceId=state.selectedId) {
  try {
    const result=await renewPairing(instanceId);
    if(result.online){setInstanceResult(instanceId,'MCP 已连接，当前没有需要复制的配对申请。','success');return;}
    const prompt=state.flows[instanceId]?.approval?.prompt;
    if(!prompt)throw Error('Gateway 没有返回可核验的配对申请');
    try {
      await navigator.clipboard.writeText(prompt);
      $("namedPairingPromptButton").textContent='提示词已复制';
      setInstanceResult(instanceId,'配对提示词已复制，请粘贴到该 OpenClaw 实例中处理。','success');
    } catch {
      $("approvalPrompt").focus(); $("approvalPrompt").select();
      setInstanceResult(instanceId,'提示词已生成并选中，请按 ⌘C 复制。','info');
    }
  } catch(error) {
    setInstanceResult(instanceId,'配对核验失败，未复制旧申请：'+error.message,'error');
  }
}
function renewPendingPairings(){for(const [id,flow] of Object.entries(state.flows))if(canUseInstance(id) && flow.approval && ['mcp','bridge'].includes(flow.approvalPurpose))renewPairing(id).catch(()=>{});}
// Background renewal is owned by the backend coordinator and its bounded lease.
window.addEventListener('pageshow',renewPendingPairings);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)renewPendingPairings();});
$("refreshButton").addEventListener("click", async () => { try { await loadInstances(true); setResult("状态已刷新。", "success"); } catch (error) { setResult(error.message, "error"); } });
$("codexHelpButton").addEventListener("click", askCodex);

mountEfficiencyModeBadge();
loadInstances(true).catch((error) => setResult(error.message, "error"));

$("allowShared").addEventListener("change", () => { if ($("allowShared").checked && /请先勾选共享工作区/.test(state.lastError || "")) setResult("共享工作区读写已允许，可继续安装文件桥。", "info"); });
$("allowNamedInstance").addEventListener("change",()=>{
  if($("allowNamedInstance").checked)namedAuthorizations.add(state.selectedId);
  else namedAuthorizations.delete(state.selectedId);
  saveNamedAuthorizations();
  syncNamedInstanceProtection();
  if($("allowNamedInstance").checked)checkMcp().catch(error=>setResult(error.message,'error'));
  else $("approvalBox").classList.add("hidden");
});
$("allowInternalPermissionRepair").addEventListener("change",()=>{
  if($("allowInternalPermissionRepair").checked)namedPermissionAuthorizations.add(state.selectedId);
  else namedPermissionAuthorizations.delete(state.selectedId);
  saveNamedPermissionAuthorizations();
  syncNamedInstanceProtection();
});
$("namedPairingPromptButton").addEventListener("click",()=>verifyAndCopyPairing());

$("remoteApprovalHelpButton").addEventListener('click',async()=>{
 try {
  const {remoteApprovalHelp}=await import('/remote-approval-help.js');
  const text=remoteApprovalHelp(state.selectedId),box=$("remoteApprovalHelpText");box.hidden=false;box.value=text;
  try{await navigator.clipboard.writeText(text);setResult('已复制远端内部审批修复说明，请发送到此实例的远端会话。','info');}
  catch{box.focus();box.select();setResult('修复说明已选中，请按 ⌘C 复制。','info');}
 }catch(error){setResult(error.message,'error');}
});

// Read-only synchronization also catches changes made by another window.
async function syncCurrentInstanceList(){
  await loadInstances(true);
  if(state.selectedId)await syncLatestConnectionJob(state.selectedId);
}
setInterval(()=>{if(!document.hidden)syncCurrentInstanceList().catch(()=>{});},30000);
window.addEventListener('pageshow',()=>syncCurrentInstanceList().catch(()=>{}));
window.addEventListener('openclaw:instances-changed',()=>syncCurrentInstanceList().catch(()=>{}));
window.addEventListener('storage',event=>{if(event.key==='openclawFarm.instanceListRevision')syncCurrentInstanceList().catch(()=>{});});
