const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const normalize=command=>String(command || '').replace(/\r\n/g,'\n').trim();

export function pendingExecApproval(message,text) {
  if(!['toolResult','tool'].includes(message.role) || message.toolName!=='exec')return null;
  const details=message.details || {};
  const match=text.match(/Approval required\s*\(id\s+(?:[0-9a-f]{8},\s*full\s+)?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\)/i);
  const id=details.status==='approval-pending'?details.approvalId:match?.[1];
  if(!UUID.test(id || ''))return null;
  const fenced=text.match(/(?:^|\n)Command:\s*\n(`{3,})(?:sh|bash)?\n([\s\S]*?)\n\1(?:\n|$)/);
  return {stage:'exec_approval_required',requestId:id,source:'exec',
    command:typeof details.command==='string'?details.command:fenced?.[2],
    host:details.host || text.match(/^Host:\s*(\S+)/m)?.[1],
    allowedDecisions:details.allowedDecisions || (text.includes('allow-once')?['allow-once']:[]),
    expiresAtMs:details.expiresAtMs};
}

export async function approveMaintenanceExec({approval,expectedCommand,instanceId,sessionKey,call,now=Date.now}) {
  if(!/^ins_[a-z0-9]+$/i.test(instanceId) || !sessionKey?.startsWith(`agent:main:openclaw-control-ui:filebridge-${instanceId.slice(4)}-`))throw Error('批准请求与当前实例维护会话不匹配');
  if(!UUID.test(approval?.requestId || '') || approval.source!=='exec')throw Error('尚未取得执行工具返回的完整批准编号，继续等待工具结果');
  if(approval.host!=='gateway' || !approval.allowedDecisions?.includes('allow-once'))throw Error('本请求不属于当前 Gateway 的单次执行批准');
  if(!normalize(expectedCommand) || normalize(approval.command)!==normalize(expectedCommand))throw Object.assign(Error('待批准命令被改写，已停止本次批准'),{code:'EXEC_COMMAND_MISMATCH'});
  if(approval.expiresAtMs && approval.expiresAtMs<=now())throw Error('本次执行批准已过期，正在检查原会话结果');
  const result=await call('exec.approval.resolve',{id:approval.requestId,decision:'allow-once'});
  if(result?.ok!==true)throw Error('MCP 尚未确认执行批准成功，继续跟踪原会话');
  return {requestId:approval.requestId,approved:true};
}
