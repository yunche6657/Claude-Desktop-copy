// browseFile (singular) must answer { folder, name, relPath } or null.
//
// The wrapper is (shared-20, exported as `u`):
//   async function ck(e, t) { let n = Ge?.browseFile; if (n) return ak(() => n(e, t)) }
// and the caller (shared-23) reads it as:
//   let i = await Fm(title, folder);
//   if (!i) return;                                  // null = cancelled, safe
//   if (n && i.relPath !== void 0) { n.openFile(i.relPath); return }
//   ... r.some(e => e.openIfInside(i.folder, i.name)) ...
//
// browseFiles (plural) was implemented in round 85 but the singular one was not, so the pair
// was inconsistent: the "Open file" gate is `!!browseFile`, so the action rendered and did
// nothing. Same class as browseFolder before round 84.
//
// The OS dialog cannot open in a test. What is asserted here is the contract: a record with
// the three fields, or a clean null.
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
  return { call };
}

test('browseFile answers null when no dialog can be shown', async () => {
  // Under node there is no Electron dialog. The answer must be a clean null, not a throw and
  // not an object -- the caller treats null as "cancelled".
  const { call } = makeBridge();
  const answer = await call('FileSystem', 'browseFile', 'Open file');
  assert.equal(answer, null, `expected null, got ${JSON.stringify(answer)}`);
});

test('browseFile does not throw for odd arguments', async () => {
  const { call } = makeBridge();
  for (const [title, folder] of [[undefined, undefined], [null, null], ['', ''], [42, {}]]) {
    const answer = await call('FileSystem', 'browseFile', title, folder);
    assert.equal(answer, null, `browseFile(${JSON.stringify(title)}, ${JSON.stringify(folder)}) must answer null`);
  }
});

test('browseFile is registered, so the "Open file" gate is honest', async () => {
  // The gate is `!!jt?.browseFile`. Before this round the method existed only via the generic
  // fallback, so the gate passed and the click did nothing.
  const { call } = makeBridge();
  // A registered handler is one that can be invoked without throwing "no handler".
  assert.doesNotThrow(() => call('FileSystem', 'browseFile', 't'));
});

test('the answer shape, when a file is chosen, carries folder / name', async () => {
  // The dialog cannot run here, so the record builder is exercised directly. This is the
  // part a fallback cannot do: the fallback only ever answers null.
  const { buildFilePickResult } = require('../desktop/bridge-services.cjs');
  assert.equal(typeof buildFilePickResult, 'function', 'the builder must be exported for this to be checkable');

  const chosen = path.join('C:', 'Users', 'Administrator', 'notes', 'todo.md');
  const record = buildFilePickResult(chosen, path.join('C:', 'Users', 'Administrator', 'notes'));

  assert.equal(record.folder, path.join('C:', 'Users', 'Administrator', 'notes'));
  assert.equal(record.name, 'todo.md');
  assert.equal(record.relPath, 'todo.md');

  // The caller does `e.openIfInside(i.folder, i.name)` -- both must be strings.
  assert.equal(typeof record.folder, 'string');
  assert.equal(typeof record.name, 'string');
});

test('relPath is only present when the file is inside the offered folder', async () => {
  // The caller branches on `i.relPath !== void 0`, so an out-of-folder pick must omit it
  // rather than send a value containing "..".
  const { buildFilePickResult } = require('../desktop/bridge-services.cjs');

  const offered = path.join('C:', 'Users', 'Administrator', 'notes');
  const inside = path.join(offered, 'sub', 'a.md');
  const outside = path.join('C:', 'Users', 'Administrator', 'other', 'b.md');

  const inRecord = buildFilePickResult(inside, offered);
  assert.equal(inRecord.relPath, path.join('sub', 'a.md'));

  const outRecord = buildFilePickResult(outside, offered);
  assert.equal(outRecord.relPath, undefined, 'an outside pick must not claim a relPath');
  assert.ok(!('relPath' in outRecord), 'the key must be absent, not merely undefined');
  // It still reports where the file actually is.
  assert.equal(outRecord.name, 'b.md');
  assert.equal(outRecord.folder, path.join('C:', 'Users', 'Administrator', 'other'));
});

test('without an offered folder, no relPath is produced', async () => {
  const { buildFilePickResult } = require('../desktop/bridge-services.cjs');
  const record = buildFilePickResult(path.join('C:', 'tmp', 'x.txt'));
  assert.equal(record.name, 'x.txt');
  assert.ok(!('relPath' in record));
});

test('the singular and plural methods both exist now', async () => {
  const { call } = makeBridge();
  assert.doesNotThrow(() => call('FileSystem', 'browseFile', 't'));
  assert.doesNotThrow(() => call('FileSystem', 'browseFiles', 't'));
});

test('browseFile ignores a folder that does not exist', async () => {
  // defaultPath must not be set to a non-existent directory; the call still has to be clean.
  const { call } = makeBridge();
  const missing = path.join(os.tmpdir(), 'fx-not-a-folder-r86');
  assert.equal(fs.existsSync(missing), false);
  const answer = await call('FileSystem', 'browseFile', 'Open file', missing);
  assert.equal(answer, null);
});
