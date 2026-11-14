// R531: the approval release in cancel() — the one decision branch-mutation could not test because it needs no
// named file, only a session and a pending prompt.
//
// WHY THIS EXISTS APART FROM THE MUTATION TABLE
//   `cancel-approvals` mutates `resolveAllApprovals(sessionId, 'cancelled', 'deny')` inside cancel(). No test file
//   mentions that function, so tools/branch-mutation.cjs was given `tests: null` and the full suite — 15 minutes for
//   one row. This test makes the row cheap and, more importantly, specific: it asserts the observable consequence
//   rather than relying on some existing test happening to notice.
//
// THE LEAK THIS PINS
//   session-kernel.cjs:2140-2143 records the failure that motivated the line:
//       "A pending approval is not tied to a live controller: a tool can ask for permission while the turn is being
//        torn down, or a request can be raised with no running turn at all. Gating this behind `if (!controller)
//        return` left those waiters pending forever — the exact leak that hung a probe for minutes."
//
//   So the assertion is not "cancel returns ok". It is: a prompt raised before the cancel SETTLES, and settles as a
//   deny rather than a timeout or an allow. A prompt that settles as `timeout` would mean the release never ran and
//   only the 60s guard saved it — observably different, and the difference this test exists to catch.
//
// MEASURED BEFORE WRITING IT
//   A probe raised a prompt, cancelled, and printed the outcome: before cancel `pending`, after cancel `deny`. The
//   `timeout` label is preserved separately in the same code path, which is what makes `deny` a meaningful reading
//   rather than "it settled somehow".
//
// WHAT IS NOT CLAIMED
//   Not that this is the only thing cancel() releases: the withdraw path, the pending-turn path and the controller
//   abort each have their own tests. Not that an unattended prompt is handled correctly in the UI — only that the
//   kernel stops waiting. Not that the deny reason reaches the executor in the form it expects; the test reads the
//   decision string only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r531-'));
  const events = [];
  const backend = {
    id: 'stub',
    start: () => ({}),
    // Never settles: the turn stays alive so cancel() has a controller, and the prompt is genuinely outstanding.
    sendMessage: () => new Promise(() => {}),
    cancel: () => ({ ok: true }),
    onEvent: () => () => {},
    dispose: () => {},
    parkHeldSteers: () => {},
    getSteerUuids: () => [],
    withdrawSteer: () => true,
  };
  const kernel = createSessionKernel({
    backend, emit: (e) => events.push(e), storePath: path.join(dir, 'store.json'),
  });
  return {
    kernel,
    events,
    dir,
    close() { kernel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a pending approval is released by cancel, as a deny', async () => {
  const { kernel, events, close } = openKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    kernel.sendMessage(sessionId, 'A').catch(() => {});
    await sleep(40);

    // A long window so a settle cannot be the timeout guard doing the work.
    let outcome = 'pending';
    kernel.requestApproval(sessionId, { toolName: 'Bash', input: { command: 'ls' } }, { timeoutMs: 60000 })
      .then((d) => { outcome = d; }, (e) => { outcome = `rejected:${e && e.message}`; });
    await sleep(20);
    assert.equal(outcome, 'pending', 'the prompt settled before cancel: this test would prove nothing');

    kernel.cancel(sessionId);
    await sleep(60);

    assert.notEqual(outcome, 'pending',
      'the approval was still pending after cancel: resolveAllApprovals did not run, and only the 60s guard stands'
      + ' between this and the leak session-kernel.cjs:2140 describes');
    assert.equal(outcome, 'deny',
      `the approval settled as ${outcome}, not deny: a timeout means the release never ran`);
    // And the prompt was actually raised, so the setup was real.
    assert.equal(events.filter((e) => e.type === 'tool_permission_request').length, 1,
      'the permission request was never emitted: the setup did not exercise the path');
  } finally {
    close();
  }
});

test('cancel with no running turn still releases the prompt', async () => {
  // The comment at 2140 says a request can be raised with NO running turn at all — that is precisely the case the
  // old `if (!controller) return` skipped. So cancel() must release the prompt even when it returns ok:false.
  const { kernel, close } = openKernel();
  try {
    const { sessionId } = kernel.start({ cwd: ROOT });
    let outcome = 'pending';
    kernel.requestApproval(sessionId, { toolName: 'Bash', input: {} }, { timeoutMs: 60000 })
      .then((d) => { outcome = d; }, (e) => { outcome = `rejected:${e && e.message}`; });
    await sleep(20);
    assert.equal(outcome, 'pending', 'the prompt settled before cancel');

    const r = kernel.cancel(sessionId);
    assert.equal(r.ok, false, 'this scenario was meant to have no running turn');

    await sleep(60);
    assert.equal(outcome, 'deny',
      'no-running-turn cancel left the prompt pending: this is the leak the comment describes');
  } finally {
    close();
  }
});

test('the release is scoped to the cancelled session', async () => {
  // resolveAllApprovals filters by sessionId. Without that filter, cancelling one session would deny prompts belonging
  // to another — a silent cross-session effect that no amount of "did it settle" testing would reveal.
  const { kernel, close } = openKernel();
  try {
    const a = kernel.start({ cwd: ROOT }).sessionId;
    const b = kernel.start({ cwd: ROOT }).sessionId;
    kernel.sendMessage(a, 'A').catch(() => {});
    await sleep(40);

    let outcomeA = 'pending';
    let outcomeB = 'pending';
    kernel.requestApproval(a, { toolName: 'Bash', input: {} }, { timeoutMs: 60000 })
      .then((d) => { outcomeA = d; });
    kernel.requestApproval(b, { toolName: 'Bash', input: {} }, { timeoutMs: 60000 })
      .then((d) => { outcomeB = d; });
    await sleep(20);

    kernel.cancel(a);
    await sleep(60);
    assert.equal(outcomeA, 'deny', 'the cancelled session saw no release');
    assert.equal(outcomeB, 'pending',
      'cancelling one session released another session\'s prompt: the sessionId filter is gone');
  } finally {
    close();
  }
});
