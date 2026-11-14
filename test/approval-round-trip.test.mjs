// The approval round trip on the kernel, including the edges that can hang a turn.
//
// MEASURED (all on a real kernel, no model involved):
//
//   allow              -> { ok: true, decision: 'allow' }, pending list emptied
//   deny               -> { ok: true, decision: 'deny' }
//   unknown requestId  -> { ok: false, reason: 'no such request' }
//   answer twice       -> the second answer is 'no such request', the first decision stands
//   nobody answers     -> decision 'timeout' after the deadline, plus a resolved event
//   cancel while open   -> decision 'deny', pending list emptied
//
// Two API shapes that cost real time to discover and are cheap to pin:
//   requestApproval(sessionId, request, { timeoutMs })      <- sessionId is FIRST
//   respondToApproval(requestId, decision, input)           <- POSITIONAL, not an object
// Passing an object to respondToApproval answers { ok: false, reason: 'no such request' },
// which looks exactly like a product bug and is not one.
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
  const storePath = path.join(os.tmpdir(), 'dsh-approval-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'x', stopReason: 'end_turn' }) }),
    storePath,
  });
  const session = kernel.start({ cwd: os.tmpdir() });
  return {
    kernel, session, events,
    pending: () => kernel.getSession(session.sessionId).pendingToolPermissions,
    cleanup: () => { try { fs.unlinkSync(storePath); } catch { /* gone */ } },
  };
}

test('a raised approval appears in pendingToolPermissions and can be allowed', async () => {
  const box = freshKernel();
  try {
    const ask = box.kernel.requestApproval(box.session.sessionId, { name: 'Write', input: { path: 'a.md' } });
    await new Promise((r) => setTimeout(r, 60));
    const list = box.pending();
    assert.equal(list.length, 1, 'the request never reached the session record');
    assert.match(list[0].requestId, /^perm_/);
    assert.equal(box.kernel.respondToApproval(list[0].requestId, 'allow').ok, true);
    assert.equal(await ask, 'allow');
    assert.deepEqual(box.pending(), [], 'the pending entry was not cleared after answering');
  } finally { box.cleanup(); }
});

test('deny resolves the waiter as deny', async () => {
  const box = freshKernel();
  try {
    const ask = box.kernel.requestApproval(box.session.sessionId, { name: 'Bash', input: { command: 'rm -rf /' } });
    await new Promise((r) => setTimeout(r, 60));
    box.kernel.respondToApproval(box.pending()[0].requestId, 'deny');
    assert.equal(await ask, 'deny');
  } finally { box.cleanup(); }
});

test('a prompt nobody answers times out instead of hanging the turn', async () => {
  // This is the hang that locked a session in an earlier round. The deadline must still fire,
  // so keep the event loop alive: the implementation unrefs its timer, which means a process
  // that does nothing else would exit before the timeout rather than hang.
  const box = freshKernel();
  const keepAlive = setInterval(() => {}, 50);
  try {
    const decision = await box.kernel.requestApproval(
      box.session.sessionId, { name: 'Write', input: {} }, { timeoutMs: 250 },
    );
    assert.equal(decision, 'timeout');
    assert.deepEqual(box.pending(), [], 'the timed-out request is still pending');
    const resolved = box.events.filter((e) => e.type === 'tool_permission_resolved');
    assert.equal(resolved.length, 1, 'no resolved event was emitted for the timeout');
    assert.equal(resolved[0].request.decision, 'timeout', 'the timeout lost its own label');
  } finally { clearInterval(keepAlive); box.cleanup(); }
});

test('cancelling while a prompt is open settles it', async () => {
  const box = freshKernel();
  const keepAlive = setInterval(() => {}, 50);
  try {
    const ask = box.kernel.requestApproval(box.session.sessionId, { name: 'Write', input: {} });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(box.pending().length, 1);
    box.kernel.cancel(box.session.sessionId);
    const decision = await Promise.race([ask, new Promise((r) => setTimeout(() => r('HANG'), 1500))]);
    assert.notEqual(decision, 'HANG', 'the prompt outlived the cancelled turn');
    assert.deepEqual(box.pending(), [], 'the cancelled prompt is still pending');
  } finally { clearInterval(keepAlive); box.cleanup(); }
});

test('answering twice cannot flip the first decision', async () => {
  const box = freshKernel();
  try {
    const ask = box.kernel.requestApproval(box.session.sessionId, { name: 'Write', input: {} });
    await new Promise((r) => setTimeout(r, 60));
    const id = box.pending()[0].requestId;
    assert.deepEqual(box.kernel.respondToApproval(id, 'allow'), { ok: true, decision: 'allow' });
    assert.deepEqual(box.kernel.respondToApproval(id, 'deny'), { ok: false, reason: 'no such request' });
    assert.equal(await ask, 'allow', 'the second answer overrode the first');
  } finally { box.cleanup(); }
});

test('an unknown request id is refused rather than silently accepted', async () => {
  const box = freshKernel();
  try {
    assert.deepEqual(box.kernel.respondToApproval('perm_does-not-exist', 'allow'),
      { ok: false, reason: 'no such request' });
  } finally { box.cleanup(); }
});

test('the resolution event carries the session and request ids the renderer looks up', async () => {
  // MEASURED consumer, shared-3-BCEbd8Fv.js and shared-11-_AVGLHEz.js:
  //   e.type === 'tool_permission_resolved' -> removePermission(t.sessionId, t.requestId)
  // where t = e.request. Only those two fields are read; the edited input is not.
  const box = freshKernel();
  try {
    const ask = box.kernel.requestApproval(box.session.sessionId, { name: 'Write', input: { path: 'a.md' } });
    await new Promise((r) => setTimeout(r, 60));
    const id = box.pending()[0].requestId;
    box.kernel.respondToApproval(id, 'allow');
    await ask;
    const resolved = box.events.filter((e) => e.type === 'tool_permission_resolved').pop();
    assert.ok(resolved && resolved.request, 'the resolved event has no request payload');
    assert.equal(resolved.request.requestId, id);
    assert.equal(resolved.request.sessionId, box.session.sessionId);
    assert.equal(resolved.request.decision, 'allow');
  } finally { box.cleanup(); }
});
