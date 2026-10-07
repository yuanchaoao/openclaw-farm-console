import {randomUUID,createHash} from 'node:crypto';
import {extractPermissionIdentity} from './permission-identity.mjs';
import {repairInternalApproval} from './internal-approval-repair.mjs';
import {maintenanceResults} from './maintenance-results.mjs';
import {approveMaintenanceExec} from './exec-approval.mjs';
export const MANAGED_SCOPES=['operator.admin','operator.read','operator.write','operator.approvals','operator.pairing'];
const probe="openclaw gateway call status --json >/dev/null && printf 'OPENCLAW_PERMISSION_PROBE_OK\\n'";
const fail=(message,code='PERMISSION_REPAIR_BLOCKED')=>Object.assign(Error(message),{code,approvalKind:'remote_internal'});
export async function ensureInternalPermissions({job,policy,call,save,onProgress,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}) {
 if(!policy?.instanceIds?.includes(job.instanceId) || policy.completed===true || policy.scopes?.length!==5 || MANAGED_SCOPES.some(s=>!policy.scopes.includes(s)))throw fail('当前实例不在本次权限补齐授权清单中','PERMISSION_POLICY_REQUIRED');
 if(!job.permissionSession)job.permissionSession=`agent:main:openclaw-control-ui:filebridge-${job.instanceId.slice(4)}-${randomUUID()}`;
 let sessionKey=job.permissionSession;
 const progress=(message,stage)=>onProgress(message,{stage});
 if(job.permissionVerifiedAt && job.permissionDeviceId){
   const current=await call('device.pair.list',{});
   const device=(current.paired || []).find(d=>d.deviceId===job.permissionDeviceId);
   const raw=typeof device?.publicKey==='string'?Buffer.from(device.publicKey,'base64url'):null;
   const scopes=device?.approvedScopes || device?.scopes || [];
   if(raw?.length===32 && createHash('sha256').update(raw).digest('hex')===job.permissionDeviceId && MANAGED_SCOPES.every(s=>scopes.includes(s)) && !(current.pending || []).some(d=>d.deviceId===job.permissionDeviceId)){
     progress('已实时核对既有内部设备及五项权限，复用此前通过的执行授权','permission_verify');
     return {ok:true,deviceId:job.permissionDeviceId,scopes:MANAGED_SCOPES,reused:true};
   }
 }
 async function send(kind,message){
   if(job.permissionPhase!==kind){job.permissionPhase=kind;job.permissionIdempotency=`permission-${job.id}-${kind}-${randomUUID()}`;job.permissionRunId=null;await save();}
   if(job.permissionRunId)return;
   const result=await call('chat.send',{sessionKey,message,idempotencyKey:job.permissionIdempotency,deliver:false});
   if(!result?.runId || !['started','in_flight','ok'].includes(result.status))throw fail('权限维护请求未获得有效回执');
   job.permissionRunId=result.runId;await save();
 }
 progress('正在通过主 agent 只读工具核验内部设备、运行用户和公钥','permission_check');
 if(job.permissionPhase?.startsWith('identity-')){sessionKey=`agent:main:openclaw-control-ui:filebridge-${job.instanceId.slice(4)}-${randomUUID()}`;job.permissionSession=sessionKey;}
 const identityRequest='identity-'+randomUUID();
 await send(identityRequest,'维护核验编号：'+identityRequest+'。重新进行权限修复只读核验，需要本回合实际工具结果。读取 /proc/self/status、/etc/passwd、/home/node/.openclaw/identity/device.json。可用read工具，或逐个exec执行 cat <文件路径>，每次仅一个cat命令。不修改文件、不批准请求。不要在回复中展示私钥或Token，只报告公开设备ID与运行用户。');
 let evidence;const deadline=now()+120000;
 while(now()<deadline){const history=await call('chat.history',{sessionKey,limit:40});try{evidence=extractPermissionIdentity({...history,sessionKey,instanceId:job.instanceId},{instanceId:job.instanceId,sessionKey,checkedAt:now(),expectedRequest:identityRequest});}catch{}if(evidence?.ok===false)evidence=null;if(evidence)break;await sleep(3000);}
 if(!evidence)throw fail('主 agent 未返回完整的实际只读身份依据；保留会话，稍后继续核验','REMOTE_INTERNAL_IDENTITY_UNVERIFIED');
 async function approveCurrent(){
  const list=await call('device.pair.list',{});
  const matches=(list.pending||[]).filter(p=>p.deviceId===evidence.deviceId && p.publicKey===evidence.publicKey);
  if(!matches.length)return false;
  const row=matches[0];
  if(![['gateway-client','backend'],['cli','cli']].some(([id,mode])=>row.clientId===id && row.clientMode===mode))throw fail('内部设备申请用途与审批或 CLI 探针不匹配');
  const result=await repairInternalApproval({instanceId:job.instanceId,call,authorization:policy,readEvidence:async()=>({...evidence,approvalClientPurposeVerified:true,clientId:row.clientId,role:'operator'})});
  if(!result.ok)throw fail('当前设备申请不满足已授权范围或身份核验要求：'+(result.missingEvidence||[]).join('、'),result.blockerCode);
  progress('已通过正式 MCP 批准当前内部设备权限申请','permission_repair');return true;
 }
 await approveCurrent();
 for(let attempt=0;attempt<3;attempt++){
   progress('正在验证内部执行审批和完整管理权限','permission_verify');
   await send('probe-'+attempt,'用户已授权此已核实内部设备补齐管理权限。只使用 exec 原样执行以下无副作用命令，不修改配置或配对文件、不安装、不重启；如待配对则停下报告。\n'+probe);
   const until=now()+90000;const execApproved=new Set();let restart=false;
   while(now()<until){
     const h=await call('chat.history',{sessionKey,limit:40}),result=maintenanceResults(h);
     if(result.approval && !execApproved.has(result.approval.requestId)){
       await approveMaintenanceExec({approval:result.approval,instanceId:job.instanceId,sessionKey,expectedCommand:probe,call});execApproved.add(result.approval.requestId);
     }
     if(await approveCurrent()){restart=true;break;}
     if(/^OPENCLAW_PERMISSION_PROBE_OK\s*$/m.test(result.executionText) && !result.failure){
       const list=await call('device.pair.list',{}),device=(list.paired||[]).find(p=>p.deviceId===evidence.deviceId && p.publicKey===evidence.publicKey);
       const scopes=device?.approvedScopes || device?.scopes || [];
       if(MANAGED_SCOPES.every(s=>scopes.includes(s))){job.permissionVerifiedAt=now();job.permissionDeviceId=evidence.deviceId;await save();progress('五项管理权限及真实执行探针验证通过，继续文件桥流程','permission_verify');return {ok:true,deviceId:evidence.deviceId,scopes:MANAGED_SCOPES};}
     }
     await sleep(3000);
   }
   if(!restart)throw fail('权限探针尚未返回成功执行记录，未继续安装');
 }
 throw fail('权限补齐未在三次探针内完成，已停止重复申请');
}
