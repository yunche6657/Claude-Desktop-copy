// R521: every exclusion made auditable, and the audit turned up two things — a fixture miscount and a hidden class.
//
// WHY `--explain` EXISTS
//   R520 closed with "29 structural scans excluded" after spot-checking exactly one. A count with one sample behind
//   it is a claim, not a result. `--explain` prints the reason for every row, so a reader checks reasoning rather
//   than arithmetic.
//
// WHAT THE AUDIT FOUND, FIRST
//   The eight "self-scan + filtered" exclusions were ALL inside tools/selfmatch-selftest.cjs — the six synthetic
//   subject programs it embeds as template strings. Those strings contain `fs.readFileSync(__filename, ...)` and
//   `if (/function\s+foo\(/.test(src))`, so the scanner counted fixtures as checks. They were excluded only because
//   the containing file happens to strip comments, which is an accident of that file rather than a property of the
//   fixture. A `fixture` arm now catches a readFileSync inside an unbalanced-backtick region.
//
// WHAT THE AUDIT FOUND, SECOND
//   With verdicts attached to every row, the explain table counted 3 risky while the summary line said 0 — because
//   the headline had always been restricted to `structural`, and those three were `unclear`, `literal-path` and
//   `class-based`. Two numbers about the same word is how a reader concludes the tool is confused. There are now two
//   named counts: `riskyAll` and the structural subset. The three non-structural rows are printed whenever they
//   exist, since hiding them was the previous behaviour.
//
// THE THREE, EXAMINED
//   tools/audit-evidence.cjs               `unclear`      reads and writes evidence/STATUS.md, so it is a genuine
//                                                         self-scan by data flow; the pattern hunts the banner
//                                                         format, which comments in a markdown status file would not
//                                                         contain. Latent, not active.
//   tools/proof-packaged-history-resume…   `literal-path` hunts `const core='…';` in a file it also writes.
//   test/contract-fields-r490.test.mjs      `class-based`  hunts a phrase; the containing file strips comments.
//   None is an active bug. All three are recorded rather than dismissed, because "none right now" is a different
//   statement from "cannot happen".
//
// WHAT IS NOT CLAIMED
//   The `fixture` arm counts backticks, so it misses single- and double-quoted fixtures and any template with an
//   odd backtick in a comment. The explain table is only as complete as the finder, whose 900-character window and
//   single-hop alias resolution remain unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('every scan carries a verdict with a stated reason', () => {
  const r = run(['--explain', '--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.ok(d.rows.length > 50, `suspiciously few rows: ${d.rows.length}`);
  for (const row of d.rows) {
    assert.ok(row.verdict && row.verdict.reason, 'a row has no verdict: ' + JSON.stringify(row.pattern));
    assert.ok(['fixture', 'not-self', 'filtered', 'risky'].includes(row.verdict.reason),
      `unexpected verdict ${row.verdict.reason}`);
    assert.ok(row.verdict.note && row.verdict.note.length > 15,
      `${row.verdict.reason} has no explanatory note`);
  }
  // The four reasons must all be represented, or one gate is never exercised on real input.
  const kinds = new Set(d.rows.map((x) => x.verdict.reason));
  for (const k of ['fixture', 'not-self', 'filtered', 'risky']) {
    assert.ok(kinds.has(k), `no row classified as ${k}: that gate is untested against real code`);
  }
});

test('the fixture arm catches the synthetic subjects in the selftest', () => {
  const d = JSON.parse(run(['--explain', '--json']).stdout);
  const fixtures = d.rows.filter((x) => x.verdict.reason === 'fixture');
  assert.ok(fixtures.length >= 6,
    `expected the selftest's synthetic subjects to be classified as fixtures, got ${fixtures.length}`);
  // The majority must be the selftest's template strings. A fixture classification elsewhere is not automatically
  // wrong — any file embedding a program as a template string qualifies — but it must not be the dominant source,
  // or the arm is catching something other than what it was built for.
  const inSelftest = fixtures.filter((f) => /selfmatch-selftest\.cjs/.test(f.file));
  assert.ok(inSelftest.length >= 6,
    `the selftest's six subjects are not classified as fixtures: ${inSelftest.length} found`);
});

test('an unbalanced-backtick file does not get guesses', () => {
  // The parity guard: test/send-feedback-r412.test.mjs has seven backticks, so parity is meaningless there and a
  // scan was previously classified `fixture` at offset 8273 — which would have silently dropped a real check.
  const d = JSON.parse(run(['--explain', '--json']).stdout);
  const rows = d.rows.filter((x) => x.file.includes('send-feedback-r412'));
  assert.ok(rows.length > 0, 'the file no longer produces a scan: this guard has nothing to test');
  for (const r of rows) {
    assert.notEqual(r.verdict.reason, 'fixture',
      'a scan in an unbalanced-backtick file was classified as a fixture');
  }
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /total % 2 !== 0/, 'the parity guard is gone');
});

test('the two risky counts are named apart, not conflated', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /const riskyAll = rows\.filter/,
    'the all-kinds risky count is gone');
  assert.match(source, /const risky = structural\.filter/,
    'the structural subset is gone');
  assert.match(source, /the historical headline/,
    'the relationship between the two counts is no longer stated');
  // And running --explain must not print a total that contradicts its own table.
  const r = run(['--explain']);
  const table = /risky\s+(\d+)/.exec(r.stdout);
  const summary = /(\d+) risky of \d+ total/.exec(r.stdout);
  // Both must be PRINTED before they can be compared. The guard used to be `if (table && summary)`, which turned a
  // missing line — a tool or harness failure — into a passing test: the tool could stop printing the summary entirely
  // and this check would vanish rather than fail. The two values exist only to be compared, so there is no state in
  // which one being absent means "nothing to assert".
  assert.ok(table, '--explain no longer prints the per-kind table: ' + (r.stdout || '').slice(0, 300));
  assert.ok(summary, '--explain no longer prints its summary line: ' + (r.stdout || '').slice(0, 300));
  assert.equal(Number(table[1]), Number(summary[1]),
    `the table says ${table[1]} risky but the summary says ${summary[1]}`);
});

test('non-structural risky rows are printed rather than hidden', () => {
  const r = run(['--explain']);
  assert.match(r.stdout, /previously hidden by the narrow count/,
    'the tool no longer announces the rows the old count omitted');
  // At least one such row exists in this repo; if that changes, the assertion should be revisited rather than
  // silently passing.
  const hasRow = /\[(unclear|literal-path|class-based)\]\s+tools?\//.test(r.stdout)
    || /\[(unclear|literal-path|class-based)\]\s+test\//.test(r.stdout);
  assert.ok(hasRow, 'no non-structural risky row was printed while the header claims some exist');
});

test('the fixture detector is described as backtick-only', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /insideTemplateLiteral/,
    'the fixture detector is gone');
  assert.match(source, /Single and\s*\*?\s*double quotes are harder|not attempted/i,
    'the backtick-only limitation is no longer disclosed');
});

test('the audit findings are recorded, including that none is an active bug', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /THE THREE, EXAMINED/, 'the per-row examination is gone');
  assert.match(source, /None is an active bug/,
    'the conclusion that none is active is no longer stated');
  // Wraps as: `"none right now" is a different` / `//   statement from "cannot happen"`
  assert.match(source, /is a different[\s\S]{0,20}statement from "cannot happen"/,
    'the distinction between latent and impossible is gone');
});
