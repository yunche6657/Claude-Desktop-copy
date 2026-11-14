import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

test('session kernel isolates last completed request from interrupted requests and other sessions', async () => {
  const listeners = new Set();
  let iteration = 0;
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sendMessage(id) {
      iteration++;
      const send = event => { for (const fn of listeners) fn({ type: 'raw', sessionId: id, frame: { type: 'stream_event', parent_tool_use_id: null, event } }); };
      send({ type: 'message_start', message: { id: 'msg' + iteration, model: 'fixture', usage: { input_tokens: iteration * 10, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });
      send({ type: 'message_delta', usage: { output_tokens: iteration } });
      if (iteration !== 2) send({ type: 'message_stop' });
      return { text: 'ok', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit() {} });
  const a = kernel.start({ cwd: process.cwd() });
  const b = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(a.sessionId, 'one');
  assert.equal(kernel.getContextUsage(a.sessionId).usage.input_tokens, 10);
  await kernel.sendMessage(a.sessionId, 'interrupted');
  assert.equal(kernel.getContextUsage(a.sessionId).usage.input_tokens, 10);
  await kernel.sendMessage(b.sessionId, 'three');
  assert.equal(kernel.getContextUsage(b.sessionId).usage.input_tokens, 30);
  assert.equal(kernel.getContextUsage(a.sessionId).usage.input_tokens, 10);
  kernel.dispose();
});

test('sending keeps the last completed input footprint until message_stop', async () => {
  const listeners = new Set();
  let iteration = 0, finish;
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sendMessage(sessionId) {
      iteration++;
      const send = event => { for (const fn of listeners) fn({ type: 'raw', sessionId, frame: { type: 'stream_event', event } }); };
      send({ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: iteration * 10, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });
      send({ type: 'message_delta', usage: { output_tokens: 500 } });
      if (iteration === 2) await new Promise(resolve => { finish = resolve; });
      send({ type: 'message_stop' });
      return { text: 'ok', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit() {} });
  try {
    const session = kernel.start({ cwd: process.cwd() });
    await kernel.sendMessage(session.sessionId, 'first');
    const pending = kernel.sendMessage(session.sessionId, 'second');
    // Drain admission microtasks without depending on a timer or model latency.
    for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
    assert.equal(typeof finish, 'function');
    assert.equal(kernel.getSession(session.sessionId).isRunning, true);
    assert.equal(kernel.getContextUsage(session.sessionId).usage.input_tokens, 10);
    finish();
    await pending;
    assert.equal(kernel.getContextUsage(session.sessionId).usage.input_tokens, 20);
  } finally { finish?.(); kernel.dispose(); }
});

test('capacity snapshots follow the request actor, not later profile changes', async () => {
  const listeners = new Set();
  let actor = 'a', contextWindow = 1000, bindingActor = 'a', changeDuring = false;
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getInfo() { return { actorToken: actor, contextCapacity: { actorToken: bindingActor, model: 'fixture', contextWindow, apiKey: 'secret' } }; },
    async sendMessage(id) {
      const send = event => { for (const fn of listeners) fn({ type: 'raw', sessionId: id, frame: { type: 'stream_event', event } }); };
      send({ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: 10 } } });
      if (changeDuring) { contextWindow = 2000; actor = 'b'; bindingActor = 'b'; }
      send({ type: 'message_delta', usage: { output_tokens: 1 } });
      send({ type: 'message_stop' });
      return { text: 'ok', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit() {} });
  const session = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(session.sessionId, 'first');
  assert.equal(kernel.getContextUsage(session.sessionId).contextWindow, 1000);
  assert.equal(JSON.stringify(kernel.getContextUsage(session.sessionId)).includes('secret'), false);
  changeDuring = true;
  await kernel.sendMessage(session.sessionId, 'stale actor');
  assert.equal(kernel.getContextUsage(session.sessionId).contextWindow, 1000);
  changeDuring = false;
  await kernel.sendMessage(session.sessionId, 'new actor');
  assert.equal(kernel.getContextUsage(session.sessionId).contextWindow, 2000);
  bindingActor = 'a';
  await kernel.sendMessage(session.sessionId, 'unbound');
  assert.equal(kernel.getContextUsage(session.sessionId).contextWindow, null);
  kernel.dispose();
});

test('new completed usage invalidates cached and in-flight SDK detail for the same actor', async () => {
  const listeners = new Set();
  let tokens = 10, calls = 0, resolveDetail = null, holdDetail = false;
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getInfo() { return { actorToken: 'same-actor' }; },
    getContextUsage(_id, actorToken) {
      calls++;
      const value = { actorToken, totalTokens: tokens };
      if (holdDetail) return new Promise(resolve => { resolveDetail = () => resolve(value); });
      return value;
    },
    async sendMessage(sessionId) {
      const send = event => { for (const fn of listeners) fn({ type: 'raw', sessionId, frame: { type: 'stream_event', event } }); };
      send({ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      send({ type: 'message_delta', usage: { output_tokens: 1 } });
      send({ type: 'message_stop' });
      return { text: 'ok', stopReason: 'end_turn' };
    },
  };
  const kernel = createSessionKernel({ backend, emit() {} });
  try {
    const session = kernel.start({ cwd: process.cwd() });
    await kernel.sendMessage(session.sessionId, 'first request');
    assert.equal((await kernel.getContextUsageDetail(session.sessionId)).totalTokens, 10);
    tokens = 20;
    await kernel.sendMessage(session.sessionId, 'new request');
    assert.equal((await kernel.getContextUsageDetail(session.sessionId)).totalTokens, 20);
    assert.equal(calls, 2);
    // A detail response measured before a later completed request must not win
    // the race just because the actor has not changed.
    tokens = 30;
    await kernel.sendMessage(session.sessionId, 'invalidate');
    holdDetail = true;
    const stale = kernel.getContextUsageDetail(session.sessionId);
    await Promise.resolve();
    assert.equal(calls, 3);
    tokens = 40;
    await kernel.sendMessage(session.sessionId, 'while detail is pending');
    resolveDetail();
    assert.equal(await stale, null);
    holdDetail = false;
    assert.equal((await kernel.getContextUsageDetail(session.sessionId)).totalTokens, 40);
    assert.equal(calls, 4);
  } finally { kernel.dispose(); }
});

test('SDK detail is on demand, actor scoped, deduplicated and failure throttled', async () => {
  let actor = null, calls = 0, resolve;
  const backend = {
    id: 'ccb', start() {}, cancel() {}, dispose() {}, async sendMessage() {}, onEvent() { return () => {}; },
    getInfo() { return { actorToken: actor }; },
    getContextUsage(id, token) { calls++; return new Promise(r => { resolve = () => r({ actorToken: token, totalTokens: calls }); }); },
  };
  const kernel = createSessionKernel({ backend, emit() {} });
  const s = kernel.start({ cwd: process.cwd() });
  assert.equal(await kernel.getContextUsageDetail(s.sessionId), null);
  assert.equal(calls, 0);
  actor = 'a';
  const first = kernel.getContextUsageDetail(s.sessionId);
  const second = kernel.getContextUsageDetail(s.sessionId);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve();
  assert.deepEqual(await first, await second);
  await kernel.getContextUsageDetail(s.sessionId);
  assert.equal(calls, 1);
  actor = 'b';
  const stale = kernel.getContextUsageDetail(s.sessionId);
  await Promise.resolve();
  actor = 'c';
  resolve();
  assert.equal(await stale, null);
  backend.getContextUsage = async () => { calls++; throw new Error('private'); };
  assert.equal(await kernel.getContextUsageDetail(s.sessionId), null);
  assert.equal(await kernel.getContextUsageDetail(s.sessionId), null);
  assert.equal(calls, 3);
  kernel.dispose();
});
