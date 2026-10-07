import test from 'node:test';
import assert from 'node:assert/strict';
import {sendMaintenanceRequest} from '../console/maintenance-send.mjs';

const instanceId='ins_demo';
const uuid='11111111-2222-3333-4444-555555555555';
const sessionKey=`agent:main:openclaw-control-ui:filebridge-demo-${uuid}`;
const idempotencyKey='bridge-install-ins_demo-'+'a'.repeat(32);
const token='fb_'+'a'.repeat(64);
const message=`set -eu\nT='${token}'\necho READY`;
const defaults={instanceId,sessionKey,idempotencyKey,message,sleep:async()=>{}};
const send=extra=>sendMaintenanceRequest({...defaults,...extra});

test('accepts only official acknowledgements bound to this idempotency key',async()=>{
  for(const status of ['started','in_flight','ok']) {
    const result=await send({call:async(method,params)=>{
      assert.equal(method,'chat.send');
      assert.equal(params.sessionKey,sessionKey);
      assert.equal(params.idempotencyKey,idempotencyKey);
      assert.equal(params.timeoutMs,120000);
      assert.equal(params.deliver,false);
      return {runId:idempotencyKey,status};
    }});
    assert.deepEqual(result,{runId:idempotencyKey,status});
  }
});

test('retries transient send failures at most three times using identical task and session',async()=>{
  const requests=[],delays=[],progress=[];
  const result=await send({sleep:async ms=>delays.push(ms),onProgress:text=>progress.push(text),call:async(method,params)=>{
    requests.push({method,params});
    if(requests.length===1)throw new Error('MCP/Gateway 响应超时，请稍后重试。');
    if(requests.length===2)throw new Error('ECONNRESET');
    return {runId:idempotencyKey,status:'in_flight'};
  }});
  assert.equal(result.status,'in_flight');
  assert.equal(requests.length,3);
  assert.equal(requests[0].params,requests[1].params);
  assert.equal(requests[1].params,requests[2].params);
  assert.deepEqual(delays,[1000,2000]);
  assert.ok(progress.every(text=>!text.includes(token)));
});

test('timeout output and empty or unrelated objects never become a successful send',async()=>{
  for(const response of [
    {output:'Gateway timeout'}, 'Gateway timeout', {output:''}, {}, {ok:true},
    {runId:uuid,status:'started'}, {runId:idempotencyKey,status:'failed'},
    {runId:idempotencyKey,status:'started',error:'permission denied'},
  ]) {
    let calls=0;
    await assert.rejects(send({call:async()=>{calls++;return response;}}),error=>{
      assert.match(error.code,/^MAINTENANCE_SEND_/);
      return true;
    });
    assert.equal(calls,/timeout/.test(JSON.stringify(response))?3:1);
  }
});

test('token, authentication and permission failures never retry despite a UUID or timeout word',async()=>{
  for(const problem of ['token_mismatch','token_expired','unauthorized','permission denied','missing scope operator.write','send blocked by session policy']) {
    let calls=0;
    await assert.rejects(send({call:async()=>{
      calls++;
      throw new Error(`${problem}, requestId: ${uuid}; timeout details ${token}; ${message}`);
    }}),error=>{
      assert.ok(['MAINTENANCE_SEND_TOKEN','MAINTENANCE_SEND_AUTH','MAINTENANCE_SEND_PERMISSION'].includes(error.code));
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes(message));
      return true;
    });
    assert.equal(calls,1);
  }
});

test('only explicit pairing failures with a complete labelled request ID return approval state',async()=>{
  for(const problem of [
    {code:'PAIRING_REQUIRED',requestId:uuid},
    new Error(JSON.stringify({code:'PAIRING_REQUIRED',requestId:uuid,message:'pairing required'})),
    new Error(`scope upgrade pending approval (requestId: ${uuid})`),
  ]) {
    let calls=0;
    const result=await send({call:async()=>{calls++;throw problem;}});
    assert.deepEqual(result,{stage:'approval_required',requestId:uuid});
    assert.equal(calls,1);
  }
  for(const problem of [`Gateway failed with run ${uuid}`,`pairing required; unrelated run ${uuid}`,'pairing required requestId: 12345678']) {
    let calls=0;
    await assert.rejects(send({call:async()=>{calls++;throw new Error(problem);}}));
    assert.equal(calls,1);
  }
});

test('terminal network failure stays failed and does not leak prompt, Token or raw error output',async()=>{
  let calls=0;const progress=[];
  await assert.rejects(send({onProgress:text=>progress.push(text),call:async()=>{
    calls++;throw new Error(`Gateway timeout for ${token}; command: ${message}`);
  }}),error=>{
    assert.equal(error.code,'MAINTENANCE_SEND_TRANSIENT');
    assert.equal(error.attempts,3);
    assert.match(error.message,/尝试发送 3 次/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls,3);
  assert.ok(progress.every(text=>!text.includes(token)));
});

test('invalid session binding never sends a request',async()=>{
  await assert.rejects(send({sessionKey:sessionKey.replace('filebridge-demo-','filebridge-other-'),call:async()=>assert.fail('must not call Gateway')}),error=>error.code==='MAINTENANCE_SEND_INVALID_REQUEST');
});
