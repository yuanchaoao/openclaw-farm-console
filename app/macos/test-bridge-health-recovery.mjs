import test from 'node:test';
import assert from 'node:assert/strict';
import {checkBridgeWithRecovery,resumeVerifiedBridgePhase} from '../console/bridge-health-recovery.mjs';
test('a configured transient failure only requests the exclusive local forward recovery',async()=>{
 const calls=[],progress=[];
 const result=await checkBridgeWithRecovery({instanceId:'ins_a',configured:true,onProgress:(text,details)=>progress.push(details.stage),run:async args=>{
  calls.push(args);if(args[0]==='bridge-health')throw Error('文件桥连接失败：TimeoutError');return {ok:true};
 }});
 assert.equal(result.ok,true);assert.deepEqual(calls,[['bridge-health','ins_a'],['bridge-reconnect','ins_a','--approved-reconnect']]);
 assert.deepEqual(progress,['local_forward_repair','verify']);
});
test('healthy connections, missing configuration and authentication errors do not restart SSH',async()=>{
 for(const [configured,error] of [[true,null],[false,Error('TimeoutError')],[true,Error('文件桥 HTTP 401')],[true,Error('钥匙串访问超时')]]){
  let requests=0;const work=checkBridgeWithRecovery({instanceId:'ins_a',configured,run:async()=>{requests++;if(error)throw error;return {ok:true};}});
  if(error)await assert.rejects(work);else assert.equal((await work).ok,true);
  assert.equal(requests,1);
 }
});
test('unverified forward ownership stops the operation and cannot imply successful health',async()=>{
 let requests=0;await assert.rejects(checkBridgeWithRecovery({instanceId:'ins_a',configured:true,run:async()=>{throw Error(++requests===1?'TimeoutError':'未找到独占 SSH 转发');}}),/未找到独占/);
 assert.equal(requests,2);
});
test('a stale tunnel marker with a reset connection repairs the existing route once',async()=>{
 const calls=[];
 const result=await resumeVerifiedBridgePhase({phaseEvidence:'TUNNEL_READY',healthFailure:Error('文件桥连接失败：ConnectionResetError'),continueSteps:async()=>{calls.push('continue');return false;},repairRoute:async()=>{calls.push('repair');return true;}});
 assert.equal(result,true);assert.deepEqual(calls,['repair']);
});
test('an install marker or unrelated failure does not rebuild the route',async()=>{
 for(const [phaseEvidence,healthFailure] of [['INSTALL_READY',Error('ConnectionResetError')],['TUNNEL_READY',Error('文件桥 HTTP 403')]]){
  const calls=[];
  await resumeVerifiedBridgePhase({phaseEvidence,healthFailure,continueSteps:async()=>{calls.push('continue');return true;},repairRoute:async()=>{calls.push('repair');return true;}});
  assert.deepEqual(calls,['continue']);
 }
});
