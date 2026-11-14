// R472: the bridge can hold a conversation; the composer cannot. Two facts, cleanly separated.
//
// WHAT WAS ASSUMED AT THE END OF R471
//   "no workspace folder -> no session -> the composer refuses to send." That was a hypothesis with no
//   test. This round tested it, and it is WRONG: sessions now exist and the frontend sees them, and the
//   composer still emits no sendMessage.
//
// WHAT IS NOW MEASURED
//
//   1. LocalSessions.start({cwd}) creates a real session through the bridge. Returned object:
//        sessionId    "local_1ba507f2-bd2f-43dc-8939-ecbddce0f7a4"
//        cwd          …\.tmp\r472-workspace
//        cliSessionId "a26694e2-…"        kernelBackend "ccb"
//        model        "claude-sonnet-5-5" isRunning false   folderExists true
//
//   2. The created session appears in the list the FRONTEND reads:
//        before: 6 ids    created: local_f59b7601-…    after: 7 ids, createdVisible = true
//      And the sidebar stops saying "您启动的会话将显示在这里".
//
//   3. Sessions carry REAL transcripts. The sidebar shows a row titled
//        "R472 direct send"
//      — that is the message text R471 sent by calling LocalSessions.sendMessage directly. So the
//      bridge send path works end to end and its result is persisted and rendered in the session list.
//      The stats panel agrees: 会话 7 / Token 76 / 输入 11 / 输出 65.
//
//   4. The COMPOSER still does nothing. With sessions present, a sidebar row clicked, the editor
//      holding "R472 with sessions" and the send button enabled and really clicked:
//        messageNodes 0
//        sendMessage entries in the bridge trace: 0
//        editor text unchanged
//
//   So the composer's submit handler has a gate unrelated to session existence. The R471 explanation
//   is retired.
//
// A SEPARATE, REAL DEFECT FOUND ON THE WAY
//   CLAUDE_TRACE=all shows `LocalSessions` and `LocalAgentModeSessions` both backed by kernelBackend
//   "ccb" in MODE=demo. Yet the demo generator (server.mjs:186) is the loopback HTTP path, which the
//   app:// frontend never calls. So in the frontend view, MODE=demo selects a CCB backend that needs a
//   real CLI, not the local demo reply. That is why token counts appear from a previous run but no new
//   inference happens here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const v = (x) => x && x.result && x.result.value;

const SEND_CAP = path.join(TMP, 'session-send-r472.json');
const VIS_CAP = path.join(TMP, 'session-visibility-r472.json');
const COMP_CAP = path.join(TMP, 'composer-with-sessions-r472.json');

test('LocalSessions.start creates a real CCB-backed session through the bridge', (t) => {
  if (!fs.existsSync(SEND_CAP)) {
    t.skip('capture absent — run .tmp/session-send3-r472.cjs');
    return;
  }
  const cap = JSON.parse(read(SEND_CAP));
  const poll = (cap.polls || [])[0] || {};
  const results = poll.results || [];
  const start = results.find((r) => r.label === 'L.start');
  assert.ok(start, 'no L.start result recorded');
  assert.equal(start.ok, true, 'L.start failed: ' + JSON.stringify(start));

  const s = start.value || {};
  assert.match(String(s.sessionId), /^local_/,
    'the returned sessionId is not a local session id: ' + s.sessionId);
  assert.equal(s.kernelBackend, 'ccb',
    'the session is not backed by the ccb kernel: ' + s.kernelBackend);
  assert.match(String(s.cwd), /r472-workspace$/,
    'the session did not take the requested cwd: ' + s.cwd);
  assert.equal(s.folderExists, true, 'the session claims its folder does not exist');
  assert.ok(s.cliSessionId, 'no cliSessionId was assigned');
});

test('the created session is visible in the list the frontend reads', (t) => {
  if (!fs.existsSync(VIS_CAP)) {
    t.skip('capture absent — run .tmp/session-visibility-r472.cjs');
    return;
  }
  const cap = JSON.parse(read(VIS_CAP));
  const created = v(cap.createdId);
  assert.match(String(created), /^local_/,
    'no session id was captured from the create call: ' + created);

  const after = v(cap.afterLists) || {};
  assert.ok(after.Lcount > 6,
    `the list still has ${after.Lcount} entries; the new session did not appear`);
  assert.equal(after.createdVisibleInL, true,
    'the created id is absent from LocalSessions.getAll');
  assert.equal(after.createdVisibleInA, true,
    'the created id is absent from LocalAgentModeSessions.getAll');

  const dom = v(cap.dom) || {};
  assert.equal(dom.stillEmpty, false,
    'the sidebar still shows the empty-state message despite a session existing');
});

test('the composer still dispatches nothing even with sessions present', (t) => {
  if (!fs.existsSync(COMP_CAP)) {
    t.skip('capture absent — run .tmp/composer-sessions-r472.cjs');
    return;
  }
  const cap = JSON.parse(read(COMP_CAP));

  // Preconditions: a session row was clicked, the composer existed, the send button was enabled.
  assert.ok((cap.steps || []).includes('clicked-row'), 'no sidebar row was clicked');
  assert.ok((cap.steps || []).includes('clicked-send'), 'the send click did not happen');
  const after = v(cap.afterRowClick) || {};
  assert.equal(after.hasComposer, true, 'no composer after opening a session');
  assert.equal(after.hasSend, true, 'no send button');
  assert.equal(cap.sendButton && cap.sendButton.disabled, false,
    'the send button was disabled, which would explain the no-op differently');

  // The negative: nothing dispatched, nothing rendered, and the draft stayed put.
  assert.equal((cap.sendMessageLines || []).length, 0,
    'sendMessage appeared in the trace, so the composer DOES dispatch now — the finding changed');
  const post = v(cap.afterSend) || {};
  assert.equal(post.messageNodes, 0, 'message nodes appeared after the send click');
  assert.equal(post.editorText, 'R472 with sessions',
    'the editor cleared, which would mean the submit was accepted');
});

test('a session created via the bridge carries persisted messages', (t) => {
  if (!fs.existsSync(COMP_CAP)) {
    t.skip('capture absent');
    return;
  }
  const cap = JSON.parse(read(COMP_CAP));
  // The sidebar row titled with the text R471 sent through LocalSessions.sendMessage is the proof that
  // the bridge send path persists a transcript, as opposed to the composer path which persists nothing.
  const sidebar = v(cap.sidebar) || {};
  const texts = (sidebar.rows || []).map((r) => r.text || '');
  assert.ok(texts.some((x) => /R472 direct send/.test(x)),
    'the session titled with the R471 direct-send message is gone: the bridge-send persistence claim '
    + 'no longer has evidence. Rows seen: ' + JSON.stringify(texts.slice(0, 12)));
});

test('in the frontend view, MODE=demo does not route to the local demo reply', (t) => {
  // The loopback demo generator lives in server.mjs and is reached only by the handdrawn view (R470
  // proved that end of it). The frontend view creates sessions with kernelBackend "ccb", so the demo
  // reply is not what it would run. Pin the structural fact behind that.
  const main = read(ROOT, 'desktop', 'main.cjs');
  assert.match(main, /server = createApp\(\{/,
    'the loopback app is gone');
  assert.match(main, /useFrontend \? FRONTEND_URL : origin/,
    'the view switch changed');

  const services = read(ROOT, 'desktop', 'bridge-services.cjs');
  // Sessions created through the bridge go to the kernel, which is the ccb path.
  assert.match(services, /kernel\.sendMessage\(/,
    'bridge sends no longer reach a kernel');

  // kernelBackend is surfaced at RUNTIME on the session object, not as a literal in bridge-services —
  // asserting the literal there failed on the first attempt. Take it from the captured session instead,
  // which is the authority for what the frontend actually receives.
  if (!fs.existsSync(SEND_CAP)) {
    t.skip('capture absent, cannot read the runtime session shape');
    return;
  }
  const cap = JSON.parse(read(SEND_CAP));
  const poll = (cap.polls || [])[0] || {};
  const start = (poll.results || []).find((r) => r.label === 'L.start');
  assert.ok(start && start.value, 'no created session to inspect');
  assert.equal(start.value.kernelBackend, 'ccb',
    'the runtime session no longer reports a kernel backend, so ccb-vs-demo cannot be observed');
  // And the demo reply text never appears in a session object — it only exists in server.mjs.
  assert.ok(!JSON.stringify(start.value).includes('Demo 演示模式'),
    'the created session carries demo reply text, which would mean MODE=demo routed into the '
    + 'loopback generator after all');
});
