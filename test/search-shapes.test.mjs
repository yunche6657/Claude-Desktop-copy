// Tests for the generic fallback's empty-container shapes.
//
// emptyFor() decides what an unimplemented getter answers. A wrong container is
// not a harmless default: callers iterate, spread or index the result, and the
// wrong kind throws inside React and takes the whole route into the error boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');

// emptyFor is module-private; exercise it through the registered fallback by
// reading the same rules from the module source would be brittle, so import the
// behaviour via a tiny harness: register the bridge and call an unimplemented
// method of each shape.
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
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

test('searchSessions answers an iterable array, never an object', async () => {
  // It ends in "Sessions", so the generic rule answered {sessions: []}. The
  // consumer iterates the value directly:
  //   for (let t of l) { ... }
  // which threw "l is not iterable" and put the whole route into the error
  // boundary ("This page ran into a problem").
  //
  // This must be checked against the FALLBACK rule, not only against the explicit
  // handler: the fallback is what answers for any namespace or build variant that
  // has no dedicated implementation.
  const { call } = makeBridge();
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const answer = await call(service, 'searchSessions', 'zz', { limit: 10 });
    assert.ok(Array.isArray(answer), `${service}.searchSessions must answer an array`);
    assert.doesNotThrow(() => { for (const _ of answer) break; });
  }
});

test('the fallback shape for any *Sessions method is an iterable array when searched', async () => {
  // Reproduce the rule directly: a method named searchSessions must not receive
  // the {sessions, archived, pinned} container that the other *Sessions getters use.
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  registerBridgeServices({
    ipcMain,
    // A map that contains ONLY an unimplemented searchSessions, so the fallback
    // path is the one under test.
    bridgeMap: { 'claude.web': { SomeService: ['searchSessions', 'getSessionList'] } },
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system' },
    frontend: { root: process.cwd() },
  });
  const call = (method) => {
    // Match the exact method suffix; endsWith alone would also match a longer name.
    const channel = [...handlers.keys()].find((c) => c.endsWith(`_$_${method}`));
    // The registered handler is async, so the answer is a promise.
    return handlers.get(channel)({}, 'zz', { limit: 5 });
  };
  assert.ok(Array.isArray(await call('searchSessions')), 'fallback must answer an array for searchSessions');
  assert.equal(Array.isArray(await call('getSessionList')), false, 'getSessionList keeps its object shape');
});

test('searchSessions finds a session by its title', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'refactor the parser' });

  const hits = await call('LocalSessions', 'searchSessions', 'parser', { limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, s.sessionId);
  assert.match(hits[0].snippet, /parser/);
});

test('searchSessions finds a session by its transcript content', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.setTranscript(s.sessionId, [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'the quick brown fox jumps' }] },
    uuid: 'u1',
  }]);

  const hits = await call('LocalSessions', 'searchSessions', 'brown fox', { limit: 10 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /brown fox/);
});

test('a positive fractional result limit still returns at least one match', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'fractional search fixture' });
  const hits = await call('LocalSessions', 'searchSessions', 'fractional search', { limit: 0.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, s.sessionId);
});

test('searchSessions is case-insensitive', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'Fix The Parser' });

  const lower = await call('LocalSessions', 'searchSessions', 'the parser', { limit: 10 });
  assert.equal(lower.length, 1);
});

test('searchSessions ignores queries shorter than two characters', async () => {
  // The palette does not even issue the call below 2 chars; answering [] keeps the
  // contract obvious for a direct caller.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'abc' });
  assert.deepEqual(await call('LocalSessions', 'searchSessions', 'a', {}), []);
  assert.deepEqual(await call('LocalSessions', 'searchSessions', '', {}), []);
});

test('searchSessions honours the limit', async () => {
  const { kernel, call } = makeBridge();
  for (let i = 0; i < 5; i += 1) {
    const s = kernel.start({ cwd: 'C:\\work' });
    kernel.update(s.sessionId, { title: `match number ${i}` });
  }
  const hits = await call('LocalSessions', 'searchSessions', 'match', { limit: 2 });
  assert.equal(hits.length, 2);
});

test('every result carries sessionId and snippet', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'findme' });

  const [hit] = await call('LocalSessions', 'searchSessions', 'findme', { limit: 10 });
  assert.equal(typeof hit.sessionId, 'string');
  assert.equal(typeof hit.snippet, 'string');
  // The consumer looks the session up in a Map keyed by sessionId.
  assert.equal(kernel.getSession(hit.sessionId).sessionId, s.sessionId);
});

test('getSessionList keeps its {sessions, archived, pinned} object shape', async () => {
  // The counterpart to the searchSessions bug: this one genuinely is an object and
  // must not be turned into an array by the same rule.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.update(s.sessionId, { title: 'x' });

  const list = await call('LocalSessions', 'getSessionList');
  assert.equal(Array.isArray(list), false);
  assert.ok(Array.isArray(list.sessions));
});
