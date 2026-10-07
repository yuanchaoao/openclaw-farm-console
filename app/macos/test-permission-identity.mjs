import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {extractPermissionIdentity} from '../console/permission-identity.mjs';
const {publicKey}=generateKeyPairSync('ed25519');
const publicKeyPem=publicKey.export({type:'spki',format:'pem'});
const raw=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url');
const identity={version:1,publicKeyPem,deviceId:createHash('sha256').update(raw).digest('hex'),privateKeyPem:'DO_NOT_RETURN_PRIVATE'};
const options={instanceId:'ins_example',sessionKey:'agent:main:openclaw-control-ui:identity-example-123',checkedAt:1000};
function history() {
 const h={sessionKey:options.sessionKey,instanceId:options.instanceId,messages:[{role:'user',content:'Read identity evidence'}]};
 for(const [i,[path,text]] of Object.entries([['/proc/self/status','Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n'],['/etc/passwd','root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n'],['/home/node/.openclaw/identity/device.json',JSON.stringify(identity)]])) {
 h.messages.push({role:'assistant',content:[{type:'toolCall',id:i,name:'read',arguments:JSON.stringify({path})}]},{role:'toolResult',toolCallId:i,toolName:'read',content:[{type:'text',text}]});
 }return h;
}
test('matched read results verify SDK-compatible raw Ed25519 fingerprint without returning secret',()=>{const r=extractPermissionIdentity(history(),options);assert.equal(r.ok,true);assert.equal(r.publicKey,raw.toString('base64url'));assert.equal(r.deviceId,identity.deviceId);assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!('privateKeyPem' in r));});
test('assistant summaries cannot substitute tool evidence',()=>{const h=history();h.messages=h.messages.map(m=>m.role==='toolResult'?{...m,role:'assistant'}:m);assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('mismatched tool IDs rejected',()=>{const h=history();h.messages[2].toolCallId='other';assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('wrong session or instance rejected',()=>{for(const field of ['sessionKey','instanceId']){const h=history();h[field]='other';assert.equal(extractPermissionIdentity(h,options).ok,false);}});
test('stale prior turn not accepted',()=>{const h=history();h.messages.push({role:'user',content:'New evidence please'});assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('wrong identity fingerprint rejected',()=>{const h=history();h.messages[6].content[0].text=JSON.stringify({...identity,deviceId:'0'.repeat(64)});assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('wrong UID or home rejected',()=>{const h=history();h.messages[4].content[0].text='node:x:1001:1000::/home/node:/bin/bash';assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('details text and object arguments supported',()=>{const h=history();h.messages[1].content[0].arguments={path:'/proc/self/status'};const m=h.messages[2];m.details={text:m.content[0].text};delete m.content;assert.equal(extractPermissionIdentity(h,options).ok,true);});
test('tool error and duplicate result fail closed',()=>{const h=history();h.messages[2].isError=true;assert.equal(extractPermissionIdentity(h,options).ok,false);const h2=history();h2.messages.push(h2.messages[2]);assert.equal(extractPermissionIdentity(h2,options).ok,false);});

test('actual remote read file argument is accepted and still binds tool result IDs',()=>{const h=history();for(const m of h.messages)for(const p of m.content||[]){if(p.type==='toolCall')p.arguments={file:JSON.parse(p.arguments).path};}assert.equal(extractPermissionIdentity(h,options).ok,true);h.messages[2].toolCallId='wrong';assert.equal(extractPermissionIdentity(h,options).ok,false);});
test('fresh identity request cannot consume an older successful read',()=>{const h=history();assert.equal(extractPermissionIdentity(h,{...options,expectedRequest:'new-request'}).ok,false);h.messages[0].content+=' new-request';assert.equal(extractPermissionIdentity(h,{...options,expectedRequest:'new-request'}).ok,true);});

test('exact read-only cat calls provide bound identity evidence without widening execution',()=>{
 for(const format of [p=>`cat ${p}`,p=>`cat -- ${p}`,p=>`cat '${p}'`,p=>`cat "${p}"`]) {
  const h=history();
  for(const m of h.messages) {
   for(const p of Array.isArray(m.content)?m.content:[])if(p.type==='toolCall'){p.name='exec';p.arguments={command:format(JSON.parse(p.arguments).path)};}
   if(m.role==='toolResult')m.toolName='exec';
  }
  assert.equal(extractPermissionIdentity(h,options).ok,true);
  h.messages[1].content[0].arguments.command+='; echo unsafe';
  assert.equal(extractPermissionIdentity(h,options).ok,false);
 }
});
