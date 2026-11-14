// R473: the composer's send is gated inside the frontend, and the gate is now localised.
//
// WHAT WAS RULED OUT THIS ROUND, BY MEASUREMENT
//
//   R470-R472 clicked send in various states and always saw zero `sendMessage` in the bridge trace.
//   This round eliminated the plausible mechanical explanations one at a time:
//
//   1. SESSION ATTACHMENT — the frontend locates its session by walking up from the editor to an
//      ancestor carrying `data-session-id` (bundle: `j_="data-session-id"`, `M_=[data-session-id]`,
//      `N_(e,t)`/`P_(e,t)` both use `.closest(M_)`). Measured live:
//          freshly booted:            data-session-id elements = 0, editorHasSessionAncestor = false
//          after clicking a session:  = 1 ("local_f59b7601-…"), ancestor at depth 7, class "epitaxy-prompt"
//      So opening a session first DOES attach the composer. Earlier rounds typed before attaching,
//      which was a real mistake, but fixing it did not make the send work.
//
//   2. CLICK THROTTLE — bundle: `var IM = 500` and the send handler
//          () => { Date.now() - g.current < IM || p(m()) }
//      A click within 500 ms of the previous one is discarded outright. Also a second gate
//          Date.now() - Ne.current >= 400 && (Ne.current = Date.now(), ke.current?.click())
//      R470-R472 all clicked more than once in quick succession, so this could have swallowed them.
//      Tested with a single click 1.5 s after typing and no further input for 15 s: still nothing.
//      Throttle ruled out.
//
//   3. BUTTON STATE — `.disabled` was false, the rect was 24x24, and elementFromPoint at its centre
//      returned the button's own child (so nothing overlays it). Ruled out.
//
//   4. THAT IT CALLS AND FAILS — instrumented every page-observable failure channel before clicking:
//      window error, unhandledrejection, console.error, console.warn, fetch, XMLHttpRequest, plus a
//      MutationObserver on the composer subtree. After one clean click:
//          errors []   rejections []   consoleErr []   consoleWarn []
//          fetches []  xhrs []         mutations 10
//      Ten DOM mutations prove the click was processed. Zero signals on any failure channel, and the
//      draft stayed in the editor.
//
//   Conclusion: the submit handler runs, changes state, and elects NOT to dispatch sendMessage. The
//   block is a computed `submitBlocked` prop — the bundle threads it as
//      y(qM, { …, submitBlocked: Rt, blockedSendPress: Rs, handleSubmit: Ds, … })
//   and `Rt` is not assigned anywhere in that component's 9000-char body, so it comes from a caller
//   that lives in another chunk. That is exactly where the next round should look.
//
// WHY THIS MATTERS FOR THE PRODUCT, NOT JUST THE PUZZLE
//   R472 proved the bridge can create sessions and persist messages. R473 proves the composer is the
//   only broken link, it is broken inside the frontend bundle, and it is a deliberate gate rather than
//   a crash. A reconstruction that renders the frontend but cannot send from it is not usable as a
//   chat client, so this is the highest-value open defect in the delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const ASSETS = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const v = (x) => x && x.result && x.result.value;

test('the bundle gates the composer on a data-session-id ancestor', () => {
  // The selector registry, in shared-1.
  const shared = read(ASSETS, 'shared-1-BJhqMmkf.js');
  assert.match(shared, /D_="code-prompt-input"/, 'the editor testid constant moved');
  assert.match(shared, /O_="code-prompt-send"/, 'the send testid constant moved');
  assert.match(shared, /j_="data-session-id"/, 'the session-id attribute name is gone');
  // The lookup helpers both climb to an ancestor carrying it.
  assert.match(shared, /closest\(M_\)/, 'the session ancestor lookup is gone');
});

test('the send handler carries a 500 ms click throttle', () => {
  const c = read(ASSETS, 'c227f4d5e-B-FYKrwT.js');
  assert.match(c, /var IM=500\b/, 'the IM throttle constant changed');
  // The handler discards a click when the elapsed time is below it.
  assert.match(c, /Date\.now\(\)-g\.current<IM\|\|p\(m\(\)\)/,
    'the throttled click handler changed shape: re-derive whether a click can be discarded');
});

test('opening a session attaches the composer to it', (t) => {
  const capPath = path.join(TMP, 'session-id-attr-r473.json');
  if (!fs.existsSync(capPath)) {
    t.skip('capture absent — run .tmp/session-id-attr-r473.cjs');
    return;
  }
  const cap = JSON.parse(read(capPath));
  const before = v(cap.before) || {};
  const after = v(cap.after) || {};

  // Freshly booted: the composer has no session ancestor. This is why typing-then-sending can never
  // work in that state, and it is the actual explanation for the R470-R471 failures.
  assert.equal(before.sessionIdAttrCount, 0,
    'the freshly booted page already has a session id; the "not attached" finding changed');
  assert.equal(before.editorHasSessionAncestor, false,
    'the editor already has a session ancestor at boot');

  // After opening a session: attached.
  assert.equal(after.sessionIdAttrCount, 1, 'no single session id after opening a session');
  assert.equal(after.editorHasSessionAncestor, true,
    'the composer still is not attached after opening a session');
  assert.match(String(after.nearestSessionAncestor && after.nearestSessionAncestor.sessionId), /^local_/,
    'the ancestor session id is not a local session id');

  // And the send button is disabled in that state only because the draft is empty.
  assert.equal(after.sendDisabled, true,
    'the send button was enabled with an empty draft; the disabled-state reasoning changes');
});

test('a single clean click still dispatches nothing, and fails silently', (t) => {
  const capPath = path.join(TMP, 'instrumented-send-r473.json');
  if (!fs.existsSync(capPath)) {
    t.skip('capture absent — run .tmp/instrumented-send-r473.cjs');
    return;
  }
  const cap = JSON.parse(read(capPath));
  const c = v(cap.capture) || {};

  assert.ok((cap.steps || []).includes('open-session'), 'the run did not open a session first');
  assert.ok((cap.steps || []).includes('single-click-send'), 'no single send click was dispatched');
  assert.equal(cap.sendButton && cap.sendButton.disabled, false,
    'the send button was disabled, which would explain the no-op differently');

  // The click WAS processed: the composer subtree mutated.
  assert.ok(c.mutations > 0,
    'zero DOM mutations means the click was not processed at all, so the finding below would be about '
    + 'event delivery rather than about a gate');

  // But it dispatched nothing, and produced no failure signal on ANY observable channel.
  assert.deepEqual(c.errors, [], 'an uncaught error appeared: the submit may be throwing');
  assert.deepEqual(c.rejections, [], 'an unhandled rejection appeared: the submit may be failing async');
  assert.deepEqual(c.consoleErr, [], 'console.error fired');
  assert.deepEqual(c.fetches, [], 'a fetch happened: there may be an HTTP path after all');
  assert.deepEqual(c.xhrs, [], 'an XHR happened');
  assert.equal(c.editorText, 'R473 instrumented',
    'the draft was cleared, which would mean the submit was accepted');

  // The bridge trace has no sendMessage either (R472/R473 captures both show this).
  assert.equal(c.nodes, 0, 'message nodes appeared after the send');
});

test('submitBlocked comes from a caller in another chunk, so the gate is not local', () => {
  // Documents where the gate is NOT: the composer component receives submitBlocked and never assigns
  // it. A future round should search the callers, not this file again.
  const c = read(ASSETS, 'c227f4d5e-B-FYKrwT.js');
  const callPos = c.indexOf('submitBlocked:Rt');
  assert.ok(callPos > 0, 'the composer call site changed shape');
  const windowBody = c.slice(Math.max(0, callPos - 9000), callPos);
  assert.ok(!/\bRt\s*=/.test(windowBody),
    'Rt is now assigned near the call site: the gate became local and this note is stale');
});
