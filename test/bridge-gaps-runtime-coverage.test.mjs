'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { audit } = require('../tools/bridge-gaps.cjs');

test('runtime bridge coverage counts handlers, fallbacks and events exactly once', async () => {
  const r = await audit();
  assert.equal(r.total, r.methods.length);
  assert.equal(r.total, Object.values(r.counts).reduce((a, b) => a + b, 0));
  assert.ok(r.counts.handler > 245, 'loop-defined handlers were missed by the old scanner');
  assert.ok(r.counts.fallback < 930, 'dynamic and conditional handlers were still called fallback');
  assert.ok(r.counts.event > 100);
  assert.equal(r.userVisibleFallbacks.every(name => typeof name === 'string'), true);
});

test('CCDScheduledTasks is implemented when dataDir is configured; Cowork remains independent', async () => {
  const r = await audit();
  const entry = (service, method) =>
    r.methods.find(row => row.service === service && row.method === method)?.kind;
  for (const method of ['createScheduledTask', 'getAllScheduledTasks', 'updateScheduledTask', 'getWatcherHistory']) {
    assert.equal(entry('CCDScheduledTasks', method), 'handler', method);
    assert.equal(entry('CoworkScheduledTasks', method), 'fallback', method);
  }
  assert.equal(entry('ClaudeAiImport', 'startAuth'), 'fallback');
  assert.equal(entry('WindowControl', 'captureScreenshot'), 'handler');
});

test('event channels are not counted as missing action methods', async () => {
  const r = await audit();
  assert.equal(r.methods.find(x => x.service === 'CCDScheduledTasks' &&
    x.method === 'onOnScheduledTaskEvent')?.kind, 'event');
  assert.equal(r.methods.find(x => x.service === 'ClaudeAiImport' &&
    x.method === 'onOnAuthStateChange')?.kind, 'event');
});
