// R511: the discovery gate is per-CONVERSATION — and that means R510 named the wrong branch.
//
// THE QUESTION R509 LEFT MASKED
//   R509 searched for GoalTool in one process; R508 executed Task in another. Branch 2 of ExecuteTool.call reads
//       const discovered = extractDiscoveredToolNames(context.messages)
//   which is a property of the message history, not of a server-side index. So neither round measured whether
//   discovery survives into a later call — each probe was a fresh conversation, and the structure of the probes
//   hid the very variable that matters.
//
// THREE CONVERSATIONS
//   A. search only          -> "Found 1 deferred tool(s): GoalTool."
//   B. search then execute  -> {"result":{"success":true,"message":"No active goal. ..."},"tool_name":"GoalTool"}
//   C. execute only         -> {"result":null,"tool_name":"GoalTool"}
//
//   B and C are the same target with the same parameters; the only difference is whether a search preceded the
//   execute in the SAME conversation. B executes, C returns null. The gate is per-conversation.
//
// WHY THIS MATTERS BEYOND THE MECHANISM: IT CORRECTS R510
//   R510 read six branches out of ExecuteTool.call and concluded GoalTool's null was branch 3 —
//   "当前不可用：Remote Control 未连接" — because that message was the only one it could pair with a null it had
//   observed. This round shows the null is branch 2. Both branches return the identical `data` shape and neither
//   writes its message into `result`, so the branch is NOT identifiable from the tool_result alone.
//
//   R510's mistake was not the reading of the branches; it was assuming a null from a known-deferred tool had to
//   be the branch whose message mentioned that tool's dependency. The discriminator is behavioural: search first
//   and the null disappears.
//
// A CLASSIFIER BUG THAT WOULD HAVE HIDDEN THE WHOLE FINDING
//   The first classifier tested branch patterns before testing for success, so GoalTool's successful answer
//   `{"result":{...}}` was labelled "other" — the single most important observation in the round reported as
//   unclassified. Success must be tested first: a non-null `result` means the call passed all six branches.
//   That is the fourth time this session that an ordering or windowing choice in a parser silently inverted a
//   conclusion.
//
// WHAT IS NOT CLAIMED
//   Not that every deferred tool behaves this way — one target, one mechanism. Not that the conversation scope
//   is the only gate: branch 3 could still apply to a tool after discovery, and this probe does not distinguish
//   "passed branch 2 and returned" from "passed branch 2 and hit nothing else". Not that a real client would
//   ever call ExecuteExtraTool without searching — the system prompt instructs it to search first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'discovery-scope.cjs');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

const run = () => spawnSync(process.execPath, [TOOL, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

test('search alone finds the deferred tool', { skip: !haveAll }, () => {
  const r = run();
  assert.equal(r.status, 0, 'the probe failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  assert.equal(d.targetDeferred, true, 'GoalTool is no longer deferred: the test would prove nothing');
  assert.ok(d.a_searchOnly.raw.some((t) => /Found 1 deferred tool\(s\): GoalTool/.test(t)),
    'the search no longer reports GoalTool: ' + JSON.stringify(d.a_searchOnly.raw));
});

test('execute succeeds only after a search in the same conversation', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);

  // B: search then execute -> a real result.
  assert.ok(d.b_searchThenExecute.raw.some((t) => /"result":\s*\{/.test(t)),
    'search-then-execute no longer returns a result: ' + JSON.stringify(d.b_searchThenExecute.raw));
  assert.ok(d.b_searchThenExecute.raw.some((t) => /"success":\s*true/.test(t)),
    'the executed result is not success:true');
  assert.ok(d.b_searchThenExecute.raw.some((t) => /No active goal/.test(t)),
    'the executed result lost its message, so it is not clearly GoalTool\'s own answer');

  // C: execute alone -> null. Same target, same params, only the preceding search differs.
  assert.ok(d.c_executeOnly.raw.some((t) => /"result":\s*null/.test(t)),
    'execute-alone no longer returns null: ' + JSON.stringify(d.c_executeOnly.raw));
});

test('the classifier tests success before branch patterns', () => {
  // The bug that hid the finding: branch patterns first made a success look unclassified.
  const source = fs.readFileSync(TOOL, 'utf8');
  const classifyBody = source.slice(source.indexOf('function classify'), source.indexOf('(async () =>'));
  const successIdx = classifyBody.indexOf('"result":\\s*\\{');
  const branchIdx = classifyBody.indexOf('has not been discovered yet');
  assert.ok(successIdx >= 0, 'the success test is gone');
  assert.ok(branchIdx >= 0, 'the branch tests are gone');
  assert.ok(successIdx < branchIdx,
    'success must be tested before branch patterns, or a successful call is labelled unclassified');
});

test('the tool records that it revised R510', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /revises R510/,
    'the tool no longer records that it corrects the previous round');
  assert.match(source, /the null was branch 2, not branch 3/,
    'the correction itself is no longer stated');
  // And the reason the correction was needed — the branch is not recoverable from the data shape.
  assert.match(source, /identical data shape/,
    'the tool no longer explains why R510 could not tell the branches apart');
});

test('the scope of the claim is stated', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /Not that every deferred tool behaves this way/,
    'the tool no longer limits the finding to one target');
  // Wraps across comment lines; match the opening clause only.
  assert.match(source, /cannot distinguish "passed branch 2 and/,
    'the tool no longer disclaims that other branches could still apply');
});
