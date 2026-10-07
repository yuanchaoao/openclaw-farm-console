import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {maintenanceResults,maintenanceRequestDigest} from '../console/maintenance-results.mjs';
const msg=(role,text)=>({role,content:[{type:'text',text}]});
test('OpenClaw bootstrap warning does not hide the current maintenance turn',()=>{
 const prompt='维护任务编号：abc\nset -eu\necho READY';
 const delivered=prompt+'\n\n[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before injection.';
 assert.equal(maintenanceRequestDigest(delivered),maintenanceRequestDigest(prompt));
 const value=maintenanceResults({messages:[msg('user',delivered),msg('toolResult','Approval required (id abcdef12).\nReply with: /approve abcdef12 allow-once|deny')]},{expectedPromptHash:'not-an-exact-match',expectedRequestDigest:maintenanceRequestDigest(prompt)});
 assert.equal(value.approval.requestId,'abcdef12');
});
test('approval is visible, echoed installation commands cannot prove completion',()=>{
 const value=maintenanceResults({messages:[msg('user','echo TUNNEL_READY'),msg('toolResult','echo TUNNEL_READY\nReply with: /approve cf2ae057 allow-once|allow-always|deny')]});
 assert.equal(value.approval.requestId,'cf2ae057');assert.equal(value.text.includes('TUNNEL_READY'),false);
});
test('actual results remain available after approval; tool-call arguments are not results',()=>{
 const value=maintenanceResults({messages:[msg('assistant','/approve cf2ae057 allow-once'),{role:'assistant',content:[{type:'toolCall',arguments:{command:'echo BAD'}}]},msg('toolResult','TUNNEL_READY')]});
 assert.equal(value.text.trim(),'TUNNEL_READY');
});
test('full approval ids retained',()=>{
 const id='12345678-1234-1234-1234-123456789abc';assert.equal(maintenanceResults({messages:[msg('assistant',`/approve ${id} allow-once`)]}).approval.requestId,id);
});

test('SDK full-id form and async user followups are supported without copying commands',()=>{
 const id='12345678-1234-1234-1234-123456789abc';
 const pending=msg('toolResult',`Approval required (id 12345678, full ${id}).\nCommand:\necho FAKE\nReply with: /approve 12345678 allow-once|deny`);
 assert.equal(maintenanceResults({messages:[pending]}).approval.requestId,id);
 const denied=maintenanceResults({messages:[msg('user','install'),pending,msg('user',`Exec denied (${id}, approval-timeout): echo FAKE`),msg('assistant','The command did not run.')]});
 assert.equal(denied.approvalEnded,true);assert.equal(denied.approval,null);
 const done=maintenanceResults({messages:[msg('user','install'),pending,msg('user',`An async command the user already approved has completed.\nExact completion details:\nExec finished (${id}, code 0)\nTUNNEL_READY\nContinue the task if needed`)]});
 assert.equal(done.approval,null);assert.equal(done.text.trim(),'TUNNEL_READY');
});

import {bridgeInstallPattern,waitForMaintenance,parseBridgeInstallResult,maintenanceMarkerPresent} from '../console/maintenance-results.mjs';
test('public key result matches real newlines, not echoed shell commands',()=>{
 const tag='a'.repeat(32),key='ssh-ed25519 '+'A'.repeat(68)+' openclaw-tunnel';
 const output=`OPENCLAW_${tag}_PUBKEY_BEGIN\n${key}\nOPENCLAW_${tag}_PUBKEY_END`;
 assert.equal(output.match(bridgeInstallPattern(tag))[1],key);
 assert.equal(bridgeInstallPattern(tag).test('echo '+output),false);
});
test('wait timeout resumes the same reader; no send/reinstall operation is involved',async()=>{
 let time=0,reads=0,pauses=0;
 const result=await waitForMaintenance({now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:1,sessionKey:'agent:main:test',onProgress(){},onPause:async()=>{pauses++;},predicate:text=>text.includes('READY'),readHistory:async()=>({messages:[msg('toolResult',++reads===2?'READY':'working')]})});
 assert.equal(result,'READY');assert.equal(pauses,1);assert.equal(reads,2);
});
test('new approval IDs update the displayed request, denied approval pauses immediately',async()=>{
 let time=0,reads=0,pauses=0;const ids=[];
 await waitForMaintenance({now:()=>time,sleep:async ms=>{time+=ms;},sessionKey:'agent:main:test',onProgress:(_,details)=>{if(details?.approval)ids.push(details.approval.requestId);},onPause:async()=>pauses++,predicate:text=>text.includes('READY'),readHistory:async()=>({messages:[msg('toolResult',['/approve aaaaaaaa allow-once','/approve bbbbbbbb allow-once','Exec denied (approval-timeout)','READY'][reads++])]})});
 assert.deepEqual(ids,['aaaaaaaa','bbbbbbbb']);assert.equal(pauses,1);
});

const taskTag='b'.repeat(32);
const publicKey='ssh-ed25519 '+'A'.repeat(68)+' openclaw-tunnel';
const installOutput=`OPENCLAW_${taskTag}_PUBKEY_BEGIN\n${publicKey}\nOPENCLAW_${taskTag}_PUBKEY_END\nOPENCLAW_${taskTag}_INSTALL_READY`;

test('both multiline stdout and Gateway flattened completion stdout prove installation',()=>{
 for(const delimiter of ['\n',' ']) {
  const output=installOutput.replaceAll('\n',delimiter);
  const history={messages:[msg('user','install this task'),msg('user',`An async command the user already approved has completed.\nExact completion details:\nExec finished (run-id, code 0) :: ${output}\nContinue the task if needed`)]};
  assert.deepEqual(parseBridgeInstallResult(history,taskTag),{publicKey});
  const results=maintenanceResults(history);
  assert.equal(results.executionText,output);
  assert.deepEqual(parseBridgeInstallResult(results,taskTag),{publicKey});
 }
 assert.deepEqual(parseBridgeInstallResult({messages:[msg('toolResult',installOutput)]},taskTag),{publicKey});
});

test('user input, tool arguments, assistant summaries, approval command echoes and echo commands cannot prove installation',()=>{
 const invalidHistories=[
  [msg('user',installOutput)],
  [{role:'assistant',content:[{type:'toolCall',arguments:{command:installOutput}}]}],
  [msg('assistant',installOutput)],
  [msg('toolResult',`Approval required (id 12345678-1234-1234-1234-123456789abc).\nCommand:\n${installOutput}`)],
  [msg('toolResult','echo '+installOutput)],
  [msg('toolResult',installOutput.replace(`\nOPENCLAW_${taskTag}_INSTALL_READY`,`\necho OPENCLAW_${taskTag}_INSTALL_READY`))]
 ];
 for(const messages of invalidHistories)assert.equal(parseBridgeInstallResult({messages},taskTag),null);
 assert.equal(maintenanceResults({messages:[msg('assistant',installOutput)]}).executionText,'');
});

test('a result must contain the same task tag and a subsequent installation ready marker',()=>{
 assert.equal(parseBridgeInstallResult({messages:[msg('toolResult',installOutput)]},'c'.repeat(32)),null);
 assert.equal(parseBridgeInstallResult({messages:[msg('toolResult',installOutput.replace(`OPENCLAW_${taskTag}_INSTALL_READY`,''))]},taskTag),null);
 assert.equal(parseBridgeInstallResult({messages:[msg('toolResult',installOutput.replace(`OPENCLAW_${taskTag}_INSTALL_READY`,`OPENCLAW_${'c'.repeat(32)}_INSTALL_READY`))]},taskTag),null);
});

test('omitted cosmetic public-key end line still requires actual matching ready output',()=>{
 const compact=installOutput.replace(`OPENCLAW_${taskTag}_PUBKEY_END\n`,'');
 for(const text of [compact,compact.replaceAll('\n',' ')])assert.deepEqual(parseBridgeInstallResult({messages:[msg('toolResult',text)]},taskTag),{publicKey});
 for(const messages of [[msg('assistant',compact)],[msg('user',compact)],[msg('toolResult','echo '+compact)],[msg('toolResult',compact.replace(`OPENCLAW_${taskTag}_INSTALL_READY`,`OPENCLAW_${'c'.repeat(32)}_INSTALL_READY`))]])assert.equal(parseBridgeInstallResult({messages},taskTag),null);
});

test('tunnel completion accepts compressed execution output and excludes echoes and summaries',()=>{
 const marker=`OPENCLAW_${taskTag}_TUNNEL_READY`;
 const history={messages:[msg('user',`Exec completed (run-id, code 0) :: checked ${marker}`)]};
 assert.equal(maintenanceMarkerPresent(history,taskTag,'TUNNEL_READY'),true);
 assert.equal(maintenanceMarkerPresent(maintenanceResults(history),taskTag,'TUNNEL_READY'),true);
 assert.equal(maintenanceMarkerPresent({messages:[msg('toolResult','echo '+marker)]},taskTag,'TUNNEL_READY'),false);
 assert.equal(maintenanceMarkerPresent({messages:[msg('assistant',marker)]},taskTag,'TUNNEL_READY'),false);
 assert.equal(maintenanceMarkerPresent(history,'c'.repeat(32),'TUNNEL_READY'),false);
});

test('nonzero completed commands fail promptly instead of waiting for a success marker',async()=>{
 const histories=[
  {messages:[msg('user','install'),msg('user','Exec finished (run-id, code 7) :: connection refused')]},
  {messages:[{...msg('toolResult','failed'),details:{exitCode:1}}]},
  {messages:[msg('toolResult','Command exited with code 2')]},
  {messages:[msg('toolResult','File parser error\n\n(Command exited with code 1)')]}
 ];
 for(const history of histories) {
  assert.ok(maintenanceResults(history).failure.exitCode>0);
  await assert.rejects(waitForMaintenance({readHistory:async()=>history,predicate:()=>false,onProgress(){},onPause:async()=>assert.fail('must not wait'),sleep:async()=>{},sessionKey:'test'}),error=>error.code==='MAINTENANCE_EXEC_FAILED' && /执行失败/.test(error.message));
 }
 assert.equal(maintenanceResults({messages:[msg('assistant','Exec finished (run-id, code 1) :: failure')]}).failure,null);
});

test('wait predicate receives execution evidence separately from assistant text',async()=>{
 let seen;
 const history={messages:[msg('assistant','Summary'),msg('toolResult',installOutput.replaceAll('\n',' '))]};
 const text=await waitForMaintenance({readHistory:async()=>history,predicate:(_text,results)=>{seen=results;return parseBridgeInstallResult(results,taskTag)!==null;},onProgress(){},onPause:async()=>assert.fail('must not wait'),sleep:async()=>{},sessionKey:'test'});
 assert.ok(text.includes('Summary'));
 assert.ok(!seen.executionText.includes('Summary'));
 assert.deepEqual(parseBridgeInstallResult(seen,taskTag),{publicKey});
});

test('remote agent failures are reported even when no transcript was created', async()=>{
 await assert.rejects(waitForMaintenance({sleep:async()=>{},onPause:async()=>{},onProgress(){},predicate:()=>false,readHistory:async()=>({messages:[]}),readRunStatus:async()=>({status:'error',error:'provider 429 quota exceeded sk-do-not-print-123456'})}),error=>error.code==='MAINTENANCE_AGENT_FAILED' && /额度/.test(error.message) && !error.message.includes('sk-'));
});
test('a finished empty agent run cannot wait indefinitely or imply installation', async()=>{
 let checks=0;
 await assert.rejects(waitForMaintenance({sleep:async()=>{},onPause:async()=>{},onProgress(){},predicate:()=>false,readHistory:async()=>({messages:[]}),readRunStatus:async()=>{checks++;return {status:'ok'};}}),error=>error.code==='MAINTENANCE_NO_EXECUTION');
 assert.equal(checks,2);
});
test('run wait timeout means pending and does not prevent a later real result', async()=>{
 let reads=0;
 const result=await waitForMaintenance({sleep:async()=>{},onPause:async()=>{},onProgress(){},predicate:text=>text==='READY',readHistory:async()=>({messages:++reads<3?[]:[msg('toolResult','READY')]}),readRunStatus:async()=>({status:'timeout'})});
 assert.equal(result,'READY');
});


test('credential recovery after an intermediate command failure is accepted only from later execution output',async()=>{
 const tag='d'.repeat(32),marker=`OPENCLAW_${tag}_CREDENTIAL_READY`;
 const failed=msg('toolResult','Process exited with code 1.');
 assert.equal(maintenanceMarkerPresent({messages:[msg('toolResult',marker),failed]},tag,'CREDENTIAL_READY'),false);
 assert.equal(maintenanceMarkerPresent({messages:[failed,msg('toolResult',marker)]},tag,'CREDENTIAL_READY'),true);
 let count=0,time=0;
 await waitForMaintenance({allowExecutionRecovery:true,now:()=>time,sleep:async ms=>time+=ms,onProgress(){},readRunStatus:async()=>({status:'timeout'}),
 readHistory:async()=>({messages:++count===1?[failed]:[failed,msg('toolResult',marker)]}),
 predicate:(_,r)=>maintenanceMarkerPresent(r,tag,'CREDENTIAL_READY')});
 assert.equal(count,2);
});

test('a turn with no execution evidence invokes bounded active stall recovery',async()=>{
 const prompt='维护任务编号：'+'a'.repeat(32)+'\nrun';
 const history={messages:[msg('user',prompt)]};
 let time=0,stalls=0;
 await assert.rejects(waitForMaintenance({
  readHistory:async()=>history,predicate:()=>false,onProgress(){},sessionKey:'test',
  onPause:async()=>assert.fail('stall recovery must run before the general timeout'),
  readRunStatus:async()=>({status:'in_flight'}),timeoutMs:300000,stallAfterMs:60000,
  expectedPromptHash:createHash('sha256').update(prompt).digest('hex'),
  now:()=>time,sleep:async ms=>time+=ms,
  onStall:async()=>{stalls++;throw Object.assign(Error('retry'),{code:'MAINTENANCE_STALLED_RETRY'});}
 }),error=>error.code==='MAINTENANCE_STALLED_RETRY');
 assert.equal(stalls,1);
});
