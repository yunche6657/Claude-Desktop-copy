// watchSessionDirectories must actually watch, and changes must reach the renderer.
//
// The consumer (cccc2cf0a, fn DC) does:
//   const canWatch = scope === "local" && sessionId !== "landing"
//     && bridge.watchSessionDirectories !== undefined
//     && bridge.onSessionDirectoryChanged !== undefined;
//   useEffect(() => {
//     if (!canWatch) return;
//     const off = bridge.onSessionDirectoryChanged((sid, dirPath) => {
//       if (sid !== sessionId || !paths.includes(dirPath)) return;
//       queryClient.refetchQueries({ queryKey: ..., exact: true });
//     });
//     bridge.watchSessionDirectories({ sessionId, watchId, dirPaths: [...paths] });
//     return () => {
//       bridge.watchSessionDirectories({ sessionId, watchId, dirPaths: [] });  // stop
//       off();
//     };
//   }, [canWatch, sessionId, watchId, paths]);
//
// Both halves used to be empty: watchSessionDirectories answered { ok: true } and started
// nothing, and onSessionDirectoryChanged had no handler at all. The gate passed (the fallback
// made both methods "exist"), so a file created in the tree only appeared after a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A bridge whose main window records every event it is sent. */
function makeBridge() {
  const handlers = new Map();
  const sent = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const api = registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send(channel, ...args) { sent.push({ channel, args }); },
      },
    }),
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
  return { call, sent, api, dispose: () => api.dispose() };
}

/** Wait until predicate() is true, or fail. */
async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('watching a real folder reports how many watchers started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-'));
  const { call, dispose } = makeBridge();
  try {
    const result = await call('LocalSessions', 'watchSessionDirectories', {
      sessionId: 's1', watchId: 'w1', dirPaths: [dir],
    });
    assert.equal(result.ok, true, `watch must succeed: ${JSON.stringify(result)}`);
    assert.equal(result.watching, 1, 'it must report one live watcher');
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 's1', watchId: 'w1', dirPaths: [] });
  } finally { dispose(); }
});

test('a file created in a watched folder emits a change event', async () => {
  // This is the whole point: without it the tree never refreshes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-'));
  const { call, sent, dispose } = makeBridge();
  try {
    await call('LocalSessions', 'watchSessionDirectories', {
      sessionId: 's2', watchId: 'w2', dirPaths: [dir],
    });

    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'x');

    const arrived = await waitFor(() => sent.some((s) => s.channel.includes('SessionDirectoryChanged')));
    assert.equal(arrived, true, `no change event arrived; sent=${JSON.stringify(sent.map((s) => s.channel))}`);

    // The payload must be ONE object. preload-frontend.cjs forwards a single argument
    // (`(_event, payload) => callback(payload)`), so two IPC args would drop the second.
    const event = sent.find((s) => s.channel.includes('SessionDirectoryChanged'));
    assert.equal(event.args.length, 1, 'exactly one payload argument survives the transport');
    assert.equal(event.args[0].sessionId, 's2', 'the event must name the session');
    assert.equal(event.args[0].dirPath, dir, 'and the folder that changed');
  } finally {
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 's2', watchId: 'w2', dirPaths: [] });
    dispose();
  }
});

test('stopping with an empty dirPaths releases the watcher', async () => {
  // The cleanup path the UI runs on unmount.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-'));
  const { call, sent, dispose } = makeBridge();
  try {
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 's3', watchId: 'w3', dirPaths: [dir] });
    const stopped = await call('LocalSessions', 'watchSessionDirectories', { sessionId: 's3', watchId: 'w3', dirPaths: [] });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.watching, 0);

    sent.length = 0;
    fs.writeFileSync(path.join(dir, 'after-stop.txt'), 'x');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sent.some((s) => s.channel.includes('SessionDirectoryChanged')), false,
      'a stopped watch must emit nothing');
  } finally { dispose(); }
});

test('an invalid request is refused rather than acknowledged', async () => {
  const { call, dispose } = makeBridge();
  try {
    for (const bad of [null, undefined, {}, { sessionId: 's' }, { sessionId: 's', watchId: 'w' },
      { sessionId: 's', watchId: 'w', dirPaths: 'not-an-array' }]) {
      const result = await call('LocalSessions', 'watchSessionDirectories', bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    }
  } finally { dispose(); }
});

test('a folder that cannot be watched is reported, not silently ignored', async () => {
  const { call, dispose } = makeBridge();
  try {
    const missing = path.join(os.tmpdir(), 'fx-does-not-exist-r93');
    fs.rmSync(missing, { force: true, recursive: true });
    const result = await call('LocalSessions', 'watchSessionDirectories', {
      sessionId: 's4', watchId: 'w4', dirPaths: [missing],
    });
    assert.equal(result.ok, false, 'an unwatchable folder must not answer ok:true');
    assert.ok(result.error);
  } finally { dispose(); }
});

test('the subscription is served by the event channel, not by a handler', async () => {
  // The registration loop deliberately skips every `on*` method:
  //   if (method.startsWith('on') && method.length > 2) continue;  // events are emitted
  // The frontend transport turns those into ipcRenderer.on(eventChannel(...)), so the
  // subscription needs no handler -- only the SENDING side has to exist. Asserting that
  // distinction here keeps someone from "fixing" it by adding a dead handler.
  const { call, sent, dispose } = makeBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-'));
  try {
    // No message channel exists for the `on*` method.
    assert.throws(() => call('LocalSessions', 'onSessionDirectoryChanged', () => {}),
      /no handler/, 'on* methods are not registered as message channels');

    // But the event channel is used when a change happens.
    await call('LocalSessions', 'watchSessionDirectories', {
      sessionId: 'sub', watchId: 'wsub', dirPaths: [dir],
    });
    fs.writeFileSync(path.join(dir, 'trigger.txt'), 'x');
    const arrived = await waitFor(() => sent.some((s) => s.channel.includes('SessionDirectoryChanged')));
    assert.equal(arrived, true, 'the event channel must carry the change');

    const event = sent.find((s) => s.channel.includes('SessionDirectoryChanged'));
    assert.match(event.channel, /\$eipc_event\$/,
      'the payload must go out on an event channel, not a message channel');
  } finally {
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 'sub', watchId: 'wsub', dirPaths: [] });
    dispose();
  }
});

test('two watches on different ids are independent', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-watch-b-'));
  const { call, sent, dispose } = makeBridge();
  try {
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 'sa', watchId: 'wa', dirPaths: [dirA] });
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 'sb', watchId: 'wb', dirPaths: [dirB] });

    // Stopping one must not stop the other.
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 'sa', watchId: 'wa', dirPaths: [] });

    sent.length = 0;
    fs.writeFileSync(path.join(dirB, 'b.txt'), 'x');
    const arrived = await waitFor(() => sent.some((s) => s.args && s.args[0] && s.args[0].sessionId === 'sb'));
    assert.equal(arrived, true, 'the remaining watch must still report');
  } finally {
    await call('LocalSessions', 'watchSessionDirectories', { sessionId: 'sb', watchId: 'wb', dirPaths: [] });
    dispose();
  }
});
