import {pendingExecApproval} from "./exec-approval.mjs";
import {createHash} from 'node:crypto';

export const maintenanceBody=message=>typeof message.content==='string'?message.content:(Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='text').map(part=>part.text || '').join('\n');
export const isExecNotification=message=>['user','system'].includes(message.role) && /An async command|(?:^|\n)Exec (?:completed|finished|denied)\b/i.test(maintenanceBody(message));
// Display history can normalize indentation. This identifies a request only;
// executable commands are still matched byte-for-byte against tool arguments.
export const maintenanceRequestDigest=text=>{
  // OpenClaw may append its own bootstrap truncation notice to the user turn.
  // It is transport metadata, not part of the maintenance request. Ignoring it
  // lets the watcher see the exec call and approval as soon as they appear.
  const request=String(text).replace(/\r\n/g,'\n').split(/\n\[Bootstrap truncation warning\]\n/)[0];
  return createHash('sha256').update(request.split('\n').map(line=>line.trim()).join('\n').trim()).digest('hex');
};

export function maintenanceResults(history,{expectedPromptHash,expectedRequestDigest}={}) {
  const all=history?.messages || history?.result?.messages || [];
  // Read only this command turn, not earlier installation/tunnel approvals.
  const bodyText=maintenanceBody;
  const lastUser=all.findLastIndex(message=>message.role==='user' && (expectedPromptHash
    ?createHash('sha256').update(bodyText(message)).digest('hex')===expectedPromptHash || (expectedRequestDigest && maintenanceRequestDigest(bodyText(message))===expectedRequestDigest):!isExecNotification(message)));
  const nextUser=all.findIndex((message,index)=>index>lastUser && message.role==='user' && !isExecNotification(message));
  const messages=expectedPromptHash && lastUser<0?[]:all.slice(lastUser+1,nextUser<0?undefined:nextUser);
  const outputs=[],executionOutputs=[];let approval=null;let approvalEnded=false;let endedEvent='';let failure=null;
  const execCalls=new Map();
  const failed=exitCode=>({executionOffset:executionOutputs.join('\n').length,exitCode,message:`远端维护命令执行失败（退出码 ${exitCode}），请查看远端安装日志。`});
  for(const message of messages) {
    if(!['assistant','toolResult','tool','system','user'].includes(message.role))continue;
    const text=bodyText(message);
    if(message.role==='assistant')for(const part of Array.isArray(message.content)?message.content:[])if(part.type==='toolCall' && part.name==='exec' && part.id){
      let args=part.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{args=null;}
      if(typeof args?.command==='string')execCalls.set(part.id,args.command);
    }
    if(['toolResult','tool'].includes(message.role)) {
      let structured=message.details;
      try { const parsed=JSON.parse(text); if(parsed && typeof parsed==='object') structured=parsed; } catch {}
      const raw=String(structured?.error?.message || structured?.error || text);
      if(/Exec approval registration failed/i.test(raw)) {
        failure={executionOffset:executionOutputs.join('\n').length,code:'REMOTE_INTERNAL_APPROVAL_BLOCKED',approvalKind:'remote_internal',
          message:'远端内部执行审批客户端无法登记命令批准。Mac 配对与此故障不同；需核验内部客户端身份后修复。'};
        continue;
      }
      if(structured?.status==='error') {
        failure={executionOffset:executionOutputs.join('\n').length,code:'MAINTENANCE_TOOL_FAILED',message:'远端维护工具返回错误，安装未完成。'};
        continue;
      }
    }
    if(message.role!=='assistant' && /approval[- ](?:timed? out|timeout|expired|denied)|exec(?:ution)? denied|审批.*(?:超时|过期|拒绝)|批准.*(?:超时|过期|拒绝)/i.test(text)) {
      approval=null;approvalEnded=true;endedEvent=text.split('\n')[0];continue;
    }
    const pending=pendingExecApproval(message,text);
    if(pending) {
      const command=execCalls.get(message.toolCallId || message.tool_call_id);
      if(typeof command==='string' && !message.details?.command)pending.command=command;
      approvalEnded=false;approval=pending;if(failure?.code==='MAINTENANCE_TOOL_FAILED')failure=null;continue;
    }
    const full=text.match(/Approval required\s*\(id\s+(?:[0-9a-f]{8},\s*full\s+)?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\)/i);
    const match=full || text.match(/\/approve\s+([0-9a-f]{8}(?:-[0-9a-f-]{27})?)\s+allow-once/i);
    if(match) {
      // Assistant summaries often abbreviate an ID already provided by the tool.
      if(!approval || !approval.requestId.startsWith(match[1]))approval={stage:'exec_approval_required',requestId:match[1]};
      approvalEnded=false;continue;
    }
    if(/approval required|等待审批|等待批准|命令已提交.*批准/i.test(text))continue;
    if (['system','user'].includes(message.role)) {
      // System notifications may repeat the command. Only its output is evidence.
      const result=text.match(/(?:^|\n)Exec (?:completed|finished)\b[^\n]*?\bcode\s+(-?\d+)\b[^\n]*?(?: :: |\n|$)([\s\S]*)/i);
      if(result) {
        approval=null;
        const exitCode=Number(result[1]);
        if(exitCode!==0)failure=failed(exitCode);
        else {
          const output=result[2].split(/\s+Continue the task if needed\b/)[0];
          outputs.push(output);executionOutputs.push(output);
        }
      }
    } else {
      outputs.push(text);
      if(['toolResult','tool'].includes(message.role)) {
        const code=message.details?.exitCode ?? message.details?.exit_code ?? message.exitCode
          ?? text.match(/(?:^|\n)\(?(?:Command|Process) exited with (?:code|status)\s+(-?\d+)/i)?.[1]
          ?? text.match(/(?:^|\n)Exit code:\s*(-?\d+)/i)?.[1];
        if(code!==undefined && Number.isInteger(Number(code)) && Number(code)!==0)failure=failed(Number(code));
        else executionOutputs.push(text);
      }
    }
  }
  const last=messages.at(-1);
  return {text:outputs.join('\n'),executionText:executionOutputs.join('\n'),approval,approvalEnded,endedEvent,failure,requestFound:!expectedPromptHash || lastUser>=0,turnSettled:last?.role==='assistant' && last.stopReason==='stop'};
}

export async function waitForMaintenance({readHistory,predicate,onProgress,sessionKey,onPause,approveExec,readRunStatus,onStall,stallAfterMs=60000,expectedPromptHash,expectedRequestDigest,requireSettledTurn=false,allowExecutionRecovery=false,timeoutMs=120000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  let deadline=now()+timeoutMs,approvalId='',endedSeen='',readErrors=0;
  const attempted=new Set();
  let runChecks=0, emptyCompleted=0, executionReported=false, failureSince=null,lastEvidenceAt=now(),stallHandled=false;
  while(true) {
    if(now()>=deadline) {
      await onPause('等待远端结果较久；已保留本次维护会话。点击继续跟踪只读取原任务结果，不会重新安装。');
      deadline=now()+timeoutMs;approvalId='';
    }
    await sleep(4000);
    let history;
    try {history=await readHistory();readErrors=0;}
    catch {
      if(++readErrors>=3){await onPause('暂时无法读取维护会话，原任务保留。点击继续跟踪可恢复读取。');readErrors=0;deadline=now()+timeoutMs;}
      continue;
    }
    const results=maintenanceResults(history,{expectedPromptHash,expectedRequestDigest});
    const {text,approval,approvalEnded,endedEvent,failure}=results;
    if(results.executionText.trim() || approval || approvalEnded) {lastEvidenceAt=now();stallHandled=false;}
    if(failure?.code)throw Object.assign(new Error(failure.message),{code:failure.code,approvalKind:failure.approvalKind});
    if(predicate(text,results)){
      if(requireSettledTurn && !results.turnSettled){onProgress('本步骤执行已成功，等待主 agent 收尾后继续下一步');continue;}
      onProgress('远端执行结果已收到',{approval:null});return text;
    }
    if(failure) {
      failureSince ??= now();
      let run;
      if(readRunStatus)try {run=await readRunStatus();} catch {}
      if(!allowExecutionRecovery || !readRunStatus || run?.status==='error' || now()-failureSince>=120000)
        throw Object.assign(new Error(failure.message),{code:'MAINTENANCE_EXEC_FAILED',exitCode:failure.exitCode});
      onProgress('远端某一步执行失败，正在等待原维护会话恢复和最终自检结果。');
      continue;
    }
    if(!executionReported && results.executionText.trim()) {
      executionReported=true;onProgress('远端已返回执行记录，正在核对本次安装结果。');
    }
    if(onStall && !stallHandled && !approval && !results.executionText.trim() && now()-lastEvidenceAt>=stallAfterMs) {
      stallHandled=true;
      onProgress('远端长时间没有产生执行记录，正在主动核对并结束空转运行。');
      await onStall(results);
    }
    if(readRunStatus && !approval && (runChecks++ % 3 === 0)) {
      let run;
      try {run=await readRunStatus();} catch { /* History polling remains available during a transient status read failure. */ }
      if(run?.status==='error') {
        const raw=typeof run.error==='string'?run.error:JSON.stringify(run.error || {});
        const reason=/429|rate.?limit|quota|余额|额度/i.test(raw)?'远端模型服务限流或额度不足'
          : /401|403|api.?key|unauthori[sz]ed|authentication/i.test(raw)?'远端模型服务认证或权限失败'
          : /context|maximum.*token|上下文/i.test(raw)?'远端模型上下文超过限制'
          : /timeout|timed out|超时/i.test(raw)?'远端主 agent 执行超时'
          : '远端主 agent 运行失败';
        throw Object.assign(new Error(reason+'；文件桥未完成安装，因此尚未进入反向隧道步骤。'),{code:'MAINTENANCE_AGENT_FAILED'});
      }
      if(run?.status==='ok' && results.requestFound && !results.executionText.trim()) {
        if(++emptyCompleted>=2)throw Object.assign(new Error('远端主 agent 已结束，但没有返回文件桥执行记录；尚未安装成功，也未建立反向隧道。'),{code:'MAINTENANCE_NO_EXECUTION'});
      } else emptyCompleted=0;
      if(!results.executionText.trim())onProgress('请求已接收，尚未收到远端执行记录；安装自检完成后才会建立反向隧道。');
    }

    if(approvalEnded && endedEvent!==endedSeen) {
      endedSeen=endedEvent;
      onProgress('远端执行批准已过期或被拒绝，原会话已保留。请在该维护会话检查执行状态。',{approval:null});
      await onPause('远端执行批准已过期或被拒绝；请先在原维护会话处理，然后继续跟踪。');
      deadline=now()+timeoutMs;approvalId='';continue;
    }
    if(approval) {
      const publicApproval={stage:approval.stage,requestId:approval.requestId,sessionKey,via:'mcp'};
      if(approval.requestId!==approvalId) {
        approvalId=approval.requestId;
        onProgress('已收到本次维护任务的执行批准请求，正在通过 MCP 处理。',{approval:publicApproval});
      }
      if(approveExec && approval.source==='exec' && !attempted.has(approval.requestId)) {
        attempted.add(approval.requestId);
        try {
          await approveExec(approval);
          onProgress('MCP 已批准本次命令，正在等待原维护会话继续执行。',{approval:null});
        } catch(error) {
          throw Object.assign(new Error('命令批准未完成；须核验原命令申请后继续。'),{code:error.code==='EXEC_COMMAND_MISMATCH'?'EXEC_COMMAND_MISMATCH':'EXEC_APPROVAL_BLOCKED',approvalKind:'exec',approval:publicApproval});
        }
      }
    }
  }
}

export function bridgeInstallPattern(taskTag) {
  if (!/^[0-9a-f]{32}$/.test(taskTag)) throw Error('维护任务编号无效');
  return new RegExp(String.raw`^OPENCLAW_${taskTag}_PUBKEY_BEGIN\s+(ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?)\s+OPENCLAW_${taskTag}_PUBKEY_END$`, 'm');
}

function executionResult(historyOrResults) {
  return typeof historyOrResults?.executionText==='string'?historyOrResults:maintenanceResults(historyOrResults);
}

function validateTaskTag(taskTag) {
  if(!/^[0-9a-f]{32}$/.test(taskTag))throw Error('维护任务编号无效');
}

function commandEchoAt(text,index) {
  const lineStart=text.lastIndexOf('\n',index-1)+1;
  return /(?:^|[\s;&|])(?:echo|printf)\s+['"]?$/.test(text.slice(lineStart,index));
}

function markerIndex(text,taskTag,kind,start=0) {
  const pattern=new RegExp(`(?:^|\\s)(OPENCLAW_${taskTag}_${kind})(?=\\s|$)`,'g');
  pattern.lastIndex=start;
  for(const match of text.matchAll(pattern)) {
    const index=match.index+match[0].indexOf(match[1]);
    if(!commandEchoAt(text,index))return index;
  }
  return -1;
}

export function maintenanceMarkerPresent(historyOrResults,taskTag,kind) {
  validateTaskTag(taskTag);
  if(!['INSTALL_READY','TUNNEL_READY','CREDENTIAL_READY','SERVICE_READY','DELETE_READY'].includes(kind))throw Error('维护结果标记无效');
  const results=executionResult(historyOrResults);
  const index=markerIndex(results.executionText,taskTag,kind);
  return index>=0 && (!results.failure || index>=results.failure.executionOffset);
}

export function parseBridgeInstallResult(historyOrResults,taskTag) {
  validateTaskTag(taskTag);
  const results=executionResult(historyOrResults);
  if(results.failure)return null;
  const text=results.executionText;
  // Gateway may flatten exec stdout into one line. Match the tagged block by
  // whitespace boundaries, but only after separating execution from chat prose.
  const block=new RegExp(String.raw`(?:^|\s)(OPENCLAW_${taskTag}_PUBKEY_BEGIN)\s+(ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?)\s+OPENCLAW_${taskTag}_PUBKEY_END(?=\s|$)`,'g');
  for(const match of text.matchAll(block)) {
    const index=match.index+match[0].indexOf(match[1]);
    if(commandEchoAt(text,index))continue;
    if(markerIndex(text,taskTag,'INSTALL_READY',match.index+match[0].length)<0)continue;
    return {publicKey:match[2]};
  }
  // Some remote versions omit the cosmetic END line. Still require an actual
  // execution result, matching task boundaries and exactly one full public key.
  const compact=new RegExp(String.raw`(?:^|\s)(OPENCLAW_${taskTag}_PUBKEY_BEGIN)\s+(ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._@-]{1,80})?)\s+OPENCLAW_${taskTag}_INSTALL_READY(?=\s|$)`,'g');
  for(const match of text.matchAll(compact))if(!commandEchoAt(text,match.index+match[0].indexOf(match[1])))return {publicKey:match[2]};
  return null;
}
