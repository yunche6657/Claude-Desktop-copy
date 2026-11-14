// LocalSessions.checkTrust must answer { trusted: boolean }, never null.
//
// Consumers dereference `.trusted` directly:
//   shared-19:   Qt.checkTrust(n).then(t => { e || i(t.trusted ? n : null) }).catch(...)
//   cc43287c9:   (await t(r.cwd)).trusted                    (fn Toe -- no catch)
//   c5a37dedf:   if (v.checkTrust && !(await v.checkTrust(e)).trusted) throw new Ne(...)
//                ("This folder isn't trusted yet. Open it from Claude Code first to trust it.")
//
// The last one is the local-code-session launch path and is NOT inside a `.catch`, so a null
// answer threw
//   TypeError: Cannot read properties of null (reading 'trusted')
// Measured on the live replica before the fix:
//   answer null
//   launchPath { ok: false, threw: "Cannot read properties of null (reading 'trusted')" }
//
// Trust is recorded by the real CLI in ~/.claude.json:
//   projects["<posix-style path>"].hasTrustDialogAccepted
//
// The tests below point HOME at a temporary directory so saveTrust never touches the real
// ~/.claude.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/**
 * Build a bridge whose ~/.claude.json lives in a temp dir.
 * `os.homedir()` is read at call time by the handler, so overriding HOME/USERPROFILE works.
 */
function makeBridge(initialStore) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-trust-home-'));
  if (initialStore !== undefined) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(initialStore, null, 2));
  }

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_TRUST_STORE: process.env.CLAUDE_TRUST_STORE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Trust writes go to a workspace overlay, not ~/.claude.json (the main process gets EPERM on
  // the home directory). Point it at this fixture so the real workspace file is never touched.
  process.env.CLAUDE_TRUST_STORE = path.join(home, 'trust-store.json');

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
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.CLAUDE_TRUST_STORE === undefined) delete process.env.CLAUDE_TRUST_STORE;
    else process.env.CLAUDE_TRUST_STORE = saved.CLAUDE_TRUST_STORE;
  };
  return { home, call, restore };
}

test('the answer is an object with a boolean `trusted`', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'checkTrust', 'C:\\some\\folder');
    assert.equal(typeof answer, 'object', 'must not be null: the caller reads .trusted');
    assert.equal(typeof answer.trusted, 'boolean');
  } finally { restore(); }
});

test('the answer carries `sources`, which the trust dialog reads', async () => {
  // This is the regression that crashed the renderer.
  //
  // The caller (ce2cf86ad, fn F) does:
  //   let a = await checkTrust(cwd, remote, opts);
  //   return a.trusted ? "accepted"
  //        : requestTrustOutcome(cwd, a.sources, remote, { gateId });
  // and the dialog (c165c93f1, fn Z) then does `sources.length`.
  //
  // Omitting `sources` made it undefined and the app died with
  //   TypeError: Cannot read properties of undefined (reading 'length')
  // stuck on "This page ran into a problem", no composer. Measured live before the fix.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    for (const cwd of ['C:\\some\\folder', 'C:\\accepted\\folder', undefined, null, '']) {
      const answer = await call('LocalSessions', 'checkTrust', cwd);
      assert.ok(Array.isArray(answer.sources), `checkTrust(${JSON.stringify(cwd)}).sources must be an array`);
      assert.doesNotThrow(() => answer.sources.length, 'the dialog calls .length on it');
    }
  } finally { restore(); }
});

test('a trusted folder also reports sources', async () => {
  const { call, restore } = makeBridge({
    projects: { 'C:/yes/folder': { hasTrustDialogAccepted: true } },
  });
  try {
    const answer = await call('LocalSessions', 'checkTrust', 'C:\\yes\\folder');
    assert.equal(answer.trusted, true);
    assert.ok(Array.isArray(answer.sources), 'the trusted path must carry sources too');
  } finally { restore(); }
});

test('checkStoredTrust carries sources as well', async () => {
  // Same contract on the sibling method; the store view reads the same field.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'checkStoredTrust', 'C:\\some\\folder');
    assert.ok(Array.isArray(answer.sources));
  } finally { restore(); }
});

test('the launch path no longer throws', async () => {
  // This is the exact expression that threw: `!(await checkTrust(e)).trusted`.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    let threw = null;
    try {
      // eslint-disable-next-line no-unused-expressions
      !(await call('LocalSessions', 'checkTrust', 'C:\\some\\folder')).trusted;
    } catch (e) { threw = e; }
    assert.equal(threw, null, `the launch path must not throw, got: ${threw && threw.message}`);
  } finally { restore(); }
});

test('a folder with no entry is reported not trusted', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'checkTrust', 'C:\\never\\seen');
    assert.equal(answer.trusted, false);
  } finally { restore(); }
});

test('an accepted folder is reported trusted', async () => {
  // The CLI keys projects by forward-slash paths.
  const { call, restore } = makeBridge({
    projects: { 'C:/accepted/folder': { hasTrustDialogAccepted: true } },
  });
  try {
    const answer = await call('LocalSessions', 'checkTrust', 'C:\\accepted\\folder');
    assert.equal(answer.trusted, true, 'backslash cwd must map to the forward-slash key');
  } finally { restore(); }
});

test('an entry without the flag is not trusted', async () => {
  const { call, restore } = makeBridge({
    projects: { 'C:/partial/folder': { allowedTools: [] } },
  });
  try {
    const answer = await call('LocalSessions', 'checkTrust', 'C:\\partial\\folder');
    assert.equal(answer.trusted, false, 'a project entry alone does not imply trust');
  } finally { restore(); }
});

test('a corrupt store answers not-trusted instead of throwing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-trust-bad-'));
  fs.writeFileSync(path.join(home, '.claude.json'), '{ this is not json');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;

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
  const channel = [...handlers.keys()].find((c) => c.endsWith('_checkTrust'));
  try {
    const answer = await handlers.get(channel)({}, 'C:\\x');
    assert.equal(answer.trusted, false);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
  }
});

test('a missing cwd is not trusted and does not throw', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    for (const bad of [undefined, null, '', 42]) {
      const answer = await call('LocalSessions', 'checkTrust', bad);
      assert.equal(answer.trusted, false, `checkTrust(${JSON.stringify(bad)}) must not trust`);
    }
  } finally { restore(); }
});

test('saveTrust persists and checkTrust reads it back', async () => {
  // A check that cannot be saved is half a feature: the user would be asked again on every
  // restart.
  const { call, home, restore } = makeBridge({ projects: {} });
  try {
    const before = await call('LocalSessions', 'checkTrust', 'C:\\fresh\\project');
    assert.equal(before.trusted, false);

    const saved = await call('LocalSessions', 'saveTrust', 'C:\\fresh\\project', true);
    assert.equal(saved.ok, true);
    assert.equal(saved.trusted, true);

    const after = await call('LocalSessions', 'checkTrust', 'C:\\fresh\\project');
    assert.equal(after.trusted, true, 'the saved decision must be readable');

    // And it must really be on disk. It lands in the overlay: the main process cannot write
    // ~/.claude.json (EPERM), so writing there reported success while changing nothing.
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'trust-store.json'), 'utf8'));
    assert.equal(raw.projects['C:/fresh/project'].hasTrustDialogAccepted, true);
  } finally { restore(); }
});

test('saveTrust can also revoke', async () => {
  const { call, restore } = makeBridge({
    projects: { 'C:/revoke/me': { hasTrustDialogAccepted: true } },
  });
  try {
    assert.equal((await call('LocalSessions', 'checkTrust', 'C:\\revoke\\me')).trusted, true);
    const saved = await call('LocalSessions', 'saveTrust', 'C:\\revoke\\me', false);
    assert.equal(saved.trusted, false);
    assert.equal((await call('LocalSessions', 'checkTrust', 'C:\\revoke\\me')).trusted, false);
  } finally { restore(); }
});

test('saveTrust preserves unrelated keys in the store', async () => {
  // ~/.claude.json holds much more than trust; a naive rewrite would destroy it.
  const { call, home, restore } = makeBridge({
    machineID: 'abc123',
    projects: { 'C:/keep/this': { allowedTools: ['Bash'] } },
  });
  try {
    await call('LocalSessions', 'saveTrust', 'C:\\new\\one', true);
    // Only our own answers are written; the CLI file stays untouched and is merged on read.
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'trust-store.json'), 'utf8'));
    assert.equal(raw.projects['C:/new/one'].hasTrustDialogAccepted, true);
    // The CLI file must be byte-identical: we never write it.
    const cli = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cli.machineID, 'abc123', 'the CLI file must be left alone');
    assert.deepEqual(cli.projects['C:/keep/this'].allowedTools, ['Bash']);
  } finally { restore(); }
});