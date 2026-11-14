// R474: FOUND IT. The send opens a workspace-trust dialog. Nothing was ever broken.
//
// THE ANSWER
//   Calling handleSubmit directly produced no sendMessage, no error and no cleared draft — but the
//   page text grew by exactly these lines:
//
//       信任此工作区？
//       Claude Code 可能会读取、写入或执行此文件夹中的文件。请仅在您信任此工作区时继续。
//       C:\Users\Administrator\Desktop\注册号 逆向\.tmp\r472-workspace
//       请阅读我们的安全指南以了解更多信息。
//       取消
//       信任工作区
//
//   That is a first-run trust confirmation for the session's cwd. The frontend asks the user to approve
//   the folder before it will send anything into a session rooted there. Until it is answered, the
//   composer leaves the draft in place and dispatches nothing.
//
// WHY FIVE ROUNDS MISSED IT
//   Every previous check looked for the OUTCOME of sending — message nodes, sendMessage in the bridge
//   trace, a cleared editor — and none looked at what appeared ON SCREEN. The dialog is rendered into
//   the same page, so `document.body.innerText` contained it the whole time; nobody diffed the text.
//   R473 even instrumented a MutationObserver on the composer subtree and saw "mutations: 10" — the
//   dialog opening WAS those mutations. The signal was recorded and misread as "click processed, no
//   effect".
//
// WHAT THIS MEANS FOR EVERY EARLIER NEGATIVE RESULT
//   R470-R473's "the composer dispatches nothing" is TRUE and is not a defect. The composer was asking
//   a legitimate question and no round answered it. R472's observation that the bridge can send directly
//   is also true — the bridge path bypasses this prompt because it targets an existing session rather
//   than starting a turn in a fresh folder.
//
// THE CORRECTION TO R473
//   R473 concluded "the submit handler elects not to dispatch — the gate is a computed submitBlocked
//   prop". The fiber read in R474 shows `submitBlocked: false`. That conclusion was wrong: the handler
//   DID dispatch, into a trust gate. The remaining R473 claims (session attachment via data-session-id,
//   the IM=500 throttle, no failure channel firing) all still hold and were each independently measured.
//
// PRODUCT MEANING
//   This is not a reconstruction defect at all — it is upstream behaviour faithfully reproduced. The
//   frontend refuses to act in an untrusted folder, exactly as the original does. The fix for a user is
//   to answer the dialog, not to change any code here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const v = (x) => x && x.result && x.result.value;

const DIFF_CAP = path.join(TMP, 'submit-diff-r474.json');
const PROPS_CAP = path.join(TMP, 'react-props-r474.json');

test('the submit opens a workspace-trust dialog, not a silent no-op', (t) => {
  if (!fs.existsSync(DIFF_CAP)) {
    t.skip('capture absent — run .tmp/submit-diff-r474.cjs');
    return;
  }
  const cap = JSON.parse(read(DIFF_CAP));
  assert.equal(v(cap.call) && v(cap.call).ok, true,
    'handleSubmit threw, so this is not the trust-dialog path');

  const diff = cap.diffTypedToAfter || {};
  const added = (diff.added || []).join('\n');

  // The dialog's own words. Assert each independently so a partial change is visible.
  assert.match(added, /信任此工作区/, 'the trust dialog heading is gone');
  assert.match(added, /可能会读取、写入或执行此文件夹中的文件/,
    'the trust dialog body text changed: re-derive what the prompt is asking');
  assert.match(added, /信任工作区/, 'the confirm action is gone');
  assert.match(added, /取消/, 'the cancel action is gone');
  // It names the folder it is asking about.
  assert.match(added, /r472-workspace/, 'the dialog does not name the session cwd');

  // And the draft is still there — consistent with "waiting for an answer", not with "sent".
  const state = v(cap.afterState) || {};
  assert.equal(state.editorText, 'R474 diff probe',
    'the draft was cleared, which would contradict the waiting-for-trust reading');
  assert.equal(state.nodes, 0, 'messages appeared without answering the dialog');
});

test('submitBlocked was false — R473s gate hypothesis was wrong', (t) => {
  if (!fs.existsSync(PROPS_CAP)) {
    t.skip('capture absent — run .tmp/react-props2-r474.cjs');
    return;
  }
  const cap = JSON.parse(read(PROPS_CAP));
  const walk = v(cap.walk) || {};
  const hit = (walk.hits || [])[0];
  assert.ok(hit, 'no fiber with submitBlocked was found');

  // The correction.
  assert.equal(hit.gates.submitBlocked, false,
    'submitBlocked is no longer false: the R474 correction is stale and the gate may be real again');
  assert.equal(hit.gates.busy, false, 'the composer reports busy');
  assert.equal(hit.gates.disabled, false, 'the composer reports disabled');
  assert.equal(hit.gates.submitQueued, false, 'a submit was queued');
  assert.equal(hit.gates.hasAttachments, false, 'unexpected attachments');

  // The session is attached, which is what makes the trust prompt meaningful.
  assert.match(String(hit.gates.composingSessionId), /^local_/,
    'composingSessionId is not set, so the session-attachment claim fails');

  // handleSubmit's real shape, so the dispatch chain is documented rather than inferred.
  assert.match(hit.handlers.handleSubmit, /personSent/,
    'handleSubmit changed shape: re-derive what it calls');
});

test('the trust dialog is upstream behaviour, localised by this project overlay', () => {
  // First attempt asserted the Chinese wording was in the ion-dist bundle. It is not — that assertion
  // failed and the failure is informative: the Chinese comes from this project's own overlay at
  // resources/i18n-overlay/zh-Hans.json, while the original English lives in the shipped frontend.
  // Keep the two separate so it is clear which part is upstream and which is ours.
  const assets = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
  const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  let upstream = 0;
  for (const f of files) {
    const body = fs.readFileSync(path.join(assets, f), 'utf8');
    if (/Do you trust|trust this workspace|Trust workspace/i.test(body)) upstream += 1;
  }
  assert.ok(upstream > 0,
    'no trust-dialog wording in the shipped bundle: the prompt would then be reconstructed behaviour '
    + 'rather than upstream, which changes the conclusion');

  // The English catalogue is the canonical source.
  const en = read(ROOT, 'resources', 'ion-dist', 'i18n', 'en-US.json');
  assert.match(en, /[Tt]rust/, 'the English catalogue has no trust entry');

  // And the Chinese shown to the user is ours.
  const zh = read(ROOT, 'resources', 'i18n-overlay', 'zh-Hans.json');
  assert.match(zh, /信任此工作区/, 'the overlay no longer supplies the Chinese trust wording');
});

test('hasTextStore is a store object, not a boolean', (t) => {
  if (!fs.existsSync(PROPS_CAP)) {
    t.skip('capture absent');
    return;
  }
  const cap = JSON.parse(read(PROPS_CAP));
  const hit = (v(cap.walk) || {}).hits && (v(cap.walk).hits || [])[0];
  const store = hit && hit.gates.hasTextStore;
  assert.ok(store && typeof store === 'object',
    'hasTextStore is no longer an object: the bundle computes Gk(store) on it, so this matters');
  // The store exposes the three members seen live.
  for (const k of ['readOutsideRender', 'set', 'subscribe']) {
    assert.ok(k in store, `hasTextStore lost its ${k} member`);
  }
});
