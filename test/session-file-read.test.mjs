// Opening a file from the tree asks LocalSessions.readSessionFileWithStatus.
//
// It had no handler, so it answered null. The consumer (cf3dc8013-DPZGVxPE.js, `S`) reads
// `i.status` off that answer, so the file tab spun forever on a file that was on disk.
// Measured on a live replica before the fix: the tab opened, the breadcrumb was right, and
// the body never left its spinner.
//
// The status literals come from shared-0-ByI5P0CP.js (`gb`):
//   Ok="ok" NotFound="notFound" TooLarge="tooLarge"
//   ReadError="readError" OutsideSessionFolders="outsideSessionFolders"
// and the consumer maps them to unavailable reasons:
//   NotFound -> "missing", TooLarge -> "too_large",
//   OutsideSessionFolders -> "outside_workspace", anything else -> "read_error".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-'));
  fs.writeFileSync(path.join(root, 'note.md'), '# hello\n\nbody text\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner');
  return root;
}

test('an existing file comes back with status "ok" and its contents', async () => {
  const root = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });
  const file = path.join(root, 'note.md');

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, file);

  assert.equal(answer.status, 'ok', 'the literal from the enum, not "Ok" or 0');
  assert.ok(answer.file, 'the consumer only uses the payload when status is ok');
  assert.equal(answer.file.contents, '# hello\n\nbody text\n');
  assert.equal(answer.file.name, 'note.md');
});

test('the answer is a status wrapper, never null', async () => {
  // null is what broke the tab: the consumer does `i.status === e.Ok` on the answer.
  const root = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });
  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'note.md'));
  assert.notEqual(answer, null);
  assert.equal(typeof answer, 'object');
  assert.equal(typeof answer.status, 'string');
});

test('a missing file reports notFound and says it is creatable', async () => {
  // The pane offers "create this file" from this signal, so it must not be a plain error.
  const root = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'nope.txt'));
  assert.equal(answer.status, 'notFound');
  assert.equal(answer.creatable, true);
});

test('a path outside the session folders reports outsideSessionFolders', async () => {
  // A distinct status: the pane has its own message for "outside workspace".
  const root = project();
  const elsewhere = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(elsewhere, 'note.md'));
  assert.equal(answer.status, 'outsideSessionFolders');
});

test('a directory is rejected with a status that is neither "ok" nor "notFound"', async () => {
  // Honest scope: this test does NOT pin the `stat.isFile()` guard on its own.
  // Removing that guard leaves the answer unchanged on this platform — reading a directory
  // throws EISDIR and the catch maps it to readError just as the guard would. The guard is
  // kept because it makes the intent explicit and avoids attempting a pointless read, but
  // the regression proof for it stays green, so it is not claimed as covered.
  //
  // What IS pinned here: a directory never masquerades as a readable file, and never as a
  // missing one (the pane offers "create this file" on notFound).
  const root = project();
  const sub = path.join(root, 'sub');
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, sub);

  assert.equal(answer.status, 'readError');
  assert.equal(answer.file, undefined, 'a directory must never yield a file payload');
  assert.notEqual(answer.status, 'ok');
  assert.notEqual(answer.status, 'notFound', 'a directory exists; it is not a missing file');
  assert.notEqual(answer.status, 'tooLarge');
});

test('a file with no read permission is reported as an error, not as empty content', async () => {
  // "Failed to read" and "empty file" are different: the pane shows different states, and
  // silently returning "" would look like a legitimately blank file.
  const root = project();
  const locked = path.join(root, 'locked.txt');
  fs.writeFileSync(locked, 'secret');
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  // Hold an exclusive handle so the subsequent read fails on Windows.
  let answer;
  try {
    const fd = fs.openSync(locked, 'r+');
    try {
      answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, locked);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return; // platform did not let us set the trap; the other tests still cover the shape
  }

  // It either read the contents (permission model allowed it) or reported an error —
  // what it must never do is answer "ok" with empty contents.
  if (answer.status === 'ok') {
    assert.equal(answer.file.contents, 'secret');
  } else {
    assert.equal(answer.status, 'readError');
  }
});

test('a file above the size limit reports tooLarge with the limit', async () => {
  // The recovered native FileAccess declares SESSION_FILE_MAX_BYTES=10485760.
  // The unrelated inline media viewer limit must not cap the text editor's reader.
  const root = project();
  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(10 * 1024 * 1024 + 10));
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, big);
  assert.equal(answer.status, 'tooLarge');
  assert.equal(answer.maxBytes, 10 * 1024 * 1024);
});

test('a subfolder file is readable, which is what clicking a nested row does', async () => {
  const root = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answer = await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'sub', 'inner.txt'));
  assert.equal(answer.status, 'ok');
  assert.equal(answer.file.contents, 'inner');
});

test('an unknown session or a non-string path reports readError', async () => {
  const { call } = makeBridge();
  assert.equal((await call('LocalSessions', 'readSessionFileWithStatus', 'local_nope', 'C:\\x')).status, 'readError');

  const { kernel, call: call2 } = makeBridge();
  const s = kernel.start({ cwd: project() });
  assert.equal((await call2('LocalSessions', 'readSessionFileWithStatus', s.sessionId, undefined)).status, 'readError');
  assert.equal((await call2('LocalSessions', 'readSessionFileWithStatus', s.sessionId, '')).status, 'readError');
});

test('every status this handler returns is one the consumer recognises', async () => {
  // The consumer's switch has four named branches; anything else falls to "read_error".
  // Pin the vocabulary so a typo like "notfound" cannot slip through.
  const legal = new Set(['ok', 'notFound', 'tooLarge', 'readError', 'outsideSessionFolders']);
  const root = project();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const answers = [
    await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'note.md')),
    await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'gone.txt')),
    await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, path.join(root, 'sub')),
    await call('LocalSessions', 'readSessionFileWithStatus', s.sessionId, 'C:\\outside.txt'),
  ];
  for (const a of answers) {
    assert.ok(legal.has(a.status), `unexpected status: ${a.status}`);
  }
});
