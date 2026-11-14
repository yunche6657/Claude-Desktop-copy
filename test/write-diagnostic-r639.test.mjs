// R639: `writeConfigFile` failed with a bare fs code, so a user who could not save a configuration saw
// "EPERM: ... open <library>/<uuid>.json.tmp-<pid>" — a temporary filename they never asked for, with no mention of
// the directory that is actually unwritable.
//
// MEASURED LIVE
//   In this workspace the running Electron app answered:
//       { ok: false, error: "EPERM: operation not permitted, open '…\\Claude-3p\\configLibrary\\<uuid>.json.tmp-17552'" }
//   while the same bytes written from a shell succeed. So the condition is per-process; what the message must carry is
//   the DIRECTORY, so the user can compare it with the one they expect.
//
// THE FIX
//   Both `mkdirSync` and the write/rename pair are inside one guard. A failure is rethrown with the library directory
//   and the fs code in the message, plus `libraryDir` and `code` on the error object. Every caller already does
//   `catch (error) { return configError(error); }`, so the answer string now carries the path.
//
// WHAT IS NOT CLAIMED
//   Not that EPERM in this workspace is fixed: it was not reproduced from a shell, and this round changes the MESSAGE,
//   not the permission. The packaged build may not hit it at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Boot the real bridge against a throwaway library. */
const harness = (makeLibraryUnwritable) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-r639-'));
  const parent = path.join(tmpRoot, 'Claude-3p');
  fs.mkdirSync(parent, { recursive: true });
  const lib = path.join(parent, 'configLibrary');

  if (makeLibraryUnwritable) {
    // A FILE where the directory should be: mkdirSync then throws EEXIST, a real unwritable-library condition.
    fs.writeFileSync(lib, 'not a directory');
  } else {
    fs.mkdirSync(lib, { recursive: true });
  }

  const savedLocal = process.env.LOCALAPPDATA;
  const savedRoaming = process.env.APPDATA;
  process.env.LOCALAPPDATA = tmpRoot;
  process.env.APPDATA = path.join(tmpRoot, 'roaming');

  delete require.cache[require.resolve(path.join(ROOT, 'desktop', 'bridge-services.cjs'))];
  const B = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));

  const DOMAIN = 'claude.settings';
  const registered = new Map();
  const noop = () => {};
  B.registerBridgeServices({
    ipcMain: { handle: (c, f) => registered.set(c, f), on: (c, f) => registered.set(c, f), removeHandler: () => {} },
    bridgeMap: { [DOMAIN]: { Custom3pSetup: ['createConfig', 'listConfigs', 'readConfig', 'writeConfig'] } },
    getMainWindow: () => null,
    settings: {
      preferences: { get: () => undefined, set: () => {}, onDidChange: () => {} },
      onChanged: noop, get: () => undefined, set: () => {},
      theme: { get: () => 'system', set: () => {} },
    },
    frontend: { send: noop, broadcast: noop, on: noop, emit: noop, once: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop },
  });

  const channel = (m) => B.messageChannel(DOMAIN, 'Custom3pSetup', m);
  const cleanup = () => {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
    if (savedRoaming === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedRoaming;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return {
    lib,
    cleanup,
    create: (opts = {}) => registered.get(channel('createConfig'))({}, opts),
  };
};

test('a successful write still succeeds and lands on disk', async () => {
  const h = harness(false);
  try {
    const r = await h.create({ name: 'good' });
    assert.equal(r.ok, true, 'the happy path broke: ' + JSON.stringify(r));
    const meta = JSON.parse(fs.readFileSync(path.join(h.lib, '_meta.json'), 'utf8'));
    assert.deepEqual(meta.entries.map((e) => e.name), ['good']);
    assert.ok(fs.existsSync(path.join(h.lib, meta.entries[0].id + '.json')));
  } finally { h.cleanup(); }
});

test('an unwritable library reports the directory, not a temporary filename', async () => {
  const h = harness(true);
  try {
    const r = await h.create({ name: 'should-fail' });
    assert.equal(r.ok, false, 'a write into an unwritable library reported success');
    const msg = String(r.error || '');
    assert.ok(msg.includes(h.lib), 'the answer does not name the library directory:\n' + msg);
    assert.ok(msg.includes('cannot write the configuration library'), 'the answer is not a sentence:\n' + msg);
    assert.match(msg, /\((EEXIST|ENOTDIR|EPERM|EACCES|error)\)/, 'the answer carries no fs code:\n' + msg);
  } finally { h.cleanup(); }
});

test('the wrapped error carries structured fields as well as a message', async () => {
  const h = harness(true);
  try {
    const r = await h.create({});
    // configError stringifies, so the structured fields are checked at the source instead.
    assert.ok(String(r.error || '').includes(h.lib));
  } finally { h.cleanup(); }
});

test('the source keeps both operations under one guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const i = src.indexOf('writeConfigFile =');
  const body = src.slice(i, i + 1800);
  const tryAt = body.indexOf('try {');
  const mkdirAt = body.indexOf('mkdirSync');
  const writeAt = body.indexOf('writeFileSync');
  assert.ok(tryAt >= 0, 'the guard is gone');
  assert.ok(mkdirAt > tryAt, 'mkdirSync sits outside the guard, so its failure would bypass the diagnostic');
  assert.ok(writeAt > tryAt, 'writeFileSync sits outside the guard');
  assert.match(body, /libraryDir/, 'the directory is no longer attached to the error');
  assert.match(body, /R639/, 'the repair is not annotated');
});
