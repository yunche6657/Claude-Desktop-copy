// R481: the frontend turn does nothing because the CCB CLI is not logged in.
//
// THE QUESTION
//   R478 made the frontend composer send, and `sendMessage` reaches the bridge. But a turn never
//   produces assistant text: R480 sampled 60 times over 44 s and got exactly one distinct transcript
//   length, zero assistant frames, and no error on any channel (page error, unhandled rejection,
//   console.error, bridge trace). The frontend shows "正在发送…" and then nothing.
//
// WHY IT LOOKED LIKE A HANG
//   Nothing failed, so nothing reported. The kernel only rejects on a missing file, a spawn failure, a
//   handshake timeout or a disposed session. A turn that RUNS and returns an error result is not a
//   kernel failure — it is a successful protocol exchange carrying an error payload, so the kernel
//   resolves normally and the renderer has an assistant message with no usable text.
//
// HOW IT WAS FOUND
//   By speaking the CLI's own protocol with no Electron in the way. Two attempts were needed:
//
//   v1 passed the ambient environment. Result: spawned true, 0 stdout lines, 0 stderr lines, exit 0 —
//   the CLI started and quit silently. Useful (it showed the CLI will exit quietly when its
//   environment is wrong) but not a reproduction.
//
//   v2 reproduced desktop/kernel-env.cjs: a private HOME / USERPROFILE / CLAUDE_CONFIG_DIR under a
//   scratch dir, TEMP/TMP/TMPDIR pointed there too, plus ANTHROPIC_MODEL. The same binary and entry
//   path then answered properly. So the environment is load-bearing, and the kernel's own env
//   construction is what makes the CLI run at all.
//
// THE ANSWER, QUOTED FROM THE RESULT FRAME
//     {"type":"result","subtype":"success","is_error":true,"duration_ms":107,
//      "num_turns":1,"result":"Not logged in · Please run /login", ...}
//
//   The full exchange worked: initialize -> control_response (with the skill/command catalogue) ->
//   system/init (tools list, cwd, session_id) -> assistant (model "<synthetic>", 0 tokens) ->
//   result (is_error true, "Not logged in"). The CLI is running correctly; it has no credentials.
//
// WHY THE FRONTEND SHOWS NOTHING RATHER THAN AN ERROR
//   The assistant frame is synthetic with stop_reason "stop_sequence" and zero usage, and the error is
//   carried on the RESULT frame's `result` string, not as a protocol error. A renderer that only
//   displays assistant content therefore has nothing to show, and the turn ends looking like a stall.
//
// WHAT THIS MEANS FOR THE DELIVERY
//   Not a reconstruction defect and not a code fix. The frontend view needs credentials before it can
//   answer: a real login, or a gateway profile that supplies a working provider. This explains why the
//   handdrawn view answers (it uses server.mjs's local demo generator) while the frontend view does not
//   (it spawns the real CLI, which needs auth).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const CAP2 = path.join(TMP, 'kernel-direct2-r481.json');
const CAP1 = path.join(TMP, 'kernel-direct-r481.json');

test('the CLI completes the protocol and reports that it is not logged in', (t) => {
  if (!fs.existsSync(CAP2)) {
    t.skip('capture absent — run .tmp/kernel-direct2-r481.cjs');
    return;
  }
  const cap = JSON.parse(read(CAP2));

  assert.equal(cap.spawned, true, 'bun never spawned the CLI');
  assert.equal(cap.gotControlResponse, true, 'initialize got no control_response');
  assert.equal(cap.gotAssistant, true, 'no assistant frame came back');
  assert.equal(cap.gotResult, true, 'no result frame came back');

  // The result frame carries the reason. Assert the wording, so a future change to the message is
  // visible rather than silently reinterpreted.
  const resultFrame = cap.chunks.find((c) => /"type":"result"/.test(c));
  assert.ok(resultFrame, 'the result frame is missing from the capture');
  assert.match(resultFrame, /"is_error":true/, 'the result is no longer flagged as an error');
  assert.match(resultFrame, /Not logged in/, 'the failure reason changed: ' + resultFrame.slice(0, 300));

  // And the assistant frame is synthetic — zero tokens — which is why the UI has nothing to render.
  const assistantFrame = cap.chunks.find((c) => /"type":"assistant"/.test(c));
  assert.ok(assistantFrame, 'the assistant frame is missing');
  assert.match(assistantFrame, /"model":"<synthetic>"/,
    'the assistant frame is no longer synthetic: the "nothing to render" explanation changes');
  assert.match(assistantFrame, /"output_tokens":0/,
    'the assistant frame reports output tokens although it rendered nothing');
});

test('the CLI exits silently when the kernel environment is not reproduced', (t) => {
  if (!fs.existsSync(CAP1)) {
    t.skip('capture absent — run .tmp/kernel-direct-r481.cjs');
    return;
  }
  const cap = JSON.parse(read(CAP1));

  // v1 evidence. Kept because it documents that a wrong environment produces a SILENT exit, which is
  // the failure mode a future debugger is most likely to hit and least likely to notice.
  assert.equal(cap.spawned, true, 'bun did not spawn even with the ambient environment');
  assert.equal(cap.gotControlResponse, false, 'the ambient-environment run now answers the handshake');
  assert.equal((cap.chunks || []).length, 0,
    'stdout was not empty in the ambient-environment run: the silent-exit observation changed');
  // The exit record must EXIST before its code means anything. `if (cap.exit)` made a missing record — a broken
  // capture — read as "nothing to assert", while the clean-code-0 observation is the whole point of this test: the
  // failure mode it documents is a SILENT exit, and a silent exit that is not recorded cannot be distinguished from a
  // probe that never ran.
  assert.ok(cap.exit, 'the capture has no exit record: the silent-exit observation is unverifiable, not absent');
  assert.equal(cap.exit.code, 0,
    'the silent exit is no longer a clean code 0: ' + JSON.stringify(cap.exit));
});

test('kernel-env.cjs really sets the variables the reproduction needed', () => {
  // The claim "the environment is load-bearing" rests on these being set by the kernel, not invented
  // by the probe. Read them from the source.
  const kernelEnv = read(ROOT, 'desktop', 'kernel-env.cjs');
  for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP', 'TMPDIR']) {
    assert.match(kernelEnv, new RegExp(`env\\.${key}\\s*=`),
      `kernel-env.cjs no longer sets ${key}: the reproduction's premise is stale`);
  }
});

test('a turn that ends with an error result does not throw in the kernel', () => {
  // The reason R480 saw no error anywhere: the kernel resolves such a turn rather than rejecting. If
  // the kernel ever starts throwing on is_error results, the frontend would surface it and this note
  // becomes wrong.
  const kernel = read(ROOT, 'desktop', 'ccb-kernel.cjs');
  // The result frame is settled through a resolve path; an is_error payload is not a protocol failure.
  assert.match(kernel, /subtype\s*===?\s*['"]result['"]|['"]result['"]\s*===?\s*subtype|case ['"]result['"]/,
    'the kernel no longer branches on a result subtype: re-derive how an error result is handled');
  assert.match(kernel, /is_error/,
    'the kernel no longer reads is_error at all: the "no exception" claim needs rechecking');
});
