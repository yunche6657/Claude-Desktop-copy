// Fork must produce a real, independent session.
//
// The caller builds the new id itself and expects the answer to carry `sessionId`:
//
//   let i = `local_${crypto.randomUUID()}`;
//   let a = await r(e.ref.id, i, e.forkAtMessageUuid, e.targetCwd);
//   hn(t, a.sessionId, {...})          // continues in a.sessionId
//
// A null answer made the row's "Fork" item do nothing at all — no new session, no
// error, no navigation.
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
  const sent = [];
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
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

/** Seed a session with a few transcript entries and return their uuids. */
function seed(kernel, count = 4) {
  const s = kernel.start({ cwd: 'C:\\work', title: 'source session' });
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      type: i % 2 ? 'assistant' : 'user',
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${i}` }] },
      uuid: `u${i}`,
      parentUuid: i === 0 ? null : `u${i - 1}`,
    });
  }
  kernel.setTranscript(s.sessionId, entries);
  return { sessionId: s.sessionId, uuids: entries.map((e) => e.uuid) };
}

test('forkSession answers {sessionId} so the caller can continue in it', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel);
  const newId = 'local_11111111-2222-4333-8444-555555555555';

  const result = await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  assert.ok(result, 'a null answer makes the Fork menu item do nothing');
  assert.equal(result.sessionId, newId, 'the caller chose the id and navigates to it');
});

test('forkSession copies the whole conversation when no anchor is given', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel, 4);
  const newId = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  assert.equal(kernel.getTranscript(newId).length, 4);
});

test('forkSession truncates at forkAtMessageUuid, inclusive', async () => {
  // "Fork from this message" means up to and including that message.
  const { kernel, call } = makeBridge();
  const src = seed(kernel, 4);
  const newId = 'local_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

  const result = await call('LocalSessions', 'forkSession', src.sessionId, newId, src.uuids[1], null);
  assert.equal(result.copiedMessages, 2, 'two entries: u0 and u1');
  assert.equal(kernel.getTranscript(newId).length, 2);
});

test('the forked session records its parent', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel);
  const newId = 'local_cccccccc-dddd-4eee-8fff-000000000000';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  assert.equal(kernel.getSession(newId).parentSessionId, src.sessionId);
});

test('a fork is independent: new messages do not touch the source', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel, 4);
  const newId = 'local_dddddddd-eeee-4fff-8000-111111111111';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  kernel.setTranscript(newId, [
    ...kernel.getTranscript(newId),
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fork-only' }] }, uuid: 'x1' },
  ]);

  assert.equal(kernel.getTranscript(newId).length, 5);
  assert.equal(kernel.getTranscript(src.sessionId).length, 4, 'the source must not grow');
});

test('forkSession honours a targetCwd', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel);
  const newId = 'local_eeeeeeee-ffff-4000-8111-222222222222';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, 'D:\\other');
  assert.equal(kernel.getSession(newId).cwd, 'D:\\other');
});

test('forkSession without targetCwd inherits the source folder', async () => {
  const { kernel, call } = makeBridge();
  const src = seed(kernel);
  const newId = 'local_ffffffff-0000-4111-8222-333333333333';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  assert.equal(kernel.getSession(newId).cwd, 'C:\\work');
});

test('forkSession answers null for an unknown source', async () => {
  const { call } = makeBridge();
  const result = await call('LocalSessions', 'forkSession', 'local_nope', 'local_99999999-8888-4777-8666-555555555555', null, null);
  assert.equal(result, null);
});

test('an unknown forkAtMessageUuid copies the whole conversation', async () => {
  // A stale anchor should not silently produce an empty fork.
  const { kernel, call } = makeBridge();
  const src = seed(kernel, 3);
  const newId = 'local_12341234-5678-49ab-8cde-0123456789ab';

  await call('LocalSessions', 'forkSession', src.sessionId, newId, 'no-such-uuid', null);
  assert.equal(kernel.getTranscript(newId).length, 3);
});

test('forkSession notifies the renderer', async () => {
  const { kernel, call, sent } = makeBridge();
  const src = seed(kernel);
  const newId = 'local_23452345-6789-4abc-8def-123456789abc';
  sent.length = 0;

  await call('LocalSessions', 'forkSession', src.sessionId, newId, null, null);
  // The fake window records { c: channel, p: payload }; the payload is the event.
  const evt = sent.find((m) => m.c.endsWith('_$_LocalSessions_$_OnEvent')
    && m.p && m.p.type === 'session_updated'
    && m.p.sessionId === newId);
  assert.ok(evt, 'the sidebar must learn about the new session');
});
