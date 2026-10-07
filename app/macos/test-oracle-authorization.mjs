import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOracleAuthorizationScript } from '../console/oracle-authorization.mjs';
import {pythonBin as python} from './portable-test-tools.mjs';

const linuxRelayOnly = {skip:process.platform==='win32'?'Generated authorization runs on the Linux relay with fcntl':false};
const key = `ssh-ed25519 ${'A'.repeat(68)} openclaw-tunnel`;
const other = `ssh-ed25519 ${'B'.repeat(68)} other-computer`;
const script = (publicKey = key, port = 20080) => buildOracleAuthorizationScript({publicKey, port});
const run = (path, value = script()) => JSON.parse(execFileSync(python, ['-', path], {input:value, encoding:'utf8'}));

test('Oracle authorization preserves unrelated lines, uses real newlines, and privately backs up exact bytes', linuxRelayOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle authorization '));
  const path = join(directory, '.ssh', 'authorized_keys');
  const original = `# trusted keys\n${other}\n\n# example: ${key}\nrestrict,permitlisten="localhost:19900" ${key}\n`;
  try {
    await mkdir(join(directory, '.ssh'));
    await writeFile(path, original, {mode:0o644});
    const result = run(path);
    assert.equal(result.ok, true);
    assert.equal(result.backupCreated, true);
    const updated = await readFile(path, 'utf8');
    assert.equal(updated, `# trusted keys\n${other}\n\n# example: ${key}\nrestrict,port-forwarding,permitlisten="localhost:20080" ${key}\n`);
    assert.equal(updated.includes('\\n'), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const backups = (await readdir(join(directory, '.ssh'))).filter(name => name.startsWith('authorized_keys.openclaw-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(directory, '.ssh', backups[0]), 'utf8'), original);
    assert.equal((await stat(join(directory, '.ssh', backups[0]))).mode & 0o777, 0o600);
    assert.equal(run(path).changed, false);
    assert.equal((await readdir(join(directory, '.ssh'))).filter(name => name.startsWith('authorized_keys.openclaw-backup-')).length, 1);
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('Oracle authorization can create the first file and safely separate a key without a final newline', linuxRelayOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle authorization '));
  const path = join(directory, '.ssh', 'authorized_keys');
  try {
    assert.equal(run(path).backupCreated, false);
    assert.equal((await stat(join(directory, '.ssh'))).mode & 0o777, 0o700);
    await writeFile(path, other);
    run(path);
    assert.equal(await readFile(path, 'utf8'), `${other}\nrestrict,port-forwarding,permitlisten="localhost:20080" ${key}\n`);
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('parallel Oracle authorizations do not lose keys from another instance', linuxRelayOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle authorization '));
  const path = join(directory, '.ssh', 'authorized_keys');
  const execute = promisify(execFile);
  try {
    const values = [script(key, 20080), script(other, 20079)];
    const fixturePaths = [];
    for (const [index, value] of values.entries()) {
      const fixture = join(directory, `script-${index}.py`);
      await writeFile(fixture, value);
      fixturePaths.push(fixture);
    }
    await Promise.all(fixturePaths.map(fixture => execute(python, [fixture, path])));
    const updated = await readFile(path, 'utf8');
    assert.equal(updated.split('\n').filter(line => line.includes('ssh-ed25519')).length, 2);
    assert.ok(updated.includes(`permitlisten="localhost:20080" ${key}`));
    assert.ok(updated.includes(`permitlisten="localhost:20079" ${other}`));
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('invalid relay authorization inputs are rejected before script generation',()=>{
  assert.throws(() => script(key + '\necho nope'), /SSH 公钥/);
  assert.throws(() => script(key, 22), /端口/);
  assert.throws(()=>buildOracleAuthorizationScript({publicKey:key,port:24000,portRange:[24000,24256],client:true}),/端口范围/);
  const wide=buildOracleAuthorizationScript({publicKey:key,port:24000,portRange:[24000,24255],client:true});
  const options=JSON.parse(wide.match(/^OPTIONS = (.+)$/m)[1]);assert.ok(Buffer.byteLength(options+' '+key)<8192);
});

test('a symlink cannot overwrite an unrelated file',linuxRelayOnly,async()=>{
  const directory = await mkdtemp(join(tmpdir(), 'oracle authorization '));
  try {
    const target = join(directory, 'keep');
    const path = join(directory, 'authorized_keys');
    await writeFile(target, 'keep this');
    await symlink(target, path);
    assert.throws(() => run(path));
    assert.equal(await readFile(target, 'utf8'), 'keep this');
  } finally { await rm(directory, {recursive:true, force:true}); }
});
