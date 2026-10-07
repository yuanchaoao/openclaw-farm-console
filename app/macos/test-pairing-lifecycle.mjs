import test from 'node:test';
import assert from 'node:assert/strict';
import {pairingFresh,verifiedPairing} from '../console/public/pairing-lifecycle.js';
import {approvalPrompt} from '../console/public/batch-approval-prompt.js';
const a={stage:'pairing_required',requestId:'12345678-1234-1234-1234-123456789abc'};
test('cached or failed verification cannot be copied',()=>{const row={instanceId:'ins_a',url:'https://example.test/ins_a/chat',approval:a};assert.equal(approvalPrompt(row),'');row.approval={...a,checkedAt:0};assert.equal(approvalPrompt(row),'');});
test('copy expires conservatively at four minutes, future timestamp rejected',()=>{const p=verifiedPairing(a,1000000);assert.equal(pairingFresh(p,1239999),true);assert.equal(pairingFresh(p,1240000),false);assert.equal(pairingFresh(p,999999),false);});
test('verified request produces exact current ID, execution approval is not device pairing',()=>{const p=verifiedPairing(a);assert.ok(approvalPrompt({instanceId:'ins_a',url:'https://example.test/ins_a/chat',approval:p}).includes(a.requestId));assert.equal(pairingFresh({...p,stage:'exec_approval_required'}),false);});
test('backend check timestamp is not extended by frontend receipt time',()=>{
 const result=verifiedPairing({stage:'pairing_required',checkedAt:1000},100000);
 assert.equal(result.checkedAt,1000);assert.equal(pairingFresh(result,241001),false);
});
