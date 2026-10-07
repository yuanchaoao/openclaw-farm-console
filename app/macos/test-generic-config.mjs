import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeSetup,persistSetup,staticFilePath,userDataRoot,requireRelayConfig} from '../console/local-config.mjs';
import {configureBridgeCommand} from '../console/remote-settings.mjs';
import {buildClientAuthorizationScript} from '../console/relay-setup.mjs';
import {execFileSync} from 'node:child_process';
import {pythonBin} from './portable-test-tools.mjs';

const settings=()=>normalizeSetup({consolePort:14317,relay:{host:'relay.example.test',user:'operator',sshPort:22022,identityFile:path.join(tmpdir(),'testkey'),portRange:[24100,24110]},bridge:{workspace:'/srv/openclaw/workspace',podPort:18082}},{});
test('generic settings require no personal relay and respect custom transport ports',()=>{
 const blank=normalizeSetup({},{});assert.equal(blank.relay.host,'');assert.equal(blank.relay.user,'');assert.equal(blank.relay.sshPort,22);assert.deepEqual(blank.relay.portRange,[19900,20080]);
 const config=settings();assert.equal(config.relay.sshPort,22022);assert.equal(config.bridge.podPort,18082);
 for(const invalid of [0,65536,'text'])assert.throws(()=>normalizeSetup({relay:{sshPort:invalid}},{}),/SSH 端口/);
 assert.throws(()=>normalizeSetup({relay:{host:'-oProxyCommand=unsafe'}},{}),/主机/);
 assert.throws(()=>normalizeSetup({relay:{user:'-operator'}},{}),/用户名/);
 assert.throws(()=>requireRelayConfig(normalizeSetup({relay:{host:'relay.example.test'}},{})),{code:'RELAY_SETUP_REQUIRED'});
 assert.throws(()=>normalizeSetup({relay:{portRange:[24000,24256]}},{}),/最多 256/);
 assert.throws(()=>normalizeSetup({bridge:{workspace:'/srv/../other'}},{}),/工作区/);
});
test('config persistence reads latest runtime paths and excludes supplied credentials',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'openclaw generic config ')),file=path.join(dir,'config/local.json');
 try{await mkdir(path.dirname(file));await writeFile(file,JSON.stringify({node:'runtime-new/node',python:'runtime-new/python',environment:{RETAINED:'yes'}}));
 const input={...settings(),token:'should-not-be-saved',initialInstance:{token:'also-not-saved'}};
 await persistSetup(normalizeSetup(input,{}),file);
 const raw=await readFile(file,'utf8'),saved=JSON.parse(raw);assert.equal(saved.node,'runtime-new/node');assert.equal(saved.python,'runtime-new/python');assert.equal(saved.environment.RETAINED,'yes');assert.equal(saved.environment.OPENCLAW_RELAY_SSH_PORT,'22022');assert.equal(saved.environment.OPENCLAW_BRIDGE_POD_PORT,'18082');assert.equal(raw.includes('should-not-be-saved'),false);assert.equal(raw.includes('also-not-saved'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('static path containment works with Windows and POSIX separators',()=>{
 assert.equal(staticFilePath('C:\\release\\public','/setup.html',path.win32),'C:\\release\\public\\setup.html');
 for(const request of ['/../private','/..%5cprivate','/%2e%2e/private'])assert.equal(staticFilePath('C:\\release\\public',request,path.win32),null);
 assert.equal(staticFilePath('/release/public','/setup.html',path.posix),'/release/public/setup.html');assert.equal(staticFilePath('/release/public','/%2e%2e/private',path.posix),null);
 assert.equal(userDataRoot({LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local'},'win32','C:\\Users\\tester'),'C:\\Users\\tester\\AppData\\Local\\OpenClaw Farm Console');
 assert.equal(userDataRoot({},'darwin','/Users/tester'),'/Users/tester/Library/Application Support/OpenClaw Farm Console');
});
test('configured Linux commands retain explicit listening ports and workspaces',()=>{
 const command=configureBridgeCommand('D=\'/home/node/.openclaw/workspace/.openclaw-file-bridge\'\nnohup python3 "$D/server.py" --root /home/node/.openclaw/workspace\ncurl http://127.0.0.1:18081/health',{workspace:'/srv/openclaw/workspace',podPort:18082});
 assert.match(command,/--port 18082 --root \/srv\/openclaw\/workspace/);assert.match(command,/127\.0\.0\.1:18082\/health/);assert.equal(command.includes('/home/node/'),false);
 for(const workspace of ['/home','/home/node','/home/node/.openclaw/workspace2','/home/node/.openclaw/workspace/nested','/srv/workspace']) {
 const options={workspace,podPort:18082},initial=configureBridgeCommand('D=\'/home/node/.openclaw/workspace/.openclaw-file-bridge\'\nnohup python3 "$D/server.py" --root /home/node/.openclaw/workspace',options);
 assert.equal(configureBridgeCommand(initial,options),initial);assert.equal(initial.match(/--port /g).length,1);
 assert.ok(initial.includes(`--root ${workspace}\n`) || initial.endsWith(`--root ${workspace}`));
 }
});
test('generated client authorization preserves unrelated keys and limits loopback destinations',{skip:process.platform==='win32'?'Relay authorization executes on Linux with fcntl':false},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'relay generic authorization ')),file=path.join(dir,'authorized_keys');
 try{const key='ssh-ed25519 '+'A'.repeat(68)+' runtime-key';await writeFile(file,'# retained\nssh-ed25519 '+'B'.repeat(68)+' retained-key\n');
 const output=execFileSync(pythonBin,['-',file],{input:buildClientAuthorizationScript(key,[24100,24102]),encoding:'utf8'});assert.equal(JSON.parse(output).ok,true);
 const result=await readFile(file,'utf8');assert.match(result,/retained-key/);assert.match(result,/permitopen="localhost:24100"/);assert.match(result,/permitopen="localhost:24102"/);assert.match(result,/permitlisten="localhost:0"/);assert.equal(result.includes('permitopen="localhost:24103"'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
