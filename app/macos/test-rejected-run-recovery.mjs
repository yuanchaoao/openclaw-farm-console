import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {verifiedRejectedTurnEnded,verifiedSettledInstallTurn,verifiedPhaseForContinuation} from '../console/maintenance-recovery.mjs';
import {bridgeInstallSteps} from '../console/maintenance-command.mjs';
import {maintenanceResults,maintenanceRequestDigest,waitForMaintenance} from '../console/maintenance-results.mjs';
const tag='a'.repeat(32),id='12345678-1234-1234-1234-123456789abc',session='agent:main:openclaw-control-ui:filebridge-example-00';
const prompt=`维护任务编号：${tag}\nset -eu\nprintf ok`;
const job={instanceId:'ins_example',maintenanceSession:session,remoteRunId:'run',taskTag:tag,commandDigest:createHash('sha256').update(prompt).digest('hex')};
function history(){return {sessionKey:session,messages:[{role:'user',content:prompt},{role:'assistant',content:[{type:'toolCall',name:'exec',id:'c1'}]},
{role:'toolResult',toolName:'exec',toolCallId:'c1',content:`Approval required (id 12345678, full ${id}).\nHost: gateway\nCommand:\n\x60\x60\x60sh\nprintf changed\n\x60\x60\x60\nallow-once`},
{role:'assistant',stopReason:'stop',content:'waiting'},{role:'user',content:`An async command finished.\nSystem: Exec denied (${id}, deny): command withheld`},{role:'assistant',stopReason:'stop',content:'ended'}]};}
test('expired run cache can recover only exact bound formally denied execution',()=>assert.equal(verifiedRejectedTurnEnded({job,history:history(),run:{runId:'run',status:'timeout'}}),true));
test('an agent stop, assistant denial, unrelated ID or changed prompt cannot authorize retry',()=>{
 for(const change of [h=>h.messages.splice(4,1),h=>h.messages[4].role='assistant',h=>h.messages[4].content=h.messages[4].content.replace(id,'22345678-1234-1234-1234-123456789abc'),h=>h.messages[0].content+='other']){
 const h=history();change(h);assert.equal(verifiedRejectedTurnEnded({job,history:h,run:{runId:'run',status:'timeout'}}),false);}
});
test('a later unknown tool execution prevents duplicate installation',()=>{const h=history();h.messages.splice(-1,0,{role:'assistant',content:[{type:'toolCall',name:'exec',id:'c2'}]});assert.equal(verifiedRejectedTurnEnded({job,history:h,run:{runId:'run',status:'ok'}}),false);});
test('current prompt hash excludes stale denial and assistant speculation',()=>{
 const h=history();h.messages.push({role:'user',content:prompt+'new'},{role:'assistant',content:'之前的批准已被拒绝，这次正在执行。'},{role:'toolResult',content:'STAGED_0'});
 const r=maintenanceResults(h,{expectedPromptHash:createHash('sha256').update(prompt+'new').digest('hex')});assert.equal(r.approvalEnded,false);assert.equal(r.executionText,'STAGED_0');
});
test('migration install uses four readable steps with self-contained shell context',()=>{
 const text=`setup\nset -eu\nD='/tmp/test'\nmkdir -p "$D"\numask 077\nT='test-only'\npython3 - <<'PY'\nprint('secret fixture')\nPY\nif [ ! -s ~/.ssh/openclaw_tunnel ]; then true; fi\nA=''\nprintf 'OPENCLAW_${tag}_INSTALL_READY\\n'`;
 const {commands}=bridgeInstallSteps(text,tag);assert.equal(commands.length,4);assert.ok(commands.every(c=>c.startsWith('set -eu\nD=')));assert.ok(commands.every(c=>!c.includes('b64decode')));assert.ok(commands[3].includes("T='test-only'"));assert.ok(commands[1].includes("\nPY\nprintf 'STAGED_1\\n'"));
});
test('Gateway display indentation normalization preserves request binding without approving changed commands',()=>{
 const expected=prompt+'\n  echo  two-spaces',shown=prompt+'\n echo  two-spaces';
 const call={type:'toolCall',name:'exec',id:'c1',arguments:{command:'set -eu\n  echo  two-spaces'}};
 const pending={role:'toolResult',toolName:'exec',toolCallId:'c1',content:`Approval required (id ${id}).\nHost: gateway\nCommand:\n\x60\x60\x60sh\nset -eu\n echo  two-spaces\n\x60\x60\x60\nallow-once`};
 const r=maintenanceResults({messages:[{role:'user',content:shown},{role:'assistant',content:[call]},pending]}, {expectedPromptHash:createHash('sha256').update(expected).digest('hex'),expectedRequestDigest:maintenanceRequestDigest(expected)});
 assert.equal(r.requestFound,true);assert.equal(r.approval.command,call.arguments.command);
});
test('next phase waits for asynchronous execution followup to finish',async()=>{
 let reads=0;await waitForMaintenance({requireSettledTurn:true,sleep:async()=>{},onProgress(){},onPause(){throw Error('unexpected pause');},predicate:(_,r)=>r.executionText==='READY',readHistory:async()=>({messages:[{role:'toolResult',content:'READY'},...++reads>1?[{role:'assistant',stopReason:'stop',content:'done'}]:[]]})});assert.equal(reads,2);
});

test('expired run recovery requires a finished execution for every actual pending tool call',()=>{
 const j={...job,idempotencyKey:`bridge-install-ins_example-${tag}-step-2-attempt-1`};
 const h=history();h.messages[0].content=`本次执行编号：${tag}-1-1`;h.messages[4].content=`Exec completed (${id}, code 0) :: STAGED_1`;
 assert.equal(verifiedSettledInstallTurn({job:j,history:h}),true);
 for(const change of [x=>x.messages.splice(4,1),x=>x.messages[4].role='assistant',x=>x.messages[4].content=x.messages[4].content.replace(id,'22345678-1234-1234-1234-123456789abc'),x=>x.messages[0].content=`本次执行编号：${tag}-3-1`,x=>x.messages.push({role:'user',content:'unrelated new task'}),x=>x.sessionKey='other',x=>x.messages.at(-1).stopReason='toolUse']){
  const copy=structuredClone(h);change(copy);assert.equal(verifiedSettledInstallTurn({job:j,history:copy}),false);
 }
 const missing=structuredClone(h);missing.messages.splice(-1,0,{role:'assistant',content:[{type:'toolCall',name:'exec',id:'missing'}]});assert.equal(verifiedSettledInstallTurn({job:j,history:missing}),false);
});

test('verified completed installation advances without relying on an expired run cache',()=>{
 const key='ssh-ed25519 '+'A'.repeat(68)+' tunnel';
 const output=`OPENCLAW_${tag}_PUBKEY_BEGIN\n${key}\nOPENCLAW_${tag}_INSTALL_READY`;
 const h={sessionKey:session,instanceId:'ins_example',messages:[{role:'user',content:prompt},{role:'toolResult',toolName:'exec',content:output},{role:'assistant',stopReason:'stop',content:'done'}]};
 assert.equal(verifiedPhaseForContinuation(job,h),'INSTALL_READY');
 for(const change of [x=>x.messages[0].content+='changed',x=>x.messages[1].role='assistant',x=>x.messages[1].content=x.messages[1].content.replaceAll(tag,'b'.repeat(32)),x=>x.messages.at(-1).stopReason='toolUse',x=>x.instanceId='ins_other']){
  const copy=structuredClone(h);change(copy);assert.equal(verifiedPhaseForContinuation(job,copy),null);
 }
});
