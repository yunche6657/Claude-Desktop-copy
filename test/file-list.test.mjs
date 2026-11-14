// The project file list feeds the @-mention picker and the Files pane.
//
// The consumer (c227f4d5e-BtCczSFM.js) is specific about the shape:
//
//   let e = await bridge.getProjectFileListIfChanged(version)   // version|null
//   if (i.paths === null) { /* unchanged: keep the cached list */ }
//   else if (i.paths) a = MD(i.version, i.paths)                // split on \n
//   ... lines.map(l => l.endsWith('/') ? l.slice(0,-1) : l)     // dirs end with /
//
// The previous fallback answered null, so the picker had no files at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeBridge(focusedCwd) {
  const handlers = new Map();
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
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', focusedCwd, kernelFactory: () => kernel },
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

/** A small tree: two files at the root, one nested, plus a skipped node_modules. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'filelist-'));
  writeFileSync(join(root, 'alpha.ts'), 'x');
  writeFileSync(join(root, 'beta.json'), '{}');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'main.ts'), 'y');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'ignored.js'), 'z');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), 'c');
  return root;
}

test('the file list answers {version, paths}, not null', async () => {
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const answer = await call('Resources', 'getProjectFileListIfChanged', null);
    assert.ok(answer, 'a null answer leaves the picker empty');
    assert.equal(typeof answer.version, 'string');
    assert.equal(typeof answer.paths, 'string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paths is a newline-separated string the consumer can split', async () => {
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const { paths } = await call('Resources', 'getProjectFileListIfChanged', null);
    const lines = paths.split('\n');
    assert.ok(lines.includes('alpha.ts'));
    assert.ok(lines.includes('beta.json'));
    assert.ok(lines.includes('src/main.ts'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directories are marked with a trailing slash', async () => {
  // The consumer strips it to build its dirs set; a plain name would be treated as
  // a file and the picker would offer a folder as if it were openable.
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const { paths } = await call('Resources', 'getProjectFileListIfChanged', null);
    const lines = paths.split('\n');
    assert.ok(lines.includes('src/'), 'the directory must end with /');
    assert.equal(lines.includes('src'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('node_modules and .git are not offered', async () => {
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const { paths } = await call('Resources', 'getProjectFileListIfChanged', null);
    assert.equal(/node_modules/.test(paths), false);
    assert.equal(/\.git\//.test(paths), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('passing the current version answers paths:null (unchanged)', async () => {
  // This is how the caller avoids re-indexing the whole tree on every poll.
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const first = await call('Resources', 'getProjectFileListIfChanged', null);
    const second = await call('Resources', 'getProjectFileListIfChanged', first.version);
    assert.equal(second.paths, null);
    assert.equal(second.version, first.version);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('passing a stale version answers the full list again', async () => {
  const root = makeTree();
  try {
    const { call } = makeBridge(root);
    const first = await call('Resources', 'getProjectFileListIfChanged', null);
    const second = await call('Resources', 'getProjectFileListIfChanged', 'some-older-version');
    assert.equal(typeof second.paths, 'string');
    assert.ok(second.paths.split('\n').includes('alpha.ts'));
    assert.equal(second.version, first.version);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable root does not throw', async () => {
  const { call } = makeBridge(join(tmpdir(), 'definitely-missing-dir-xyz'));
  const answer = await call('Resources', 'getProjectFileListIfChanged', null);
  assert.ok(answer);
  assert.equal(answer.paths, '');
});
