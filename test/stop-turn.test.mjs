// Stop must cancel a running turn.
//
// `stop` had no handler, so pressing the stop button answered null and the turn kept
// running — the only way to end a long response was to wait it out. The kernel already
// implements cancellation through an AbortController; only the bridge was missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

/** An agent whose run blocks until aborted, so stop has something to cancel. */
function slowAgent() {
  return {
    model: 'stub',
    tools: [],
    run({ signal }) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ text: 'finished', stopReason: 'end_turn' }), 30000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ text: '', stopReason: 'aborted' });
        }, { once: true });
      });
    },
  };
}

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => slowAgent(),
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

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('stop cancels the running turn', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'do something long');
  await settle();
  assert.equal(kernel.getSession(s.sessionId).isRunning, true, 'the turn must be running first');

  const result = await call('LocalSessions', 'stop', s.sessionId);
  assert.ok(result, 'a null answer means the stop button does nothing');
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);

  await turn;
  await settle();
  assert.equal(kernel.getSession(s.sessionId).isRunning, false, 'the turn must have ended');
});

test('stop is available in both session namespaces', async () => {
  // The composer may use either transport depending on the surface.
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const turn = kernel.sendMessage(s.sessionId, 'long task');
    await settle();
    const result = await call(service, 'stop', s.sessionId);
    assert.equal(result.cancelled, true, `${service}.stop must cancel`);
    await turn;
    await settle();
  }
});

test('stopping when nothing runs reports cancelled:false, not an error', async () => {
  // The UI can press stop after the turn already finished; that must not surface as a
  // failure.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  const result = await call('LocalSessions', 'stop', s.sessionId);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
});

test('stop on an unknown session does not throw', async () => {
  const { call } = makeBridge();
  const result = await call('LocalSessions', 'stop', 'local_nope');
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
});

test('stop refuses an empty session id', async () => {
  const { call } = makeBridge();
  for (const bad of ['', null, undefined, 42]) {
    const result = await call('LocalSessions', 'stop', bad);
    assert.equal(result.ok, false);
  }
});

test('a cancelled turn leaves the session reusable', async () => {
  // Cancelling must clear isRunning, or every later send is refused as "already
  // running".
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'long task');
  await settle();
  await call('LocalSessions', 'stop', s.sessionId);
  await turn;
  await settle();

  const record = kernel.getSession(s.sessionId);
  assert.equal(record.isRunning, false);
});
