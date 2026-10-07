import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {maintenanceRequestDigest} from '../console/maintenance-results.mjs';
import {configureBridgeCommand} from '../console/remote-settings.mjs';

const src=await readFile(new URL('../console/server.mjs',import.meta.url),'utf8');
function fixture(listener='absent') {
  const calls=[];
  const job={instanceId:'ins_a',maintenanceSession:'agent:main:openclaw-control-ui:filebridge-a-'+randomUUID(),port:20080,enableDelete:true,taskTag:'a'.repeat(32)};
  let saves=0;
  const context={randomUUID,createHash,maintenanceRequestDigest,configureBridgeCommand,RELAY_DESTINATION:'operator@relay',RELAY_KEY:'/tmp/key',
    setupConfig:{relay:{sshPort:22022},bridge:{podPort:18081,workspace:'/home/node/.openclaw/workspace'}},
    checkMcpDirect:async()=>({online:true}),readBridgeCredential:async()=>'fb_'+'a'.repeat(64),
    parseBridgeInstallResult:()=>({publicKey:'verified-public-key'}),authorizeBridge:async()=>calls.push('authorize'),
    checkOracleBridgeListener:async()=>{calls.push('probe-oracle');return listener;},
    requireOracleBridgeListener:async()=>calls.push('verify-oracle'),appendConnectionJobLog:()=>{},jobStore:{save:async()=>saves++},
    shellSingleQuote:v=>`'${v}'`,sendMaintenanceRequest:async input=>{assert.ok(saves>0);assert.match(input.message,/-R localhost:20080:127.0.0.1:18081/);assert.ok(!input.message.includes('pgrep'));calls.push('send-tunnel');return {runId:input.idempotencyKey};},
    waitForMaintenance:async()=>calls.push('wait-tunnel'),approveMaintenanceExec:()=>{},maintenanceMarkerPresent:()=>true,
    validateBridgeOperations:async()=>calls.push('validate-files'),
    runFarmCommand:async args=>{calls.push(args[0]);return args[0]==='bridge-health'?{ok:true,capabilities:{read:true,write:true,delete:true}}:{};}};
  const a=src.indexOf('async function continueVerifiedBridgeSteps('),b=src.indexOf('async function resumeConnectionJob(',a);
  return {job,calls,run:vm.runInNewContext(src.slice(a,b)+'\ncontinueVerifiedBridgeSteps',context)};
}
test('verified installation resumes only missing tunnel then validates operations',async()=>{
  const f=fixture();assert.equal(await f.run(f.job,{phaseEvidence:'INSTALL_READY'},{}),true);
  assert.deepEqual(f.calls,['authorize','probe-oracle','send-tunnel','wait-tunnel','verify-oracle','bridge-configure','bridge-health','validate-files']);
});
test('live Oracle listener is reused without another tunnel command',async()=>{
  const f=fixture('healthy');assert.equal(await f.run(f.job,{phaseEvidence:'TUNNEL_READY'},{}),true);
  assert.deepEqual(f.calls,['probe-oracle','verify-oracle','bridge-configure','bridge-health','validate-files']);
});
test('old tunnel marker with absent Oracle listener recreates only tunnel',async()=>{
  const f=fixture();assert.equal(await f.run(f.job,{phaseEvidence:'TUNNEL_READY'},{}),true);
  assert.deepEqual(f.calls,['probe-oracle','send-tunnel','wait-tunnel','verify-oracle','bridge-configure','bridge-health','validate-files']);
});
test('occupied unhealthy Oracle listener blocks another tunnel',async()=>{
  const f=fixture('unhealthy');await assert.rejects(f.run(f.job,{phaseEvidence:'TUNNEL_READY'},{}),{code:'RELAY_LISTENER_UNHEALTHY'});
  assert.deepEqual(f.calls,['probe-oracle']);
});
test('unknown phase or missing port does not mutate remote',async()=>{
  const f=fixture();assert.equal(await f.run(f.job,{},{}),false);f.job.port=null;
  await assert.rejects(f.run(f.job,{phaseEvidence:'INSTALL_READY'},{}),{code:'RELAY_PORT_REVIEW_REQUIRED'});
  assert.deepEqual(f.calls,[]);
});
