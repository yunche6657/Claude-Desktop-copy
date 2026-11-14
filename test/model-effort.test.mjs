// The composer's model and effort pickers must actually change the session.
//
//   setModel(sessionId, "claude-opus-5-5")
//   setEffort(sessionId, "high")
//
// Both were unhandled, so the bridge answered null: the picker closed, the session
// record kept its old value, and the button snapped back to the previous label. The
// trace shows the call IS made, which is why it looked like a UI bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const sent = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const capabilities = require('../desktop/model-capabilities.cjs');
  capabilities.currentCapabilityProfile = () => ({ inferenceModelCapabilities: Object.fromEntries(['claude-opus-5-5', 'claude-sonnet-4-5', process.env.CLAUDE_AGENT_MODEL, 'deepseek-v4.1-flash'].filter(Boolean).map(model => [model, { supportedEfforts: ['low', 'medium', 'high'] }])) });
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

test('setModel changes the session record', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  // The kernel seeds a default model; the point is that setModel replaces it.
  const before = kernel.getSession(s.sessionId).model;
  assert.notEqual(before, 'claude-opus-5-5');

  const result = await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  assert.ok(result, 'a null answer makes the picker snap back');
  assert.equal(result.model, 'claude-opus-5-5');
  assert.equal(kernel.getSession(s.sessionId).model, 'claude-opus-5-5');
});

test('setModel answers the updated session, which the UI reconciles against', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  const result = await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  assert.equal(result.sessionId, s.sessionId);
  assert.equal(typeof result.model, 'string');
});

test('setModel notifies the renderer', async () => {
  const { kernel, call, sent } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  sent.length = 0;
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');

  const evt = sent.find((m) => m.c.endsWith('_$_LocalSessions_$_OnEvent')
    && m.p && m.p.type === 'session_updated'
    && m.p.sessionId === s.sessionId);
  assert.ok(evt, 'the session list must learn about the new model');
});

test('setModel refuses an empty or non-string model', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');

  for (const bad of ['', null, undefined, 42, {}]) {
    const result = await call('LocalSessions', 'setModel', s.sessionId, bad);
    assert.equal(result, null, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(kernel.getSession(s.sessionId).model, 'claude-opus-5-5', 'the prior model must survive');
});

test('setModel on an unknown session answers null instead of throwing', async () => {
  const { call } = makeBridge();
  const result = await call('LocalSessions', 'setModel', 'local_nope', 'claude-opus-5-5');
  assert.equal(result, null);
});

test('setEffort changes the session record', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });

  const result = await call('LocalSessions', 'setEffort', s.sessionId, 'high');
  assert.ok(result);
  assert.equal(result.effortLevel, 'high');
  assert.equal(kernel.getSession(s.sessionId).effortLevel, 'high');
});

test('setEffort refuses an empty value', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  await call('LocalSessions', 'setEffort', s.sessionId, 'high');

  for (const bad of ['', null, 42]) {
    assert.equal(await call('LocalSessions', 'setEffort', s.sessionId, bad), null);
  }
  assert.equal(kernel.getSession(s.sessionId).effortLevel, 'high');
});

test('setModel and setEffort do not disturb each other', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  await call('LocalSessions', 'setEffort', s.sessionId, 'low');

  const record = kernel.getSession(s.sessionId);
  assert.equal(record.model, 'claude-opus-5-5');
  assert.equal(record.effortLevel, 'low');
});

test('the choice persists across a reload', async () => {
  // The picker reads the model from the session record, so losing it on reload would
  // make the button show the default again.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w', model: 'claude-sonnet-4-5' });
  await call('LocalSessions', 'setModel', s.sessionId, 'claude-opus-5-5');
  kernel.flush();

  assert.equal(kernel.getSession(s.sessionId).model, 'claude-opus-5-5');
});

test('getDefaultEffort answers a string', async () => {
  const { call } = makeBridge();
  const effort = await call('LocalSessions', 'getDefaultEffort');
  assert.equal(typeof effort, 'string');
  assert.ok(effort.length > 0);
});
