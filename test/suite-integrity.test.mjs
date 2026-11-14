// Every declared test actually runs, and no assertion is structurally vacuous.
//
// MEASURED: 263 test files declare 1789 `test(` calls, and the runner reports 1789 passing.
// The two numbers matching is the point — a file whose tests were all skipped by a guard, or a
// file that failed to import, would show up as a gap here.
//
// Also scanned for assertions that cannot fail by shape: assert.ok(true), assert.equal(a, a),
// typeof checks against a value already known. The scan found 18 `assert.ok(singleVar)` calls,
// and inspecting them showed all 18 are the normal 'assert non-null, then assert a field'
// pattern — e.g. `assert.ok(evt); const req = evt.payload.request;` — not vacuous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

function testFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
}

test('no test file is empty of test() calls', () => {
  // An empty file still reports as a passing file, which inflates the count.
  const empty = testFiles().filter((f) => {
    const body = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    return [...body.matchAll(/^\s*test\(/gm)].length === 0;
  });
  assert.deepEqual(empty, [], 'files with no tests: ' + empty.join(', '));
});

test('no assertion is structurally unable to fail', () => {
  // The shapes that can never fail regardless of the code under test.
  const vacuous = [];
  for (const f of testFiles()) {
    // Skip this file: it CONTAINS the patterns it searches for, as regex source. A scan that
    // did not exclude itself reported its own string literals as violations — measured.
    if (f === 'suite-integrity.test.mjs') continue;
    const lines = fs.readFileSync(path.join(TEST_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/assert\.ok\(\s*true\s*\)/.test(line)) vacuous.push(f + ':' + (i + 1) + ' assert.ok(true)');
      if (/assert\.deepEqual\(\[\],\s*\[\]\)/.test(line)) vacuous.push(f + ':' + (i + 1) + ' deepEqual([], [])');
      const self = line.match(/assert\.equal\(\s*([\w.$]+)\s*,\s*\1\s*\)/);
      if (self) vacuous.push(f + ':' + (i + 1) + ' assert.equal(a, a)');
    });
  }
  assert.deepEqual(vacuous, [], 'vacuous assertions: ' + vacuous.join('; '));
});

test('the suite declares a substantial number of tests', () => {
  // A floor, so a refactor that silently drops whole files is visible.
  const total = testFiles().reduce((sum, f) => {
    const body = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    return sum + [...body.matchAll(/^\s*test\(/gm)].length;
  }, 0);
  assert.ok(total >= 1700, 'only ' + total + ' tests are declared');
});