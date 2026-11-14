// Fast mode must be storable and readable.
//
// The composer renders a screen-reader status line ("Fast mode off") from the session
// record, and setFastMode arrives in TWO shapes for the same toggle — a boolean and the
// string "fast" (both observed in the live trace):
//
//   [trace] LocalSessions.setFastMode ["local_...",true]
//   [trace] LocalSessions.setFastMode ["local_...","fast"]
//
// The record had no fastMode field at all, so setFastMode answered null and the status
// always read "off". Note the honest scope: this build configures one model and has no
// alternative to switch to, so fastMode records the user's CHOICE; it does not swap
// models. No visible control exposes it in this frontend build (the only "Fast mode"
// text is an sr-only status), so this is plumbing, not a faked toggle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

test('a new session records fastMode as off', async () => {
  const { kernel } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  assert.equal(kernel.getSession(s.sessionId).fastMode, false);
});

test('setFastMode accepts a boolean', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });

  const on = await call('LocalSessions', 'setFastMode', s.sessionId, true);
  assert.ok(on, 'a null answer leaves the status line stuck on "off"');
  assert.equal(on.fastMode, true);
  assert.equal(kernel.getSession(s.sessionId).fastMode, true);

  const off = await call('LocalSessions', 'setFastMode', s.sessionId, false);
  assert.equal(off.fastMode, false);
});

test('setFastMode accepts the string "fast"', async () => {
  // The second shape observed in the trace; treating only booleans left it dead.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });

  const on = await call('LocalSessions', 'setFastMode', s.sessionId, 'fast');
  assert.ok(on);
  assert.equal(kernel.getSession(s.sessionId).fastMode, true);
});

test('the off spellings are honoured too', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setFastMode', s.sessionId, true);

  for (const off of [false, 'normal', 'off']) {
    assert.ok(await call('LocalSessions', 'setFastMode', s.sessionId, off), String(off));
    assert.equal(kernel.getSession(s.sessionId).fastMode, false, String(off));
    await call('LocalSessions', 'setFastMode', s.sessionId, true);
  }
});

test('an unrecognised value is refused and changes nothing', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setFastMode', s.sessionId, true);

  for (const bad of ['turbo', null, undefined, 42, {}]) {
    assert.equal(await call('LocalSessions', 'setFastMode', s.sessionId, bad), null, String(bad));
  }
  assert.equal(kernel.getSession(s.sessionId).fastMode, true, 'the prior value must survive');
});

test('setFastMode is declared only in LocalSessions', async () => {
  // bridge-map.json lists setFastMode under LocalSessions alone. Adding an agent-mode
  // handler would create a channel the preload never exposes, so the map is the
  // contract here.
  const map = require('../desktop/shim/bridge-map.json');
  assert.ok((map['claude.web'].LocalSessions || []).includes('setFastMode'));
  assert.equal((map['claude.web'].LocalAgentModeSessions || []).includes('setFastMode'), false);
});

test('setFastMode on an unknown session answers null', async () => {
  const { call } = makeBridge();
  assert.equal(await call('LocalSessions', 'setFastMode', 'local_nope', true), null);
});

test('fast mode does not disturb the model, effort or permission mode', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  await call('LocalSessions', 'setEffort', s.sessionId, 'high');
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');
  await call('LocalSessions', 'setFastMode', s.sessionId, true);

  const record = kernel.getSession(s.sessionId);
  assert.equal(record.model, 'claude-opus-5-5');
  assert.equal(record.effortLevel, 'high');
  assert.equal(record.permissionMode, 'plan');
  assert.equal(record.fastMode, true);
});

test('the choice persists across a reload', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setFastMode', s.sessionId, true);
  kernel.flush();
  assert.equal(kernel.getSession(s.sessionId).fastMode, true);
});
