// getSessionList must answer a real loadGeneration, not a hard-coded 0.
//
// The consumer (shared-8-7ijQhFwx.js) does:
//   let { sessions, loadGeneration, archivedPending } = await getSessionList();
//   let d = loadGeneration !== 0;
//   setState({ sessions, isInitialized: true, initialLoadTimedOut: false,
//              archivedRowsPending: qh(archivedPending),
//              ...(d ? { loadFailed: false } : {}) });
//   if (d) Hh = true;
//   zh = Wh === s ? loadGeneration : undefined;
//
// and the "initialized" event feeds `loadGeneration` into `Jh(e.loadGeneration ?? Infinity)`.
//
// So the field is a MONOTONIC VERSION and `!== 0` is the signal "this list came from a real
// load". Hard-coded 0 meant `d` was always false: the store could never clear `loadFailed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
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

test('the answer carries sessions, loadGeneration and archivedPending', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'getSessionList');
  assert.equal(typeof answer, 'object');
  assert.ok(Array.isArray(answer.sessions), 'sessions must be an array');
  assert.equal(typeof answer.loadGeneration, 'number');
  assert.equal(typeof answer.archivedPending, 'boolean');
});

test('loadGeneration is non-zero, so the consumer can clear loadFailed', async () => {
  // `d = loadGeneration !== 0` gates `{ loadFailed: false }`. A hard-coded 0 kept the failed
  // state forever.
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'getSessionList');
  assert.notEqual(answer.loadGeneration, 0, 'a zero generation never clears loadFailed');
  assert.equal(answer.loadGeneration !== 0, true, 'the consumer predicate must be true');
});

test('loadGeneration increases between calls', async () => {
  // It is a version, so two reads must be distinguishable.
  const { call } = makeBridge();
  const first = await call('LocalSessions', 'getSessionList');
  const second = await call('LocalSessions', 'getSessionList');
  assert.ok(second.loadGeneration > first.loadGeneration,
    `generation must advance: ${first.loadGeneration} -> ${second.loadGeneration}`);
});

test('loadGeneration is a finite integer', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'getSessionList');
  assert.ok(Number.isFinite(answer.loadGeneration));
  assert.equal(Number.isInteger(answer.loadGeneration), true);
});

test('sessions reflects the kernel contents', async () => {
  const { call } = makeBridge();
  const before = await call('LocalSessions', 'getSessionList');
  await call('LocalAgentModeSessions', 'start', { cwd: process.cwd() });
  const after = await call('LocalSessions', 'getSessionList');
  assert.equal(after.sessions.length, before.sessions.length + 1,
    'a started session must appear in the list');
});

test('the generation keeps advancing even when the list is unchanged', async () => {
  // The version tracks reads, not mutations: a second read of an unchanged list is still a
  // distinct load, and the consumer compares generations to decide whether to act.
  const { call } = makeBridge();
  const a = await call('LocalSessions', 'getSessionList');
  const b = await call('LocalSessions', 'getSessionList');
  assert.equal(a.sessions.length, b.sessions.length);
  assert.notEqual(a.loadGeneration, b.loadGeneration);
});

test('archivedPending is false, because no archived fetch is in flight', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'getSessionList');
  assert.equal(answer.archivedPending, false);
});
