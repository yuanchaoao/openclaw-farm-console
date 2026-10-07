import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../console/public/connections.js',import.meta.url),'utf8');
const install=source.slice(source.indexOf('async function installBridge('),source.indexOf('\nasync function askCodex()'));
const finish=source.slice(source.indexOf('async function finishBridgeResult('),source.indexOf('\nasync function pollConnectionJob('));
function fixture(flow){
 const calls=[],state={selectedId:'ins_test',instances:[{id:'ins_test',name:'1',protectedName:false}],flows:{ins_test:flow},statuses:{}};
 const ctx=vm.createContext({state,$:()=>({checked:true,classList:{add(){}}}),canUseInstance:()=>true,bridgeAccessPayload:()=>({}),syncNamedInstanceProtection(){},setStep(){},setResult(){},setInstanceResult(){},saveConnectionMemory(){},showApproval(){},api:async path=>{calls.push(path);return {jobId:'fresh'};},pollConnectionJob:async id=>calls.push(id)});
 vm.runInContext(install+'\n'+finish,ctx);return {ctx,state,calls};
}
test('click with a stale pairing job creates a fresh installation check',async()=>{
 const {ctx,state,calls}=fixture({jobId:'old',jobStatus:'running',approval:{prompt:'old request'},approvalPurpose:'mcp'});
 await ctx.installBridge();assert.deepEqual(calls,['/api/connections/mcp/install-bridge','fresh']);assert.equal(state.flows.ins_test.approval,null);
});
test('approval result is terminal and cannot leave the job running',async()=>{
 const {ctx,state}=fixture({jobId:'old',jobStatus:'running'});
 assert.equal(await ctx.finishBridgeResult({stage:'pairing_required'}),false);
 assert.equal(state.flows.ins_test.jobId,'');assert.equal(state.flows.ins_test.jobStatus,'approval_required');
});
test('a genuinely running job is resumed, not installed twice',async()=>{
 const {ctx,calls}=fixture({jobId:'active',jobStatus:'running'});
 await ctx.installBridge();assert.deepEqual(calls,['/api/connections/jobs/active/resume','active']);
});
