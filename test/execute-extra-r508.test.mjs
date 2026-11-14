// R508: a withheld tool was invoked through ExecuteExtraTool — but only after a control run destroyed the first
// version of the finding.
//
// THE CLAIM UNDER TEST
//   R507 measured 39 tools in the init frame and 23 in the request, and said the 17 withheld ones are "reachable
//   through SearchExtraTools / ExecuteExtraTool". That was inferred from tool descriptions. It explicitly did
//   not claim they work.
//
// THE FIRST ATTEMPT, AND WHY IT PROVED NOTHING
//   Glob was the first target: read-only, no side effects, verifiable output. It returned
//       is_error: false, {"result":{"filenames":[],"fileCount":0},"tool_name":"Glob"}
//   — and the run also reported `withheld: NO`, because Glob IS in the envelope. So the call succeeded and tested
//   the wrong thing.
//
//   GoalTool next, withheld, returned is_error:false with `result:null`. artifact, withheld, the same. Both looked
//   like success.
//
// THE CONTROL THAT INVALIDATED IT
//   A tool name that does not exist — ZZZNotARealTool — returned the identical answer:
//       is_error: false, {"result":null,"tool_name":"ZZZNotARealTool"}
//   So `result:null` with `is_error:false` means "the gateway produced no result", not "the tool ran". Two runs
//   that appeared to demonstrate the claim demonstrated nothing, and without the control this round would have
//   reported "withheld tools are invocable, measured" on a call that never happened.
//
//   This is the sixth instance of one failure family in this session: R488's phantom tools, R493's detector
//   matching its own comment, R495's index counting its own output, R498's name mismatch, R501's refuted
//   hypothesis, and now this. In every case the wrong version produced a confident, self-consistent result.
//
// THE TARGET THAT ACTUALLY SATISFIES BOTH CONDITIONS
//   `Task` is absent from the request envelope AND returns a non-null result:
//       {"status":"completed","prompt":"say ok","agentId":"af2fac3b4636f05cd",
//        "agentType":"general-purpose","content":[{"type":"text","text":"done"}],
//        "totalDurationMs":19,"totalTokens":3,"totalToolUseCount":0,...}
//   That is a spawned subagent reporting completion. Nothing about it can be produced by a gateway that failed to
//   find the tool.
//
//   Contrast within the same probe: DiscoverSkills (withheld) returns null, Task (withheld) returns a completed
//   agent. So the null is a property of those tools, not of the gateway's inability to route.
//
// WHAT THIS ESTABLISHES
//   "Withheld" means "not in the envelope", not "unavailable" — for at least one withheld tool, measured.
//
// WHAT IT DOES NOT
//   Not that all 17 are invocable. Not that a mutating tool would pass approval — this probe does not exercise
//   the permission layer beyond allowing ExecuteExtraTool. And not that `is_error:false` is ever evidence of
//   execution; the control proves the opposite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'tools', 'execute-extra-probe.cjs');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

const run = (args = []) => spawnSync(process.execPath, [PROBE, '--json', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

test('a withheld tool executes and returns a non-null result', { skip: !haveAll }, () => {
  const r = run();
  assert.equal(r.status, 0, 'the probe failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.equal(d.target, 'Task', 'the default target changed');
  assert.equal(d.targetWithheld, true, 'Task is no longer withheld: the demonstration would test nothing');
  assert.equal(d.toolResultFound, true, 'no tool_result came back');
  assert.equal(d.toolResultIsError, false, 'the call reported an error');
  // The discriminator: a non-null result, because is_error:false alone is not evidence (see the control).
  assert.equal(d.returnedNonNullResult, true,
    'Task returned a null result: it must return a value for this to demonstrate anything');

  // And the value must be a completed agent, which a routing failure cannot fabricate.
  assert.ok(d.gatewayResult, 'no parsed gateway result');
  assert.equal(d.gatewayResult.toolName, 'Task');
  assert.equal(d.gatewayResult.result.status, 'completed',
    'the spawned agent did not report completion: ' + JSON.stringify(d.gatewayResult.result).slice(0, 200));
  assert.ok(Array.isArray(d.gatewayResult.result.content),
    'the agent result has no content array');
  assert.equal(d.gatewayResult.result.content[0].text, 'done',
    'the agent returned unexpected text');
});

test('the control returns the same answer for a nonexistent tool', { skip: !haveAll }, () => {
  // This is the test that keeps the previous one honest. Without it, `is_error:false` would be read as success.
  const d = JSON.parse(run(['--control']).stdout);
  assert.equal(d.target, 'ZZZNotARealTool', 'the control target changed');
  assert.equal(d.toolResultFound, true, 'the control produced no tool_result');
  assert.equal(d.toolResultIsError, false,
    'the control now reports an error: the gateway may have changed to validate names, re-derive this');
  assert.equal(d.returnedNonNullResult, false,
    'the control returned a non-null result: a nonexistent tool produced output, which cannot be right');
  assert.equal(d.gatewayResult.toolName, 'ZZZNotARealTool',
    'the gateway no longer echoes the requested name');
});

test('the tool refuses to call a null result a success', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  // The verdict must rest on returnedNonNullResult, not on is_error.
  assert.match(source, /returnedNonNullResult && report\.toolResultIsError === false/,
    'the verdict no longer requires a non-null result');
  assert.match(source, /does NOT demonstrate execution/,
    'the tool no longer refuses the null-result reading');
  // The phrase wraps across two comment lines:
  //   "... so is_error:false is not evidence of"
  //   "//   execution."
  assert.match(source, /is_error:false\s+is not evidence of\s*\/\/\s*execution/i,
    'the tool no longer states the lesson from the control');
  // The lesson also lives in the "WHAT A SUCCESSFUL DEMONSTRATION WOULD REQUIRE" header and in the verdict
  // branch, so both are checked rather than only the one phrasing.
  assert.match(source, /ExecuteExtraTool returns is_error:false for a nonexistent tool name/,
    'the tool no longer records that the gateway answers for nonexistent tools');
});

test('the control is recorded, not quietly dropped', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /ZZZNotARealTool/, 'the control target is gone');
  assert.match(source, /--control/, 'the control flag is gone');
  assert.match(source, /THE CONTROL THAT INVALIDATED THE FIRST READING/,
    'the narrative of the discovery is gone');
});

test('the scope of the demonstration is stated', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /Not that all 17 withheld tools are invocable/,
    'the tool no longer limits the claim to one tool');
  // Wraps as: "this probe does not exercise the" / "//   permission layer beyond allowing ExecuteExtraTool"
  assert.match(source, /does not exercise the\s*\/\/\s*permission layer/,
    'the tool no longer disclaims the permission layer');
});
