import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {archiveRecord,requireActiveRecord,archiveJob} from '../console/instance-lifecycle.mjs';
import {openJobStore,publicJob} from '../console/connection-job-store.mjs';
import {reconcileInstanceRows,removeInstanceRow} from '../console/public/instance-list-sync.js';
import {BatchAutosave} from '../console/public/batch-autosave.js';
import {BatchConnections} from '../console/public/batch-connection-core.js';

test('removal binds instance ID, preserves the same-named instance and existing configuration',()=>{
 const registry={instances:{ins_old:{id:'ins_old',name:'23',credential_ref:'keychain:old',file_bridge:{relay_port:20001}},ins_keep:{id:'ins_keep',name:'23'}}};
 assert.equal(archiveRecord(registry,'ins_old',100),100);
 assert.equal(archiveRecord(registry,'ins_old',200),100);
 assert.throws(()=>requireActiveRecord(registry,'ins_old'),error=>error.code==='INSTANCE_ARCHIVED');
 assert.equal(requireActiveRecord(registry,'ins_keep').name,'23');
 assert.equal(registry.instances.ins_old.credential_ref,'keychain:old');
 assert.deepEqual(registry.instances.ins_old.file_bridge,{relay_port:20001});
});

test('archived tasks remain archived across restart and late async state changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge removal store '));
 try {
  const path=join(dir,'jobs.json'),store=await openJobStore(path);
  const job={id:'j',instanceId:'ins_old',status:'blocked',approval:{requestId:'stale'},logs:[]};
  archiveJob(job,100);store.jobs.set(job.id,job);job.status='failed';await store.save();
  const restored=(await openJobStore(path)).jobs.get('j');
  assert.equal(restored.status,'archived');assert.equal(restored.previousStatus,'blocked');
  assert.equal(restored.archivedAt,100);assert.equal(publicJob(restored).approval,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('stale browser rows cannot restore a removed instance or discard unrelated token drafts',()=>{
 const old={id:'a',instanceId:'ins_old',url:'https://example.test/ins_old/chat',name:'23'};
 const keep={id:'b',instanceId:'ins_keep',url:'https://example.test/ins_keep/chat',name:'23',token:'unsaved-draft'};
 const draft={id:'c',url:'',token:'new-draft'};
 const rows=reconcileInstanceRows([old,keep,draft],{instances:[{id:'ins_keep',hasCredential:true}],archivedInstanceIds:['ins_old']});
 assert.deepEqual(rows,[keep,draft]);assert.equal(old.removed,true);assert.equal(keep.token,'unsaved-draft');assert.equal(draft.token,'new-draft');
});

test('removal waits for the current autosave and prevents its queued replacement',async()=>{
 let release;const calls=[];
 const api=async(url,body)=>{calls.push(url);if(url.endsWith('/register')){await new Promise(r=>release=r);return {instanceId:'ins_old'};}return {archived:true};};
 const autosave=new BatchAutosave({api});const row={id:'a',url:'https://example.test/ins_old/chat',token:'a'.repeat(30)};
 const first=autosave.save(row);row.token='b'.repeat(30);const second=autosave.save(row);
 const removing=removeInstanceRow({row,autosave,api});release();
 await Promise.all([first,second,removing]);await autosave.save(row);
 assert.deepEqual(calls,['/api/connections/register','/api/instances/ins_old/archive']);
 const b=new BatchConnections({api:()=>{throw Error('must not send');}});b.rows=[row];
 b.start([row],'bridge',{allowSharedWorkspace:true});assert.equal(b.pending.length,0);assert.equal(b.running.size,0);
});

test('HTTP removal synchronizes list and tasks, blocks stale registration/resume, persists through reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge removal api '));
 process.env.OPENCLAW_UI_DATA_DIR=join(dir,'data');process.env.OPENCLAW_INSTANCES_FILE=join(dir,'instances.json');
 process.env.OPENCLAW_PYTHON_BIN=join(dir,'must-not-spawn');
 await mkdir(join(dir,'data'));
 await writeFile(process.env.OPENCLAW_INSTANCES_FILE,JSON.stringify({instances:{ins_old:{id:'ins_old',name:'23',status:'active',credential_ref:'retained'},ins_keep:{id:'ins_keep',name:'23',status:'active'}}}));
 await writeFile(join(dir,'data/connection-jobs.json'),JSON.stringify({jobs:[{id:'old-job',instanceId:'ins_old',status:'blocked',createdAt:1,updatedAt:1}]}));
 const {server}=await import('../console/server.mjs');
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body)=>{const response=await fetch(base+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  assert.equal((await request('/api/instances/ins_old/archive',{})).data.archived,true);
  const current=(await request('/api/instances')).data;
  assert.deepEqual(current.instances.map(x=>x.id),['ins_keep']);assert.deepEqual(current.archivedInstanceIds,['ins_old']);
  assert.deepEqual((await request('/api/connections/instances/ins_old/latest')).data,{ok:true,archived:true,job:null});
  for(const [path,body,message] of [['/api/connections/register',{url:'https://example.test/ins_old/chat',token:'x'.repeat(30),replace:true},/已从管理列表移出/],['/api/connections/jobs/old-job/resume',{},/已从管理列表移出/],['/api/connections/mcp/install-bridge',{instanceId:'ins_old',confirm:true,allowSharedWorkspace:true},/实例不存在或尚未注册/]]){
   const result=await request(path,body);assert.ok(result.status>=400);assert.match(result.data.error,message);
  }
  const registry=JSON.parse(await readFile(process.env.OPENCLAW_INSTANCES_FILE,'utf8'));
  assert.equal(registry.instances.ins_old.credential_ref,'retained');
  assert.equal((await openJobStore(join(dir,'data/connection-jobs.json'))).jobs.get('old-job').status,'archived');
  const newer=await request('/api/connections/mcp/install-bridge',{instanceId:'ins_keep',confirm:true,allowSharedWorkspace:true});
  assert.equal((await request('/api/connections/jobs/old-job')).data.job.status,'archived','a new job must not evict older durable history');
  for(let n=0;n<50;n++){
   const current=(await request('/api/connections/jobs/'+newer.data.jobId)).data.job;
   if(['failed','blocked'].includes(current.status))break;
   await new Promise(r=>setTimeout(r,10));
  }
  await new Promise(r=>setTimeout(r,20));
 }finally{if(server.listening)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
