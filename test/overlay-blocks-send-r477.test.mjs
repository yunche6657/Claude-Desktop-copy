// R477: the send button is covered by the notification banner — a layout defect in this reconstruction.
//
// THE MECHANISM, PROVEN BY REMOVING THE CAUSE
//   Hit-testing the send button's centre (1108, 745) with the app idle:
//       top-most element = div, cls "flex min-w-0 flex-wrap items-start gap-y-sm gap-x-md flex-1"
//                          rect [808, 688, 332, 80]
//                          text "Claude 的通知已关闭。请在"系统设置"中启用通知… 打开系统设置"
//       relationToButton = "other"
//       button rect      = [1096, 733, 24, 24]
//   The banner box spans x 808..1140 and y 688..768, so the button at x 1096..1120, y 733..757 sits
//   entirely inside it. Every click aimed at send lands on the banner.
//
//   Then, in one run:
//       click with banner present   -> covered: true,  diff EMPTY, no sendMessage
//       hide the covering node      -> covered: false, topTag "span" (the button's own child)
//       click again                 -> diff shows "Claude 正在回复 / 您说：… / 正在发送…",
//                                      sendMessage ["local_f59b7601-…", "R477 before unblock", …]
//
//   Correlation became causation because the only change was hiding the cover.
//
// WHY THIS IS A RECONSTRUCTION DEFECT, NOT UPSTREAM DESIGN
//   The button is not disabled, has tabIndex 0, pointer-events auto, no inert ancestors, and its
//   onClick is attached (a wrapper: `(...t)=>{let n=t[0];return cn(n)&&on(n),e(...t)}`). Nothing about
//   the control refuses the click. A banner rendered on top of the composer's trailing controls is a
//   stacking/layout mistake in this build — the shipped app does not overlay its own send button.
//
// WHAT R475 GOT RIGHT AND WRONG
//   Right: the trust prompt is a real gate and answering it produces a send (via the direct path).
//   Wrong: it concluded the click path was a separate unexplained branch (`clickSteerOptions`
//   returning `priority:"next"`). The actual reason a click did nothing was simpler — the click never
//   reached the button. The queue hint in the composer ("按 Enter 发送，按 Ctrl+Enter 加入队列稍后
//   发送") shows `priority:"next"` is Ctrl+Enter's queue action, not the plain click, so that reading
//   was a red herring.
//
// SIX ROUNDS, ONE OVERLAY
//   R470-R476 all clicked at the button's centre and all found no dispatch. R473 even ran
//   elementFromPoint and got isSameOrChild TRUE — because on that run the banner was not yet shown
//   (it appears after the notification-permission check resolves). R477 reproduced the covered state
//   and named the cover. The lesson: a hit test is only valid for the state it ran in; re-run it at
//   the moment of the click, which is what finally exposed this.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const v = (x) => x && x.result && x.result.value;

const OVERLAY = path.join(TMP, 'overlay-r477.json');
const UNBLOCK = path.join(TMP, 'banner-unblock-r477.json');

test('the notification banner covers the send button', (t) => {
  if (!fs.existsSync(OVERLAY)) {
    t.skip('capture absent — run .tmp/overlay-r477.cjs');
    return;
  }
  const cap = JSON.parse(read(OVERLAY));
  const idle = v(cap.idle) || {};
  const top = idle.top || {};
  const btn = idle.buttonRect || [];

  assert.equal(idle.isButton, false,
    'the button is no longer covered: this defect may be fixed and the test should assert the new state');
  assert.equal(top.relationToButton, 'other',
    'the covering element is now a relative of the button: the geometry reasoning changes');
  assert.match(String(top.text), /通知已关闭/,
    'the covering element is not the notification banner: ' + JSON.stringify(String(top.text).slice(0, 80)));

  // Geometric containment: the button's rect lies inside the banner's rect.
  const [bx, by, bw, bh] = btn;
  const [ox, oy, ow, oh] = top.rect || [];
  assert.ok(bx >= ox && by >= oy && bx + bw <= ox + ow && by + bh <= oy + oh,
    `button [${btn}] is not inside banner [${top.rect}] — re-derive the overlap`);
});

test('hiding the banner makes the same click send', (t) => {
  if (!fs.existsSync(UNBLOCK)) {
    t.skip('capture absent — run .tmp/banner-unblock-r477.cjs');
    return;
  }
  const cap = JSON.parse(read(UNBLOCK));

  // Before: covered, and the click did nothing.
  const a = cap.sendButtonA || {};
  assert.equal(a.covered, true, 'the banner was not covering at click time in this run');
  assert.equal(a.topTag, 'div', 'the cover was not a div');
  assert.deepEqual((cap.diffBefore || {}).added, [],
    'the covered click changed the page: the before/after contrast is lost');

  // After: clear, and the click dispatched.
  const b = cap.sendButtonB || {};
  assert.equal(b.covered, false, 'the button was still covered after hiding the banner');
  assert.equal(b.topTag, 'span', 'the top-most element is not the button`s own child');

  const added = (cap.diffAfter || {}).added || [];
  assert.ok(added.some((l) => /Claude 正在回复/.test(l)),
    'no reply indicator after the unblocked click: ' + JSON.stringify(added.slice(0, 6)));
  assert.ok(added.some((l) => /您说：R477 before unblock/.test(l)),
    'the sent text did not appear in the transcript');

  assert.ok((cap.sendMessageLines || []).length >= 1,
    'no sendMessage after the unblocked click');
  assert.match(cap.sendMessageLines[0], /LocalSessions\.sendMessage/,
    'the traced call is not LocalSessions.sendMessage');

  // The steps must show the order, otherwise "after hiding" could mean something else.
  assert.deepEqual(cap.steps, ['open-session', 'click-with-banner', 'hid-banner', 'click-after-hide'],
    'the run did not follow the before/hide/after sequence: ' + JSON.stringify(cap.steps));
});

test('the send control itself is not refusing the click', (t) => {
  // Rules out the competing explanation: the button is live, so the cover is the only blocker.
  const cap = path.join(TMP, 'click-binding-r476.json');
  if (!fs.existsSync(cap)) {
    t.skip('capture absent — run .tmp/click-binding-r476.cjs');
    return;
  }
  const b = v(JSON.parse(read(cap)).binding) || {};
  assert.equal(b.disabled, false, 'the button reports disabled');
  assert.equal(b.ariaDisabled, null, 'the button is aria-disabled');
  assert.equal(b.pointerEvents, 'auto', 'the button has pointer-events:none');
  assert.equal(b.tabIndex, 0, 'the button is not focusable');
  assert.deepEqual(b.inertAncestors, [], 'an ancestor is inert / hidden');
  assert.equal(b.onClickType, 'function', 'the button has no onClick');
  // The handler is a wrapper, which is expected; what matters is that one exists.
  assert.match(String(b.onClickSrc), /=>/, 'onClick is not a function expression');
});
