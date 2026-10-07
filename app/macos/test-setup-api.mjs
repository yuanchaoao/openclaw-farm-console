import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'setup api '));
process.env.OPENCLAW_CONFIG_FILE=join(directory,'config/local.json');
process.env.OPENCLAW_UI_DATA_DIR=join(directory,'data');
process.env.OPENCLAW_INSTANCES_FILE=join(directory,'instances.json');
process.env.OPENCLAW_FARM_SCRIPT=join(directory,'fake_farm.py');
process.env.OPENCLAW_INSTALLATION_ID='isolated-installation';
// Keep the configured startup port distinct from the wizard's new port.
process.env.OPENCLAW_UI_PORT='14318';
for(const name of ['OPENCLAW_RELAY_HOST','OPENCLAW_RELAY_USER','OPENCLAW_ORACLE_HOST','OPENCLAW_ORACLE_SECONDARY_HOST'])delete process.env[name];
await mkdir(join(directory,'config'));
await writeFile(process.env.OPENCLAW_CONFIG_FILE,JSON.stringify({node:'retain-node',python:'retain-python',environment:{RETAINED:'yes'}}));
await writeFile(process.env.OPENCLAW_FARM_SCRIPT,`import json,os,sys\nfrom pathlib import Path\na=sys.argv\nid=a[a.index('--instance-id')+1]\nassert '--token-stdin' in a\nassert 'mock-initial-token' not in ' '.join(a)\nassert sys.stdin.read().strip()=='mock-initial-token-1234567890'\nrow={'id':id,'name':id,'web_url':a[a.index('--url')+1],'status':'registered_unverified'}\nPath(os.environ['OPENCLAW_INSTANCES_FILE']).write_text(json.dumps({'instances':{id:row}}))\nprint(json.dumps({'instance':row}))\n`);
const {server}=await import('../console/server.mjs');
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
const settings={consolePort:14317,relay:{host:'relay.example.test',user:'operator',sshPort:22022,identityFile:join(directory,'relay-key'),portRange:[24100,24110]},bridge:{workspace:'/srv/openclaw/workspace',podPort:18082}};
const post=(url,body,origin)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
test.after(async()=>{await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});});
test('first-use API saves ordinary settings while registering initial token only through stdin',async()=>{
 assert.equal((await (await fetch(base+'/api/setup')).json()).configured,false);
 const response=await post('/api/setup',{config:settings,initialInstance:{url:'https://gateway.example.test/ins_initial/chat',token:'mock-initial-token-1234567890',name:'1',replace:true}});assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.config.relay.sshPort,22022);assert.equal(result.registration.name,'1');assert.equal(result.restartRequired,true);
 const config=await readFile(process.env.OPENCLAW_CONFIG_FILE,'utf8');assert.equal(config.includes('mock-initial-token'),false);assert.equal(JSON.parse(config).node,'retain-node');assert.equal(JSON.parse(config).environment.RETAINED,'yes');
 assert.equal((await (await fetch(base+'/api/local-status')).json()).installationId,'isolated-installation');
 for(const name of ['/setup.html','/setup.js','/setup.css'])assert.equal((await fetch(base+name)).status,200);
});
test('cross-origin setup writes are refused before mutation',async()=>{const before=await readFile(process.env.OPENCLAW_CONFIG_FILE,'utf8');assert.equal((await post('/api/setup',{config:settings},'https://untrusted.example')).status,500);assert.equal(await readFile(process.env.OPENCLAW_CONFIG_FILE,'utf8'),before);});

test('setup generates a dedicated key once and never overwrites the existing private key',{skip:process.platform==='win32' && spawnSync('ssh-keygen',['-V']).error?.code==='ENOENT'?'Windows OpenSSH optional feature is not installed':false},async()=>{
 const first=await post('/api/setup/ssh-key',{});assert.equal(first.status,200);const result=await first.json();assert.equal(result.created,true);assert.match(result.publicKey,/^ssh-ed25519 /);
 const before=await readFile(settings.relay.identityFile);const again=await post('/api/setup/ssh-key',{});assert.equal(again.status,200);assert.equal((await again.json()).created,false);assert.deepEqual(await readFile(settings.relay.identityFile),before);
 const authorization=await (await fetch(base+'/api/setup/relay-authorization')).json();assert.equal(authorization.publicKey,result.publicKey);assert.match(authorization.script,/permitopen/);assert.equal(authorization.script.includes('PRIVATE KEY'),false);
});

test('a key missing from the selected settings cannot mark setup complete',async()=>{
 const before=await readFile(process.env.OPENCLAW_CONFIG_FILE,'utf8');const changed={...settings,relay:{...settings.relay,identityFile:join(directory,'missing-key')}};
 const response=await post('/api/setup',{config:changed,complete:true});assert.equal(response.status,500);assert.equal(await readFile(process.env.OPENCLAW_CONFIG_FILE,'utf8'),before);assert.equal((await (await fetch(base+'/api/setup')).json()).configured,false);
});
