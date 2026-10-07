import test from 'node:test';import assert from 'node:assert/strict';
import {verifiedFailedTurnEnded} from '../console/maintenance-recovery.mjs';
const job={instanceId:'ins_example',maintenanceSession:'agent:main:openclaw-control-ui:filebridge-example-00',taskTag:'a'.repeat(32),remoteRunId:'run-1'};
const run={runId:'run-1',status:'timeout'};
function history(){return {sessionKey:job.maintenanceSession,messages:[{role:'user',content:'install '+job.taskTag},{role:'assistant',content:[{type:'toolCall',name:'exec',id:'c1'}]},{role:'toolResult',toolCallId:'c1',content:JSON.stringify({status:'error',tool:'exec',error:'Exec approval registration failed'})},{role:'assistant',stopReason:'stop',content:[]}]};}
test('expired run cache uses closed tagged actual failed tool turn',()=>assert.equal(verifiedFailedTurnEnded({job,history:history(),run}),true));
test('active, mismatched, or untagged execution cannot be repeated',()=>{for(const r of [{runId:'run-1',status:'running'},{runId:'other',status:'timeout'}])assert.equal(verifiedFailedTurnEnded({job,history:history(),run:r}),false);const h=history();h.messages[0].content='other';assert.equal(verifiedFailedTurnEnded({job,history:h,run}),false);});
test('missing result, success, or open turn is not proven failed',()=>{for(const change of [h=>h.messages.splice(2,1),h=>h.messages[2].content=JSON.stringify({status:'running',tool:'exec'}),h=>h.messages.at(-1).stopReason='toolUse']){const h=history();change(h);assert.equal(verifiedFailedTurnEnded({job,history:h,run}),false);}});
