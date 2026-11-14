// LocalSessions.getWorkingTreeDirtyState must answer with the UI's own enum member.
//
// The method had no handler, so the generic fallback answered `null`. Its only consumer
// (shared-11-D8DsEVkq.js, fn `Jp`) is:
//
//   queryFn: () => path
//     ? (U.getWorkingTreeDirtyState ? U.getWorkingTreeDirtyState(path)
//        : (await U.isWorkingTreeDirty?.(path)) ? Fe.Dirty : Fe.Clean)
//     : Fe.Clean
//   select: e => e !== Fe.Clean
//
// and `Fe` is the enum defined in shared-0-BRYCPbU4.js
//   Lx = function (e) { return e.Dirty = "dirty", e.Clean = "clean",
//                            e.Unknown = "unknown", e }({})
// exported as `e_` and imported into shared-11 as `Fe`.
//
// `null !== "clean"` is true, so answering null reports EVERY folder as dirty forever.
// This is the "constant does not match the consumer's enum" defect class again, and the
// first one where the wrong value was a plausible-looking absence rather than a wrong
// string.
//
// Measured on a live replica before the fix: answer null, consumer -> dirty, on a folder
// that is not even a git repository. After: answer "unknown".
//
// Handlers are registered with ipcMain.handle, so every call returns a promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

// The enum members, copied from the shipped bundle.
const CLEAN = 'clean';
const DIRTY = 'dirty';
const UNKNOWN = 'unknown';

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A committed repo with no pending changes. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clean-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('a clean repository answers "clean"', async () => {
  const { call } = makeBridge();
  const repo = makeRepo();
  assert.equal(await call('LocalSessions', 'getWorkingTreeDirtyState', repo), CLEAN);
});

test('an uncommitted edit answers "dirty"', async () => {
  const { call } = makeBridge();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  assert.equal(await call('LocalSessions', 'getWorkingTreeDirtyState', repo), DIRTY);
});

test('a staged new file answers "dirty"', async () => {
  const { call } = makeBridge();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git(repo, ['add', 'b.txt']);
  assert.equal(await call('LocalSessions', 'getWorkingTreeDirtyState', repo), DIRTY);
});

test('a folder that is not a repository answers "unknown", never "clean"', async () => {
  const { call } = makeBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-norepo-'));
  const answer = await call('LocalSessions', 'getWorkingTreeDirtyState', dir);
  assert.equal(answer, UNKNOWN);
  // Claiming "clean" here would be a fabricated success: cleanliness was never checked.
  assert.notEqual(answer, CLEAN);
});

test('a missing folder answers "unknown" rather than throwing', async () => {
  const { call } = makeBridge();
  const missing = path.join(os.tmpdir(), 'fx-does-not-exist-round72');
  assert.equal(await call('LocalSessions', 'getWorkingTreeDirtyState', missing), UNKNOWN);
});

test('no argument falls back to the working directory instead of crashing', async () => {
  const { call } = makeBridge();
  const answer = await call('LocalSessions', 'getWorkingTreeDirtyState');
  assert.ok([CLEAN, DIRTY, UNKNOWN].includes(answer), `unexpected answer: ${answer}`);
});

test('every answer is a member of the UI enum, so `!== clean` means something', async () => {
  // This is the defect stated as an assertion: the consumer only ever compares the
  // answer to the enum's Clean member. A value outside the enum (null, undefined, a
  // bare boolean) is silently "dirty forever".
  const { call } = makeBridge();
  const repo = makeRepo();
  const clean = await call('LocalSessions', 'getWorkingTreeDirtyState', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  const dirty = await call('LocalSessions', 'getWorkingTreeDirtyState', repo);
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-norepo2-'));

  const members = new Set([CLEAN, DIRTY, UNKNOWN]);
  for (const [label, value] of [
    ['clean repo', clean],
    ['dirty repo', dirty],
    ['not a repo', await call('LocalSessions', 'getWorkingTreeDirtyState', noRepo)],
  ]) {
    assert.ok(members.has(value), `${label}: ${JSON.stringify(value)} is not an enum member`);
  }

  // And the selector's own logic, replayed: only "clean" is falsy for "is dirty".
  const isDirty = (e) => e !== CLEAN;
  assert.equal(isDirty(clean), false, 'a clean repo must not be reported dirty');
  assert.equal(isDirty(dirty), true);
  assert.equal(isDirty(UNKNOWN), true, 'unknown is not clean, so it counts as dirty');
  assert.equal(isDirty(null), true, 'and this is exactly what null used to do');
});
