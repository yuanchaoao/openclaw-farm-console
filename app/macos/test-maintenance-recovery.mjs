import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMaintenanceRecovery as assess} from '../console/maintenance-recovery.mjs';

const now = 1_800_000_000_000;
const tag = 'a'.repeat(32);
const job = {instanceId:'ins_demo',sessionKey:'agent:main:openclaw-control-ui:filebridge-demo-12345678-abcd-abcd-abcd-123456789abc',runId:'run-1',taskTag:tag,phase:'installing',lastProgressAt:now};
const run = {runId:'run-1',status:'running'};
const empty = {messages:[]};
const tool = (content, details) => ({messages:[{role:'toolResult',toolName:'exec',content,details}]});
const check = (overrides={}) => assess({job,history:empty,run,now,...overrides});

test('internal approval tool failure blocks and never retries even when agent ended',()=>{
  const result=check({run:{...run,status:'error'},history:tool(JSON.stringify({status:'error',error:'Exec approval registration failed: Error: gateway closed (1008): pairing required'}))});
  assert.equal(result.blockerCode,'REMOTE_INTERNAL_APPROVAL_BLOCKED');
  assert.equal(result.approvalKind,'remote_internal');
  assert.equal(result.canRetry,false);
});
test('legacy job without run acknowledgement keeps actual internal approval diagnosis',()=>{
  const result=check({job:{...job,runId:undefined},run:undefined,history:tool(JSON.stringify({status:'error',error:'Exec approval registration failed: pairing required'}))});
  assert.equal(result.blockerCode,'REMOTE_INTERNAL_APPROVAL_BLOCKED');
  assert.equal(result.canRetry,false);
});
test('default business session and mismatched history or run cannot be recovered',()=>{
  assert.equal(check({job:{...job,sessionKey:'agent:main:main'}}).blockerCode,'MAINTENANCE_IDENTITY_MISMATCH');
  assert.equal(check({history:{messages:[],sessionKey:'wrong'}}).blockerCode,'MAINTENANCE_IDENTITY_MISMATCH');
  assert.equal(check({run:{status:'error',runId:'different'}}).blockerCode,'MAINTENANCE_RUN_MISMATCH');
  assert.equal(check({run:{status:'error'}}).canRetry,false);
});
test('uncertain dispatch and unavailable queries never authorize a second send',()=>{
  assert.equal(check({job:{...job,runId:undefined,dispatchIntent:true},run:undefined}).nextAction,'reconcile_dispatch');
  assert.equal(check({history:null}).canRetry,false);
  assert.equal(check({run:undefined}).canRetry,false);
});
test('expired command approval requires original execution verification',()=>{
  const history=tool('Approval required', {status:'approval-pending',approvalId:'12345678-abcd-abcd-abcd-123456789abc',expiresAtMs:now-1,command:'secret command'});
  const result=check({history});
  assert.equal(result.blockerCode,'EXEC_APPROVAL_EXPIRED');
  assert.equal(result.canRetry,false);
  assert.equal(JSON.stringify(result).includes('secret command'),false);
});
test('live approval is a verification action, never blind approval',()=>{
  const history=tool('Approval required', {status:'approval-pending',approvalId:'12345678-abcd-abcd-abcd-123456789abc',expiresAtMs:now+60_000});
  assert.equal(check({history}).nextAction,'verify_exec_approval');
});
test('agent ok and prose claiming success do not complete installation',()=>{
  assert.equal(check({run:{...run,status:'ok'}}).blockerCode,'MAINTENANCE_NO_EXECUTION');
  const history={messages:[{role:'assistant',content:`OPENCLAW_${tag}_INSTALL_READY`}]};
  assert.equal(check({run:{...run,status:'ok'},history}).blockerCode,'MAINTENANCE_NO_EXECUTION');
});
test('matching phase marker leads to actual service validation, never completion',()=>{
  const history=tool(`OPENCLAW_${tag}_INSTALL_READY`);
  const result=check({history});
  assert.equal(result.nextAction,'verify_actual_service');
  assert.notEqual(result.status,'complete');
  assert.notEqual(check({history,job:{...job,phase:'tunnel'}}).nextAction,'verify_actual_service');
  assert.equal(check({history:tool(`OPENCLAW_${tag}_TUNNEL_READY`),job:{...job,phase:'tunnel'}}).phaseEvidence,'TUNNEL_READY');
});
test('only matched terminal failed run can permit a new attempt',()=>{
  assert.equal(check({run:{...run,status:'error'}}).canRetry,true);
  assert.equal(check().canRetry,false);
  assert.equal(check({run:{...run,status:'ok'}}).canRetry,false);
  assert.equal(check({run:{...run,status:'cancelled'}}).canRetry,false);
});
test('completed jobs only recheck service and never restart installation',()=>{
  const result=check({job:{...job,status:'complete'},run:{...run,status:'error'}});
  assert.equal(result.nextAction,'verify_actual_service');
  assert.equal(result.canRetry,false);
});
test('structured run failure also detects internal approval fault',()=>{
  const result=check({run:{...run,status:'error',error:{message:'Exec approval registration failed: pairing required'}}});
  assert.equal(result.blockerCode,'REMOTE_INTERNAL_APPROVAL_BLOCKED');
});
test('five minutes with no progress pauses the job and retains read-only continuation',()=>{
  const result=check({job:{...job,lastProgressAt:now-300_000}});
  assert.equal(result.status,'blocked');
  assert.equal(result.blockerCode,'MAINTENANCE_NO_PROGRESS');
  assert.equal(result.canContinue,true);
});
test('old approval preceding the current user turn cannot contaminate recovery',()=>{
  const history={messages:[{role:'assistant',content:'/approve 12345678 allow-once'}, {role:'user',content:'current task'}, {role:'toolResult',toolName:'exec',content:`OPENCLAW_${tag}_INSTALL_READY`}]};
  assert.equal(check({history}).nextAction,'verify_actual_service');
});
