// Tests for the bridge payload shapes whose contract is enforced by the shipped
// frontend at the call site.
//
// Each of these was a real defect: the method existed, answered something, and the
// renderer silently discarded the answer because one required field was missing.
// A wrong shape here does not throw — it degrades to null — so these tests exist to
// keep the fields the consumer actually reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A stub agent that answers a fixed reply. */
function stubAgent(reply = 'STUB') {
  return {
    model: 'stub-model',
    tools: [],
    async run({ onEvent }) {
      onEvent({ type: 'text', text: reply });
      return { text: reply, stopReason: 'end_turn' };
    },
  };
}

/** A minimal main-process stand-in so real handlers can be registered. */
function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => stubAgent(),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

test('getTranscriptTail answers {messages, hasMore}, never a bare array', async () => {
  // localTransport.fetchTranscriptTail does:
  //   const o = await r(e, t);
  //   if (!o || !Array.isArray(o.messages)) return null;
  // A bare array has no `.messages`, so the whole tail silently became null.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });

  const tail = await call('LocalSessions', 'getTranscriptTail', s.sessionId, 50);
  assert.equal(Array.isArray(tail), false, 'must be an object, not an array');
  assert.ok(Array.isArray(tail.messages), 'messages must be an array');
  assert.equal(typeof tail.hasMore, 'boolean');
});

test('getTranscriptTail honours the requested limit and reports hasMore', async () => {
  // The argument used to be ignored, so a long conversation could only ever page
  // two entries at a time.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  const entries = [];
  for (let i = 0; i < 10; i += 1) {
    entries.push({ type: i % 2 ? 'assistant' : 'user', message: { role: 'user', content: [] }, uuid: `u${i}` });
  }
  kernel.getTranscript(s.sessionId).push(...entries);

  const tail = await call('LocalSessions', 'getTranscriptTail', s.sessionId, 4);
  assert.equal(tail.messages.length, 4);
  assert.equal(tail.hasMore, true, 'six older entries remain');

  const all = await call('LocalSessions', 'getTranscriptTail', s.sessionId, 100);
  assert.equal(all.messages.length, 10);
  assert.equal(all.hasMore, false);
});

test('getTranscriptTail on an unknown session still answers the object shape', async () => {
  const { call } = makeBridge();
  const tail = await call('LocalSessions', 'getTranscriptTail', 'local_nope', 5);
  assert.ok(Array.isArray(tail.messages));
  assert.equal(tail.hasMore, false);
});

test('getContextUsage carries rawMaxTokens, which the transport requires', async () => {
  // The transport rejects the payload outright without this field:
  //   return !n || typeof n != "object" || !("rawMaxTokens" in n) ? null : n
  // The meter therefore rendered nothing at all before this field existed.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.getTranscript(s.sessionId).push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    uuid: 'u1',
  });

  const usage = await call('LocalSessions', 'getContextUsage', s.sessionId);
  assert.equal(typeof usage, 'object');
  assert.ok('rawMaxTokens' in usage, 'transport discards the payload without this');
  assert.ok(usage.rawMaxTokens > 0);
});

test('getContextUsage answers the fields the meter renders from', async () => {
  // ZX()/ua()/Kx() read categories[], totalTokens and percentage, treat a
  // "Free space"/kind:"free" entry as the remainder and a "Autocompact buffer"
  // (kind "buffer") entry as reserved headroom.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.getTranscript(s.sessionId).push(
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a'.repeat(800) }] }, uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] }, uuid: 'u2' },
  );

  const usage = await call('LocalSessions', 'getContextUsage', s.sessionId);
  assert.ok(Array.isArray(usage.categories), 'categories must be an array');
  assert.equal(typeof usage.totalTokens, 'number');
  assert.equal(typeof usage.percentage, 'number');
  assert.ok(usage.totalTokens > 0, 'a non-empty transcript must report usage');

  const free = usage.categories.find((c) => c.kind === 'free');
  assert.ok(free, 'a free-space entry lets the meter draw the remainder');
  // Every category is shaped for the renderer.
  for (const c of usage.categories) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.tokens, 'number');
  }
  // Used + free must account for the whole window.
  assert.equal(usage.totalTokens + free.tokens, usage.rawMaxTokens);
});

test('getContextUsage is null for an unknown session', async () => {
  const { call } = makeBridge();
  assert.equal(await call('LocalSessions', 'getContextUsage', 'local_nope'), null);
});
