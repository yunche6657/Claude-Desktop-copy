// R638: `createConfig` gave every unnamed entry the same name, so the account menu filled with identical rows.
//
// WHAT WAS MEASURED IN THE LIVE LIBRARY
//       seven entries, all named "New config", all with an EMPTY body ({}), 0 fields each
//
//   The consumer does send a name (`n("new", formatMessage({defaultMessage:"Untitled"}))`), but it never arrives as
//   `options.name`, so every creation fell through to the same literal. The result is a list the user cannot read: rows
//   look identical, and selecting one applies an empty profile that fails configuration.
//
// THE FIX
//   A default name is made unique within the library, taking the smallest free ordinal. The ordinal skips names already
//   present, so a hand-named "New config 2" is never duplicated. An explicit name is always kept verbatim.
//
// HOW THIS IS TESTED
//   Through the REAL bridge: `registerBridgeServices` is given a fake `ipcMain` and a `bridgeMap` naming the
//   Custom3pSetup methods, then the registered channels are invoked the way the frontend invokes them. That exercises
//   the actual handler, not a copy of its logic.
//
// WHAT IS NOT CLAIMED
//   Not that empty bodies are fixed: an abandoned creation still leaves a row that cannot connect. The row is real (the
//   user asked for it), so it is kept and made legible rather than hidden.
//   Not that the frontend's label arrives: the fix makes the fallback safe, it does not repair whatever drops `options.name`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Boot the real bridge against a throwaway library and return the invoked channels. */
const harness = () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-r638-'));
  const lib = path.join(tmpRoot, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(lib, { recursive: true });

  const savedLocal = process.env.LOCALAPPDATA;
  const savedRoaming = process.env.APPDATA;
  process.env.LOCALAPPDATA = tmpRoot;
  process.env.APPDATA = path.join(tmpRoot, 'roaming');

  // Fresh module registry so each harness gets its own closure state.
  delete require.cache[require.resolve(path.join(ROOT, 'desktop', 'bridge-services.cjs'))];
  const B = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));

  const DOMAIN = 'claude.settings';
  const METHODS = ['listConfigs', 'createConfig', 'readConfig', 'writeConfig', 'setAppliedConfig', 'deleteConfig'];
  const registered = new Map();
  const ipcMain = { handle: (c, f) => registered.set(c, f), on: (c, f) => registered.set(c, f), removeHandler: () => {} };
  const noop = () => {};

  B.registerBridgeServices({
    ipcMain,
    bridgeMap: { [DOMAIN]: { Custom3pSetup: METHODS } },
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
  const meta = () => JSON.parse(fs.readFileSync(path.join(lib, '_meta.json'), 'utf8'));

  const cleanup = () => {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
    if (savedRoaming === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedRoaming;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return {
    lib,
    meta,
    cleanup,
    create: (opts = {}) => registered.get(channel('createConfig'))({}, opts),
    write: (id, body) => registered.get(channel('writeConfig'))({}, id, body),
    list: () => registered.get(channel('listConfigs'))({}),
    registered,
  };
};

test('three unnamed creations produce three distinct names', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = await h.create();
      assert.equal(r.ok, true, 'create failed: ' + JSON.stringify(r));
    }
    const names = h.meta().entries.map((e) => e.name);
    assert.equal(names.length, 3);
    assert.equal(new Set(names).size, 3, 'duplicate names remain: ' + JSON.stringify(names));
    assert.equal(names.filter((n) => n === 'New config').length, 1, 'the bare default should appear once');
  } finally { h.cleanup(); }
});

test('an ordinal skips a name the user already took', async () => {
  const h = harness();
  try {
    await h.create({ name: 'New config 2' });
    await h.create({ name: 'New config' });
    await h.create();
    const names = h.meta().entries.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, 'a generated name collided with a user name: ' + JSON.stringify(names));
    assert.ok(names.includes('New config 2'), 'the user name was overwritten');
  } finally { h.cleanup(); }
});

test('an explicit name is kept verbatim', async () => {
  const h = harness();
  try {
    await h.create({ name: 'my gateway' });
    assert.ok(h.meta().entries.map((e) => e.name).includes('my gateway'));
  } finally { h.cleanup(); }
});

test('a written gateway body round-trips, including inferenceModels', async () => {
  const h = harness();
  try {
    await h.create({ name: 'gw' });
    const id = h.meta().entries[0].id;
    const body = {
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'https://gw.example.test',
      inferenceGatewayApiKey: 'key-not-real',
      inferenceModels: ['claude-sonnet-4-5'],
    };
    const w = await h.write(id, body);
    assert.equal(w.ok, true, 'write refused: ' + JSON.stringify(w));
    const back = JSON.parse(fs.readFileSync(path.join(h.lib, id + '.json'), 'utf8'));
    assert.deepEqual(back.inferenceModels, ['claude-sonnet-4-5']);
    assert.equal(back.inferenceGatewayBaseUrl, 'https://gw.example.test');
  } finally { h.cleanup(); }
});

test('an empty library lists cleanly', async () => {
  const h = harness();
  try {
    const l = await h.list();
    assert.deepEqual(l.entries, []);
    assert.equal(l.appliedId, null);
  } finally { h.cleanup(); }
});

test('the source carries the uniqueness rule, not just the test', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(src, /takenNames/, 'the uniqueness set is missing');
  assert.match(src, /R638/, 'the repair is not annotated');
  assert.ok(!/\|\| 'New config';[\s\S]{0,120}meta\.entries\.push\(\{ id, name \}\);\n/.test(src.replace(/takenNames[\s\S]*?if \(takenNames\.has\(name\)\) \{[\s\S]*?\}\n/, '')),
    'createConfig still pushes the raw default name without deduplication');
});
