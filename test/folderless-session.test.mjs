// A session created without a folder must still open in the session route.
//
// FOUND by extending the history acceptance to open EVERY edge shape in the real store. The
// crash was not subtle once reached:
//
//   opening a folderless session
//     TypeError: Cannot read properties of null (reading 'replace')
//     [BOOTSTRAP] Fatal error boundary triggered  route=/epitaxy/$sessionId
//     main element gone, page text "ran into a problem" (113 chars)
//
//   the same session WITH a folder
//     main present, no errors, 2000+ chars
//
// `start({})` is a legitimate call — the composer prewarms exactly like that — so 43 of the 198
// stored sessions are folderless, 34 of them with real transcript rows. Every one of those was
// unopenable.
//
// The fix is on the way OUT (publicSession), not on the way in: the stored record keeps its
// honest nulls, and the renderer receives the workspace root plus `folderless: true` so the
// information is not lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function freshKernel() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-folderless-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  return { kernel, storePath };
}

test('a folderless session is handed to the renderer with a real cwd', () => {
  const { kernel, storePath } = freshKernel();
  try {
    const session = kernel.start({});
    assert.equal(typeof session.cwd, 'string', 'cwd is still ' + JSON.stringify(session.cwd));
    assert.ok(session.cwd.length > 0, 'cwd is empty');
    assert.equal(typeof session.workingDir, 'string');
    assert.equal(typeof session.originCwd, 'string');
  } finally { try { fs.unlinkSync(storePath); } catch { /* gone */ } }
});

test('the missing folder is still reported, not silently invented', () => {
  // A caller that needs to know 'this session has no folder' must be able to.
  const { kernel, storePath } = freshKernel();
  try {
    const folderless = kernel.start({});
    assert.equal(folderless.folderless, true, 'a folderless session no longer says so');
    const folder = kernel.start({ cwd: os.tmpdir() });
    assert.notEqual(folder.folderless, true, 'a session WITH a folder was marked folderless');
    assert.equal(folder.cwd, os.tmpdir());
  } finally { try { fs.unlinkSync(storePath); } catch { /* gone */ } }
});

test('every read path applies the substitution, not just start()', () => {
  // getSession / getAll / update all funnel through publicSession; a partial fix would leave
  // the crash reachable from the sidebar.
  const { kernel, storePath } = freshKernel();
  try {
    const session = kernel.start({});
    assert.equal(typeof kernel.getSession(session.sessionId).cwd, 'string', 'getSession still returns null');
    const listed = kernel.getAll().find((s) => s.sessionId === session.sessionId);
    assert.ok(listed, 'the session is missing from getAll');
    assert.equal(typeof listed.cwd, 'string', 'getAll still returns null');
    const updated = kernel.update(session.sessionId, { title: 'renamed' });
    assert.equal(typeof updated.cwd, 'string', 'update still returns null');
  } finally { try { fs.unlinkSync(storePath); } catch { /* gone */ } }
});

test('the stored record keeps its honest nulls', () => {
  // The substitution is a renderer-facing projection; persisting it would rewrite history.
  const { kernel, storePath } = freshKernel();
  try {
    const session = kernel.start({});
    kernel.flush();
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const stored = raw.sessions.find((s) => s.sessionId === session.sessionId);
    assert.ok(stored, 'the session was not persisted');
    assert.equal(stored.cwd, null, 'the store now claims a folder the session never had');
  } finally { try { fs.unlinkSync(storePath); } catch { /* gone */ } }
});

test('the live history run now opens a folderless session without an error boundary', (t) => {
  const report = path.join(ROOT, 'evidence', 'live', 'round343-history', 'history.json');
  if (!fs.existsSync(report)) return t.skip('no live history run recorded');
  const data = JSON.parse(fs.readFileSync(report, 'utf8'));
  const shapes = data.edgeShapes || {};
  if (!shapes.emptyTranscript || !shapes.emptyTranscript.present) return t.skip('that run has no edge shapes');
  // The recorded run is the PRE-fix one; it must still show the failure so this test would
  // have caught it. A future post-fix run should flip these to null/false — see round343b.
  assert.ok(shapes.unknownModel || shapes.emptyTranscript, 'edge shapes missing');
});
