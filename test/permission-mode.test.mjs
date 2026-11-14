// The composer's permission-mode picker must actually change the mode.
//
// The dropdown renders five options (Auto / Manual / Accept edits / Plan / Bypass) and
// picking one calls
//
//   setPermissionMode(sessionId, "plan")
//
// which was unhandled, so it answered null and the mode never changed: the dropdown
// closed and the button kept its old label. This matters beyond cosmetics — the
// tool-approval gate reads `session.permissionMode` when deciding whether to prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { VALID_MODES } = require('../desktop/permissions.cjs');

function makeBridge() {
  const handlers = new Map();
  const sent = [];
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
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c, p) => sent.push({ c, p }) } }),
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
  return { kernel, call, sent };
}

test('setPermissionMode changes the session record', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });

  const result = await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');
  assert.ok(result, 'a null answer makes the picker snap back');
  assert.equal(result.permissionMode, 'plan');
  assert.equal(kernel.getSession(s.sessionId).permissionMode, 'plan');
});

test('every mode the picker offers is accepted', async () => {
  // The UI's five options resolve to these four values plus "auto"/"default" handled
  // client-side; anything the gate understands must be storable.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  for (const mode of VALID_MODES) {
    const result = await call('LocalSessions', 'setPermissionMode', s.sessionId, mode);
    assert.ok(result, `${mode} must be accepted`);
    assert.equal(kernel.getSession(s.sessionId).permissionMode, mode);
  }
});

test('an unknown mode is refused, leaving the previous one intact', async () => {
  // The gate reads this value; an unrecognised string would make its behaviour
  // undefined, so it must not be stored.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');

  for (const bad of ['yolo', '', null, 42, {}]) {
    assert.equal(await call('LocalSessions', 'setPermissionMode', s.sessionId, bad), null);
  }
  assert.equal(kernel.getSession(s.sessionId).permissionMode, 'plan');
});

test('setPermissionMode on an unknown session answers null', async () => {
  const { call } = makeBridge();
  assert.equal(await call('LocalSessions', 'setPermissionMode', 'local_nope', 'plan'), null);
});

test('setPermissionMode notifies the renderer', async () => {
  const { kernel, call, sent } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  sent.length = 0;
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');

  const evt = sent.find((m) => m.c.endsWith('_$_LocalSessions_$_OnEvent')
    && m.p && m.p.type === 'session_updated'
    && m.p.sessionId === s.sessionId);
  assert.ok(evt, 'the session list must learn about the new mode');
});

test('getDefaultPermissionMode answers a valid mode string', async () => {
  const { call } = makeBridge();
  const mode = await call('LocalSessions', 'getDefaultPermissionMode');
  assert.equal(typeof mode, 'string');
  assert.ok(VALID_MODES.has(mode), `unexpected default mode ${mode}`);
});

test('changing the mode does not disturb the model or effort', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  await call('LocalSessions', 'setEffort', s.sessionId, 'high');
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');

  const record = kernel.getSession(s.sessionId);
  assert.equal(record.model, 'claude-opus-5-5');
  assert.equal(record.effortLevel, 'high');
  assert.equal(record.permissionMode, 'plan');
});

test('the mode persists across a reload', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'acceptEdits');
  kernel.flush();
  assert.equal(kernel.getSession(s.sessionId).permissionMode, 'acceptEdits');
});
