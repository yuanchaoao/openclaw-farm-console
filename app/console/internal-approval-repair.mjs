import {createHash} from 'node:crypto';
export function internalApprovalDecision({instanceId,pending,paired,evidence,authorization,now=Date.now()}) {
 const blocked=(missing)=>({ok:false,blockerCode:'REMOTE_INTERNAL_IDENTITY_UNVERIFIED',approvalKind:'remote_internal',missingEvidence:missing,checkedAt:now});
 if(!evidence || evidence.instanceId!==instanceId || evidence.source!=='authenticated_remote_read' || !Number.isFinite(evidence.checkedAt) || now-evidence.checkedAt>60000 || evidence.checkedAt>now)
   return blocked(['当前实例经认证的远端只读身份核验']);
 if(!evidence.runningUser || !evidence.stateDir || !evidence.deviceId || !evidence.publicKey || !evidence.approvalClientPurposeVerified)
   return blocked(['实际运行用户、状态目录、审批客户端身份、公钥及用途']);
 const row=(pending||[]).find(p=>p.deviceId===evidence.deviceId && p.publicKey===evidence.publicKey);
 if(!row)return blocked(['与已核验内部客户端身份一致的当前待批准申请']);
 const old=(paired||[]).find(p=>p.deviceId===row.deviceId && p.publicKey===row.publicKey);
 const previous=old?.approvedScopes || old?.scopes;
 const explicitlyAllowed=authorization?.completed!==true && authorization?.instanceIds?.includes(instanceId) && Array.isArray(authorization.scopes) && row.scopes?.length && row.scopes.every(s=>authorization.scopes.includes(s));
 if(!explicitlyAllowed && (!Array.isArray(previous) || !row.scopes?.length || row.scopes.some(s=>!previous.includes(s))))return blocked(['申请权限与该设备既有批准权限一致的依据']);
 if(row.clientId!==evidence.clientId || row.role!==evidence.role)return blocked(['申请的客户端用途和角色与实际执行客户端一致']);
 return {ok:true,requestId:row.requestId,deviceId:row.deviceId,fingerprint:createHash('sha256').update(row.publicKey).digest('hex'),checkedAt:now};
}
export async function repairInternalApproval({instanceId,call,readEvidence,authorization}) {
 const list=await call('device.pair.list',{});
 const evidence=await readEvidence();
 const decision=internalApprovalDecision({instanceId,pending:list.pending,paired:list.paired,evidence,authorization});
 if(!decision.ok)return decision;
 // Re-read immediately before mutation; approval never follows a cached ID.
 const fresh=await call('device.pair.list',{});
 const checked=internalApprovalDecision({instanceId,pending:fresh.pending,paired:fresh.paired,evidence,authorization});
 if(!checked.ok || checked.requestId!==decision.requestId)return {...checked,ok:false,blockerCode:'INTERNAL_APPROVAL_CHANGED'};
 await call('device.pair.approve',{requestId:checked.requestId});
 return {ok:true,approvalKind:'remote_internal',deviceId:checked.deviceId,checkedAt:Date.now(),nextAction:'在原维护会话验证无副作用命令执行审批'};
}
