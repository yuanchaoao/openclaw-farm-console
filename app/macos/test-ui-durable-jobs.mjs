import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchConnections,savedRows} from '../console/public/batch-connection-core.js';
import {batchCounts} from '../console/public/batch-performance.js';
test('blocked and awaiting approval stop polling and retain durable task reference',async()=>{
 for(const status of ['blocked','awaiting_approval']) {
  let requests=0;const b=new BatchConnections({api:async()=>{requests++;return {job:{id:'job',instanceId:'ins_a',status,message:'受阻',nextAction:'检查远端身份'}};},sleep:()=>{throw Error('must release slot');}});
  const row=b.add({instanceId:'ins_a',jobId:'job'});await b.poll(row);
  assert.equal(requests,1);assert.equal(row.jobId,'job');assert.equal(row.state,status);assert.equal(batchCounts([row]).pending,1);
 }
});
test('latest lookup restores backend blocked status without remote mutation',async()=>{
 const calls=[];const b=new BatchConnections({api:async(url,body)=>{calls.push([url,body]);return {job:{id:'new',instanceId:'ins_a',status:'blocked',blockerCode:'INTERNAL_APPROVAL'}};}});
 const row=b.add({instanceId:'ins_a',jobId:'old',approval:{requestId:'old'}});await b.syncLatest(row);
 assert.deepEqual(calls,[['/api/connections/instances/ins_a/latest',undefined]]);assert.equal(row.jobId,'new');assert.equal(row.approval,null);assert.equal(row.blockerCode,'INTERNAL_APPROVAL');
});
test('browser persistence discards secrets approvals and unchecked health',()=>{
 const [saved]=savedRows([{id:'a',instanceId:'ins_a',url:'https://example.com/ins_a/chat?token=secret',token:'secret',mcp:'online',bridge:'online',state:'complete',approval:{requestId:'old',command:'approve old'},jobId:'task'}]);
 assert.equal(saved.jobId,'task');for(const field of ['token','mcp','bridge','state','approval'])assert.equal(field in saved,false);assert.equal(JSON.stringify(saved).includes('secret'),false);
});
test('latest task instance mismatch is rejected',async()=>{
 const b=new BatchConnections({api:async()=>({job:{id:'bad',instanceId:'ins_b',status:'complete'}})});
 await assert.rejects(b.syncLatest({instanceId:'ins_a'}),/实例不匹配/);
});
test('a blocked instance releases the batch slot to the next instance',async()=>{
 const sent=[];const b=new BatchConnections({limit:1,api:async(url,body)=>{
  if(url.endsWith('/resume'))return {};
  if(url.includes('/jobs/'))return {job:{id:'existing',instanceId:'ins_a',status:'blocked',message:'内部审批受阻'}};
  if(url.endsWith('/install-bridge')){sent.push(body.instanceId);return {stage:'complete'};}
  throw Error(url);
 }});
 const a=b.add({url:'https://example.com/ins_a/chat',instanceId:'ins_a',name:'1',registered:true,jobId:'existing'});
 const c=b.add({url:'https://example.com/ins_b/chat',instanceId:'ins_b',name:'2',registered:true});
 b.start([a,c],'bridge',{allowSharedWorkspace:true});
 for(let i=0;i<10 && b.running.size;i++)await new Promise(r=>setTimeout(r,0));
 assert.equal(a.state,'blocked');assert.equal(a.jobId,'existing');assert.deepEqual(sent,['ins_b']);assert.equal(b.running.size,0);
});
