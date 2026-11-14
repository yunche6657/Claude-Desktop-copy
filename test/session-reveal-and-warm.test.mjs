// Two channels the file panel and the model switcher call were answering `null`.
//
// FOUND by walking the 934 generic-fallback methods and asking which ones the SHIPPED
// frontend actually calls (not merely declares). Two of the survivors are user-visible:
//
//   showSessionFileInFolder   measured: null
//     consumer (c856385e2-aEyDzrcK.js):
//       v.showSessionFileInFolder(r.sessionId, r.path)?.then(e => { e || a() })?.catch(a)
//       a = () => addError("Couldn't show this file in its folder.")
//     so EVERY reveal raised an error toast even though the file was right there.
//
//   warmSession               measured: null
//     consumer:
//       await e.stop(t); if (r()) await e.setModel(t, n);
//       if (e.warmSession) try { await e.warmSession(t); a = true } catch {}
//       return r() ? (a ? 'restarted' : 'applies_on_next_start') : 'superseded'
//     so a model change reported "needs a restart" although stop+setModel had succeeded.
//
// MEASURED AFTER the fix:
//   warmSession(existing)   -> { sessionId, model, warmed: true }
//   warmSession(unknown)    -> null
//   showSessionFileInFolder(inside the session root)  -> true
//   showSessionFileInFolder('../../..' escape)        -> false
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A bridge over a real kernel, with a recorded reveal call. */
async function makeBridge(extra = {}) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-reveal-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    backend: { id: 'ccb', start() {}, async sendMessage() { return { text: '', stopReason: 'end_turn' }; },
      cancel() {}, onEvent() { return () => {}; }, dispose() {}, async warm() {} },
    storePath,
  });
  const revealed = [];
  const handlers = new Map();
  registerBridgeServices(Object.assign({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    openExternal: async () => {},
    showItemInFolder: (t) => revealed.push(t),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  }, extra));
  // Takes rest args explicitly: an arrow function has no own `arguments`, so the earlier
  // version silently forwarded the wrong list and every handler saw undefined parameters.
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes('_$_' + service + '_$_') && c.endsWith('_$_' + method));
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, kernel, revealed, storePath };
}

test('warmSession answers a real session record, not null', async () => {
  const b = await makeBridge();
  try {
    const folder = path.join(os.tmpdir(), 'dsh-warm-session');
    // Create THROUGH the bridge: its handlers use their own kernel instance, and a session made
    // directly on the test's kernel would be invisible to them (measured: warmSession answered
    // null for exactly that reason).
    const session = await b.call('LocalSessions', 'start', { cwd: folder });
    const warmed = await b.call('LocalSessions', 'warmSession', session.sessionId);
    assert.ok(warmed, 'warmSession answered ' + JSON.stringify(warmed) + '; the model switcher reads that as needing a restart');
    assert.equal(warmed.sessionId, session.sessionId);
    assert.equal(warmed.warmed, true);
  } finally { try { fs.unlinkSync(b.storePath); } catch { /* gone */ } }
});

test('warmSession is a native no-op for an unknown session and never claims warmed', async () => {
  const b = await makeBridge();
  try {
    assert.equal(await b.call('LocalSessions', 'warmSession', 'local_not-a-session'), undefined);
  } finally { try { fs.unlinkSync(b.storePath); } catch { /* gone */ } }
});

test('revealing a file inside the session folder answers true and calls the host', async () => {
  const b = await makeBridge();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reveal-'));
  try {
    fs.writeFileSync(path.join(folder, 'visible.txt'), 'x');
    const session = await b.call('LocalSessions', 'start', { cwd: folder });
    const answer = await b.call('LocalSessions', 'showSessionFileInFolder', session.sessionId, 'visible.txt');
    assert.equal(answer, true, 'reveal answered ' + JSON.stringify(answer) + '; a falsey answer shows an error');
    assert.equal(b.revealed.length, 1, 'the host reveal was never called');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    try { fs.unlinkSync(b.storePath); } catch { /* gone */ }
  }
});

test('revealing a file outside the session folder answers false and never calls the host', async () => {
  const b = await makeBridge();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reveal-'));
  try {
    const session = await b.call('LocalSessions', 'start', { cwd: folder });
    const escape = path.join('..', '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts');
    // Two escape shapes: a relative traversal and an absolute path elsewhere on disk. The
    // first version of this test only used the relative form, and dropping the root check
    // left it green (measured) because the relative path resolved outside every root anyway.
    const absolute = path.resolve(os.tmpdir(), '..', 'outside-the-session.txt');
    for (const attempt of [escape, absolute, 'C:\\Windows\\win.ini']) {
      const answer = await b.call('LocalSessions', 'showSessionFileInFolder', session.sessionId, attempt);
      assert.equal(answer, false, 'reveal answered ' + JSON.stringify(answer) + ' for ' + attempt);
    }
    assert.equal(b.revealed.length, 0, 'the host was asked to reveal a path outside the session');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    try { fs.unlinkSync(b.storePath); } catch { /* gone */ }
  }
});

test('without a host capability a valid path still answers true', async () => {
  // A headless run has no shell. The path IS revealable, so reporting a refusal would show the
  // user an error they cannot act on.
  const b = await makeBridge({ showItemInFolder: undefined });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reveal-'));
  try {
    const session = await b.call('LocalSessions', 'start', { cwd: folder });
    const answer = await b.call('LocalSessions', 'showSessionFileInFolder', session.sessionId, 'anything.txt');
    assert.equal(answer, true, 'a headless reveal reported a refusal');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    try { fs.unlinkSync(b.storePath); } catch { /* gone */ }
  }
});

test('the root check lives in resolveForReveal, not only in the bridge', async () => {
  // WHY THIS EXISTS: targetFor() guards twice — a `continue` over the candidate roots before
  // resolving symlinks, and an `inside(realRoot, realTarget)` check after. MEASURED:
  //
  //   remove only the realpath check  -> all tests GREEN (the outer guard still refuses)
  //   remove only the pre-realpath one -> all tests GREEN (the inner guard still refuses)
  //   remove BOTH                      -> 2 tests red
  //
  // So neither layer is dead code and neither alone is the whole defence. Pinning the lower
  // layer here means a future loosening of that module is caught even if the bridge keeps its
  // own `if (!target) return false;` guard.
  const { createSessionFileAccess } = require(path.join(ROOT, 'desktop', 'session-file-access.cjs'));
  const sessions = new Map();
  const access = createSessionFileAccess({ getSession: (id) => sessions.get(id) });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roots-'));
  try {
    sessions.set('s1', { sessionId: 's1', cwd: folder, workingDir: folder });
    // A path inside the session resolves to a real object.
    const inside = await access.resolveForReveal('s1', 'inside.txt');
    assert.ok(inside && typeof inside.path === 'string', 'an in-root path did not resolve');
    // Every escape shape must resolve to nothing, at THIS layer.
    for (const attempt of [
      path.join('..', 'escape.txt'),
      path.resolve(os.tmpdir(), '..', 'outside.txt'),
      'C:\\Windows\\win.ini',
    ]) {
      assert.equal(await access.resolveForReveal('s1', attempt), null, 'targetFor resolved an out-of-root path: ' + attempt);
    }
    // An unknown session resolves nothing either.
    assert.equal(await access.resolveForReveal('nope', 'inside.txt'), null);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('both channels are registered with real handlers', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  for (const method of ['showSessionFileInFolder', 'warmSession']) {
    assert.ok(bridge.includes('_$_' + method + "'"), method + ' has no handler');
  }
});
