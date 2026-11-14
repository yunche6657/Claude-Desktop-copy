// The message path, verified without the provider.
//
// Every gateway model returned 503 for three consecutive rounds:
//
//   13 models probed -> all {"error":{"message":"No available accounts: no available accounts"}}
//
// which left the app's CORE action — send a message, get a reply, see it on screen — with no
// acceptance coverage at all. Unreachable upstream is not a reason to stop testing; it is a
// reason to replace exactly one component.
//
// So desktop/main.cjs grew an opt-in seam: with CLAUDE_AGENT_STUB_TEXT set, only the model call
// is replaced. The kernel, the transcript writer, the event stream and the renderer are the real
// ones. Unset, the branch never runs and the real runner is built exactly as before.
//
// MEASURED, CLAUDE_PROOF_PHASES=message on an invisible window:
//
//   send            { ok: true, text: 'MESSAGE-PHASE-OK', error: null }
//   transcriptRows  2
//   transcriptTypes ['user', 'assistant']
//   rendered        'Claude 已完成回复 … 您说：Reply with exactly: MESSAGE-PHASE-OK
//                    Claude 已回复：MESSAGE-PHASE-OK  MESSAGE-PHASE-OK'
//
// What a stub CANNOT prove: that the request body is the shape the provider wants. That still
// needs the real gateway, and it is recorded as outstanding rather than pretended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'evidence', 'live', 'round347-message', 'message.json');

test('the stub seam is opt-in and inert by default', () => {
  // A seam that changed production behaviour without the env var would be a real defect.
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /process\.env\.CLAUDE_AGENT_STUB_TEXT/, 'the seam reads no env var');
  assert.match(main, /if \(typeof stubText === 'string' && stubText\.length > 0\)/, 'the seam is not guarded');
  // The real runner must still be constructed on the normal path.
  assert.match(main, /const runner = createAgentRunner\(\{/, 'the real runner construction is gone');
  // Ordering matters: the guard must appear BEFORE the real runner, or it can never run.
  const guard = main.indexOf("typeof stubText === 'string'");
  const real = main.indexOf('const runner = createAgentRunner({');
  assert.ok(guard > 0 && real > guard, 'the stub guard is not ahead of the real runner');
});

test('the harness has a message phase that asserts both rows and the rendered reply', () => {
  const harness = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  assert.match(harness, /phase === 'message'/, 'the message phase is gone');
  assert.match(harness, /transcriptTypes, \['user', 'assistant'\]/, 'the row types are no longer asserted');
  // Asserting the store alone would pass even if the reply never reached the screen.
  assert.match(harness, /rendered\.includes\(expected\)/, 'the phase no longer checks the rendered reply');
});

test('the recorded message run completed the whole chain', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no message run recorded in evidence/live/round347-message');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(report.ok, true, 'the message run failed: ' + JSON.stringify(report.error || null));
  assert.equal(report.visible, false, 'the window was supposed to stay invisible');
  assert.equal(report.send.ok, true, 'sendMessage did not report ok');
  assert.equal(report.send.text, 'MESSAGE-PHASE-OK', 'the reply text was ' + JSON.stringify(report.send.text));
  assert.equal(report.transcriptRows, 2, 'the transcript has ' + report.transcriptRows + ' rows');
  assert.deepEqual(report.transcriptTypes, ['user', 'assistant']);
});

test('the reply is verified on screen, not only in the store', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no message run recorded');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.ok(report.rendered, 'the run captured no rendered text');
  assert.ok(report.rendered.includes('MESSAGE-PHASE-OK'), 'the reply never reached the screen');
});
