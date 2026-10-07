import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {maintenanceResults,waitForMaintenance} from '../console/maintenance-results.mjs';
import {openJobStore} from '../console/connection-job-store.mjs';
import {PairingCoordinator} from '../console/pairing-coordinator.mjs';
import {validateBridgeOperations} from '../console/bridge-validation.mjs';
import {createHash} from 'node:crypto';
const broken={messages:[{role:'toolResult',toolName:'exec',content:[{type:'text',text:JSON.stringify({status:'error',error:'Exec approval registration failed: Error: gateway closed (1008): pairing required'})}]}]};
test('actual internal approval registration failure immediately blocks, never counts as execution success',async()=>{
  const result=maintenanceResults(broken);assert.equal(result.failure.code,'REMOTE_INTERNAL_APPROVAL_BLOCKED');assert.equal(result.executionText,'');
  let reads=0;await assert.rejects(waitForMaintenance({readHistory:async()=>{reads++;return broken;},predicate:()=>true,onProgress:()=>{},sleep:async()=>{},onPause:()=>{throw Error('must not pause');}}),{code:'REMOTE_INTERNAL_APPROVAL_BLOCKED'});assert.equal(reads,1);
});
test('restart keeps execution identity but invalidates pending state and excludes secrets and approvals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge jobs ')),path=join(dir,'jobs.json');
 try{const store=await openJobStore(path);store.jobs.set('j',{id:'j',instanceId:'ins_a',status:'running',remoteRunId:'run',maintenanceSession:'session',token:'SECRET',prompt:'SECRET',approval:{requestId:'stale'}});await store.save();const raw=await readFile(path,'utf8');assert.ok(!raw.includes('SECRET'));assert.ok(!raw.includes('stale'));const loaded=await openJobStore(path);assert.equal(loaded.jobs.get('j').status,'blocked');assert.equal(loaded.jobs.get('j').blockerCode,'RESTART_REVIEW_REQUIRED');assert.equal(loaded.jobs.get('j').remoteRunId,'run');}finally{await rm(dir,{recursive:true,force:true});}
});
test('completed jobs are not automatically restarted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-complete-'));try{const path=join(dir,'jobs.json'),store=await openJobStore(path);store.jobs.set('j',{id:'j',status:'complete'});await store.save();assert.equal((await openJobStore(path)).jobs.get('j').status,'complete');}finally{await rm(dir,{recursive:true,force:true});}
});
test('pairing renewal is server owned, deduplicated, bounded; failures remove old IDs',async()=>{
 let time=100,calls=0,fail=false,online=false;
 const manager=new PairingCoordinator(async()=>{calls++;if(fail)throw Error('network');return online?{online:true}:{stage:'pairing_required',requestId:'current',deviceId:'device'};},{now:()=>time});
 await Promise.all([manager.verify('a'),manager.verify('a')]);assert.equal(calls,1);
 time+=60000;await manager.tick();assert.equal(calls,2);assert.equal(manager.records.get('a').requestId,'current');
 time+=30*60000;await manager.tick();assert.equal(calls,2);
 fail=true;await assert.rejects(manager.verify('a'));assert.equal(manager.records.has('a'),false);
 fail=false;online=true;assert.equal((await manager.verify('a')).requestId,undefined);
});
test('real readback hash and cleanup gate completion, mismatches still clean unique file',async()=>{
 let content,deleted=false;
 const call=async(args,stdin)=>{if(args[0]==='file-write'){content=stdin;return{};}if(args[0]==='file-read')return JSON.parse(content);if(args[0]==='file-stat')return {sha256:createHash('sha256').update(content).digest('hex')};if(args[0]==='file-delete'){assert.match(args[2],/^\.openclaw-bridge-validation-/);deleted=true;}return{};};
 assert.equal((await validateBridgeOperations(call,'ins_a')).write,true);assert.equal(deleted,true);
 deleted=false;await assert.rejects(validateBridgeOperations((args,stdin)=>args[0]==='file-read'?{}:call(args,stdin),'ins_a'),/不一致/);assert.equal(deleted,true);
});
