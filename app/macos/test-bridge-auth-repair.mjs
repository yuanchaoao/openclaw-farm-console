import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildBridgeCredentialSync} from '../console/bridge-auth-repair.mjs';
import {pythonBin,assertShellSyntax,bashSyntaxSkip} from './portable-test-tools.mjs';
const token='fb_'+'0123456789abcdef'.repeat(4),tag='a'.repeat(32);
test('sync script preserves existing grants, backs up privately, and never redownloads the bridge',async t=>{
 const prompt=buildBridgeCredentialSync({token,taskTag:tag});
 await t.test('generated Linux credential sync shell syntax',{skip:bashSyntaxSkip},()=>assertShellSyntax(prompt.slice(prompt.indexOf('set -eu\n'))));
 assert.ok(!prompt.includes(token));assert.ok(!prompt.includes('r2.dev'));assert.ok(prompt.includes('/v1/capabilities'));assert.ok(prompt.includes('CREDENTIAL_READY'));
 const root=mkdtempSync(join(tmpdir(),'bridge sync test ')),path=join(root,'secrets.json');
 const old={tokens:[{token:'old-computer-'+'abcdefgh01234567'.repeat(3),scopes:['read','write','delete']}]};const raw=JSON.stringify(old);writeFileSync(path,raw,{mode:0o600});
 const generated=prompt.split("python3 - <<'PY'\n")[1].split('\nPY\n')[0].replace("Path('/home/node/.openclaw/workspace/.openclaw-file-bridge/secrets.json')",`Path(${JSON.stringify(path)})`);
 // The command runs on a Linux relay. Windows has no fchmod, so record its
 // exact requested modes while still exercising the complete JSON mutation.
 const script=process.platform==='win32'?'import os\nrequested_modes=[]\nos.fchmod=lambda fd,mode: requested_modes.append(mode)\n'+generated+'\nassert requested_modes == [0o600,0o600]\n':generated;
 try {
  for(let i=0;i<2;i++){const result=spawnSync(pythonBin,['-c',script],{env:{...process.env,OPENCLAW_BRIDGE_SYNC_TOKEN:token},encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
  const saved=JSON.parse(readFileSync(path));assert.deepEqual(saved.tokens[0],old.tokens[0]);assert.equal(saved.tokens.length,2);assert.deepEqual(saved.tokens[1].scopes.sort(),['delete','read','write']);
  const backups=readdirSync(root).filter(n=>n.startsWith('secrets.before-mac-sync-'));assert.equal(backups.length,2);assert.ok(backups.some(n=>readFileSync(join(root,n),'utf8')===raw));
  await t.test('Linux relay writes owner-only credentials and backups',{skip:process.platform==='win32'?'POSIX file modes are enforced on the Linux relay':false},()=>{
   assert.equal(statSync(path).mode&0o777,0o600);for(const name of backups)assert.equal(statSync(join(root,name)).mode&0o777,0o600);
  });
 }finally{rmSync(root,{recursive:true});}
});
test('invalid sync parameters never produce a command',()=>{
 assert.throws(()=>buildBridgeCredentialSync({token:'wrong',taskTag:tag}));assert.throws(()=>buildBridgeCredentialSync({token,taskTag:'other'}));
});
