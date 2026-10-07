import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkPool,concurrencyLimit} from '../console/concurrency.mjs';
import {BatchConnections} from '../console/public/batch-connection-core.js';

test('50 remote tasks share 16 local requests, drain fairly and recover slots after errors',async()=>{
 const pool=createWorkPool(16);let active=0,peak=0;const started=[];
 const results=await Promise.allSettled(Array.from({length:50},(_,i)=>pool.run(async()=>{
  started.push(i);active++;peak=Math.max(peak,active);
  await new Promise(r=>setTimeout(r,3));active--;
  if(i===5)throw Error('simulated isolated failure');return i;
 })));
 assert.equal(peak,16);assert.deepEqual(started,Array.from({length:50},(_,i)=>i));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,49);
 assert.equal(await pool.run(()=>99),99);
});

test('speed-first batch starts 50 distinct MCP checks concurrently',async()=>{
 let active=0,peak=0,done=0;
 const batch=new BatchConnections({api:async(path)=>{if(path==='/api/actions')return {result:{ok:true}};active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,3));active--;done++;return {online:true};}});
 for(let i=0;i<50;i++)batch.add({url:`https://example.org/ins_${i}/chat`,instanceId:`ins_${i}`,name:String(i+1),registered:true});
 batch.start(batch.rows,'check');
 for(let i=0;i<100&&done<50;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(peak,50);assert.equal(done,50);assert.equal(batch.rows.filter(r=>r.state==='checked').length,50);
});

test('invalid concurrency settings cannot stall or create unbounded work',()=>{
 assert.equal(concurrencyLimit('oops',16),16);assert.equal(concurrencyLimit('0',16),16);
 assert.equal(concurrencyLimit('999',16,32),32);assert.equal(new BatchConnections({api:()=>{},limit:0}).limit,100);
});
