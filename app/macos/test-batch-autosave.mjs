import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchAutosave} from '../console/public/batch-autosave.js';
import {savedRows} from '../console/public/batch-connection-core.js';
const row=()=>({id:'a',url:'https://example.test/ins_a/chat',token:'a'.repeat(30)});
test('valid input saves without health request; unchanged input does not rewrite',async()=>{const calls=[],a=new BatchAutosave({api:async(...v)=>{calls.push(v);return {instanceId:'ins_a'};}}),r=row();await a.save(r);await a.save(r);assert.equal(calls.length,1);assert.equal(calls[0][1].deferHealth,true);assert.equal(r.registered,true);assert.equal(r.credentialSave,'saved');assert.ok(!JSON.stringify(savedRows([r])).includes(r.token));});
test('edits made during saving are persisted in order',async()=>{let release;const tokens=[],a=new BatchAutosave({api:async(_,b)=>{tokens.push(b.token);if(tokens.length===1)await new Promise(r=>release=r);return {instanceId:'ins_a'};}}),r=row();const first=a.save(r);r.token='b'.repeat(30);const second=a.save(r);release();await Promise.all([first,second]);assert.deepEqual(tokens,['a'.repeat(30),'b'.repeat(30)]);});
test('failed save never says saved; invalid input never sends',async()=>{const a=new BatchAutosave({api:async()=>{throw Error('secret');}}),r=row();await assert.rejects(a.save(r),/自动保存失败/);assert.equal(r.credentialSave,'error');assert.equal(r.registered,undefined);await a.save({...r,url:''});});
