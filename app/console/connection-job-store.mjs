import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {archiveJob} from './instance-lifecycle.mjs';

// Explicit schema prevents closures, command bodies and credentials entering disk/API.
const fields=['id','parentJobId','instanceId','status','stage','createdAt','updatedAt','checkedAt','message','error','blockerCode','approvalKind','nextAction','maintenanceSession','remoteRunId','idempotencyKey','commandDigest','requestDigest','port','credentialRef','taskTag','enableDelete','dispatchIntent','acknowledged','missingEvidence','internalPendingCount','recoveryAction','permissionSession','permissionPhase','permissionIdempotency','permissionRunId','permissionVerifiedAt','permissionDeviceId','routeProbeSession','routeProbeTag','routeProbeRunId','routeProbeVersion','routeProbeStartedAt','endProbeFingerprint','endProbeTag','endProbeRunId'];
export function publicJob(job) {
  const out=Object.fromEntries(fields.filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
  // A recovered job may still carry the error from an earlier failed attempt.
  // Once end-to-end verification reaches complete, that stale error is no
  // longer actionable and must not survive an API response or the next save.
  if(out.status==='complete')out.error=null;
  if(job.archivedAt)archiveJob(Object.assign(out,{archivedAt:job.archivedAt,previousStatus:job.previousStatus}),job.archivedAt);
  out.logs=(job.logs||[]).slice(-80).map(({at,message})=>({at,message}));
  if(job.result)out.result=Object.fromEntries(['stage','instanceId','message','maintenanceSession','capabilities','checkedAt'].filter(k=>job.result[k]!==undefined).map(k=>[k,job.result[k]]));
  // Approval IDs are intentionally never restored from disk; must be revalidated.
  return out;
}
export async function openJobStore(path) {
  let items=[];
  try {items=JSON.parse(await readFile(path,'utf8')).jobs || [];} catch(e) {if(e.code!=='ENOENT')throw e;}
  const jobs=new Map(items.map(item=>{
    const job=publicJob(item);
    if(!job.archivedAt && ['running','queued','waiting','awaiting_approval'].includes(job.status))Object.assign(job,{status:'blocked',blockerCode:'RESTART_REVIEW_REQUIRED',checkedAt:0,nextAction:'检查原维护会话和实际服务；不重新发送安装请求',message:'服务重启后待核对原执行结果',approvalKind:null});
    return [job.id,job];
  }));
  let writes=Promise.resolve();
  const save=()=>{
    const data=JSON.stringify({version:1,jobs:[...jobs.values()].map(publicJob)},null,2);
    const pending=writes.then(async()=>{await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path+'.tmp',data,{mode:0o600});await rename(path+'.tmp',path);});
    writes=pending.catch(()=>{});return pending;
  };
  await save();
  return {jobs,save};
}
