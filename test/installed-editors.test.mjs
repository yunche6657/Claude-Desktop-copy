// getInstalledEditors must report the editors this machine really has.
//
// The consumer (c856385e2-BuWw23-a.js, fn `an`) does:
//   (await g?.getInstalledEditors?.() ?? []).filter(sn).sort(on)
//   sn = e => e.installed && e.type !== "xcode"
//   on = (a, b) => a.name.localeCompare(b.name)
// and the record is read as { name, type, installed }. `type` is then passed straight into
// openInEditor(path, type, line, col, wslDistro).
//
// The type enum is (shared-0-BRYCPbU4.js, `_x`):
//   { VSCode:"vscode", Cursor:"cursor", Zed:"zed", Windsurf:"windsurf", Xcode:"xcode" }
// with display names from c14700b8b: VS Code / Cursor / Zed / Windsurf / Xcode.
//
// With no handler the menu was simply empty: the consumers use `?? []`, so this was never a
// crash, only a missing feature. Measured on the live replica: answer null, filtered length
// 0, while `code` is on PATH at D:\VSCode\bin\code.cmd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

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

// The enum members, copied from the shipped bundle.
const TYPES = new Set(['vscode', 'cursor', 'zed', 'windsurf', 'xcode']);
const NAMES = { vscode: 'VS Code', cursor: 'Cursor', zed: 'Zed', windsurf: 'Windsurf', xcode: 'Xcode' };

/** Is `command` resolvable on this host? */
function onPath(command) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(finder, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { return false; }
}

test('the answer is an array of records with the fields the consumer reads', async () => {
  const { call } = makeBridge();
  const editors = await call('LocalSessions', 'getInstalledEditors');
  assert.ok(Array.isArray(editors), 'must be an array, not null');
  assert.ok(editors.length > 0, 'the catalogue must not be empty: the menu needs entries to filter');
  for (const e of editors) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.type, 'string');
    assert.equal(typeof e.installed, 'boolean');
  }
});

test('every type is a member of the UI enum', async () => {
  const { call } = makeBridge();
  const editors = await call('LocalSessions', 'getInstalledEditors');
  for (const e of editors) {
    assert.ok(TYPES.has(e.type), `${JSON.stringify(e.type)} is not an editor type the UI knows`);
  }
});

test('the display names match the shipped catalogue', async () => {
  const { call } = makeBridge();
  const editors = await call('LocalSessions', 'getInstalledEditors');
  for (const e of editors) {
    assert.equal(e.name, NAMES[e.type], `${e.type} should be named ${NAMES[e.type]}`);
  }
});

test('VS Code is reported installed on this host, because code is on PATH', async () => {
  const { call } = makeBridge();
  const editors = await call('LocalSessions', 'getInstalledEditors');
  const vscode = editors.find((e) => e.type === 'vscode');
  assert.ok(vscode, 'the catalogue must include vscode');
  if (onPath('code') || onPath('code.cmd')) {
    assert.equal(vscode.installed, true, 'code is on PATH, so VS Code must be installed');
  }
});

test('an editor that is not on PATH is reported as not installed', async () => {
  // Guards against marking everything installed, which would show a menu full of editors
  // that cannot actually be launched.
  const { call } = makeBridge();
  const editors = await call('LocalSessions', 'getInstalledEditors');
  const zed = editors.find((e) => e.type === 'zed');
  if (zed && !onPath('zed') && !onPath('zed.exe')) {
    assert.equal(zed.installed, false, 'zed is not on PATH here');
  }
});

test('the consumer\'s filter yields VS Code and drops xcode', async () => {
  // Replay the consumer's pipeline exactly.
  const { call } = makeBridge();
  const raw = (await call('LocalSessions', 'getInstalledEditors')) ?? [];
  const filtered = raw.filter((e) => e.installed && e.type !== 'xcode').sort((a, b) => a.name.localeCompare(b.name));

  if (onPath('code') || onPath('code.cmd')) {
    assert.ok(filtered.some((e) => e.type === 'vscode'), 'the menu must offer VS Code here');
  }
  assert.ok(!filtered.some((e) => e.type === 'xcode'), 'xcode is filtered out on non-mac');
  // Sorted by name, as the consumer requires.
  const names = filtered.map((e) => e.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'the list must be name-sorted');
});

test('openInEditor answers a boolean, and refuses unknown editors', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'openInEditor', 'C:\\nope\\file.txt', 'not-an-editor');
  assert.equal(answer, false, 'an unknown editor type cannot open anything');
});

test('openInEditor refuses a path that does not exist', async () => {
  const { call } = makeBridge();
  const missing = 'C:\\definitely-not-here-round81.txt';
  assert.equal(await call('LocalSessions', 'openInEditor', missing, 'vscode'), false);
});

test('openInEditor refuses an empty path', async () => {
  const { call } = makeBridge();
  for (const bad of [undefined, null, '', 42]) {
    assert.equal(await call('LocalSessions', 'openInEditor', bad, 'vscode'), false);
  }
});
