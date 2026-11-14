// The "change folder" affordance rendered but did nothing.
//
// The gate is:
//   ic = e => { let t = e?.type === "local", n = rn(t ? e : null);
//               return t && !!b?.changeCwd && !!y?.browseFolder && n }
// where b = LocalSessions and y = FileSystem. Both methods were DECLARED, so the menu item
// appeared -- but changeCwd, browseFolder and browseFiles all answered null. Measured on the
// live replica:
//   gate { changeCwd: true, browseFolder: true, affordanceVisible: true }
//   browseFolder null, browseFiles null, changeCwd null
// Clicking the item therefore did nothing at all, which is worse than the item being absent:
// the user has no way to tell it is inert.
//
// The OS dialog cannot be opened in a test, so what is asserted here is the contract the
// caller depends on: a path string or null for "cancelled", and a { ok } object for the move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge(initialStore) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cwd-home-'));
  if (initialStore !== undefined) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(initialStore, null, 2));
  }
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
  };
  return { home, call, restore };
}

test('browseFolder exists and answers a path or null, never an object', async () => {
  // Under node there is no Electron dialog, so this exercises the "cannot show a dialog"
  // path -- which must still be a clean null rather than a throw or an object.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('FileSystem', 'browseFolder', 'Select folder');
    assert.ok(answer === null || typeof answer === 'string', `got ${typeof answer}`);
  } finally { restore(); }
});

test('browseFiles and browseFolders behave the same way', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const files = await call('FileSystem', 'browseFiles', 'Select files');
    const folders = await call('FileSystem', 'browseFolders', 'Select folders');
    assert.ok(files === null || Array.isArray(files), `browseFiles gave ${typeof files}`);
    assert.ok(folders === null || Array.isArray(folders), `browseFolders gave ${typeof folders}`);
  } finally { restore(); }
});

test('changeCwd answers an object the caller can read', async () => {
  // The caller reads `.ok` / the pending state; a null there would be read as a field access.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cwd-target-'));
    const answer = await call('LocalSessions', 'changeCwd', 'session-1', dir);
    assert.equal(typeof answer, 'object');
    assert.equal(typeof answer.ok, 'boolean');
  } finally { restore(); }
});

test('an untrusted folder parks the move instead of silently failing', async () => {
  // This is the pendingCwd / pendingCwdTrustPrompt path: the UI shows a confirmation, then
  // calls answerPendingCwdTrust.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cwd-untrusted-'));
    const answer = await call('LocalSessions', 'changeCwd', 'session-1', dir);
    assert.equal(answer.ok, false);
    assert.equal(answer.pending, true, 'an untrusted folder must park, not fail');
    assert.equal(answer.pendingCwd, dir);
  } finally { restore(); }
});

test('a trusted folder moves immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cwd-trusted-'));
  const key = dir.replace(/\\/g, '/');
  const { call, restore } = makeBridge({ projects: { [key]: { hasTrustDialogAccepted: true } } });
  try {
    const answer = await call('LocalSessions', 'changeCwd', 'session-1', dir);
    assert.equal(answer.ok, true);
    assert.equal(answer.cwd, dir);
  } finally { restore(); }
});

test('changeCwd refuses a path that is not a directory', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'changeCwd', 'session-1', 'C:\\definitely\\not\\here\\r84');
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, 'not a directory');
  } finally { restore(); }
});

test('changeCwd refuses a missing session or path', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    for (const [sid, cwd] of [[undefined, 'C:\\x'], ['s', undefined], ['', 'C:\\x'], ['s', '']]) {
      const answer = await call('LocalSessions', 'changeCwd', sid, cwd);
      assert.equal(answer.ok, false, `changeCwd(${JSON.stringify(sid)}, ${JSON.stringify(cwd)}) must refuse`);
    }
  } finally { restore(); }
});

test('answerPendingCwdTrust answers an object and accepts a prompt', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'answerPendingCwdTrust', 'session-1', 'prompt-1', true);
    assert.equal(typeof answer, 'object', 'must not be null');
    assert.equal(answer.ok, true);
    assert.equal(answer.accepted, true);
  } finally { restore(); }
});

test('answering "reject" does not grant trust', async () => {
  // This test has to make `cwd` RESOLVE, otherwise the trust-write branch is unreachable and
  // the assertion guards nothing -- which is exactly how an earlier version of it stayed
  // green while the implementation granted trust on reject.
  //
  // The handler resolves the folder from the kernel's session records, so start a session
  // first and then answer its prompt.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cwd-reject-'));
  const key = dir.replace(/\\/g, '/');
  const { call, home, restore } = makeBridge({ projects: {} });
  try {
    const started = await call('LocalAgentModeSessions', 'start', { cwd: dir, workingDir: dir });
    const sessionId = started && (started.sessionId || (started.session && started.session.sessionId));
    assert.ok(sessionId, 'the session must have started, or the test cannot reach the branch');

    // Reject. Nothing may be recorded as trusted.
    const answer = await call('LocalSessions', 'answerPendingCwdTrust', sessionId, 'prompt-1', false);
    assert.equal(answer.accepted, false);

    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const entry = raw.projects && raw.projects[key];
    assert.ok(!entry || entry.hasTrustDialogAccepted !== true, 'rejecting must not record trust');

    // And the accept path must actually write, so the difference is real.
    const accepted = await call('LocalSessions', 'answerPendingCwdTrust', sessionId, 'prompt-2', true);
    assert.equal(accepted.accepted, true);
    const after = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(after.projects[key].hasTrustDialogAccepted, true, 'accepting must record trust');
  } finally { restore(); }
});

test('answerPendingCwdTrust refuses a missing session id', async () => {
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const answer = await call('LocalSessions', 'answerPendingCwdTrust', '', 'p', true);
    assert.equal(answer.ok, false);
  } finally { restore(); }
});

test('the affordance gate now leads somewhere', async () => {
  // Replay the gate and then require that the methods behind it answer something usable.
  const { call, restore } = makeBridge({ projects: {} });
  try {
    const browse = await call('FileSystem', 'browseFolder', 't');
    const move = await call('LocalSessions', 'changeCwd', 'session-1', os.tmpdir());
    // browse is null here only because node has no Electron dialog; the important part is
    // that it is a clean null and that changeCwd answers an object rather than null.
    assert.ok(browse === null || typeof browse === 'string');
    assert.equal(typeof move, 'object');
    assert.notEqual(move, null);
  } finally { restore(); }
});
