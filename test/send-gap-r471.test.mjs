// R471: the frontend send path is implemented and reachable — the composer never reaches it because
// no workspace folder is selected, so no session exists to send into.
//
// THE CHAIN, MEASURED FROM THE RUNNING APP
//   1. The preload exposes 8 domains / 76 services under window['claude.web'].
//      Both send methods exist there: LocalSessions.sendMessage and LocalAgentModeSessions.sendMessage.
//
//   2. CLAUDE_TRACE=all, one send attempt (type into [data-testid=code-prompt-input], real CDP click on
//      [data-testid=code-prompt-send]):
//          fallback channels logged: 29
//          sendMessage entries logged: 0
//      So the click does NOT reach the bridge. The composer refuses to dispatch.
//
//   3. Asking the bridge directly from the renderer:
//          LocalSessions.getAll                            -> []
//          LocalAgentModeSessions.getDefaultWorkspaceFolders -> []
//          LocalSessions.getDetectedProjects               -> []
//          LocalAgentModeSessions.getSessionsBridgeEnabled -> true
//          LocalSessions.getSessionsBridgeEnabled          -> THREW: Cannot read properties of null
//                                                                    (reading 'toString')
//
//   4. Calling sendMessage directly, bypassing the composer:
//          LocalSessions.sendMessage('r471-probe-session', …)
//            -> Error: unknown session: r471-probe-session
//          LocalAgentModeSessions.sendMessage('r471-probe-session', …)
//            -> same
//
//   Conclusion: the handlers are registered and reachable; they reject an unknown session. With no
//   workspace folder there is no session for the composer to create, so it cannot send. The gap is a
//   missing precondition, not a missing binding — which is the opposite of what R470/R471 set out to
//   prove.
//
// WHY THE EARLIER PLAN WAS WRONG
//   R470's handoff said: compare preload-frontend.cjs against bridge-services.cjs to find the missing
//   handler. Both handlers ARE present (bridge-services.cjs:1768 for LocalSessions, :1362 for
//   LocalAgentModeSessions), so that comparison would have found nothing. The runtime answered it in
//   one probe where reading source had no chance.
//
// WHAT "unknown session" PROVES ABOUT THE BINDING
//   The error text carries the full channel name, e.g.
//     $eipc_message$_6010a08f-…-$_claude.web_$_LocalSessions_$_sendMessage
//   So the request crossed contextBridge, reached ipcMain, matched an exact handler, and the handler
//   itself raised. That is an end-to-end confirmation of the preload→main wiring that no amount of
//   static comparison would have given.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('both sendMessage handlers are registered in the main process', () => {
  // The static half: whatever the runtime says, the bindings must exist.
  const services = read(ROOT, 'desktop', 'bridge-services.cjs');
  assert.match(services, /define\('claude\.web_\$_LocalSessions_\$_sendMessage'/,
    'LocalSessions.sendMessage is no longer wired');
  assert.match(services, /define\('claude\.web_\$_LocalAgentModeSessions_\$_sendMessage'/,
    'LocalAgentModeSessions.sendMessage is no longer wired');
  // Both must reach the kernel, not a stub.
  const kernelCalls = (services.match(/kernel\.sendMessage\(/g) || []).length;
  assert.ok(kernelCalls >= 2,
    `only ${kernelCalls} kernel.sendMessage call sites: a handler may have been stubbed out`);
});

test('the composer does not reach the bridge when no workspace folder exists', (t) => {
  const capture = path.join(TMP, 'trace-r471.json');
  if (!fs.existsSync(capture)) {
    t.skip('trace capture absent — run .tmp/trace-r471.cjs');
    return;
  }
  const cap = JSON.parse(read(capture));

  // The click happened.
  assert.ok((cap.steps || []).includes('clicked-send'),
    'the capture has no send click, so the negative below is not established');
  // And nothing came of it.
  assert.equal(cap.result && cap.result.n, 0, 'message nodes appeared this time');
  assert.equal(cap.result && cap.result.sessionAppeared, false,
    'a session appeared, contradicting the no-workspace-folder explanation');
  // Crucially: the composer text stayed in the editor, which is what "submit was refused" looks like.
  assert.equal(cap.result && cap.result.editorText, 'R471 trace probe',
    'the editor cleared, which would mean the submit was accepted — re-derive the finding');

  // The bridge never saw a sendMessage call.
  const sendish = (cap.sendishLines || []).join('\n');
  assert.ok(!/sendMessage/.test(sendish),
    'sendMessage appears in the trace, so the composer DID dispatch — the finding changes');

  // Meanwhile 29 other channels did fall back, so tracing was working.
  assert.ok((cap.fallbackLines || []).length >= 20,
    `only ${(cap.fallbackLines || []).length} fallback lines: the trace may not have been on`);
});

test('the bridge answers with "unknown session", proving the wiring is live', (t) => {
  const capture = path.join(TMP, 'bridge-call-r471.json');
  if (!fs.existsSync(capture)) {
    t.skip('bridge-call capture absent — run .tmp/bridge-call-r471.cjs');
    return;
  }
  const cap = JSON.parse(read(capture));
  const answers = (cap.answers && cap.answers.result && cap.answers.result.value) || {};

  // Preconditions the composer needs, all empty.
  assert.deepEqual(answers['LocalSessions.getAll'], [],
    'sessions exist now: the empty-state precondition changed');
  assert.deepEqual(answers['LocalAgentModeSessions.getDefaultWorkspaceFolders'], [],
    'a default workspace folder now exists: re-derive why the composer refused');
  assert.deepEqual(answers['LocalSessions.getDetectedProjects'], [],
    'projects were detected now');

  // One method throws — worth pinning because it is a real defect independent of the send gap.
  assert.match(String(answers['LocalSessions.getSessionsBridgeEnabled']), /^THREW:/,
    'LocalSessions.getSessionsBridgeEnabled now succeeds: the null-deref described here is fixed '
    + 'and this assertion should be replaced with the new behaviour');

  // The direct calls reached main and were rejected for a domain reason, not a wiring reason.
  const direct = (cap.directSend && cap.directSend.result && cap.directSend.result.value) || {};
  for (const key of ['LocalSessions.sendMessage', 'LocalAgentModeSessions.sendMessage']) {
    const r = direct[key];
    assert.ok(r && r.ok === false, `${key} unexpectedly succeeded`);
    assert.match(r.error, /unknown session: r471-probe-session/,
      `${key} failed for a different reason, so the wiring conclusion does not hold: ${r.error}`);
    // The channel name in the error proves the request crossed the bridge.
    assert.match(r.error, /\$eipc_message\$_/,
      `${key} error does not name an EIPC channel: the call may not have left the renderer`);
    assert.match(r.error, /claude\.web_\$_/,
      `${key} error does not name the web domain`);
  }
});

test('LocalSessions.getSessionsBridgeEnabled is not implemented, and the caller crashes on the fallback', () => {
  // The renderer call threw: "Cannot read properties of null (reading 'toString')".
  //
  // Cause: there is NO LocalSessions handler. Only the AgentMode variant exists:
  //     bridge-services.cjs:1165  define('claude.web_$_LocalAgentModeSessions_$_getSessionsBridgeEnabled', () => true)
  //
  // And the bridge map lists the method under LocalAgentModeSessions only — NOT under LocalSessions.
  // So this particular call was made by my probe, not by the frontend. That matters for honesty: the
  // TypeError is a real property of the fallback mechanism, but it is not what blocks the composer.
  // The composer's blocker is the empty workspace folder, established in the test above.
  const services = read(ROOT, 'desktop', 'bridge-services.cjs');

  assert.ok(services.includes("'claude.web_$_LocalAgentModeSessions_$_getSessionsBridgeEnabled'"),
    'the AgentMode getSessionsBridgeEnabled handler is gone');

  assert.ok(!services.includes("'claude.web_$_LocalSessions_$_getSessionsBridgeEnabled'"),
    'a LocalSessions.getSessionsBridgeEnabled handler now exists: the missing-handler observation '
    + 'is resolved');

  const map = JSON.parse(read(ROOT, 'desktop', 'shim', 'bridge-map.json'));
  const web = map['claude.web'] || {};
  const ls = Array.isArray(web.LocalSessions) ? web.LocalSessions : Object.keys(web.LocalSessions || {});
  const am = Array.isArray(web.LocalAgentModeSessions)
    ? web.LocalAgentModeSessions : Object.keys(web.LocalAgentModeSessions || {});

  // The asymmetry: advertised on one service, absent on the other, and no handler for the absent one.
  assert.ok(!ls.includes('getSessionsBridgeEnabled'),
    'LocalSessions now advertises getSessionsBridgeEnabled, so the preload would expose it as a real '
    + 'method rather than relying on the fallback');
  assert.ok(am.includes('getSessionsBridgeEnabled'),
    'LocalAgentModeSessions no longer advertises getSessionsBridgeEnabled');
});
