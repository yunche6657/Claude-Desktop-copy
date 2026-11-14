// R566: spot-checking the extremes found a THIRD per-line mistake, and then a better measure than counting assertions.
//
// R567 NOTE: the analysis moved into tools/loop-multiplicity.cjs, so the assertions about WHERE a string lives were
// pointed at the wrong file. They now check the module that owns the behaviour, and the two structural claims were
// dropped — "the note appears at the tool" is a claim about file layout, and layout is allowed to change when logic
// moves. What the round concluded is unchanged:
//
//       multi-turn-context.test.mjs    47 lines, 1 test,  2 assertions, 86 prose-only terms   -> CORRECT
//       security-guards.test.mjs       96 lines, 3 tests, 3 assertions, 119 prose-only terms  -> CORRECT
//
//   Both counts were right. What they showed is that these files assert FEW things about MANY subjects: `security-guards`
//   loops over 14 guards, collects offenders, and asserts `deepEqual(offenders, [])` once — a STRONGER shape than 14
//   separate asserts, because the failure lists every offender together.
//
// THE THIRD PER-LINE MISTAKE
//   `hybrid-bootstrap-runtime-gate-r378.test.mjs` has SIX assertions, all on one line:
//
//       try{assert.equal(…);await …;assert.deepEqual(…);assert.equal(…);…assert.ok(stored.command);}finally{…}
//
//   Counting lines that contain `assert.` counted it once. Same error as R565's `^\s*assert\.` and R564's prose split:
//   a per-line rule applied to code written on one line.
//
// THE MEASURE THAT REPLACES A COUNT
//   `image-bridge.test.mjs` (1 assertion, deepEqual over a two-element call log) and
//   `mcp-relay-list-lifecycle-r378.test.mjs` (1 assertion, deepEqual over a ten-event trace) are the clearest evidence
//   that a count is the wrong measure: neither is a weak test, and a count of `assert.` calls puts both at the bottom.
//
// WHAT IS NOT CLAIMED
//   Not that the fact count is accurate: the loop multiplicity is read from a literal in the same file and falls back to
//   1, so it is a LOWER BOUND and is labelled as one.
//   Not that a high ratio is better: a many-item `deepEqual` reports all offenders at once but stops at the first
//   mismatch, so a 14-item comparison can conceal later problems. Both shapes have a cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyse } from '../tools/loop-multiplicity.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'assertion-strength.cjs');
const MODULE = path.join(ROOT, 'tools', 'loop-multiplicity.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('a file with six assertions on one line counts as six', () => {
  const d = report();
  const row = d.rows.find((r) => r.file === 'hybrid-bootstrap-runtime-gate-r378.test.mjs');
  assert.ok(row, 'the file is missing from the report');
  assert.equal(row.assertions, 6,
    `it reports ${row.assertions} assertions; the file has six on a single line`);
});

test('no file is reported with fewer assertions than it has', () => {
  // The general form of the bug. R567 tightened the pattern to require a call (`assert.x(`), so files whose comments
  // mention `assert.` without calling it are now correctly BELOW their raw `assert.` count — the comparison is against
  // calls, which is what the module counts.
  const d = report();
  for (const row of d.rows) {
    const text = fs.readFileSync(path.join(ROOT, 'test', row.file), 'utf8');
    const calls = (text.match(/\bassert\.[A-Za-z_$][\w$]*\s*\(/g) || []).length;
    assert.equal(row.assertions, calls,
      `${row.file}: reported ${row.assertions}, file has ${calls} assertion calls`);
  }
});

test('the two files left with one assertion are the ones that check a whole trace at once', () => {
  const d = report();
  const singles = d.rows.filter((r) => r.assertions === 1).map((r) => r.file).sort();
  assert.deepEqual(singles, ['image-bridge.test.mjs', 'mcp-relay-list-lifecycle-r378.test.mjs'],
    `the single-assertion set changed: ${singles.join(', ')}`);
  const image = fs.readFileSync(path.join(ROOT, 'test', 'image-bridge.test.mjs'), 'utf8');
  assert.match(image, /assert\.deepEqual\(calls,\[/, 'image-bridge no longer asserts a call log');
  const relay = fs.readFileSync(path.join(ROOT, 'test', 'mcp-relay-list-lifecycle-r378.test.mjs'), 'utf8');
  assert.match(relay, /assert\.deepEqual\(trace,\[/, 'the relay test no longer asserts a trace');
});

test('a loop of many subjects raises the fact count', () => {
  const d = report();
  const row = d.rows.find((r) => r.file === 'security-guards.test.mjs');
  assert.ok(row, 'security-guards is missing');
  assert.ok(row.ratio > 1,
    `its ratio is ${row.ratio}: the loop over 14 guards is not being counted`);
});

test('the tool says its fact count is a lower bound', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LOWER BOUND/, 'the output no longer says the count is a lower bound');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /can conceal|Both shapes have a cost/i,
    'the cost of a many-item deepEqual is not acknowledged');
});

test('an invalid identifier cannot break the pattern builder', () => {
  // The guard lives in the module now, which is where `new RegExp` is built.
  const src = fs.readFileSync(MODULE, 'utf8');
  assert.ok(src.includes('const isName'),
    'the identifier guard is gone, so a fragment can still be fed to new RegExp');
  assert.match(src, /if \(!isName\(name\)\) return 1;/, 'the guard is not applied in multiplicity()');
});

test('the analysis itself is in the module, not the reporter', () => {
  // Behaviour lives in one place; the reporter reads the tree and prints.
  const mod = fs.readFileSync(MODULE, 'utf8');
  assert.match(mod, /module\.exports = \{/, 'the module exports nothing');
  const a = analyse(fs.readFileSync(path.join(ROOT, 'test', 'security-guards.test.mjs'), 'utf8'));
  assert.ok(a.ratio > 3, `the module gives ratio ${a.ratio} for security-guards`);
});
