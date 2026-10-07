import {maintenanceResults, maintenanceMarkerPresent,maintenanceBody,isExecNotification,parseBridgeInstallResult} from './maintenance-results.mjs';
import {pendingExecApproval} from './exec-approval.mjs';
import {createHash} from 'node:crypto';

const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const terminalFailure = new Set(['error', 'failed']);
const active = new Set(['started', 'running', 'in_flight', 'queued']);

// Completed phase output permits only the next phase, never a repeat install.
// The transcript outlives the Gateway's short-lived agent.wait result cache.
export function verifiedPhaseForContinuation(job,history) {
  const prefix=`agent:main:openclaw-control-ui:filebridge-${job.instanceId?.slice(4)}-`;
  if(!job.maintenanceSession?.startsWith(prefix) || history?.sessionKey!==job.maintenanceSession ||
     (history.instanceId && history.instanceId!==job.instanceId) || !/^[0-9a-f]{32}$/.test(job.taskTag || '') ||
     (!job.commandDigest && !job.requestDigest))return null;
  const result=maintenanceResults(history,{expectedPromptHash:job.commandDigest,expectedRequestDigest:job.requestDigest});
  if(!result.requestFound || !result.turnSettled || result.failure || result.approval)return null;
  if(maintenanceMarkerPresent(result,job.taskTag,'TUNNEL_READY'))return 'TUNNEL_READY';
  if(parseBridgeInstallResult(result,job.taskTag))return 'INSTALL_READY';
  return null;
}

// This is a decision only: callers must fetch history from the recorded session
// and run status from the recorded run ID. No output includes command text,
// credentials, raw errors, or history, so it can be included in a durable job.
export function assessMaintenanceRecovery({job, history, run, now = Date.now()}) {
  const result = (status, nextAction, blockerCode = null, extra = {}) => ({
    status, nextAction, blockerCode, canRetry: false, canContinue: false,
    approvalKind: null, checkedAt: now, ...extra,
  });
  const instance = job?.instanceId || job?.instance;
  const session = job?.sessionKey || job?.session;
  if (!/^ins_[a-z0-9]+$/i.test(instance || '') ||
      !new RegExp(`^agent:main:openclaw-control-ui:filebridge-${instance?.slice(4)}-${UUID}$`, 'i').test(session || '')) {
    return result('blocked', 'verify_task_identity', 'MAINTENANCE_IDENTITY_MISMATCH');
  }
  const historySession = history?.sessionKey || history?.result?.sessionKey;
  const historyInstance = history?.instanceId || history?.instance;
  if ((historySession && historySession !== session) || (historyInstance && historyInstance !== instance)) {
    return result('blocked', 'verify_task_identity', 'MAINTENANCE_IDENTITY_MISMATCH');
  }
  const receivedRun = run?.runId || run?.id;
  if (run && (!job.runId || receivedRun !== job.runId ||
      (run.sessionKey && run.sessionKey !== session) ||
      (run.instanceId && run.instanceId !== instance))) {
    return result('blocked', 'verify_run_identity', 'MAINTENANCE_RUN_MISMATCH');
  }
  if (job.status === 'complete' || job.status === 'completed') {
    return result('running', 'verify_actual_service', null, {canContinue: true});
  }
  if (!history || !Array.isArray(history.messages || history.result?.messages)) {
    if (!job.runId) return result('blocked', 'reconcile_dispatch', 'MAINTENANCE_DISPATCH_UNCONFIRMED');
    return result('blocked', 'check_original_task', 'MAINTENANCE_HISTORY_UNAVAILABLE', {canContinue: true});
  }
  const evidence = maintenanceResults(history);
  const runError = typeof run?.error === 'string' ? run.error : run?.error?.message;
  if (evidence.failure?.code === 'REMOTE_INTERNAL_APPROVAL_BLOCKED' ||
      /Exec approval registration failed/i.test(runError || '')) {
    return result('blocked', 'verify_internal_client_identity', 'REMOTE_INTERNAL_APPROVAL_BLOCKED', {approvalKind: 'remote_internal'});
  }
  // A legacy task may lack its acknowledgement yet contain a real internal
  // approval error in its bound session. Preserve that actionable diagnosis.
  // Otherwise an interrupted send might have reached the Gateway: never infer
  // non-execution merely because the local acknowledgement is missing.
  if (!job.runId) return result('blocked', 'reconcile_dispatch', 'MAINTENANCE_DISPATCH_UNCONFIRMED');
  const tag = job.taskTag;
  const phase = job.phase || job.stage;
  const marker = /tunnel/i.test(phase || '') ? 'TUNNEL_READY'
    : /credential/i.test(phase || '') ? 'CREDENTIAL_READY' : 'INSTALL_READY';
  if (/^[0-9a-f]{32}$/.test(tag || '') && !evidence.failure && maintenanceMarkerPresent(evidence, tag, marker)) {
    // A marker authorizes checking the next step; only actual health and file
    // operations can establish completion, never an agent's "ok" status.
    return result('running', 'verify_actual_service', null, {canContinue: true, phaseEvidence: marker});
  }
  if (evidence.approvalEnded || (evidence.approval?.expiresAtMs && evidence.approval.expiresAtMs <= now)) {
    return result('blocked', 'verify_original_execution', 'EXEC_APPROVAL_EXPIRED', {approvalKind: 'exec', canContinue: true});
  }
  if (evidence.approval) {
    return result('waiting', 'verify_exec_approval', 'EXEC_APPROVAL_REQUIRED', {approvalKind: 'exec', canContinue: true});
  }
  if (evidence.failure?.code) {
    return result('blocked', 'inspect_original_failure', evidence.failure.code);
  }
  if (run && terminalFailure.has(run.status)) {
    return result('failed', 'create_new_attempt', 'MAINTENANCE_RUN_FAILED', {canRetry: true});
  }
  if (run?.status === 'ok' || run?.status === 'completed') {
    return result('blocked', 'verify_actual_service', evidence.executionText.trim() ?
      'MAINTENANCE_RESULT_UNVERIFIED' : 'MAINTENANCE_NO_EXECUTION', {canContinue: true});
  }
  const progressAt = Number(job.lastProgressAt || job.progressAt || job.updatedAt || job.createdAt);
  if (!Number.isFinite(progressAt) || progressAt > now || now - progressAt >= 300_000) {
    return result('blocked', 'check_original_task', 'MAINTENANCE_NO_PROGRESS', {canContinue: true});
  }
  if (run && active.has(run.status)) return result('running', 'check_original_task', null, {canContinue: true});
  return result('blocked', 'check_original_task', 'MAINTENANCE_RUN_UNCONFIRMED', {canContinue: true});
}

// The Gateway run cache can expire while the bound transcript remains. Accept
// only a closed, tagged turn whose every actual tool call returned an error.
export function verifiedFailedTurnEnded({job,history,run}) {
  if(run?.runId!==job.remoteRunId || run?.status!=='timeout')return false;
  if(!/^[0-9a-f]{32}$/.test(job.taskTag || ''))return false;
  const expected=`agent:main:openclaw-control-ui:filebridge-${job.instanceId?.slice(4)}-`;
  if(!job.maintenanceSession?.startsWith(expected) || history?.sessionKey!==job.maintenanceSession)return false;
  const msgs=history.messages;
  if(!Array.isArray(msgs))return false;
  const body=m=>typeof m.content==='string'?m.content:(m.content || []).filter(p=>p.type==='text').map(p=>p.text || '').join('\n');
  const starts=msgs.flatMap((m,i)=>m.role==='user' && body(m).includes(job.taskTag)?[i]:[]);
  if(starts.length!==1)return false;
  let end=msgs.findIndex((m,i)=>i>starts[0] && m.role==='user');if(end<0)end=msgs.length;
  const turn=msgs.slice(starts[0]+1,end),last=turn.at(-1);
  if(last?.role!=='assistant' || last.stopReason!=='stop')return false;
  const calls=new Set(),results=new Set();let internalFailure=false;
  for(const m of turn){
    if(m.role==='assistant')for(const p of m.content || [])if(p.type==='toolCall'){
      if(p.name!=='exec' || !p.id || calls.has(p.id))return false;calls.add(p.id);
    }
    if(['toolResult','tool'].includes(m.role)){
      const id=m.toolCallId ?? m.tool_call_id;if(!calls.has(id) || results.has(id))return false;
      let detail;try{detail=JSON.parse(body(m));}catch{return false;}
      if(detail.status!=='error' || detail.tool!=='exec' || !detail.error)return false;
      if(/Exec approval registration failed/i.test(typeof detail.error==='string'?detail.error:detail.error.message || ''))internalFailure=true;
      results.add(id);
    }
  }
  return internalFailure && calls.size>0 && calls.size===results.size;
}

// A completed agent turn is not proof that an asynchronously approved command
// ended. Require a matching execution denial for each pending tool request.
export function verifiedRejectedTurnEnded({job,history,run}) {
  if(run?.runId!==job.remoteRunId || !['timeout','ok','error','completed','failed'].includes(run.status))return false;
  const prefix=`agent:main:openclaw-control-ui:filebridge-${job.instanceId?.slice(4)}-`;
  if(!job.maintenanceSession?.startsWith(prefix) || history?.sessionKey!==job.maintenanceSession || !job.commandDigest)return false;
  const messages=history.messages;if(!Array.isArray(messages))return false;
  const starts=messages.flatMap((m,i)=>m.role==='user' && createHash('sha256').update(maintenanceBody(m)).digest('hex')===job.commandDigest?[i]:[]);
  if(starts.length!==1 || !maintenanceBody(messages[starts[0]]).includes(job.taskTag))return false;
  const next=messages.findIndex((m,i)=>i>starts[0] && m.role==='user' && !isExecNotification(m));
  const turn=messages.slice(starts[0]+1,next<0?undefined:next);
  if(turn.at(-1)?.role!=='assistant' || turn.at(-1)?.stopReason!=='stop')return false;
  const denied=new Set();
  for(const m of turn)if(isExecNotification(m)){
    const event=maintenanceBody(m).match(/\bExec denied\s*\(([^)\n]+)\)/i)?.[1];
    for(const id of event?.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) || [])denied.add(id.toLowerCase());
  }
  const calls=new Set(),resolved=new Set();let hasDenial=false;
  for(const m of turn){
    if(m.role==='assistant')for(const p of Array.isArray(m.content)?m.content:[])if(p.type==='toolCall'){
      if(p.name!=='exec' || !p.id || calls.has(p.id))return false;calls.add(p.id);
    }
    if(['tool','toolResult'].includes(m.role)){
      const id=m.toolCallId || m.tool_call_id;if(!calls.has(id)||resolved.has(id))return false;
      const text=maintenanceBody(m),pending=pendingExecApproval(m,text);
      if(pending){if(!denied.has(pending.requestId.toLowerCase()))return false;hasDenial=true;}
      else {
        let detail;try{detail=JSON.parse(text);}catch{}
        if(!(detail?.status==='error' && detail?.tool==='exec') && !/^Validation failed for tool ["']?exec["']?:/i.test(text))return false;
      }
      resolved.add(id);
    }
  }
  return hasDenial && calls.size>0 && calls.size===resolved.size;
}

export function verifiedSettledInstallTurn({job,history}) {
  const prefix=`agent:main:openclaw-control-ui:filebridge-${job.instanceId?.slice(4)}-`;
  if(!job.maintenanceSession?.startsWith(prefix) || history?.sessionKey!==job.maintenanceSession)return false;
  const step=job.idempotencyKey?.match(/-([0-9a-f]{32})-step-([0-3])-attempt-\d+$/);
  if(!step || step[1]!==job.taskTag)return false;
  const messages=history.messages || [];
  const start=messages.findLastIndex(m=>m.role==='user' && !isExecNotification(m));
  if(start<0)return false;
  const turnStep=maintenanceBody(messages[start]).match(/本次执行编号：([0-9a-f]{32})-(\d+)-(\d+)/);
  if(!turnStep || turnStep[1]!==job.taskTag || Number(turnStep[2])>Number(step[2]))return false;
  const turn=messages.slice(start+1);
  if(turn.at(-1)?.role!=='assistant' || turn.at(-1)?.stopReason!=='stop')return false;
  const ended=new Set(),calls=new Set(),results=new Set();
  for(const m of turn)if(isExecNotification(m)){
    const event=maintenanceBody(m).match(/\bExec (?:finished|completed|denied)\s*\(([^)\n]+)\)/i)?.[1];
    for(const id of event?.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) || [])ended.add(id.toLowerCase());
  }
  for(const m of turn){
    if(m.role==='assistant')for(const p of Array.isArray(m.content)?m.content:[])if(p.type==='toolCall'){
      if(p.name!=='exec' || !p.id || calls.has(p.id))return false;calls.add(p.id);
    }
    if(['tool','toolResult'].includes(m.role)){
      const id=m.toolCallId || m.tool_call_id;if(!calls.has(id) || results.has(id))return false;
      const text=maintenanceBody(m),pending=pendingExecApproval(m,text);
      if(pending){if(!ended.has(pending.requestId.toLowerCase()))return false;}
      else {
        let detail;try{detail=JSON.parse(text);}catch{}
        const exit=detail?.exitCode ?? m.details?.exitCode ?? text.match(/(?:Command|Process) exited with (?:code|status)\s+(-?\d+)/i)?.[1];
        if(exit===undefined && !(detail?.status==='error' && detail?.tool==='exec'))return false;
      }
      results.add(id);
    }
  }
  return calls.size>0 && calls.size===results.size;
}

// Older installer attempts can outlive agent.wait's cache. In that format the
// failed curl is followed by a process poll, and later retries may be aborted
// before making any tool call. Accept only this exact, fully closed failure;
// the caller must additionally confirm chat.abort reports no active run.
export function verifiedLegacyDownloadFailure({job,history,run}) {
  if(run?.runId!==job.remoteRunId || run.status!=='timeout')return false;
  const prefix=`agent:main:openclaw-control-ui:filebridge-${job.instanceId?.slice(4)}-`;
  if(!job.maintenanceSession?.startsWith(prefix) || history?.sessionKey!==job.maintenanceSession ||
     !/^[0-9a-f]{32}$/.test(job.taskTag || ''))return false;
  const messages=history.messages;
  if(!Array.isArray(messages))return false;
  const starts=messages.flatMap((m,i)=>m.role==='user' && maintenanceBody(m).includes(job.taskTag)?[i]:[]);
  if(!starts.length)return false;
  let failed=false;
  for(let t=0;t<starts.length;t++){
    const turn=messages.slice(starts[t]+1,starts[t+1] ?? messages.length);
    if(!turn.length)continue;
    const last=turn.at(-1);
    if(last?.role!=='assistant' || !['stop','aborted'].includes(last.stopReason))return false;
    const calls=new Map(),resolved=new Set();
    for(const m of turn){
      if(m.role==='assistant')for(const p of Array.isArray(m.content)?m.content:[])if(p.type==='toolCall'){
        if(!p.id || calls.has(p.id) || !['exec','process'].includes(p.name))return false;
        calls.set(p.id,p.name);
      }
      if(['tool','toolResult'].includes(m.role)){
        const id=m.toolCallId || m.tool_call_id;
        if(!calls.has(id) || resolved.has(id))return false;
        const body=maintenanceBody(m);
        if(calls.get(id)==='exec'){
          if(!/Command exited with code 1\b/.test(body) || !/(?:HTTP\s*404|404 Not Found|curl: \(22\).*404)/i.test(body))return false;
          failed=true;
        } else if(!/No running or recent sessions\./.test(body))return false;
        resolved.add(id);
      }
    }
    if(calls.size!==resolved.size)return false;
    if(last.stopReason==='aborted' && calls.size)return false;
  }
  return failed;
}
