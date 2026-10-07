import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {oracleBridgeHealthProbeScript, oracleBridgeProbeStatus} from '../console/oracle-bridge-liveness.mjs';
import {pythonBin} from './portable-test-tools.mjs';

const token = 'fb_' + 'a'.repeat(64);

async function runProbe(port, credential = token) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-'], {stdio:['pipe','ignore','pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code, status:oracleBridgeProbeStatus(stderr)}));
    child.stdin.end(oracleBridgeHealthProbeScript(port, credential));
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Oracle-side probe accepts only an authenticated healthy bridge', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/health');
    assert.equal(request.headers['x-openclaw-token'], token);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ok:true}));
  }, async port => {
    assert.deepEqual(await runProbe(port), {code:0,status:'unknown'});
  });
});

test('absent listener is distinguished from a live but unhealthy listener', async () => {
  let formerPort;
  await withServer((_request, response) => {
    response.statusCode = 403;
    response.end('forbidden');
  }, async port => {
    formerPort = port;
    assert.deepEqual(await runProbe(port), {code:12,status:'unhealthy'});
  });
  assert.deepEqual(await runProbe(formerPort), {code:11,status:'absent'});
});

test('invalid probe input and unrelated SSH errors cannot be mistaken for absence', () => {
  assert.throws(() => oracleBridgeHealthProbeScript(80, token));
  assert.throws(() => oracleBridgeHealthProbeScript(20080, 'short'));
  assert.equal(oracleBridgeProbeStatus('Permission denied (publickey)'), 'unknown');
});
