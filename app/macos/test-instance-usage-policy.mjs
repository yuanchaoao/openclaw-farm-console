import assert from 'node:assert/strict';
import {isBatchEligibleInstance,requireInstanceAuthorization} from '../console/instance-usage-policy.mjs';
import {isBatchEligibleName} from '../console/public/batch-connection-core.js';

for (const name of ['1','40','50',' 60 ']) {
  assert.equal(isBatchEligibleInstance({name}),true,name);
  assert.equal(isBatchEligibleName(name),true,name);
}
for (const name of ['刀刀曼语','兔八哥','23号','ins_dze326b7n','', '1a']) {
  assert.equal(isBatchEligibleInstance({name}),false,name);
  assert.equal(isBatchEligibleName(name),false,name);
  assert.throws(()=>requireInstanceAuthorization({id:'ins_example',name}),error=>error.code==='NAMED_INSTANCE_AUTHORIZATION_REQUIRED');
  assert.equal(requireInstanceAuthorization({id:'ins_example',name},{allowNamedInstance:true}).name,name);
}
assert.equal(requireInstanceAuthorization({id:'ins_example',name:'7'}).name,'7');

const batchUi=await (await import('node:fs/promises')).readFile(new URL('../console/public/batch-connections.js',import.meta.url),'utf8');
assert.match(batchUi,/filter\(row=>row\.registered && isBatchEligibleName\(row\.name\)/);
assert.match(batchUi,/row\.selected=el\('batchAll'\)\.checked && isBatchEligibleName\(row\.name\)/);
const singleUi=await (await import('node:fs/promises')).readFile(new URL('../console/public/connections.js',import.meta.url),'utf8');
const html=await (await import('node:fs/promises')).readFile(new URL('../console/public/connections.html',import.meta.url),'utf8');
assert.match(singleUi,/allowNamedInstance:true/);
assert.match(singleUi,/allowInternalPermissionRepair=true/);
assert.match(html,/id="allowNamedInstance" type="checkbox"/);
assert.match(html,/id="allowInternalPermissionRepair" type="checkbox"/);
assert.match(html,/id="restartBridgeButton"/);
assert.match(singleUi,/forceNewAttempt/);
const server=await (await import('node:fs/promises')).readFile(new URL('../console/server.mjs',import.meta.url),'utf8');
assert.match(server,/body\.allowNamedInstance===true && body\.allowInternalPermissionRepair===true/);
assert.match(server,/主动从未完成步骤继续安装/);
assert.match(server,/chat\.abort/);
assert.match(server,/远端旧运行未确认终止/);

console.log('instance usage policy tests passed');
