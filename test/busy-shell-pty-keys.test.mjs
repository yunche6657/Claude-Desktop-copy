// getBusyShellPtyKeys must describe the shells that actually exist.
//
// The consumer (c11959232-D0R2R6wT.js, fn Xt) reads the answer as sets of PTY KEYS:
//   key(sessionId, tabId) = tabId === "0" ? sessionId : `${sessionId}::${tabId}`
//   live    -- a shell process exists for this key
//   busy    -- a subset of live currently running a command
//   unknown -- keys that could not be probed
//   probed  -- whether the probe actually ran
// and it chooses the tab to attach with:
//   ... t.id === "0" ? (live.has(key) || !probed) : (live.has(key) || key === pending)
//
// The handler used to return a frozen
//   { live: [], busy: [], unknown: [], probed: true, tabs: [] }
// regardless of reality. That is not "no result": `probed: true` claims the probe ran and
// `live: []` claims nothing is alive. Measured on the live replica while a shell existed
// and getTerminalShells listed it, the answer was still live: [], so
// `liveContainsTab0` was false and the pane could not recognise its own live tab.
//
// Every test that starts a shell registers cleanup via t.after, so a failed assertion
// still stops the child. Without that, a red run left a live cmd.exe holding the event
// loop open and the whole file hung instead of reporting the failure.
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
  const settings = {
    sidebarMode: 'epitaxy',
    themeMode: 'system',
    kernelFactory: () => kernel,
  };
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings,
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  // Always kill every spawned shell, pass or fail.
  const cleanup = () => { try { settings.disposeShells?.(); } catch { /* already gone */ } };
  return { kernel, call, cleanup };
}

/** Start a shell and guarantee it is stopped when the test ends. */
async function startShell(t, call, sessionId) {
  t.after(() => { try { call('LocalSessions', 'stopShellPty', sessionId); } catch { /* gone */ } });
  await call('LocalSessions', 'startShellPty', sessionId, 80, 24, 'pane_open', null, true, {});
}

test('the answer has the five buckets the consumer reads', async (t) => {
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const answer = await call('LocalSessions', 'getBusyShellPtyKeys', 'local_none');
  for (const key of ['live', 'busy', 'unknown', 'tabs']) {
    assert.ok(Array.isArray(answer[key]), `${key} must be an array`);
  }
  assert.equal(typeof answer.probed, 'boolean');
});

test('with no shell for the session, live is empty and that is truthful', async (t) => {
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const answer = await call('LocalSessions', 'getBusyShellPtyKeys', 'local_absent');
  assert.deepEqual(answer.live, []);
  assert.equal(answer.probed, true, 'the probe did run; it simply found nothing');
});

test('a started shell appears in live under its session id', async (t) => {
  // Session id IS the pty key for tab 0 (key = tabId === "0" ? sessionId : ...).
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const sessionId = 'local_dirty-keys';
  await startShell(t, call, sessionId);

  const answer = await call('LocalSessions', 'getBusyShellPtyKeys', sessionId);
  assert.deepEqual(answer.live, [sessionId], 'the running shell must be reported as live');
});

test('a stopped shell disappears from live', async (t) => {
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const sessionId = 'local_stop-keys';
  await startShell(t, call, sessionId);
  assert.deepEqual((await call('LocalSessions', 'getBusyShellPtyKeys', sessionId)).live, [sessionId]);

  await call('LocalSessions', 'stopShellPty', sessionId);
  assert.deepEqual((await call('LocalSessions', 'getBusyShellPtyKeys', sessionId)).live, []);
});

test('live is scoped to the session that was asked about', async (t) => {
  // Answering another session's shells as if they were this session's would make the pane
  // attach to a tab that belongs to a different session.
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  await startShell(t, call, 'local_a');

  assert.deepEqual((await call('LocalSessions', 'getBusyShellPtyKeys', 'local_a')).live, ['local_a']);
  assert.deepEqual((await call('LocalSessions', 'getBusyShellPtyKeys', 'local_b')).live, []);
});

test('probed:true is only claimed alongside a derived answer', async (t) => {
  // The defect was `probed: true` with a constant payload. Guard the relationship: while a
  // shell exists, probed:true must come with a non-empty live set.
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const sessionId = 'local_honest';
  await startShell(t, call, sessionId);

  const answer = await call('LocalSessions', 'getBusyShellPtyKeys', sessionId);
  if (answer.probed) {
    assert.ok(answer.live.length > 0, 'probed:true with no live entries while a shell runs is the old bug');
  }
});

test('busy is not fabricated: an idle shell is not reported as busy', async (t) => {
  // A pipe offers no way to ask "is this process at a prompt?", so `busy` stays empty.
  // Claiming a busy shell would suppress diff refreshes; claiming idle only delays them.
  const { call, cleanup } = makeBridge();
  t.after(cleanup);
  const sessionId = 'local_idle';
  await startShell(t, call, sessionId);

  const answer = await call('LocalSessions', 'getBusyShellPtyKeys', sessionId);
  assert.deepEqual(answer.busy, []);
  // But the shell is still reported live, so the pane can attach to it.
  assert.deepEqual(answer.live, [sessionId]);
});
