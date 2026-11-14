// R475: THE FRONTEND COMPOSER SENDS. The gate was the workspace-trust prompt, exactly as R474 said.
//
// THE CHAIN, READ FROM THE BRIDGE TRACE IN ONE RUN
//     [trace] claude.web.LocalSessions.checkTrust ["…\.tmp\r472-workspace"]
//     [trace] claude.web.LocalSessions.saveTrust  ["…\.tmp\r472-workspace"]
//     [trace] claude.web.LocalSessions.sendMessage ["local_f59b7601-…", "R475 trust v4", …]
//
//   Answering the dialog fires saveTrust; sendMessage follows immediately. That is the first
//   `sendMessage` entry any round has ever observed from the frontend, after six rounds of looking.
//
// AND THE COMPOSER RENDERED A TURN
//     [0] "R475 trust v4 | 显示消息操作"
//     [1] "R475 trust v4"
//     [2] "R475 trust v4"
//     [3] "R475 trust v4"
//     body tail: "Claude 正在回复 … 您说：R475 trust v4 … 正在发送…"
//
// TWO SEPARATE FINDINGS THAT MUST NOT BE CONFLATED
//
//   1. The trust prompt was the gate for the DIRECT submit path. R474 established it; R475 confirmed
//      it end to end and produced a real send.
//
//   2. CLICKING the send button still does nothing. Measured in the same run, side by side:
//          path A  click [data-testid=code-prompt-send]  ->  page text unchanged (diff empty)
//          path B  props.handleSubmit({preventDefault,stopPropagation})
//                                                          ->  the trust dialog appears
//      and the bundle explains the difference:
//          clickSteerOptions: () => _n.current && !bn.current && br.current ? {priority:"next"} : void 0
//          click handler:     (…) => { Date.now() - g.current < IM || p(m()) }
//      The click passes `m()` — the result of clickSteerOptions() — into handleSubmit. A bare call
//      passes nothing. So the two paths do not exercise the same code, and the click's branch does
//      not reach the dispatch in this state. That is a distinct, still-open defect.
//
// WHY THE FIRST ATTEMPT FAILED (worth keeping: it is the same class of error as R474's own)
//   v3 selected "any visible element whose innerText matches /信任工作区/". The whole dialog matched —
//   it is 392x203 and its innerText contains the heading — so the click landed on empty dialog space.
//   v4 enumerated candidates by AREA and took the smallest:
//       [0] span   own="信任工作区"  area=1186  rect=[705,461,64,19] kids=0   <- the label
//       [1] button own="信任工作区"  area=1867  rect=[697,458,79,24] kids=2   <- the control
//       [2] div    own="取消\n信任工作区" area=8298                          <- the button row
//   Clicking [0] propagated to the button and the dialog closed (hasTrustDialog false, editor cleared).
//   Picking the smallest visible match is what fixed it — the same "measure, then choose" habit that
//   R474's text diff required.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const v = (x) => x && x.result && x.result.value;

const SEND_CAP = path.join(TMP, 'answer-trust2-r475.json');
const COMPARE_CAP = path.join(TMP, 'click-vs-call-r475.json');

test('answering the trust prompt makes the frontend call sendMessage', (t) => {
  if (!fs.existsSync(SEND_CAP)) {
    t.skip('capture absent — run .tmp/answer-trust2-r475.cjs');
    return;
  }
  const cap = JSON.parse(read(SEND_CAP));

  // The trust button was found as a leaf and clicked.
  assert.ok((cap.steps || []).includes('clicked-trust-leaf'),
    'the run did not click the trust control');
  const chosen = cap.chosen || {};
  assert.equal(chosen.own, '信任工作区',
    'the clicked element was not the confirm control: ' + JSON.stringify(chosen));
  assert.ok(chosen.area < 3000,
    `the clicked element had area ${chosen.area}: that is the dialog container, not the control`);

  // The dialog closed and the draft was consumed.
  const after = v(cap.afterTrust) || {};
  assert.equal(after.hasTrustDialog, false, 'the trust dialog did not close');
  assert.equal(after.editorText, '', 'the draft was not consumed after trust was granted');

  // And the bridge saw a send.
  const sends = cap.sendMessageLines || [];
  assert.ok(sends.length >= 1,
    'no sendMessage appeared in the bridge trace even after trust — the finding does not hold');
  assert.match(sends[0], /LocalSessions\.sendMessage/,
    'the traced call is not LocalSessions.sendMessage: ' + sends[0].slice(0, 120));
  assert.match(sends[0], /local_f59b7601/, 'the send was not addressed to the session');

  // The turn rendered.
  const nodes = (v(cap.final) || {}).nodes || [];
  assert.ok(nodes.length >= 2,
    `only ${nodes.length} message nodes after send; expected at least the user turn`);
  assert.ok(nodes.some((m) => /R475 trust v4/.test(m)),
    'the sent text is not present in the transcript');
});

test('the trace shows checkTrust -> saveTrust -> sendMessage in that order', (t) => {
  if (!fs.existsSync(SEND_CAP)) {
    t.skip('capture absent');
    return;
  }
  const cap = JSON.parse(read(SEND_CAP));
  const lines = cap.turnLines || [];
  const idx = (re) => lines.findIndex((l) => re.test(l));

  const ci = idx(/LocalSessions\.checkTrust/);
  const si = idx(/LocalSessions\.saveTrust/);
  const mi = idx(/LocalSessions\.sendMessage/);

  assert.ok(ci >= 0, 'no checkTrust in the trace');
  assert.ok(si >= 0, 'no saveTrust in the trace');
  assert.ok(mi >= 0, 'no sendMessage in the trace');
  assert.ok(ci < si, 'saveTrust preceded checkTrust');
  assert.ok(si < mi, 'sendMessage preceded saveTrust: the ordering claim is wrong');
});

test('clicking the send button still does not submit, while a direct call does', (t) => {
  if (!fs.existsSync(COMPARE_CAP)) {
    t.skip('capture absent — run .tmp/click-vs-call-r475.cjs');
    return;
  }
  const cap = JSON.parse(read(COMPARE_CAP));
  assert.ok((cap.steps || []).includes('pathA-click'), 'path A (click) did not run');

  // Path A: nothing at all.
  const diffA = cap.diffA || {};
  assert.deepEqual(diffA.added, [], 'the click now changes the page: the defect may be fixed');
  assert.deepEqual(diffA.removed, [], 'the click now removes text');

  // Path B: the dialog.
  const diffB = cap.diffB || {};
  assert.ok((diffB.added || []).some((l) => /信任此工作区/.test(l)),
    'the direct call no longer opens the trust dialog, so the contrast is gone');

  // The reason the two paths differ, quoted from the live props.
  const props = v(cap.pathB) || {};
  const before = props.before || {};
  assert.equal(before.submitBlocked, false, 'submitBlocked is not false any more');
  assert.equal(before.clickSteerOptionsType, 'function',
    'clickSteerOptions is not a function: the click/direct asymmetry has a different cause now');
  assert.match(String(before.clickSteerOptionsSrc), /priority/,
    'clickSteerOptions no longer returns a priority object: re-derive the click branch');
});

test('the trust gate is upstream behaviour in the shipped frontend', () => {
  // The English wording lives in the bundle; the Chinese shown to the user comes from this project's
  // overlay. Keeping them separate avoids claiming a reconstruction feature as an upstream one.
  const assets = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
  const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  let upstream = 0;
  for (const f of files) {
    const body = fs.readFileSync(path.join(assets, f), 'utf8');
    if (/checkTrust|saveTrust/.test(body)) upstream += 1;
  }
  assert.ok(upstream > 0,
    'no checkTrust/saveTrust in the shipped bundle: the gate would be reconstructed behaviour');

  const zh = read(ROOT, 'resources', 'i18n-overlay', 'zh-Hans.json');
  assert.match(zh, /信任此工作区/, 'the overlay lost the Chinese trust wording');

  // And the bridge implements the two trust methods the frontend calls.
  const services = read(ROOT, 'desktop', 'bridge-services.cjs');
  assert.match(services, /LocalSessions_\$_checkTrust|checkTrust/, 'checkTrust is not implemented');
  assert.match(services, /LocalSessions_\$_saveTrust|saveTrust/, 'saveTrust is not implemented');
});
