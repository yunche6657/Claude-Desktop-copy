// The session record must carry the directory under the names the frontend reads.
//
// The Files pane resolves its tree root as (cccc2cf0a-JnTR9JZB.js, `Nx`):
//   A = lister?.root ?? data?.workingDir ?? landingRoot ?? ""
// With no lister and no landingRoot, a missing `workingDir` makes the root "" and the tree
// renders "Folder is empty" — while FileSystem.listDirectory answers 65 entries for the
// same path. Measured on a running replica before the fix: workingDir absent, tree empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const okAgent = () => ({
  model: 's',
  tools: [],
  async run() { return { text: '', stopReason: 'end_turn' }; },
});

function kernelAt(storePath) {
  return createSessionKernel({ emit: () => {}, createAgent: okAgent, storePath });
}

test('a new session carries workingDir and originCwd, not just cwd', async () => {
  const kernel = createSessionKernel({ emit: () => {}, createAgent: okAgent });
  const s = kernel.start({ cwd: 'C:\\work\\proj' });

  assert.equal(s.cwd, 'C:\\work\\proj');
  // The tree reads workingDir; session details read originCwd.
  assert.equal(s.workingDir, 'C:\\work\\proj');
  assert.equal(s.originCwd, 'C:\\work\\proj');
});

test('the three directory names always agree', async () => {
  // Divergence would be worse than absence: the tree would list one folder while the
  // transcript's paths resolve against another.
  const kernel = createSessionKernel({ emit: () => {}, createAgent: okAgent });
  for (const dir of ['C:\\a', 'C:\\a\\b', '/tmp/x']) {
    const s = kernel.start({ cwd: dir });
    assert.equal(s.workingDir, s.cwd, dir);
    assert.equal(s.originCwd, s.cwd, dir);
  }
});

test('a session with no cwd NEVER reports a stray empty string', async () => {
  // The original point stands: "" produced an empty tree, so it must never be used to mean
  // 'no directory'. The renderer-facing value is now the workspace root (round 343): a null
  // cwd crashed the whole session route with
  //   TypeError: Cannot read properties of null (reading 'replace')
  // so publicSession substitutes a real path and marks the record `folderless`. The STORE
  // still keeps its honest null — that half is asserted in folderless-session.test.mjs.
  const kernel = createSessionKernel({ emit: () => {}, createAgent: okAgent });
  const s = kernel.start({});
  for (const key of ['cwd', 'workingDir', 'originCwd']) {
    assert.notEqual(s[key], '', key + ' is an empty string, which renders an empty tree');
    assert.equal(typeof s[key], 'string', key + ' is not a usable path: ' + JSON.stringify(s[key]));
    assert.ok(s[key].length > 0);
  }
  assert.equal(s.folderless, true, 'the record no longer says it has no folder');
});

test('records written before these fields existed are backfilled on load', async () => {
  // A store from an older build has cwd but no workingDir. Without a backfill those
  // sessions keep an empty Files tree forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const legacy = {
    version: 1,
    savedAt: Date.now(),
    sessions: [
      { sessionId: 'local_legacy-1', cwd: 'C:\\legacy\\path', isArchived: false, isStarred: false },
      { sessionId: 'local_legacy-2', cwd: null, isArchived: false, isStarred: false },
    ],
    transcripts: {},
  };
  fs.writeFileSync(storePath, JSON.stringify(legacy));

  const kernel = kernelAt(storePath);
  const a = kernel.getSession('local_legacy-1');
  assert.equal(a.workingDir, 'C:\\legacy\\path', 'backfilled from cwd');
  assert.equal(a.originCwd, 'C:\\legacy\\path');

  const b = kernel.getSession('local_legacy-2');
  // Round 343: the renderer-facing projection supplies the workspace root for a null cwd
  // (a null crashed the route). The invariant this test protects is unchanged — the value
  // must never be "", which is what rendered an empty file tree.
  assert.notEqual(b.workingDir, '', 'a null cwd backfilled to an empty string');
  assert.notEqual(b.originCwd, '');
  assert.equal(typeof b.workingDir, 'string');
  assert.equal(typeof b.originCwd, 'string');
  assert.equal(b.folderless, true, 'the record lost its folderless marker');
});

test('a backfilled record keeps its other fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    sessions: [{
      sessionId: 'local_keep-1',
      cwd: 'C:\\keep',
      title: 'a title',
      titleSource: 'user',
      permissionMode: 'plan',
      isStarred: true,
      isArchived: false,
    }],
    transcripts: {},
  }));

  const rec = kernelAt(storePath).getSession('local_keep-1');
  assert.equal(rec.title, 'a title');
  assert.equal(rec.titleSource, 'user');
  assert.equal(rec.permissionMode, 'plan');
  assert.equal(rec.isStarred, true);
  assert.equal(rec.workingDir, 'C:\\keep');
});

test('the backfill is written to disk, not just held in memory', async () => {
  // A backfill that never reaches the file is re-derived on every start and leaves the
  // store permanently missing the field — which is what happened first: the running app
  // answered workingDir correctly while all 53 records on disk still lacked it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    sessions: [{ sessionId: 'local_persist-1', cwd: 'C:\\persist', isArchived: false, isStarred: false }],
    transcripts: {},
  }));

  const kernel = kernelAt(storePath);
  assert.equal(kernel.getSession('local_persist-1').workingDir, 'C:\\persist');
  kernel.flush();

  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const rec = raw.sessions.find((s) => s.sessionId === 'local_persist-1');
  assert.equal(rec.workingDir, 'C:\\persist', 'the field must be on disk');
  assert.equal(rec.originCwd, 'C:\\persist');

  // A second load must find the fields already present, so nothing is backfilled again.
  const second = kernelAt(storePath);
  assert.equal(second.getSession('local_persist-1').workingDir, 'C:\\persist');
});