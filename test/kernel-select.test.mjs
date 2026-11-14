// Kernel selection: which backend runs a turn, and is the substitution announced?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KERNEL_IDS, selectKernel, probeCcb, probeLocal, normaliseProbe } = require('../desktop/kernel-select.cjs');

const ccbOk = { id: 'ccb', available: true };
const localOk = { id: 'local', available: true };

test('with both available and no preference, the richer kernel wins', () => {
  const choice = selectKernel({ probes: [ccbOk, localOk] });
  assert.equal(choice.id, KERNEL_IDS.CCB);
  assert.equal(choice.fellBack, false);
  assert.match(choice.reason, /selected by default/);
});

test('an unavailable CCB announces why it fell back instead of silently using local', () => {
  const choice = selectKernel({
    probes: [{ id: 'ccb', available: false, reason: 'bun runtime not found at X' }, localOk],
  });
  assert.equal(choice.id, KERNEL_IDS.LOCAL);
  assert.equal(choice.fellBack, true);
  assert.match(choice.reason, /ccb: bun runtime not found at X/);
});

test('an explicitly requested kernel that is available is used even over the default', () => {
  const choice = selectKernel({ requested: 'local', probes: [ccbOk, localOk] });
  assert.equal(choice.id, KERNEL_IDS.LOCAL);
  assert.equal(choice.fellBack, false);
  assert.match(choice.reason, /requested/);
});

test('requesting an unavailable kernel substitutes, and says so', () => {
  const choice = selectKernel({
    requested: 'ccb',
    probes: [{ id: 'ccb', available: false, reason: 'CCB_DISABLE=1' }, localOk],
  });
  assert.equal(choice.id, KERNEL_IDS.LOCAL);
  assert.equal(choice.fellBack, true);
  assert.equal(choice.requested, 'ccb');
  assert.match(choice.reason, /ccb requested but unavailable \(CCB_DISABLE=1\); using local/);
});

test('requesting something unknown does not pretend it worked', () => {
  const choice = selectKernel({ requested: 'gpt-kernel', probes: [ccbOk, localOk] });
  assert.equal(choice.id, KERNEL_IDS.LOCAL);
  assert.equal(choice.fellBack, true);
  assert.match(choice.reason, /not one of the known kernels/);
});

test('with nothing available the answer is an explicit null, never a guess', () => {
  const choice = selectKernel({ probes: [{ id: 'ccb', available: false, reason: 'gone' }, { id: 'local', available: false, reason: 'no agent runner configured' }] });
  assert.equal(choice.id, null);
  assert.match(choice.reason, /no kernel is available/);
  assert.match(choice.reason, /gone/);
  assert.match(choice.reason, /no agent runner configured/);
});

test('a probe node missing its reason still produces a readable explanation', () => {
  assert.equal(normaliseProbe('ccb', { available: false }).reason, 'unavailable');
  const choice = selectKernel({ probes: [{ id: 'ccb', available: false }, localOk] });
  assert.match(choice.reason, /unavailable/);
});

test('duplicate or malformed probes cannot change the decision', () => {
  const choice = selectKernel({ probes: [null, undefined, { available: true }, ccbOk, ccbOk, localOk] });
  assert.equal(choice.id, KERNEL_IDS.CCB);
  assert.equal(choice.probes.length, 2);
});

test('probeCcb reports the exact missing file rather than a generic failure', () => {
  const result = probeCcb({
    env: {},
    root: 'C:\\app',
    exists: () => false,
    path: require('node:path').win32,
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /bun runtime not found at C:\\app/);
  assert.match(result.reason, /kernel bundle not found/);
});

test('probeCcb is positive only when both files exist', () => {
  const path = require('node:path').win32;
  const onlyBun = probeCcb({ env: {}, root: 'C:\\app', exists: (file) => /bun\.exe$/.test(file), path });
  assert.equal(onlyBun.available, false);
  assert.match(onlyBun.reason, /kernel bundle not found/);

  const both = probeCcb({ env: {}, root: 'C:\\app', exists: () => true, path });
  assert.equal(both.available, true);
  assert.equal(both.reason, null);
  assert.match(both.entry, /cli-bun\.js$/);
});

test('an explicit CCB_DISABLE switch is honoured even when the files are there', () => {
  const result = probeCcb({ env: { CCB_DISABLE: '1' }, root: 'C:\\app', exists: () => true, path: require('node:path').win32 });
  assert.equal(result.available, false);
  assert.match(result.reason, /CCB_DISABLE=1/);
});

test('probeLocal says why it is unavailable instead of returning a bare false', () => {
  assert.equal(probeLocal({ hasAgent: false }).reason, 'no agent runner configured');
  assert.equal(probeLocal({ hasAgent: true }).available, true);
});

test('the real project layout resolves to the agent-core paths this repo ships', () => {
  const path = require('node:path');
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
  const result = probeCcb({ env: {}, root, exists: () => true, path });
  assert.match(result.bun, /agent-core[\\/]bun[\\/]bun\.exe$/);
  assert.match(result.entry, /agent-core[\\/]claude-code[\\/]dist[\\/]cli-bun\.js$/);
});
