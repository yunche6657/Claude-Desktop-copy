// R507: a real turn ran end to end for the first time, and it showed that the tool list R488–R506 counted is
// not the tool list the model is offered.
//
// THE TWENTY-ROUND BLIND SPOT
//   Every conclusion from R488 to R506 rests on static reading plus one init-frame probe. The init frame proves
//   the CLI assembles tools; it says nothing about what travels in the request. R481 had recorded why a real
//   turn was never attempted: no credentials, and a real gateway produces api_retry backoff. But R482 established
//   that the login gate only checks for the PRESENCE of a credential, and a loopback server supplies that with
//   no account and no network.
//
//   So tools/turn-probe.cjs starts a local HTTP server, points the CLI at it, answers with a minimal SSE stream,
//   and reports whether the turn completed. It does:
//       exit code 0, result subtype=success isError=false, text "probe-ok"
//
// THE DISCOVERY
//   With default flags, the init frame lists 39 tools and the request body carries 23.
//
//        withheld (17): CronCreate, CronDelete, CronList, DiscoverSkills, EnterWorktree, ExitWorktree,
//                       GoalTool, LocalMemoryRecall, Monitor, ProposeGoal, RefreshMcpTools, SendFeedback,
//                       Task, TeamCreate, TeamDelete, VaultHttpFetch, artifact
//        sent but not in the frame (1): Agent
//
//   Two causes, and conflating them is what has been blurring this series:
//
//     withheld   The 17 are assembled and offered through SearchExtraTools / ExecuteExtraTool rather than
//                directly. This is what `shouldDefer` governs. R501 measured that flag against FRAME membership,
//                found it did not predict it, and reported the hypothesis as refuted. The refutation was
//                correct and the question was wrong: the flag governs ENVELOPE membership. Both rounds were
//                reading the wrong list, in opposite directions.
//     renamed    `Agent` is sent while the frame shows `Task`, because one directory declares both names and
//                the two lists normalise differently. This is the fourth instance of the name-mismatch family
//                after R488, R498 and R500 — and it is the reason the tool pairs them rather than reporting a
//                phantom in each column.
//
// WHAT THIS CHANGES ABOUT THE EARLIER NUMBERS
//   "The runtime registers 39 tools" was true of the frame and false of the request. Every R488–R494 coverage
//   figure counts something real — the contract against the frame — but none of them counts what the model was
//   actually offered. That is the correction this round adds, and it is a correction of scope, not of arithmetic.
//
// WHAT IS NOT CLAIMED
//   Not that the 17 withheld tools are unusable: ExecuteExtraTool can invoke them, and this round does not
//   demonstrate that. Not that 23 is "the" number either — a turn that triggers tool search would send a
//   different envelope, and that path is not exercised. The measurement is one configuration, taken twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'tools', 'turn-probe.cjs');
const ENVELOPE = path.join(ROOT, 'tools', 'tool-envelope.cjs');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

const run = (tool, args = []) => spawnSync(process.execPath, [tool, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

test('a real turn completes against a loopback server', { skip: !haveAll }, () => {
  const r = run(PROBE, ['--json']);
  assert.equal(r.status, 0, 'the probe failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.equal(d.exitCode, 0, 'the CLI exited non-zero');
  assert.ok(d.messageRequest, 'no message request was captured');
  assert.equal(d.messageRequest.method, 'POST');
  assert.match(d.messageRequest.path, /messages/, 'the endpoint changed');
  assert.equal(d.messageRequest.anthropicVersion, '2023-06-01', 'the API version header changed');
  assert.equal(d.messageRequest.hasAuthHeader, true, 'the synthetic token was not sent');

  // The point of the round: the turn actually finished, not merely that a request went out.
  assert.ok(d.result, 'no result frame was produced');
  assert.equal(d.result.isError, false, 'the result frame reports an error: ' + JSON.stringify(d.result));
  assert.equal(d.result.subtype, 'success', 'the result subtype is not success');
  assert.ok(d.assistantFrames > 0, 'no assistant frame was produced');
});

test('the request envelope is recorded, not assumed', { skip: !haveAll }, () => {
  // --keep-body is required: without it the probe deliberately omits the body, so `body` is undefined. Asking
  // for it explicitly is what makes this test measure the envelope rather than test an absent field.
  const d = JSON.parse(run(PROBE, ['--json', '--keep-body']).stdout);
  assert.ok(d.messageRequest && d.messageRequest.body,
    'the probe did not include the request body despite --keep-body');
  const body = JSON.parse(d.messageRequest.body);
  assert.ok(body.model, 'no model in the request');
  assert.equal(body.stream, true, 'the request is no longer streaming');
  assert.ok(Array.isArray(body.tools), 'tools is not an array');
  assert.ok(Array.isArray(body.system), 'system is not an array of blocks');
  assert.ok(body.max_tokens > 0, 'max_tokens missing');
  // Every tool must carry a schema, or the request would be malformed.
  for (const t of body.tools) {
    assert.ok(t.name, 'a tool has no name');
    assert.ok(t.input_schema && typeof t.input_schema === 'object',
      `${t.name} has no input_schema`);
  }
});

test('the frame and the request disagree, and that disagreement is the finding', { skip: !haveAll }, () => {
  const r = run(ENVELOPE, ['--json']);
  assert.equal(r.status, 0, 'the envelope tool failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  assert.ok(!d.error, 'the tool refused: ' + d.error);

  assert.equal(d.frameCount, 39, 'the init-frame tool count changed');
  assert.equal(d.requestCount, 23, 'the request tool count changed');
  assert.equal(d.withheld.length, 17,
    `the withheld count changed to ${d.withheld.length}: re-derive the envelope discussion`);

  // Two early rounds each attacked one half of this and neither named it.
  assert.ok(d.withheld.includes('Task'), 'Task is no longer withheld from the request');
  assert.ok(d.withheld.includes('GoalTool'), 'GoalTool is no longer withheld');
  assert.deepEqual(d.onlyInRequest, ['Agent'],
    'the Agent/Task naming asymmetry is gone or grew: ' + JSON.stringify(d.onlyInRequest));
});

test('Agent and Task are paired rather than double-counted', () => {
  const source = fs.readFileSync(ENVELOPE, 'utf8');
  assert.match(source, /const SAME_TOOL = \[\['Agent', 'Task'\]\]/,
    'the Agent/Task pairing is gone: they will appear as a phantom in both columns');
  assert.match(source, /normalise/, 'the name normalisation is gone');
  // And the report must say so, because a reader seeing one name in each list will otherwise assume two tools.
  assert.match(source, /naming difference inside one directory/,
    'the report no longer explains the Agent/Task asymmetry');
});

test('the tool states that the frame is not the request', () => {
  const source = fs.readFileSync(ENVELOPE, 'utf8');
  assert.match(source, /frame is what the CLI assembled/i,
    'the tool no longer distinguishes assembly from the envelope');
  assert.match(source, /not that the 17 withheld tools are unusable/i,
    'the tool no longer disclaims that withheld means unusable');
  assert.match(source, /one configuration, measured twice/,
    'the tool no longer limits its scope to one configuration');
});

test('the probe reports failure rather than silencing it', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /did NOT complete cleanly/,
    'the probe no longer has a failure path: a broken fixture would report success');
  assert.match(source, /reported rather than worked around/,
    'the probe no longer states that a failed turn is reported');
});
