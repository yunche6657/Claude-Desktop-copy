// The Cowork file surface must answer, and must answer in the right shape.
//
// Contracts read from the consumers (c21f11e6d-DNRpuJO9.js):
//   readLocalFile(sessionId, encodeURIComponent(path)) -> { content }
//       zb(): let i = await tt?.readLocalFile?.(e, enc); let o = i?.content ?? ""
//   writeLocalFile(sessionId, encodeURIComponent(path), text) -> boolean
//       Bb(): if (!await tt?.writeLocalFile?.(...)) throw Error("File system is not available")
//   listFilesInFolder(sessionId, folder) -> array
//       Kv(): let r = await tt.listFilesInFolder(e, t); n(s => ({ ...s, [t]: r }))
//
// All four answered null. The dangerous one is listFilesInFolder: its guard is a truthiness
// test on the METHOD (`if (tt?.listFilesInFolder)`), which the fallback satisfies, so the
// call ran, the state stored null, and the explorer did `value.map(...)`. Measured on the
// live replica: render { ok: false, threw: "Cannot read properties of null (reading 'map')" }.
//
// The read status enum is (shared-0-BRYCPbU4.js, `yx`):
//   Ok="ok" NotFound="notFound" TooLarge="tooLarge" ReadError="readError"
//   OutsideSessionFolders="outsideSessionFolders"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const STATUS = new Set(['ok', 'notFound', 'tooLarge', 'readError', 'outsideSessionFolders']);

/**
 * Build a bridge and start one session rooted at a temp folder, so the session-scoped path
 * checks have real roots to compare against.
 */
async function makeBridgeWithSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-fileops-'));

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

  const started = await call('LocalAgentModeSessions', 'start', { cwd: root, workingDir: root });
  const sessionId = started && (started.sessionId || (started.session && started.session.sessionId));
  assert.ok(sessionId, 'a session must start, otherwise every path check refuses');

  return { root, sessionId, call };
}

test('listFilesInFolder answers an array, never null', async () => {
  // This is the crash: null reached `.map`.
  const { root, sessionId, call } = await makeBridgeWithSession();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.mkdirSync(path.join(root, 'sub'));

  const list = await call('FileSystem', 'listFilesInFolder', sessionId, root);
  assert.ok(Array.isArray(list), `expected an array, got ${list === null ? 'null' : typeof list}`);
  assert.doesNotThrow(() => list.map((f) => f.name), 'the render path maps this value');
  const names = list.map((f) => f.name).sort();
  assert.deepEqual(names, ['a.txt', 'sub']);
});

test('the list records carry the fields a tree needs', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  fs.writeFileSync(path.join(root, 'x.txt'), 'x');
  const list = await call('FileSystem', 'listFilesInFolder', sessionId, root);
  for (const entry of list) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.path, 'string');
    assert.equal(typeof entry.isDirectory, 'boolean');
  }
});

test('readLocalFile answers { content } for a real file', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, 'hello round 85');

  const result = await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(file));
  assert.equal(typeof result, 'object', 'must not be null: the caller reads .content');
  assert.equal(result.status, 'ok');
  assert.equal(result.content, 'hello round 85');
});

test('readLocalFile reports a missing file with the NotFound status', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const missing = path.join(root, 'absent.txt');
  const result = await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(missing));
  assert.equal(result.status, 'notFound');
  assert.equal(result.content, '');
});

test('readLocalFile refuses a path outside the session folders', async () => {
  // The session is rooted in a temp dir; the Windows directory is not in it.
  const { sessionId, call } = await makeBridgeWithSession();
  const outside = 'C:\\Windows\\win.ini';
  const result = await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(outside));
  assert.equal(result.status, 'outsideSessionFolders', 'a session may only read its own folders');
});

test('every read status is a member of the UI enum', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const good = path.join(root, 'f.txt');
  fs.writeFileSync(good, 'x');

  const cases = [
    await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(good)),
    await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(path.join(root, 'no.txt'))),
    await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent('C:\\Windows\\win.ini')),
  ];
  for (const result of cases) {
    assert.ok(STATUS.has(result.status), `${JSON.stringify(result.status)} is outside the enum`);
  }
});

test('writeLocalFile answers a boolean and really writes', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const file = path.join(root, 'written.txt');

  const ok = await call('FileSystem', 'writeLocalFile', sessionId, encodeURIComponent(file), 'saved');
  assert.equal(ok, true, 'the caller throws when this is falsy');
  assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
});

test('writeLocalFile refuses a path outside the session folders', async () => {
  const { sessionId, call } = await makeBridgeWithSession();
  const outside = path.join(os.tmpdir(), 'fx-should-not-write-r85.txt');
  const ok = await call('FileSystem', 'writeLocalFile', sessionId, encodeURIComponent(outside), 'x');
  assert.equal(ok, false);
  assert.equal(fs.existsSync(outside), false, 'nothing may be written outside the session');
});

test('an unknown session cannot read or write anything', async () => {
  // Refusing is the safe default: a session id the kernel does not know has no declared roots.
  const { root, call } = await makeBridgeWithSession();
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x');

  const read = await call('FileSystem', 'readLocalFile', 'no-such-session', encodeURIComponent(file));
  assert.equal(read.status, 'outsideSessionFolders');

  const list = await call('FileSystem', 'listFilesInFolder', 'no-such-session', root);
  assert.deepEqual(list, []);
});

test('a subdirectory of the session root is allowed', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const sub = path.join(root, 'nested');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'deep.txt');
  fs.writeFileSync(file, 'deep');

  const result = await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(file));
  assert.equal(result.status, 'ok');
  assert.equal(result.content, 'deep');
});

test('path traversal out of the session root is refused', async () => {
  const { root, sessionId, call } = await makeBridgeWithSession();
  const escape = path.join(root, '..', '..', 'windows', 'win.ini');
  const result = await call('FileSystem', 'readLocalFile', sessionId, encodeURIComponent(escape));
  assert.equal(result.status, 'outsideSessionFolders');
});

// Round 257 rewrote this contract: the shipped renderer calls
//   savePastedFile(contentBase64, mimeType, fileName)
// and reads `.path` off the answer. There is no sessionId in the call — the earlier version of
// these two tests asserted the wrong shape, which is why they were the tests that failed when
// the handler was corrected.
/**
 * Remove a file a test caused to be written, and fail if it is still there.
 *
 * savePastedFile writes into the workspace root BY DESIGN (that is where an @-reference
 * resolves from), so every test that exercises it leaves a real file behind. Two of them were
 * doing exactly that: `paste.txt` and `decode.txt` reappeared in the repo root after every run
 * and had to be deleted by hand each round.
 */
function removeWritten(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone is fine */ }
  assert.equal(fs.existsSync(filePath), false, 'the test left ' + filePath + ' behind');
}

test('savePastedFile answers { path } for a base64 payload', async () => {
  const { call } = await makeBridgeWithSession();
  // 'aGVsbG8=' is base64 for 'hello'.
  const stored = await call('FileSystem', 'savePastedFile', 'aGVsbG8=', 'text/plain', 'paste.txt');
  try {
    assert.equal(typeof stored, 'object', 'the caller reads .path, not a bare string');
    assert.equal(typeof stored.path, 'string', 'the caller needs a path back');
    assert.equal(fs.readFileSync(stored.path, 'utf8'), 'hello');
  } finally {
    if (stored && stored.path) removeWritten(stored.path);
  }
});

test('savePastedFile decodes base64 instead of writing the encoded text', async () => {
  // Writing the base64 string itself creates a file that exists and is corrupt — the worst
  // combination, because nothing looks wrong until something reads the bytes.
  const { call } = await makeBridgeWithSession();
  const stored = await call('FileSystem', 'savePastedFile', 'aGVsbG8=', 'text/plain', 'decode.txt');
  try {
    assert.doesNotMatch(fs.readFileSync(stored.path, 'utf8'), /aGVsbG8/, 'the payload was written verbatim');
  } finally {
    if (stored && stored.path) removeWritten(stored.path);
  }
});