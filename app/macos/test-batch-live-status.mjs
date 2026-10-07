import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchConnections} from '../console/public/batch-connection-core.js';
test('health refresh bypasses running job, checks bridge despite old unconfigured metadata',async()=>{
 const calls=[],b=new BatchConnections({api:async(url)=>{calls.push(url);return url==='/api/actions'?{result:{ok:true}}:{online:true};}});
 const row={id:'x',instanceId:'ins_a',registered:true,jobId:'keep-job',state:'installing',stale:true,bridgeConfigured:false};b.running.add('x');
 await b.refreshConnection(row);
 assert.deepEqual(calls.sort(),['/api/actions','/api/connections/mcp/check']);assert.equal(row.jobId,'keep-job');assert.equal(row.state,'installing');assert.equal(row.liveStatus.bridge,'online');assert.equal(row.stale,false);
});
test('failed live health cannot retain an old green light',async()=>{
 const b=new BatchConnections({api:async()=>{throw Error('connection refused');}}),row={id:'x',instanceId:'ins_a',registered:true,mcp:'online',bridge:'online',stale:true};
 await b.refreshConnection(row);assert.equal(row.liveStatus.mcp,'failed');assert.equal(row.liveStatus.bridge,'failed');assert.equal(row.healthChecking,false);
});
test('concurrent refreshes deduplicate requests',async()=>{
 let release,calls=0;const gate=new Promise(r=>release=r),b=new BatchConnections({api:async()=>{calls++;await gate;return {online:true,result:{ok:true}};}}),row={id:'x',instanceId:'ins_a',registered:true};
 const a=b.refreshConnection(row),c=b.refreshConnection(row);release();await Promise.all([a,c]);assert.equal(calls,2);
});
test('fresh pairing replaces stale copy data and successful health clears only Mac pairing',async()=>{
 let online=false;const b=new BatchConnections({api:async url=>url==='/api/actions'?{result:{ok:false}}:online?{online:true}:{stage:'pairing_required',requestId:'new-request',deviceId:'device'}});
 const row={id:'x',registered:true,instanceId:'ins_a',approval:{stage:'pairing_required',requestId:'old-request'}};
 await b.refreshConnection(row);assert.equal(row.approval.requestId,'new-request');online=true;await b.refreshConnection(row);assert.equal(row.approval,null);
 row.approval={stage:'exec_approval_required',requestId:'exec-request'};await b.refreshConnection(row);assert.equal(row.approval.requestId,'exec-request');
});
