// R509: the search half of the deferred-tool workflow works — found only after two of my own probe bugs.
//
// WHAT WAS UNDER TEST
//   R508 proved a withheld tool executes through ExecuteExtraTool. The other half is discovery: does
//   SearchExtraTools actually see the tools that are absent from the request envelope? The system prompt claims
//   it must be used first:
//       "Additional tools (deferred tools, MCP tools, skills) are NOT in your tool list and must be discovered
//        via SearchExtraTools first, then invoked via ExecuteExtraTool."
//
// THE ANSWER
//       select:GoalTool      -> "Found 1 deferred tool(s): GoalTool.
//                                Use ExecuteExtraTool with {"tool_name": "<name>", "params": {...}} ..."
//       select:ZZZNoSuchToolZZZ -> "No matching deferred tools found"
//   Different answers, the real name present, the impossible name absent. The discovery step is real.
//
// TWO PROBE BUGS THAT EACH PRODUCED A PLAUSIBLE FALSE FINDING
//   1. tool_result.content is a plain STRING, not an array of blocks. The first probe assumed an array, so both
//      queries yielded null, and the report concluded "both results are identical — the tool is not
//      distinguishing a real name from an impossible one". That conclusion was manufactured entirely by my
//      parser. Now the content shape is printed, so a parsing failure is visible instead of being read as data.
//   2. The probe was missing `--verbose`. Without it the CLI emitted no tool_result at all, producing the same
//      null-result symptom a second time. The throwaway debug script that captured the real answer differed
//      from the probe in exactly that flag.
//
//   Together these are the seventh and eighth instances of the session's recurring failure: a measurement whose
//   instrument was broken, reported as a fact about the thing measured. What caught them was not rereading the
//   code but asking why a debug script succeeded where the tool failed.
//
// THE DEFAULT QUERY WAS ALSO WRONG, AND ITS OWN ANSWER SAID SO
//   The first default was `Task`, and SearchExtraTools replied:
//       "No deferred tools found. Agent is already loaded as core tool(s) — call directly, do NOT search for or
//        wrap in ExecuteExtraTool."
//   So `Task` is the registered name of a CORE tool (Agent), not a deferred one. That single sentence does two
//   things: it invalidates searching for Task as a test of the deferred set, and it retroactively qualifies R508
//   — the call through ExecuteExtraTool worked, but by the tool's own account the wrapper was unnecessary. The
//   demonstration of the path stands; the framing of Task as "a withheld tool" does not.
//
//   `GoalTool` is the better default: absent from the envelope, not in the core list the system prompt names,
//   and it returned null through ExecuteExtraTool — so whether search finds it was genuinely open.
//
// WHAT THIS DOES NOT ESTABLISH
//   Not that every withheld tool is discoverable — one name proves the index covers it, not that the index is
//   complete. Not that search returns schemas, only names. And not that GoalTool being findable implies it is
//   functional: search finding a name and ExecuteExtraTool returning null for it are both true at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'tools', 'search-extra-probe.cjs');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

const run = () => spawnSync(process.execPath, [PROBE, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

test('a withheld tool is discoverable and an impossible name is not', { skip: !haveAll }, () => {
  const r = run();
  assert.equal(r.status, 0, 'the probe failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.equal(d.query, 'GoalTool', 'the default query changed');
  assert.equal(d.targetWithheld, true, 'GoalTool is no longer withheld: the test would prove nothing');

  // The two answers must differ; identical text is the symptom of a broken probe, not a finding.
  assert.equal(d.identicalResults, false,
    'both queries returned the same text: the probe is not distinguishing real from impossible names');
  assert.equal(d.targetMentionsName, true,
    'the withheld tool was not named in its own search result: ' + JSON.stringify(d.targetResult));
  assert.equal(d.controlMentionsName, false,
    'the impossible name came back in its own result, which is echo rather than search');

  // And the wording must be the tool's, not a coincidence.
  assert.match(d.targetResult, /Found 1 deferred tool\(s\): GoalTool/,
    'the search result no longer reports the tool as found');
  assert.match(d.controlResult, /No matching deferred tools found/,
    'the control result no longer reports no match');
});

test('the probe reports the content shape so a parse failure is visible', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  assert.ok(d.contentShape, 'the content shape is not reported');
  // Both answers came back as a plain string. If the CLI changes to blocks, this assertion fires and the
  // parsing can be revisited rather than silently degrading to null.
  assert.equal(d.contentShape.target, 'string',
    'tool_result.content is no longer a string: revisit the parser');
  assert.equal(d.contentShape.control, 'string',
    'tool_result.content is no longer a string: revisit the parser');

  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /rawShape/, 'the raw shape is no longer recorded');
  assert.match(source, /is a plain STRING here, not an array of blocks/,
    'the parsing lesson is gone');
});

test('the probe passes --verbose, without which it silently captured nothing', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /'--print', '--verbose', '--output-format'/,
    '--verbose is missing: the probe will capture no tool_result and report a vacuous identical-results finding');
  assert.match(source, /--verbose is load-bearing/, 'the reason for the flag is no longer recorded');
});

test('Task is recorded as a core tool, not a deferred one', () => {
  // SearchExtraTools said so itself, and that answer invalidates the first default query.
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /Agent is already loaded as core tool\(s\)/,
    'the tool\'s own answer about Task is no longer quoted');
  assert.match(source, /retroactively qualifies R508/,
    'the tool no longer records that Task needed no wrapper');
});

test('the scope of the discovery claim is stated', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  // Wraps as: "Not that every withheld tool is discoverable — one name proves the index covers it, not that
  // the index is // complete." Match the opening phrase without the em dash tail.
  assert.match(source, /Not that every withheld tool is discoverable/,
    'the tool no longer limits discovery to one name');
  assert.match(source, /are both true/,
    'the tool no longer records that findable and functional are separate facts');
});
