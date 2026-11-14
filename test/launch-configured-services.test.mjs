// getConfiguredServices must read the project's .claude/launch.json, not answer [].
//
// FOUND by taking the 6 Launch methods the shipped frontend really calls and checking each one.
// Five of them need a real preview host and remain a recorded structural gap; this one does not.
//
// It used to be hard-coded to return [] with a comment asserting the pane is unreachable. The
// pane IS still unreachable (it needs a service store that can reach "ready"), but this channel
// is independent of that: the shipped consumer (cf580efe9-BFcQCjF9.js) only needs the entries so
// its picker can offer a name.
//
//   getConfiguredServices?.(cwd).then(t => { if (!cancelled) set({ cwd, configs: t ?? [] }) })
//
// and the path it reads is the literal '/.claude/launch.json' (var Ei in that bundle). Answering
// [] for every project meant the picker could never offer an entry even when the project
// declared a perfectly good one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function makeBridge() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-launch-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => {
      const seg = c.split('_$_');
      return seg[seg.length - 2] === service && seg[seg.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, cleanup: () => { try { fs.unlinkSync(storePath); } catch { /* gone */ } } };
}

/** A throwaway project directory carrying an optional launch.json. */
function projectWith(launchJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-'));
  if (launchJson !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'launch.json'),
      typeof launchJson === 'string' ? launchJson : JSON.stringify(launchJson));
  }
  return dir;
}

test('the declared configurations are returned, in order', async () => {
  const b = await makeBridge();
  const dir = projectWith({ configurations: [
    { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 },
    { name: 'api', runtimeExecutable: 'node', runtimeArgs: ['server.js'] },
  ] });
  try {
    const configs = await b.call('Launch', 'getConfiguredServices', dir);
    assert.equal(configs.length, 2, 'the declared entries were not returned: ' + JSON.stringify(configs));
    assert.deepEqual(configs.map((c) => c.name), ['web', 'api']);
    assert.equal(configs[0].port, 3000);
    assert.deepEqual(configs[0].runtimeArgs, ['run', 'dev']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); b.cleanup(); }
});

test('a bare array of entries is accepted', async () => {
  // A hand-written file is often just an array, not wrapped in { configurations }.
  const b = await makeBridge();
  const dir = projectWith([{ name: 'only', runtimeExecutable: 'pnpm', runtimeArgs: ['dev'] }]);
  try {
    const configs = await b.call('Launch', 'getConfiguredServices', dir);
    assert.equal(configs.length, 1);
    assert.equal(configs[0].name, 'only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); b.cleanup(); }
});

test('a malformed entry keeps its place with safe fields', async () => {
  // A missing name must not drop the entry: the picker still needs a row to show.
  const b = await makeBridge();
  const dir = projectWith({ configurations: [{}, { name: 'good', runtimeExecutable: 'node', runtimeArgs: [] }] });
  try {
    const configs = await b.call('Launch', 'getConfiguredServices', dir);
    assert.equal(configs.length, 2, 'an entry with no fields was dropped');
    assert.equal(configs[0].name, 'dev server', 'the fallback name is missing');
    assert.deepEqual(configs[0].runtimeArgs, []);
    assert.equal(configs[0].runtimeExecutable, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); b.cleanup(); }
});

test('a project with no launch.json answers an empty array', async () => {
  const b = await makeBridge();
  const dir = projectWith(undefined);
  try {
    assert.deepEqual(await b.call('Launch', 'getConfiguredServices', dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); b.cleanup(); }
});

test('unreadable json and a missing cwd both answer an empty array rather than throwing', async () => {
  const b = await makeBridge();
  const dir = projectWith('{ this is not json');
  try {
    assert.deepEqual(await b.call('Launch', 'getConfiguredServices', dir), []);
    assert.deepEqual(await b.call('Launch', 'getConfiguredServices', undefined), []);
    assert.deepEqual(await b.call('Launch', 'getConfiguredServices', ''), []);
    assert.deepEqual(await b.call('Launch', 'getConfiguredServices', path.join(os.tmpdir(), 'dsh-absent-' + Date.now())), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); b.cleanup(); }
});

test('getConfiguredServices is no longer a hard-coded empty array', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(!/Launch_\$_getConfiguredServices', \(\) => \[\]\)/.test(bridge),
    'the hard-coded empty array is back');
  assert.ok(bridge.includes("previewLaunch.getConfiguredServices(cwd)"), 'the handler no longer delegates to the launch configuration reader');
});
