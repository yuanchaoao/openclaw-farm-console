import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingExecApproval,approveMaintenanceExec} from '../console/exec-approval.mjs';
import {maintenanceResults,waitForMaintenance} from '../console/maintenance-results.mjs';
const id='12345678-1234-1234-1234-123456789abc';
const command='set -eu\nprintf ready';
const sessionKey='agent:main:openclaw-control-ui:filebridge-example-job';
const fixture={role:'toolResult',toolName:'exec',details:{status:'approval-pending',approvalId:id,host:'gateway',command,allowedDecisions:['allow-once']},content:[{type:'text',text:`Approval required (id 12345678, full ${id}).\nHost: gateway\nCommand:\n\x60\x60\x60sh\n${command}\n\x60\x60\x60\nReply with: /approve 12345678 allow-once|deny`}]};
const approval=pendingExecApproval(fixture,fixture.content[0].text);
const options={approval,expectedCommand:command,instanceId:'ins_example',sessionKey};
test('only full-id current command goes through official single-use RPC',async()=>{
 const calls=[];await approveMaintenanceExec({...options,call:async(...args)=>{calls.push(args);return {ok:true};}});
 assert.deepEqual(calls,[['exec.approval.resolve',{id,decision:'allow-once'}]]);
});
test('short id, other instance, modified commands and unsolicited replies cannot be approved',async()=>{
 let called=false;const call=async()=>{called=true;return {ok:true};};
 for(const patch of [{approval:{...approval,requestId:'12345678'}},{instanceId:'ins_other'},{expectedCommand:command+'\nrm -rf /tmp/other'},{approval:{...approval,source:'assistant'}},{approval:{...approval,host:'node'}}])await assert.rejects(approveMaintenanceExec({...options,...patch,call}));
 assert.equal(called,false);
});
test('assistant short summary never replaces tool full id or bound command',()=>{
 const result=maintenanceResults({messages:[fixture,{role:'assistant',content:[{type:'text',text:'/approve 12345678 allow-once'}]}]});
 assert.equal(result.approval.requestId,id);assert.equal(result.approval.command,command);
});
test('successful automatic approval happens once and waits for original task output',async()=>{
 let approvals=0,reads=0,clock=0;const updates=[];
 await waitForMaintenance({sessionKey,now:()=>clock,sleep:async ms=>{clock+=ms;},onPause:async()=>assert.fail('should not pause'),onProgress:(message,details)=>updates.push({message,details}),predicate:text=>text==='READY',approveExec:async a=>{approvals++;return approveMaintenanceExec({...options,approval:a,call:async()=>({ok:true})});},readHistory:async()=>({messages:++reads<3?[fixture]:[{role:'toolResult',content:[{type:'text',text:'READY'}]}]})});
 assert.equal(approvals,1);assert.equal(reads,3);assert.equal(JSON.stringify(updates).includes(command),false);
});
test('pending command can be parsed from actual SDK text when details are absent',()=>{
 const a=pendingExecApproval({...fixture,details:undefined},fixture.content[0].text);assert.equal(a.command,command);assert.equal(a.requestId,id);
});
