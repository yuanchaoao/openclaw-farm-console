import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPrompt,allApprovalPrompts} from '../console/public/batch-approval-prompt.js';
const id='12345678-1234-1234-1234-123456789abc';
const row={instanceId:'ins_one',url:'https://example.test/ins_one/chat?token=secret',token:'never-copy-this',approval:{stage:'pairing_required',requestId:id,checkedAt:Date.now()}};
test('copy includes exact instance and request, never token or URL query',()=>{const p=approvalPrompt(row);assert.ok(p.includes(`openclaw devices approve ${id}`));assert.ok(p.includes('ins_one'));assert.ok(!p.includes('secret'));assert.ok(!p.includes(row.token));});
test('all copy groups pending instances and skips healthy ones',()=>{const p=allApprovalPrompts([row,{...row,approval:null},{...row,instanceId:'ins_two',url:'https://example.test/ins_two/chat'}]);assert.equal((p.match(/openclaw devices approve/g)||[]).length,2);assert.ok(p.includes('ins_two'));});
test('mismatched instances and automatic execution approvals cannot produce manual commands',()=>{assert.equal(approvalPrompt({...row,instanceId:'ins_other'}),'');assert.equal(approvalPrompt({...row,approval:{stage:'exec_approval_required',requestId:id}}),'');});
test('missing request identifier does not fabricate an approval command',()=>{assert.ok(!approvalPrompt({...row,approval:{stage:'pairing_required',requestId:'bad'}}).includes('devices approve'));});
