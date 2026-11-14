// R534: ranking functions by exposure, so "which branches deserve a mutation entry" stops being a matter of taste.
//
// THE QUESTION R533 LEFT
//   367 branches, 5 touched. The count alone says nothing about where to work next, and the obvious sort — by branch
//   count — ranks a function nothing tests the same as one twenty tests drive. This round builds a checking order
//   from two independently derivable numbers.
//
// THE RANKING, AND THE TWO TIMES IT HAD TO BE REPAIRED
//   uncovered branches per referencing test file, where "referencing" means a test file whose source mentions the
//   function by name or mentions an event string the function emits.
//
//   First version: counted the module basename too. Every row read 215, because almost every test mentions
//   `session-kernel`. A column of identical numbers ranks nothing — and it looked plausible, which is the danger.
//
//   Second version: name only. `flushHeldMcpVerbs` — 48 branches, the largest function in the file — showed ZERO
//   referencing tests. That is false: test/session-mcp-clear-queue-r378.test.mjs drives it directly. A helper called
//   only from internals is usually tested by its EFFECTS; it never appears under its own name. So name matching
//   reports the opposite of the truth for exactly the functions worth looking at.
//
//   Third version: name OR emitted event string. `flushHeldMcpVerbs` now reads 15 referencing tests and ranks well
//   down. That is a correction in the direction of not raising a false alarm.
//
// WHAT THE RANKING NOW SAYS
//   The largest genuinely unreferenced function is `runTurn` (8 branches, 0 mentions). `runMessage` (43 branches) has
//   one, and is the top of the ranked list at 43 uncovered branches per referencing file.
//
//   `runTurn` is called only from inside `runMessage`, so a test driving `runMessage` reaches it without naming it.
//   The metric cannot see that, and the tool says so rather than implying 8 untested branches.
//
// WHAT IS NOT CLAIMED
//   Not that a mention is a drive: a comment counts, and an event string shared by several functions credits all of
//   them. Not that the uncovered count is coverage: it is "no mutation anchor lies here", which R532 established is
//   weaker than condition coverage. Not that the ranking is complete — a function reachable only through two
//   intermediaries will look unreferenced however its strings are matched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'function-risk.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('the module basename is not counted as a reference for every function', () => {
  // The first repair. A column of identical counts is the symptom.
  const d = report();
  const counts = d.rows.map((r) => r.tests);
  const distinct = new Set(counts);
  assert.ok(distinct.size > 3,
    `only ${distinct.size} distinct reference counts across ${d.rows.length} functions: the metric is degenerate`);

  // And the specific degeneration must not have returned: every function reading the same number.
  const mode = counts.sort((a, b) => counts.filter((x) => x === a).length - counts.filter((x) => x === b).length).pop();
  const share = counts.filter((x) => x === mode).length / counts.length;
  assert.ok(share < 0.5,
    `${(share * 100).toFixed(0)}% of functions share the reference count ${mode}: one needle is matching everything`);

  // A generic name still over-matches, and that is a known limit rather than a pass. Recorded here so the honest
  // reading of any single row is "an upper bound on references". `start` appears as a word in 281 test files.
  const start = d.rows.find((r) => r.fn === 'start');
  assert.ok(!start || start.tests > 50,
    'if `start` now matches few files the metric changed in a way worth re-examining');
});

test('a function tested only through its effects is not reported as unreferenced', () => {
  // The second repair, pinned on the concrete case: flushHeldMcpVerbs has no name mention but is driven by
  // session-mcp-clear-queue-r378 through the events it emits.
  const d = report();
  const row = d.rows.find((r) => r.fn === 'flushHeldMcpVerbs');
  assert.ok(row, 'flushHeldMcpVerbs is no longer in the report');
  assert.ok(row.tests > 0,
    'flushHeldMcpVerbs shows zero referencing tests again: effect-only coverage is not being seen');

  // And the test file that drives it must really exist and really mention the behaviour.
  const t = fs.readFileSync(path.join(ROOT, 'test', 'session-mcp-clear-queue-r378.test.mjs'), 'utf8');
  assert.equal(t.includes('flushHeldMcpVerbs'), false,
    'the file now names the function directly, so this case no longer tests the effect-matching path');
  assert.ok(/session_mcp_held_verb_failed|mcpClearAuth/.test(t),
    'the driving test no longer references the behaviour either');
});

test('the ranking is ordered by uncovered branches per referencing file', () => {
  const d = report();
  const finite = d.rows.filter((r) => r.ratio !== 'no-referencing-test');
  for (let i = 1; i < finite.length; i += 1) {
    assert.ok(finite[i - 1].ratio >= finite[i].ratio,
      'the ranking is not descending: ' + JSON.stringify(finite.slice(i - 1, i + 1).map((r) => [r.fn, r.ratio])));
  }
  // Functions with no referencing test sort first and are labelled, not given a huge number.
  const noTest = d.rows.filter((r) => r.tests === 0);
  for (const r of noTest) {
    assert.equal(r.ratio, 'no-referencing-test',
      `${r.fn} has no test but its ratio is ${r.ratio}: JSON cannot carry Infinity, and a number would read as small`);
  }
});

test('the two repairs are documented at the tool', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /every row read 215|a column of 215/i,
    'the degenerate-count failure is no longer recorded');
  assert.match(source, /showed zero referencing\s*\n?\s*\*?\s*tests|showed ZERO referencing tests/i,
    'the name-only failure is no longer recorded');
  assert.match(source, /tested by its EFFECTS|tested by its effects/i,
    'the reason effect matching is needed is gone');
});

test('the report states that a mention is not a drive', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /A mention is not a drive/, 'the central caveat is gone from the printed report');
  assert.match(source, /a comment counts/i, 'the specific way a mention overstates is no longer named');
});
