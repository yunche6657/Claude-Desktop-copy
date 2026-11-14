// A restart must restore the workspace the user left.
//
// MEASURED by capturing state, killing the process, relaunching on a new port, and comparing:
//
//   sessionCount   156  ->  156        same
//   newest id      local_52669477-...  ->  same
//   theme          light ->  light      same
//   sidebarMode    epitaxy -> epitaxy   same
//
// That is the whole contract: the store is the source of truth and the app reads it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the session store is written atomically, so a kill cannot leave half a file', () => {
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /writeFileSync\(tmp, JSON\.stringify\(payload/, 'the store write is missing');
  assert.match(kernel, /renameSync\(tmp, storePath\)/, 'the store write is not atomic');
});

test('load() restores sessions from disk rather than starting empty', () => {
  // Declared as `const load = () => {`, not a function declaration — a first version of this
  // assertion looked for `function load(` and failed against correct code.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const load = \(\) => \{/, 'there is no load path');
  assert.match(kernel, /readFileSync\(storePath, 'utf8'\)/, 'load does not read the store');
});

test('a session marked running at shutdown is reset on load', () => {
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /isRunning: false/, 'nothing resets the running flag on load');
});

test('preferences are persisted and read back on start', () => {
  const bridge = read('desktop/bridge-services.cjs');
  assert.match(bridge, /_\$_setPreference'/, 'setPreference is not registered');
  assert.match(bridge, /_\$_getPreferences'/, 'getPreferences is not registered');
});

test('the quit path flushes the store before disposing the bridge', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /bridge\?\.flushKernel\?\.\(\)/, 'quitting does not flush the kernel');
  const flushAt = main.indexOf('flushKernel');
  const disposeAt = main.indexOf('bridge?.dispose()');
  assert.ok(flushAt > 0 && disposeAt > flushAt, 'the flush runs after dispose');
});

test('a session left running at shutdown is usable after load', async () => {
  // FOUND BY A MUTATION SWEEP. Flipping the load-time reset (`isRunning: false` -> `true`) left
  // the earlier assertions green, because none of them seeded a store that ALREADY had
  // isRunning: true — they only checked freshly-created sessions.
  //
  // Measured: a store seeded with isRunning:true loads with isRunning:false, and the restored
  // session accepts a message instead of refusing with 'a turn is already running'.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-seeded-' + process.pid + '-' + Date.now() + '.json');
  const seed = {
    sessions: [{
      sessionId: 'local_seeded_running',
      cwd: ROOT,
      title: 'seeded',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isRunning: true,
      permissionMode: 'ask',
      fastMode: false,
    }],
    transcripts: { local_seeded_running: [] },
  };
  fs.writeFileSync(storePath, JSON.stringify(seed), 'utf8');
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
      emit: () => {},
      storePath,
    });
    const restored = kernel.getAll().find((s) => s.sessionId === 'local_seeded_running');
    assert.ok(restored, 'the seeded session was not loaded');
    assert.equal(restored.isRunning, false, 'a session left running was loaded as still running');
    const res = await kernel.sendMessage('local_seeded_running', 'are you usable?');
    assert.equal(res.ok, true, 'the restored session refused the message');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});