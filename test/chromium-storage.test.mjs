// Chromium's own storage must live somewhere this process can actually write.
//
// Measured before the fix: IndexedDB was completely dead in the renderer.
//
//   indexedDB.databases()          -> UnknownError
//   indexedDB.open('probe-db', 1)  -> UnknownError: Internal error.
//
// and every mount logged it:
//
//   [frontend:warning] [LOCAL_STORAGE] IndexedDB state read rejected; continuing without
//   persisted state {"name":"dframe-starred-code","error":"UnknownError"}
//
// 「continuing without persisted state」 means the renderer's own stores — starred sessions,
// session groups, pinned projects, task cards — silently lose everything on reload.
//
// The cause is the same one already documented at resolveStorePath: Electron's main process
// cannot write under the default userData on this host, and Chromium keeps IndexedDB there.
// Plain node CAN write there (measured), so it is a property of the Electron process.
//
// After app.setPath('userData', <workspace>/.data/chromium) before app.whenReady():
//   indexedDB.databases() -> [{"name":"keyval-store"}]
//   indexedDB.open(...)   -> ok, and the database survives a reload
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

test('the app relocates Chromium storage to a writable directory', () => {
  assert.match(MAIN, /app\.setPath\('userData'/, 'userData is never relocated; IndexedDB stays broken');
});

test('the relocation happens before app.whenReady', () => {
  // setPath after the app is ready has no effect on the storage partitions.
  const setPathAt = MAIN.indexOf("app.setPath('userData'");
  const readyAt = MAIN.indexOf('app.whenReady().then(');
  assert.ok(setPathAt > 0, 'the relocation is missing');
  assert.ok(readyAt > 0, 'app.whenReady is missing');
  assert.ok(setPathAt < readyAt, 'the relocation runs after ready, so it cannot take effect');
});

test('the target directory is proved writable before it is used', () => {
  // Same discipline as resolveStorePath: never assume, measure. A read-only workspace must
  // leave the default in place rather than point Chromium at a directory it cannot use.
  const at = MAIN.indexOf('(function relocateChromiumStorage()');
  assert.ok(at > 0, 'the relocation helper is missing');
  const block = MAIN.slice(at, at + 1200);
  assert.match(block, /writeFileSync\(probe/, 'no write probe before relocating');
  assert.match(block, /catch/, 'no fallback when the probe fails');
});

test('fresh workspace creates every Chromium path before asking Electron to use it', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-paths-'));
  const assigned = new Map();
  const start = MAIN.indexOf('(function relocateChromiumStorage()');
  const end = MAIN.indexOf('})();', start) + 5;
  try {
    vm.runInNewContext(MAIN.slice(start, end), { fs, path, console, process: { env: { CLAUDE_WORKSPACE: workspace }, pid: process.pid },
      app: { setPath(name, directory) { if (!fs.existsSync(directory)) throw new Error('Directory does not exist'); assigned.set(name, directory); } } });
    for (const name of ['userData', 'sessionData', 'cache', 'temp', 'crashDumps']) assert.ok(assigned.has(name), name);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('the relocation covers cache and session data, not only userData', () => {
  // Chromium keeps blobs in sessionData and cache; leaving those behind reintroduces the
  // same failure on a different root.
  const at = MAIN.indexOf("app.setPath('userData'");
  const block = MAIN.slice(at, at + 900);
  for (const name of ['sessionData', 'cache']) {
    assert.ok(block.includes("'" + name + "'"), 'the relocation skips ' + name);
  }
});
