import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {BatchConnections,bridgeActionLabel,permissionStageLabel} from '../console/public/batch-connection-core.js';
const source=fs.readFileSync(new URL('../console/public/connections.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(0,source.indexOf('const SELECTED_INSTANCE_KEY')),ctx);
test('single and batch expose the three permission stages without claiming completion',()=>{
 for(const stage of ['permission_check','permission_repair','permission_verify']) {
  assert.ok(permissionStageLabel(stage));
  assert.equal(ctx.permissionStageLabel(stage),permissionStageLabel(stage));
  const batch=new BatchConnections({api:async()=>{}}),row=batch.add({instanceId:'ins_a'});
  batch.applyJob(row,{id:'job',instanceId:'ins_a',status:'running',stage});
  assert.equal(row.state,'installing');assert.ok(row.message.includes(permissionStageLabel(stage)));
  assert.notEqual(row.bridge,'online');
 }
});
test('only an internal blocked task offers permission repair, not unrelated pairing',()=>{
 for(const code of ['REMOTE_INTERNAL_APPROVAL_FAILED','REMOTE_INTERNAL_IDENTITY_UNVERIFIED']) {
  const label='核验并补齐权限后继续安装';
  assert.equal(bridgeActionLabel({state:'blocked',blockerCode:code}),label);
  assert.equal(ctx.bridgeActionLabel({jobStatus:'blocked',blockerCode:code}),label);
 }
 assert.equal(bridgeActionLabel({state:'blocked',blockerCode:'MAC_PAIRING_REQUIRED'}),'一键安装文件桥');
});
test('permission repair action resumes the existing backend task, never approves a device in UI',async()=>{
 const calls=[],batch=new BatchConnections({api:async(url)=>{calls.push(url);return url.endsWith('/resume')?{ok:true}:{id:'job',instanceId:'ins_a',status:'blocked',blockerCode:'REMOTE_INTERNAL_IDENTITY_UNVERIFIED'};}});
 const row=batch.add({instanceId:'ins_a',jobId:'job',registered:true,state:'blocked'});
 await batch.run({row,mode:'bridge',options:{allowSharedWorkspace:true}});
 assert.deepEqual(calls,['/api/connections/jobs/job/resume','/api/connections/jobs/job']);
 assert.equal(row.state,'blocked');
});
