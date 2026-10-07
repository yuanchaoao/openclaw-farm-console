import test from 'node:test';
import assert from 'node:assert/strict';
import { getPerformanceProfile } from '../console/performance-profile.mjs';

const GIB = 1024 ** 3;
const profile = (memoryGiB, parallelism) => getPerformanceProfile({totalMemoryBytes: memoryGiB * GIB, parallelism});

test('24 GiB / 15 processors supports many remote workflows while bounding local work', () => {
  const value = profile(24, 15);
  assert.equal(value.mode, 'speed');
  assert.ok(value.gatewayConcurrency >= 24 && value.gatewayConcurrency <= 32);
  assert.equal(value.sshConcurrency, 10);
  assert.equal(value.batchConcurrency, 100);
  assert.equal(value.maxBatchConcurrency, 100);
  assert.ok(value.batchConcurrency > value.gatewayConcurrency);
  assert.match(value.labels.explanation, /远端主 agent 会话/);
  assert.match(value.labels.limitation, /实际完成速度取决于远端负载和网络/);
});

test('low-memory and small-CPU machines receive smaller local and batch limits', () => {
  const large = profile(24, 15);
  const medium = profile(8, 4);
  const small = profile(2, 1);
  for (const key of ['gatewayConcurrency', 'sshConcurrency', 'batchConcurrency']) {
    assert.ok(small[key] >= 1 && small[key] < medium[key]);
    assert.ok(medium[key] < large[key]);
  }
});

test('high-end hardware remains bounded by process and relay capacities', () => {
  const value = profile(1024, 512);
  assert.equal(value.gatewayConcurrency, 32);
  assert.equal(value.sshConcurrency, 10);
  assert.equal(value.maxBatchConcurrency, 100);
  assert.ok(value.batchConcurrency <= value.relayPortCapacity);
  assert.equal(value.relayPortCapacity, 181);
});

test('invalid readings use finite conservative defaults and unsupported modes fail clearly', () => {
  for (const input of [NaN, Infinity, -1, 0, '24']) {
    const value = getPerformanceProfile({totalMemoryBytes: input, parallelism: input});
    assert.equal(value.totalMemoryGiB, 2);
    assert.equal(value.availableParallelism, 1);
    assert.equal(value.gatewayConcurrency, 2);
    assert.equal(value.sshConcurrency, 1);
    assert.equal(value.maxBatchConcurrency, 10);
  }
  assert.throws(() => getPerformanceProfile({mode: 'unlimited'}), /不支持的并发模式/);
});

test('defaults read the host without producing private paths or credentials', () => {
  const value = getPerformanceProfile();
  assert.ok(value.totalMemoryGiB > 0);
  assert.ok(Number.isInteger(value.availableParallelism));
  assert.ok(value.batchConcurrency >= 1 && value.batchConcurrency <= 100);
  assert.equal(JSON.stringify(value).includes('/Users/'), false);
});
