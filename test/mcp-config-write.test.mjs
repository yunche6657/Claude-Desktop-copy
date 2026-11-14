// MCP.setMcpServerConfigs must actually persist, and must not damage the rest of the file.
//
// Before the fix it answered `{ ok: true }` and wrote nothing. Measured live:
//   writeResult: { ok: true }
//   actuallySaved: false
// so every server the user added was silently discarded while the UI reported success.
//
// The real file also holds deploymentMode, coworkUserFilesPath and a large `preferences`
// tree, so a naive `writeFile(JSON.stringify({ mcpServers }))` would destroy them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/**
 * Build a bridge pointed at a throwaway config file via LOCALAPPDATA, so the real
 * %LOCALAPPDATA%\Claude-3p\claude_desktop_config.json is never touched.
 */
function makeBridge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'));
  const configDir = path.join(root, 'Claude-3p');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'claude_desktop_config.json');

  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;

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

  const restore = () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  };

  return { root, configPath, call, restore };
}

test('a saved server can be read back', async () => {
  const { configPath, call, restore } = makeBridge();
  try {
    const servers = { probe: { command: 'echo', args: ['hi'] } };
    const result = await call('MCP', 'setMcpServerConfigs', servers);
    assert.equal(result.ok, true, `write must succeed: ${JSON.stringify(result)}`);

    // The real assertion: the file changed and the read path sees it.
    assert.equal(fs.existsSync(configPath), true, 'the config file must be created');
    const readBack = await call('MCP', 'getMcpServersConfig');
    assert.deepEqual(readBack, servers);
  } finally { restore(); }
});

test('writing does not destroy the other keys in the file', async () => {
  // This is the assertion that matters most: the real file carries deploymentMode,
  // coworkUserFilesPath and a large preferences tree.
  const { configPath, call, restore } = makeBridge();
  try {
    const original = {
      deploymentMode: '3p',
      coworkUserFilesPath: 'C:\\Users\\someone\\Claude',
      preferences: { sidebarMode: 'epitaxy', nested: { deep: [1, 2, 3] } },
      mcpServers: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2));

    await call('MCP', 'setMcpServerConfigs', { s1: { command: 'a' } });

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(after.deploymentMode, '3p');
    assert.equal(after.coworkUserFilesPath, 'C:\\Users\\someone\\Claude');
    assert.deepEqual(after.preferences, { sidebarMode: 'epitaxy', nested: { deep: [1, 2, 3] } });
    assert.deepEqual(after.mcpServers, { s1: { command: 'a' } });
  } finally { restore(); }
});

test('removing a server really removes it', async () => {
  // The UI's remove flow re-reads after writing and reports failure if the key is still
  // there, so a no-op write made removal impossible.
  const { call, restore } = makeBridge();
  try {
    await call('MCP', 'setMcpServerConfigs', { a: { command: 'a' }, b: { command: 'b' } });
    await call('MCP', 'setMcpServerConfigs', { b: { command: 'b' } });
    const readBack = await call('MCP', 'getMcpServersConfig');
    assert.equal(Object.hasOwn(readBack, 'a'), false, 'the removed server must be gone');
    assert.equal(Object.hasOwn(readBack, 'b'), true);
  } finally { restore(); }
});

test('an empty map is written, not ignored', async () => {
  const { configPath, call, restore } = makeBridge();
  try {
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { x: 1 }, mcpServers: { old: {} } }));
    await call('MCP', 'setMcpServerConfigs', {});
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.mcpServers, {}, 'clearing the list must be persisted');
    assert.deepEqual(after.preferences, { x: 1 }, 'and the rest must survive');
  } finally { restore(); }
});

test('an invalid argument is refused rather than reported as success', async () => {
  const { call, restore } = makeBridge();
  try {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      const result = await call('MCP', 'setMcpServerConfigs', bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    }
  } finally { restore(); }
});

test('a corrupt existing file is replaced without crashing', async () => {
  const { configPath, call, restore } = makeBridge();
  try {
    fs.writeFileSync(configPath, '{ this is not json');
    const result = await call('MCP', 'setMcpServerConfigs', { s: { command: 'x' } });
    assert.equal(result.ok, true);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.mcpServers, { s: { command: 'x' } });
  } finally { restore(); }
});

test('the write goes through a temp file and renames it into place', async () => {
  // Atomicity is what protects the real config: this file also holds deploymentMode and the
  // whole preferences tree, so a write interrupted mid-way must not leave a truncated file.
  //
  // Checking "no leftover temp file" is NOT enough -- a direct writeFileSync also leaves no
  // temp file. The distinguishing fact is that the content is staged in a temp file and
  // renamed over the target, so observe fs.renameSync directly rather than sampling the
  // directory (the write is far too fast to catch by polling).
  const { configPath, call, restore } = makeBridge();
  try {
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { a: 1 }, mcpServers: {} }));

    const realRename = fs.renameSync;
    const renames = [];
    fs.renameSync = (from, to) => {
      renames.push({ from: String(from), to: String(to) });
      return realRename(from, to);
    };
    try {
      await call('MCP', 'setMcpServerConfigs', { s: { command: 'x' } });
    } finally {
      fs.renameSync = realRename;
    }

    assert.equal(renames.length, 1, 'the write must be a single rename into place');
    assert.equal(renames[0].to, configPath, 'the rename target must be the real config');
    assert.ok(renames[0].from.includes('.tmp-'),
      `the source must be a temp file, got ${renames[0].from}`);

    // And nothing is left behind.
    const leftovers = fs.readdirSync(path.dirname(configPath)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally { restore(); }
});

test('revealConfig refuses when there is no config file', async () => {
  // It used to answer { ok: true } without revealing anything.
  const { configPath, call, restore } = makeBridge();
  try {
    fs.rmSync(configPath, { force: true });
    const result = await call('MCP', 'revealConfig');
    assert.equal(result.ok, false, 'it must not claim to have revealed a missing file');
  } finally { restore(); }
});

test('revealServerLog refuses without a server name', async () => {
  const { call, restore } = makeBridge();
  try {
    for (const bad of [undefined, null, '', 42]) {
      const result = await call('MCP', 'revealServerLog', bad);
      assert.equal(result.ok, false);
    }
  } finally { restore(); }
});

test('revealServerLog refuses a server with no log file', async () => {
  const { call, restore } = makeBridge();
  try {
    const result = await call('MCP', 'revealServerLog', 'no-such-server-r90');
    assert.equal(result.ok, false, 'it must not open an unrelated log');
  } finally { restore(); }
});

test('an unwritable config reports failure instead of claiming success', async () => {
  // MEASURED on this host: the Electron main process gets EPERM writing outside the
  // workspace, including %LOCALAPPDATA%\Claude-3p. Verified live:
  //   writeResult: { ok: false, error: "...EPERM...", code: "EPERM" }
  //   electron-node write failed: EPERM
  // The important property is that a failed write is REPORTED, not swallowed. This test
  // forces the failure by pointing the config at a path that cannot be created.
  const { call, restore } = makeBridge();
  const previous = process.env.LOCALAPPDATA;
  try {
    // A path under a file (not a directory) cannot be created on any platform.
    const blocker = path.join(os.tmpdir(), `fx-mcp-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'not a directory');
    process.env.LOCALAPPDATA = blocker;

    const result = await call('MCP', 'setMcpServerConfigs', { s: { command: 'x' } });
    assert.equal(result.ok, false, 'a write that cannot happen must not answer ok:true');
    assert.ok(result.error, 'the failure must carry a reason');
    assert.ok('code' in result, 'and the platform code, so the UI can explain it');
    fs.unlinkSync(blocker);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    restore();
  }
});
