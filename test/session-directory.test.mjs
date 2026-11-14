// The Files pane's tree reads directories through LocalSessions.listSessionDirectory.
//
// This method had no handler, so it answered null and the renderer's `?? []` turned that
// into "Folder is empty" for a folder with 65 entries (cfac349aa-C6zhOLan.js, `at`):
//   return await (id==="landing" ? _?.listDirectoryAtCwd?.(root, dir)
//                                : _?.listSessionDirectory?.(id, dir)) ?? []
//
// An earlier round concluded "the pane makes no file-system calls" from a probe that
// wrapped FileSystem.* — the pane calls this LocalSessions method instead, so that probe
// was watching the wrong namespace. Measured after the fix on a live replica: 47 rows,
// real folders first, and expanding `ccd-ref` issued a second call with its sub-path.
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

/** A real folder with two files and a subfolder holding one more. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.json'), '{}');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '#');
  return root;
}

test('listSessionDirectory lists the session folder as {name, path, isDirectory}', async () => {
  const root = makeProject();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const entries = await call('LocalSessions', 'listSessionDirectory', s.sessionId, root);

  assert.ok(Array.isArray(entries), 'an array, never null — null is what rendered "Folder is empty"');
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['a.txt', 'b.json', 'sub']);
  assert.equal(byName['a.txt'].isDirectory, false);
  assert.equal(byName.sub.isDirectory, true);
  // The renderer maps `path` to absPath, so it must be absolute and inside the folder.
  assert.equal(byName['a.txt'].path, path.join(root, 'a.txt'));
});

test('a subfolder can be listed, which is what expanding a tree row does', async () => {
  const root = makeProject();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const inner = await call('LocalSessions', 'listSessionDirectory', s.sessionId, path.join(root, 'sub'));
  assert.deepEqual(inner.map((e) => e.name), ['inner.md']);
});

test('a path outside the session folder lists nothing', async () => {
  // The path comes from the renderer. Without confinement this would enumerate any
  // directory on the machine on request.
  const root = makeProject();
  const elsewhere = makeProject();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', s.sessionId, elsewhere), []);
  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', s.sessionId, os.tmpdir()), []);
  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', s.sessionId, path.parse(root).root), []);
});

test('a ".." escape out of the session folder lists nothing', async () => {
  const root = makeProject();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: path.join(root, 'sub') });

  // Resolves to `root`, which is the PARENT of the session folder.
  const escape = path.join(root, 'sub', '..');
  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', s.sessionId, escape), []);
});

test('a sibling whose name merely starts with the folder name is not inside it', async () => {
  // The classic prefix bug: "C:\\proj" must not admit "C:\\proj-secrets".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  const proj = path.join(base, 'proj');
  const sibling = path.join(base, 'proj-secrets');
  fs.mkdirSync(proj);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 's');

  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: proj });
  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', s.sessionId, sibling), []);
});

test('an unknown session, or a non-string path, answers an empty list rather than throwing', async () => {
  const { call } = makeBridge();
  assert.deepEqual(await call('LocalSessions', 'listSessionDirectory', 'local_nope', 'C:\\x'), []);

  const { kernel, call: call2 } = makeBridge();
  const s = kernel.start({ cwd: makeProject() });
  assert.deepEqual(await call2('LocalSessions', 'listSessionDirectory', s.sessionId, undefined), []);
  assert.deepEqual(await call2('LocalSessions', 'listSessionDirectory', s.sessionId, ''), []);
  assert.deepEqual(await call2('LocalSessions', 'listSessionDirectory', s.sessionId, 42), []);
});

test('a folder that has been deleted rejects instead of pretending to be empty', async () => {
  // The renderer distinguishes failed from empty (`everFailed`), and shows a different
  // state for each. Reporting a vanished folder as [] would hide the failure.
  const root = makeProject();
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });
  const gone = path.join(root, 'sub');
  fs.rmSync(gone, { recursive: true });

  await assert.rejects(() => call('LocalSessions', 'listSessionDirectory', s.sessionId, gone));
});

test('the listing is capped so a huge folder cannot flood the renderer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  for (let i = 0; i < 520; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), '');
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: root });

  const entries = await call('LocalSessions', 'listSessionDirectory', s.sessionId, root);
  assert.equal(entries.length, 500);
});

test('watchSessionDirectories acknowledges without claiming live updates', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: makeProject() });
  const ack = await call('LocalSessions', 'watchSessionDirectories', {
    sessionId: s.sessionId, watchId: 'w1', dirPaths: [],
  });
  assert.notEqual(ack, null, 'null forced the renderer to special-case the answer');
  assert.equal(ack.ok, true);
});
