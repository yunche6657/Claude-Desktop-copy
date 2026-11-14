// A pending approval cannot survive a restart, so it must not be restored.
//
// An approval request lives in the RUNNING kernel. When the process that owned it is
// gone, nothing can answer it: respondToToolPermission looks the request id up in memory
// and answers {ok:false, reason:'no such request'}. Restoring the field from disk
// therefore leaves the session stuck on "needs input" forever — measured: one session
// sat in that state for 34 minutes across three restarts, holding ["perm_1"].
//
// The loader already forces isRunning to false for exactly the same reason; the pending
// list has to follow, or the UI keeps offering to answer a request that cannot exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const STUB = () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } });

/** A store file holding one session that was waiting for approval when it died. */
function storeWithStaleApproval() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-approval-'));
  const storePath = path.join(dir, 'kernel-sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    version: 2,
    sessions: [{
      sessionId: 'local_stale',
      cwd: dir,
      workingDir: dir,
      originCwd: dir,
      title: 'stuck session',
      isRunning: false,
      pendingToolPermissions: [{ requestId: 'perm_1', toolName: 'Skill', input: { name: 'docx' } }],
    }],
    transcripts: {},
  }), 'utf8');
  return { dir, storePath };
}

test('a pending approval is not restored from disk', () => {
  const { dir, storePath } = storeWithStaleApproval();
  const kernel = createSessionKernel({ storePath, log: () => {}, createAgent: STUB });
  try {
    const session = kernel.getSession('local_stale');
    assert.ok(session, 'the session itself must still load');
    assert.deepEqual(session.pendingToolPermissions, [],
      'an approval from a dead process cannot be answered and must be dropped');
  } finally { kernel.dispose?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the rest of the session record survives the cleanup', () => {
  // The fix must not throw away the session, only the unanswerable request.
  const { dir, storePath } = storeWithStaleApproval();
  const kernel = createSessionKernel({ storePath, log: () => {}, createAgent: STUB });
  try {
    const session = kernel.getSession('local_stale');
    assert.equal(session.title, 'stuck session');
    assert.equal(session.isRunning, false);
    assert.equal(session.workingDir, dir, 'backfilled fields still apply');
  } finally { kernel.dispose?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('answering the dropped request is refused, not silently accepted', () => {
  // The old state made the UI believe there was something to answer.
  const { dir, storePath } = storeWithStaleApproval();
  const kernel = createSessionKernel({ storePath, log: () => {}, createAgent: STUB });
  try {
    const result = kernel.respondToApproval('perm_1', 'allow', null);
    assert.equal(result.ok, false, 'there is no such request in this process');
  } finally { kernel.dispose?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});