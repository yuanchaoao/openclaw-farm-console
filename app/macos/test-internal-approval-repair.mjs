import test from 'node:test';import assert from 'node:assert/strict';
import {internalApprovalDecision,repairInternalApproval} from '../console/internal-approval-repair.mjs';
const evidence={instanceId:'ins_a',source:'authenticated_remote_read',checkedAt:Date.now(),runningUser:'node',stateDir:'/home/node/.openclaw',deviceId:'d',publicKey:'p',clientId:'cli',role:'operator',approvalClientPurposeVerified:true};
const pending=[{deviceId:'d',publicKey:'p',clientId:'cli',role:'operator',requestId:'r',scopes:['operator.read']}],paired=[{deviceId:'d',publicKey:'p',approvedScopes:['operator.read']}];
test('Linux repair or only pending request does not authorize approval',()=>{assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:[{...pending[0],platform:'linux',isRepair:true}],paired}).ok,false)});
test('exact identity and existing scopes required',()=>{assert.equal(internalApprovalDecision({instanceId:'ins_a',pending,paired,evidence}).ok,true);assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:[{...pending[0],scopes:['operator.admin']}],paired,evidence}).ok,false);assert.equal(internalApprovalDecision({instanceId:'ins_b',pending,paired,evidence}).ok,false)});
test('changed request blocks mutation; verified request uses only formal approve API',async()=>{let calls=[];await repairInternalApproval({instanceId:'ins_a',readEvidence:async()=>evidence,call:async(m,p)=>{calls.push(m);return {pending,paired}}});assert.deepEqual(calls,['device.pair.list','device.pair.list','device.pair.approve']);calls=[];const result=await repairInternalApproval({instanceId:'ins_a',readEvidence:async()=>evidence,call:async(m)=>{calls.push(m);return {pending:calls.length===1?pending:[],paired}}});assert.equal(result.ok,false);assert.ok(!calls.includes('device.pair.approve'));});
test('explicit current-instance authorization permits five-scope upgrade but excludes other instances and scopes',()=>{
 const authorization={instanceIds:['ins_a'],scopes:['operator.admin','operator.read','operator.write','operator.approvals','operator.pairing'],completed:false};
 const upgrade=[{...pending[0],scopes:['operator.admin','operator.approvals']}];
 assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:upgrade,paired,evidence,authorization}).ok,true);
 assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:upgrade,paired,evidence,authorization:{...authorization,completed:true}}).ok,false);
 assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:upgrade,paired,evidence,authorization:{...authorization,instanceIds:['ins_b']}}).ok,false);
 assert.equal(internalApprovalDecision({instanceId:'ins_a',pending:[{...pending[0],scopes:['operator.talk.secrets']}],paired,evidence,authorization}).ok,false);
});
