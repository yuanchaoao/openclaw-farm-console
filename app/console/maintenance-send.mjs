const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACK_STATUSES = new Set(['started', 'in_flight', 'ok']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function failureParts(value) {
  const objects = [], strings = [];
  const visit = (item, depth = 0) => {
    if (depth > 4 || item == null) return;
    if (typeof item === 'string') {
      strings.push(item);
      for (const line of item.split('\n')) {
        try { const parsed = JSON.parse(line); if (object(parsed)) visit(parsed, depth + 1); } catch {}
      }
    } else if (object(item)) {
      objects.push(item);
      for (const key of ['code', 'error_code', 'message', 'error', 'output', 'details', 'health_error']) visit(item[key], depth + 1);
    }
  };
  visit(value);
  return {objects, text:strings.join('\n')};
}

function pairingRequest(value) {
  const {objects, text} = failureParts(value);
  const pairing = objects.some(item => item.code === 'PAIRING_REQUIRED' || item.error_code === 'PAIRING_REQUIRED')
    || /pairing required|scope upgrade pending approval/i.test(text);
  if (!pairing) return null;
  const requestId = objects.map(item => item.requestId).find(id => typeof id === 'string' && UUID.test(id))
    || text.match(/\brequestId\s*[:=]\s*["']?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b/i)?.[1];
  return {requestId};
}

function failureKind(error) {
  const {text} = failureParts(error);
  if (/INVALID_ACK/.test(text)) return 'ack';
  if (/pairing required|scope upgrade pending approval|设备配对|批准设备配对/i.test(text)) return 'pairing';
  if (/token[_ ](?:mismatch|expired|missing|invalid)|invalid[_ ]token|token.*(?:不匹配|过期|无效)|凭据.*(?:无效|过期)|AUTH_TOKEN/i.test(text)) return 'token';
  if (/unauthori[sz]ed|authentication failed|AUTH_|HTTP\s*401\b|认证.*(?:失败|拒绝)/i.test(text)) return 'auth';
  if (/permission|forbidden|scope|access denied|policy|HTTP\s*403\b|权限|拒绝访问|禁止|需要.*批准/i.test(text)) return 'permission';
  if (/timed? out|timeout|ETIMEDOUT|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|EPIPE|network|socket hang up|fetch failed|gateway closed|abnormal closure|connection.*(?:closed|reset|refused)|HTTP\s*50[234]\b|超时|断开连接|连接.*(?:中断|重置|拒绝)|网络/i.test(text)) return 'transient';
  return 'failed';
}

function sendError(kind, instanceId, attempts) {
  const messages = {
    ack:'Gateway 没有返回本次维护任务的有效接收确认（runId / status）；尚未确认发送成功，已停止等待安装结果。',
    pairing:'MCP 需要完成设备配对或写权限批准，但尚未取得完整批准编号；请先检查当前实例的 MCP 配对状态。',
    token:'Gateway 拒绝了维护请求的 Token，请更新当前实例凭据；尚未确认发送成功，未重复提交。',
    auth:'Gateway 拒绝了维护请求认证，请检查当前实例凭据及设备配对；尚未确认发送成功，未重复提交。',
    permission:'Gateway 拒绝了维护请求的权限或会话策略，请检查 MCP 写权限；尚未确认发送成功，未重复提交。',
    transient:`已用同一任务编号尝试发送 ${attempts} 次，Gateway 仍未确认接收。原维护会话和任务编号保留，停止等待本次结果。`,
    failed:'Gateway 未接受维护请求或返回了错误结果；尚未确认发送成功，已停止等待安装结果。',
  };
  return Object.assign(new Error(`实例 ${instanceId}：${messages[kind]}`), {
    code:`MAINTENANCE_SEND_${kind.toUpperCase()}`, attempts,
  });
}

// OpenClaw 2026.4.2 chat.send acknowledges with {runId:idempotencyKey,
// status:'started'|'in_flight'|'ok'}; the latter two are deduplicated replies.
// A transport timeout is not an acknowledgement. Every retry keeps this identity.
export async function sendMaintenanceRequest({call, instanceId, sessionKey, message, idempotencyKey, onProgress = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const prefix = `agent:main:openclaw-control-ui:filebridge-${String(instanceId).slice(4)}-`;
  if (typeof call !== 'function' || !/^ins_[a-z0-9]+$/i.test(instanceId)
      || typeof sessionKey !== 'string' || !sessionKey.startsWith(prefix) || !UUID.test(sessionKey.slice(prefix.length))
      || typeof message !== 'string' || !message.trim()
      || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 256) {
    throw Object.assign(new Error('维护请求缺少有效实例、主 agent 会话或任务编号，未发送。'), {code:'MAINTENANCE_SEND_INVALID_REQUEST'});
  }
  const params = Object.freeze({sessionKey, message, deliver:false, timeoutMs:120000, idempotencyKey});
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await call('chat.send', params);
      if (!object(response) || response.error || response.output !== undefined || response.ok === false || response.status === 'error' || response.code || response.error_code) {
        throw response || {code:'INVALID_ACK'};
      }
      if (typeof response.runId !== 'string' || response.runId !== idempotencyKey || !ACK_STATUSES.has(response.status)) throw {code:'INVALID_ACK'};
      onProgress('Gateway 已确认接收本次维护任务，正在跟踪原主 agent 会话。');
      return {runId:response.runId, status:response.status};
    } catch (error) {
      const pairing = pairingRequest(error);
      if (pairing?.requestId) return {stage:'approval_required', requestId:pairing.requestId};
      const kind = pairing ? 'pairing' : failureKind(error);
      if (kind !== 'transient' || attempt === 3) throw sendError(kind, instanceId, attempt);
      onProgress(`Gateway 暂未确认接收，正在用同一任务编号重试发送（第 ${attempt + 1}/3 次）；不会另建安装任务。`);
      await sleep(attempt * 1000);
    }
  }
}
