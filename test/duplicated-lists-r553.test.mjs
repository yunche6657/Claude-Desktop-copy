// R553: a detector for "one list written out more than once", and what it found — which was mostly not defects.
//
// WHY THIS DETECTOR EXISTS
//   Three consecutive rounds found the same failure in three different spellings:
//     R550  `blank()`         an 81-line lexer in two files; the copy missing the template layer made a file
//                             permanently unscannable.
//     R551  `contractTools()` same name, two files, disagreeing about the one case that matters — `return null` versus
//                             `return []`, so a missing input produced an empty report with exit 0.
//     R552  `UNION_NAMES`     the same two strings in six places; a CONSTANT, so tools/duplicate-decisions.cjs (which
//                             compares same-named functions) could not see it.
//
//   The common form is not "duplicate code", it is "one list, copied". So this tool groups by the SET OF STRING
//   LITERALS rather than by function name.
//
// WHAT IT FOUND: THE TOP GROUPS ARE NOT DEFECTS
//   1654 bracketed string lists, 105 repeated across files. Read, not assumed:
//
//   `['LocalSessions','LocalAgentModeSessions']` — 12 test files. Production has NO such array: bridge-services.cjs
//   registers each namespace as its own literal. The tests sample a registry; they are not copying a list. Nothing to
//   unify, and unifying them would invent an abstraction that production does not have.
//
//   `['coordinator','config','reserved',…]` — 8 proof scripts, each declaring the coverage fields its own scenario
//   needs. Selected, not copied.
//
//   `['SystemRoot','windir','PATH','ComSpec','PATHEXT']` and the four home-directory names — 7 proof scripts. Here the
//   SURROUNDING CODE has drifted: `proof-sdk-mcp` assigns `env.HOME` inline, the other two build a `dir` and merge
//   `TEMP`/`TMPDIR` differently. That is R551's lesson arriving again — the list matches while the logic does not. But
//   proof scripts are the record of what a past round ran; editing them rewrites that record, so they are reported and
//   left alone.
//
// THE HONEST CONCLUSION ABOUT THE DETECTOR
//   Its first useful result is negative: the lists that repeat most are not the lists that drift. It WOULD have shown
//   `UNION_NAMES`, ranked among 104 other groups. A detector's value is its ranking, and a ranking whose top is
//   dominated by legitimate repetition ranks badly. Recorded rather than papered over.
//
// WHAT IS NOT CLAIMED
//   Not that the 105 groups were all read — the top four were. Not that the tool finds lists built with `.push` or
//   spread across multiple statements: it only reads bracketed literal runs. Not that a repeated list is a defect: the
//   report says so at the bottom of every run, because the opposite reading is the tempting one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'duplicated-lists.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('the detector finds repeated lists and ranks them by how many files share them', () => {
  const d = report();
  assert.ok(d.listsSeen > 500, `only ${d.listsSeen} bracketed string lists found: the scan is not covering the tree`);
  assert.ok(d.groups > 10, `only ${d.groups} repeated groups: the detector collapsed`);
  // Ranked: the first group must be shared by at least as many files as the last.
  const counts = d.rows.map((g) => g.fileCount);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] <= counts[i - 1], `the ranking is out of order at index ${i}`);
  }
});

test('standard-library vocabularies are excluded, because their repetition means nothing', () => {
  // The first run's top two groups were `['pipe','pipe','pipe']` (23 files) and `['ignore','pipe','pipe']` (20) — both
  // `stdio` options for child_process.spawn. They repeat because Node's API repeats.
  const d = report();
  const bad = d.rows.filter((g) => g.values.every((v) => ['pipe', 'ignore', 'inherit'].includes(v)));
  assert.deepEqual(bad.map((g) => g.values), [], 'a stdio vocabulary is still being reported as a repeated list');
  const signals = d.rows.filter((g) => g.values.every((v) => /^SIG[A-Z]+$/.test(v)));
  assert.deepEqual(signals.map((g) => g.values), [], 'a signal list is still being reported');
});

test('the excluded vocabularies are named at the tool, not silently dropped', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /STDIO_VALUES/, 'the stdio exclusion went unnamed');
  assert.match(src, /SIGNAL_VALUES/, 'the signal exclusion went unnamed');
  assert.match(src, /not because anyone copied a list/, 'the reason for the exclusion is gone');
});

test('the largest group is recorded as legitimate rather than presented as a defect', () => {
  // `['LocalSessions','LocalAgentModeSessions']` in 12 test files. Production has no such array, so unifying the tests
  // would invent an abstraction production does not have.
  const d = report();
  const top = d.rows[0];
  assert.ok(top, 'no groups at all');
  assert.ok(top.fileCount >= 5, `the largest group is only ${top.fileCount} files: the ranking lost its subject`);
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /registers each namespace as a separate literal|sampling a registry/,
    'the finding about the largest group is not recorded');
  assert.match(src, /proof scripts are evidence of what was run|left alone/,
    'the decision to leave proof scripts unchanged is not recorded');
});

test('the tool states that a repeated list is not a defect', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not a defect list/, 'the human output no longer warns that repetition is not a defect');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /ranks badly|dominated by legitimate repetition/,
    'the honest conclusion about the ranking is not recorded');
});

test('a list built with push or spread is outside what this tool can see, and it says so', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /only reads bracketed literal runs|\.push/, 'the detection limit is not stated');
});
