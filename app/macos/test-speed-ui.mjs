import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {performanceSettings,batchCounts} from '../console/public/batch-performance.js';
import {BatchConnections} from '../console/public/batch-connection-core.js';

test('speed mode migrates older limits to recommendation while preserving new manual choices',()=>{
  const config={batchConcurrency:100,maxBatchConcurrency:100};
  assert.equal(performanceSettings(config).limit,100);
  assert.equal(performanceSettings(config,{version:1,manual:true,limit:50}).limit,100);
  assert.equal(performanceSettings(config,{version:2,manual:true,limit:20}).limit,20);
  assert.equal(performanceSettings(config,{version:2,manual:false,limit:50}).limit,100);
  assert.deepEqual(performanceSettings(config).choices,[10,20,50,100]);
});

test('server capacity bounds choices and manual limits, with valid fallback when config is unavailable',()=>{
  const settings=performanceSettings({batchConcurrency:16,maxBatchConcurrency:16},{version:2,manual:true,limit:100});
  assert.equal(settings.limit,16);
  assert.deepEqual(settings.choices,[10,16]);
  assert.equal(performanceSettings({batchConcurrency:-1,maxBatchConcurrency:'bad'}).limit,100);
});

test('live counters distinguish executing, queued, blocked and successful rows',()=>{
  const counts=batchCounts([
    {state:'queued'}, {state:'registering'}, {state:'checking'}, {state:'installing'},
    {state:'installing',approval:{requestId:'pending'}}, {state:'failed'}, {state:'interrupted'},
    {state:'checked',bridge:'failed'}, {state:'complete'}, {state:'checked',bridge:'online'}, {state:'idle'},
  ]);
  assert.deepEqual(counts,{total:11,running:3,queued:1,pending:4,complete:2});
});

test('the UI can start 100 distinct instances and never duplicate an in-flight instance',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let active=0,peak=0,calls=0;
  const batch=new BatchConnections({api:async()=>{calls++;active++;peak=Math.max(peak,active);await gate;active--;return {online:true};}});
  for(let i=0;i<100;i++)batch.add({instanceId:`ins_${i}`,url:`https://example.test/ins_${i}/chat`,name:String(i+1),registered:true});
  const duplicate=batch.add({instanceId:'ins_0',url:'https://example.test/ins_0/chat',name:'1',registered:true});
  batch.start(batch.rows,'check');
  assert.equal(peak,200);assert.equal(duplicate.state,'failed');assert.equal(calls,200);
  release();
  for(let i=0;i<20&&batch.running.size;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(batch.running.size,0);
});

test('failed background jobs immediately show their reason without speculative health rechecks',async()=>{
  const source=await readFile(new URL('../console/public/connections.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function pollConnectionJob('),source.indexOf('async function installBridge('));
  assert.ok(fn.endsWith('\n\n'), 'fixture extracts the complete polling function only');
  const notices=[],elements={};let requests=0;
  const state={selectedId:'ins_demo',pollingJobs:new Set(),flows:{ins_demo:{jobId:'job1'}}};
  const context={state,encodeURIComponent,setTimeout:resolve=>resolve(),
    $:id=>elements[id]||=( {classList:{toggle(){}}} ),
    api:async()=>{requests++;return {job:{status:'failed',retryable:true,error:'Gateway 未确认接收本次任务'}};},
    saveConnectionMemory(){},setInstanceResult:(_id,message,type)=>notices.push({message,type}),
    refreshInstanceStatus:()=>assert.fail('failed send must not be hidden behind health retries'),
    finishBridgeResult:()=>assert.fail('failed send is not an installed bridge'),
  };
  const poll=vm.runInNewContext(`(${fn})`,context);
  await assert.rejects(poll('job1','ins_demo'),/未确认接收/);
  assert.equal(requests,1);
  assert.deepEqual(notices,[{message:'Gateway 未确认接收本次任务',type:'error'}]);
  assert.equal(state.flows.ins_demo.jobStatus,'failed');
});

test('browser memory never restores an unverified green light',async()=>{
  const source=await readFile(new URL('../console/public/connections.js',import.meta.url),'utf8');
  const loader=source.slice(source.indexOf('function loadConnectionMemory()'),source.indexOf('const connectionMemory ='));
  const result=vm.runInNewContext(`${loader}\nloadConnectionMemory()`,{CONNECTION_MEMORY_KEY:'test',localStorage:{getItem:()=>JSON.stringify({statuses:{ins_demo:{mcp:true,bridge:true}}})}});
  assert.equal(JSON.stringify(result.statuses),'{}');
});

test('one-click buttons, checked permissions and live metrics remain visible',async()=>{
  const html=await readFile(new URL('../console/public/connections.html',import.meta.url),'utf8');
  const batch=await readFile(new URL('../console/public/batch-connections.js',import.meta.url),'utf8');
  for(const id of ['batchAll','batchShared','batchDelete','batchReplace','replaceCredential','allowShared','enableDelete'])assert.match(html,new RegExp(`id="${id}"[^>]*checked`));
  for(const id of ['batchSpeed','batchCount-running','batchCount-queued','batchCount-pending','batchCount-complete'])assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/id="installBridgeButton"[^>]*>一键安装文件桥/);
  assert.match(batch,/api\('\/api\/performance'\)/);
  assert.doesNotMatch(batch,/getItem\('openclawFarm\.batchLimit'\)/);
  assert.match(batch,/data-field="token" type="password"/);
});
