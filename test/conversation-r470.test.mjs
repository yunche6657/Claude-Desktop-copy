// R470: the packaged app completes a conversation — on ONE of its two surfaces.
//
// THE DISTINCTION THIS ESTABLISHES
//   desktop/main.cjs serves two views:
//     handdrawn (default) — this project's own renderer/, served by server.mjs over loopback
//     frontend            — the shipped resources/ion-dist, served over app://
//
//   R464 proved the FRONTEND renders (237 KB DOM, real Chinese UI). It never proved the frontend can
//   send. This round found that it cannot: text reaches the editor, the send button is enabled and is
//   genuinely clicked, and no session is created.
//
//   The HANDDRAWN view, by contrast, completes a full turn:
//     [0] "R470 handdrawn 对话验证"
//     [1] "【Demo 演示模式】这是一段本地模拟回复，未调用真实 Claude CLI，未执行任何 shell 命令。
//          你发送的内容是：R470 handdrawn 对话验证
//          此结果仅用于演示会话、流式输出与取消操作。"
//     distinctLengths = 2  -> the reply arrived in more than one poll, i.e. it streams.
//
// WHY THE REPLY IS A DEMO REPLY, AND WHY THAT IS NOT A CHEAT
//     desktop/main.cjs:355   const mode = process.env.MODE || 'demo'
//     main.cjs:461           createApp({ mode, … })            -> server.mjs
//     server.mjs:186         the demo branch builds the reply locally
//     server.mjs:260         authentication: mode === 'demo' ? 'none' : 'explicit-environment'
//
//   So "can the app hold a conversation without credentials" has the answer YES, and until this round
//   no round had asked it — R463/R464 assumed credentials were required and stopped short. The demo
//   reply is the app's own designed behaviour, not a stub injected by the test.
//
// SIX WRONG DIAGNOSES ALONG THE WAY (recorded so they are not repeated)
//   1. searched `textarea` on the frontend — it is a tiptap ProseMirror div
//   2. assigned `.value` on that div — divs have no value
//   3. dispatched `new KeyboardEvent('keydown')` — untrusted events are ignored; Input.dispatchKeyEvent
//      is required
//   4. read the `sr-only` 1x1 span "方向键可移动图块…" as a stuck tile-mode indicator. It is permanent
//      screen-reader help text. Six attempts were spent sending Escape because of it.
//   5. put 10+ seconds of waiting inside one Runtime.evaluate with awaitPromise — never resolved
//   6. read a shrinking bodyLen as a page failure when it was my own "关闭" click working
//
//   The most costly is #4: a static accessibility string was treated as state, which sent the whole
//   investigation down a path that did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = path.resolve(ROOT, '..', '.tmp', 'handdrawn-turn-r470.json');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the handdrawn surface completed a streamed demo turn', (t) => {
  if (!fs.existsSync(CAPTURE)) {
    t.skip('capture absent — run .tmp/handdrawn-turn-r470.cjs to regenerate');
    return;
  }
  const cap = JSON.parse(read(CAPTURE));

  // The surface really was the loopback renderer, not the app:// frontend.
  assert.match(cap.surface.url, /^http:\/\/127\.0\.0\.1:\d+\/$/,
    'the capture is not from the handdrawn loopback surface: ' + cap.surface.url);
  assert.equal(cap.surface.title, 'Code Desktop');
  assert.equal(cap.surface.editables, 0,
    'contenteditable elements exist — this looks like the frontend surface, not handdrawn');

  // The composer is a textarea here, unlike the frontend's ProseMirror div. That asymmetry is the
  // reason selector-based driving broke earlier.
  const cands = cap.composerCandidates || [];
  assert.ok(cands.length > 0 && cands[0].name === '#hero-prompt',
    'the handdrawn composer moved: ' + JSON.stringify(cands));

  assert.equal(cap.sent, 'clicked:hero-send', 'the send did not happen: ' + cap.sent);

  const messages = (cap.final && cap.final.messages) || [];
  assert.equal(messages.length, 2,
    `expected one user + one assistant message, got ${messages.length}: ` + JSON.stringify(messages));

  // The user turn echoes what was typed.
  assert.match(messages[0], /handdrawn 对话验证/, 'the user message is not the prompt that was sent');

  // The assistant turn is the app's own demo reply, naming both the mode and the echoed input.
  assert.match(messages[1], /Demo 演示模式/,
    'the reply is not the demo generator output: ' + messages[1].slice(0, 120));
  assert.match(messages[1], /未调用真实 Claude CLI/,
    'the demo banner text changed — re-derive where the reply comes from');
  assert.match(messages[1], /R470 handdrawn 对话验证/,
    'the reply does not echo the user input, so it is not responding to this turn');

  // Streaming evidence: the assembled transcript length took more than one value across polls.
  assert.ok(cap.distinctLengths >= 2,
    'distinctLengths=' + cap.distinctLengths + ': the reply appeared in a single poll, so streaming '
    + 'is not demonstrated by this capture');
});

test('the demo mode needs no credentials, which is why this was testable at all', () => {
  const main = read(ROOT, 'desktop', 'main.cjs');
  assert.match(main, /const mode = process\.env\.MODE \|\| 'demo'/,
    'the default mode changed: the no-credential path may no longer exist');

  // Both the reply generator and the authentication exemption live in server.mjs, not main.cjs —
  // main.cjs only forwards `mode` into createApp. Asserting them against main.cjs was the first
  // version of this test and it failed for that reason.
  const server = read(ROOT, 'server.mjs');
  assert.match(server, /authentication: mode === 'demo' \? 'none' : 'explicit-environment'/,
    'the demo authentication exemption is gone');
  assert.match(server, /【Demo 演示模式】/,
    'the demo reply generator is gone — the capture above could not have come from it');

  // And main.cjs does hand the mode through.
  assert.match(main, /createApp\(\{[\s\S]{0,200}?mode,/,
    'main.cjs no longer passes mode into the loopback app: the demo branch would be unreachable');
});

test('the two surfaces are genuinely different code paths', () => {
  // This is the finding, not an implementation detail: the frontend view does not talk to server.mjs,
  // so "the frontend renders" and "the app can converse" are independent claims.
  const main = read(ROOT, 'desktop', 'main.cjs');

  // handdrawn is served by the loopback app created from server.mjs.
  assert.match(main, /server = createApp\(\{/,
    'the loopback app is gone: the handdrawn surface would have no backend');
  assert.match(main, /useFrontend \? FRONTEND_URL : origin/,
    'the view switch changed: re-derive which surface each URL refers to');

  // And the frontend URL is the app:// scheme, not the loopback origin.
  assert.match(main, /app:\/\/localhost\/epitaxy/,
    'the frontend URL changed');
});

test('the frontend surface renders but does not create a session', (t) => {
  // Recorded as a known limit, with the evidence that pins it.
  const frontendCapture = path.resolve(ROOT, '..', '.tmp', 'cdp-dom-r464.json');
  if (!fs.existsSync(frontendCapture)) {
    t.skip('R464 frontend capture absent');
    return;
  }
  const cap = JSON.parse(read(frontendCapture));
  const v = cap.value || {};
  // R464's evidence: the frontend DID render.
  assert.equal(cap.target.url, 'app://localhost/epitaxy?coldLaunch=1');
  assert.ok(v.htmlLength > 100_000, 'the frontend DOM capture no longer shows a rendered shell');

  // What R470 adds: sending there produced nothing. The capture from this round shows zero message
  // nodes after a real click on an enabled send button.
  const sendCapture = path.resolve(ROOT, '..', '.tmp', 'demo-turn-r470.json');
  if (!fs.existsSync(sendCapture)) {
    t.skip('R470 frontend send capture absent');
    return;
  }
  const send = JSON.parse(read(sendCapture));
  assert.ok(send.editorText && send.editorText.includes('R470'),
    'the frontend capture does not show text in the editor, so the send test is not described');
  assert.equal(send.sendBox && send.sendBox.disabled, false,
    'the send button was disabled, which would explain the no-op differently');
  assert.ok(send.steps.includes('real-click-send'),
    'no real click was dispatched: the negative result is not established');
  // The negative: nothing appeared.
  assert.equal(send.final && send.final.count, 0,
    'the frontend DID produce messages this time — the gap described here may be closed, so this '
    + 'test should be updated rather than kept as a known limitation');
});
