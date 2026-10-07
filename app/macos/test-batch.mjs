import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BatchConnections,savedRows} from '../console/public/batch-connection-core.js';
const token='secret-example-token-1234567890';
const row=i=>({url:`https://example.org/ins_${i}/chat`,token,name:String(i+1)});
const wait=async batch=>{for(let i=0;i<1000&&(batch.running.size||batch.pending.length);i++)await new Promise(r=>setTimeout(r,2));assert.equal(batch.running.size,0);};
test('concurrency bounded; approval and failure free workers; no bridge without MCP',async()=>{
 let active=0,max=0;const installed=[];
 const batch=new BatchConnections({limit:3,api:async(path,body)=>{
  if(path.endsWith('/register'))return {instanceId:body.url.match(/ins_\d/)[0]};
  if(path.endsWith('/check'))assert.fail('one-click installation uses the backend MCP preflight');
  if(path.endsWith('install-bridge')){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,8));active--;if(body.instanceId==='ins_0')return {stage:'pairing_required'};if(body.instanceId==='ins_1')throw Error('offline '+token);installed.push(body.instanceId);assert.equal(body.enableDelete,true);return {stage:'complete'};}
 }});
 for(let i=0;i<8;i++)batch.add(row(i));batch.start(batch.rows,'bridge',{allowSharedWorkspace:true,enableDelete:true});await wait(batch);
 assert.equal(max,3);assert.equal(batch.rows[0].state,'approval');assert.equal(batch.rows[1].mcp,'failed');assert.equal(installed.length,6);assert.equal(batch.rows[1].message.includes(token),false);assert.equal(batch.rows[2].token,token);
});
test('saved state excludes credentials, URL query secrets and invalid edited URLs',()=>{
 const batch=new BatchConnections({api:()=>{}});const r=batch.add({...row(1),instanceId:'ins_1',url:row(1).url+'?token='+token});
 assert.equal(JSON.stringify(savedRows(batch.rows)).includes(token),false);r.url='bad';assert.deepEqual(savedRows(batch.rows),[]);
});
test('resumes existing job without new registration or installation',async()=>{
 let calls=0;const batch=new BatchConnections({api:async path=>{calls++;assert.equal(path,'/api/connections/instances/ins_1/latest');return {job:{instanceId:'ins_1',status:'complete',result:{stage:'complete'}}};}});
 const r=batch.add({...row(1),instanceId:'ins_1',registered:true,jobId:'job1'});batch.start([r],'resume');await wait(batch);assert.equal(calls,1);assert.equal(r.bridge,'online');
});
test('duplicate instance and missing consent cannot launch duplicate installations',async()=>{
 const batch=new BatchConnections({api:async()=>({online:true})});batch.add(row(1));assert.throws(()=>batch.start(batch.rows,'bridge'),/勾选/);
 batch.add(row(1));batch.start(batch.rows,'check');await wait(batch);assert.equal(batch.rows[1].state,'failed');
});
test('single and batch permission checkboxes default checked; tokens are password inputs',async()=>{
 const html=await readFile(new URL('../console/public/connections.html',import.meta.url),'utf8');
 for(const id of ['allowShared','enableDelete','batchShared','batchDelete','batchAll'])assert.match(html,new RegExp(`id="${id}"[^>]*checked`));
 const js=await readFile(new URL('../console/public/batch-connections.js',import.meta.url),'utf8');assert.match(js,/data-field="token" type="password"/);
});
