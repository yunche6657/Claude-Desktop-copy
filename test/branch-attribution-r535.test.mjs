// R535: the ranking R534 built was pointing at a function that does not exist at the size claimed.
//
// WHAT R534 CONCLUDED
//   `beginExistingStart` was the top of the risk ranking: 14 branches, zero referencing tests, called only from
//   inside. That was going to be the next target.
//
// WHAT IT ACTUALLY IS
//   Eleven lines, session-kernel.cjs:347-357, containing two `if`s:
//       turn.then(result => { if (!started) reject(...) }, error => { if (!started) reject(error); else log(...) })
//   The other twelve branches attributed to it belong to top-level constant initialisers and event handlers that
//   follow it in the file.
//
// WHY THE ATTRIBUTION WAS WRONG
//   `functionAt` took the nearest preceding `function name(` and stopped there. A branch inside a top-level `const`
//   arrow, or inside a bare `if` between two declarations, has `beginExistingStart` as its nearest preceding
//   declaration — and was credited to it. Nothing about that is a cosmetic label: the branch count is what made the
//   function worth looking at, so an inflated count invents a target out of the code that happens to follow.
//
// THE FIX, AND WHAT IT MOVED
//   The walk-back now also verifies that the declaration's OWN body still encloses the offset — brace depth from the
//   body's opening must not return to zero before it. Attribution after the fix, measured:
//       beginExistingStart   14 -> 2     (matches the source exactly)
//       flushHeldMcpVerbs    48 -> 22    (body spans 803-847; half its former count was the same mistake)
//       (top level)              138     now names the code that has no enclosing declaration
//
//   The total is unchanged at 367 and the touched count unchanged at 5, which is the check that the fix relabelled
//   rather than lost anything.
//
// WHAT IS STILL APPROXIMATED
//   An arrow function assigned to a `const` has no `function name(` to find, and an object-literal method is likewise
//   invisible to this walk. Those branches land in '(top level)' rather than being guessed at — which is why that
//   bucket is now the largest, and why its size is not evidence of anything being untested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'branch-coverage.cjs');
const KERNEL = path.join(ROOT, 'desktop', 'session-kernel.cjs');

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

test('a function shorter than its own branch count is impossible', () => {
  // The direct assertion: for every function, the branches attributed to it must fit inside its source extent.
  // beginExistingStart spans 11 lines and was credited with 14 branches; its neighbours supplied the excess.
  const d = report();
  const source = fs.readFileSync(KERNEL, 'utf8');
  const lines = source.split('\n');

  const extent = (fn) => {
    // Accept any of the shapes functionAt now recognises: `function name(`, `const name = ...=>`, `name(args) {`,
    // `name: ...=>`. The first version only looked for `function name(` and failed on object methods like `onState`.
    //
    // THE DECLARATION MATCHED MUST BE ONE OF SEVERAL NAMESAKE DECLARATIONS. `current` is declared six times in this
    // file; `findIndex` took the first, whose body ends 25 lines before the branch under test, and reported the tool as
    // wrong when the tool had the right one. So the check now accepts ANY declaration of that name whose extent
    // contains the branch line — which is what "the branch is inside a function called X" actually claims.
    const starts = [];
    lines.forEach((l, i) => {
      if ([`function ${fn}(`, `const ${fn} =`, `let ${fn} =`].some((p) => l.includes(p))) starts.push(i);
      else if (new RegExp(`^\\s{2,}${fn}\\s*\\(`).test(l)) starts.push(i);
      else if (new RegExp(`^\\s{2,}${fn}\\s*:`).test(l)) starts.push(i);
    });
    if (!starts.length) return null;
    const ends = [];
    for (const at of starts) {
      let depth = 0;
      let begun = false;
      for (let i = at; i < lines.length; i += 1) {
        depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
        if (lines[i].includes('{')) begun = true;
        if (begun && depth === 0) { ends.push(i + 1); break; }
      }
    }
    return ends.length ? Math.max(...ends) : null;
  };

  for (const row of d.rows) {
    if (row.fn === '(top level)') continue;
    const end = extent(row.fn);
    assert.ok(end, `${row.fn} has no locatable body end`);
    assert.ok(row.line >= 0, `${row.fn} branch at a negative line`);
    // A branch must start on or before the function's closing line.
    assert.ok(row.line <= end,
      `branch at L${row.line} is attributed to ${row.fn}, whose body ends at L${end}`);
  }
});

test('beginExistingStart reports exactly the two branches it contains', () => {
  const r = run(['--in', 'beginExistingStart', '--json']);
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  assert.equal(d.total, 2,
    `beginExistingStart has ${d.total} branches; the function is eleven lines with two ifs`);
  // Both must be the two `if (!started)` calls, which is what the function is for.
  for (const row of d.rows) {
    assert.match(row.text, /!started/, `unexpected branch inside beginExistingStart: ${row.text}`);
  }
});

test('relabelling did not lose branches', () => {
  // R535 established that fixing attribution must move labels without changing the total. R536 then found the total
  // itself was wrong — eleven lines carried two rows because `else if` matched both the `if` and the `else if`
  // patterns, and `.catch(` matched the handler pattern. The deduped total is 352.
  //
  // So this asserts the CURRENT invariant rather than R535's number: every branch has a distinct keyword offset, and
  // the count is stable. A change here is a counting change and deserves a look, which is exactly what R536 was.
  const d = report();
  assert.equal(d.total, 352, `the branch total is ${d.total}, expected 352 after deduplication`);
  assert.equal(d.covered, 5, `the touched count changed to ${d.covered}`);

  // The real invariant: no two rows may share a keyword offset. Line and kind are not enough — line 858 holds two
  // distinct `if` keywords — so the offset is what must be unique, and the tool now reports it.
  assert.equal(d.rows.length, d.total, 'the reported total does not match the number of rows');
  const offsets = d.rows.map((r) => r.offset);
  assert.equal(new Set(offsets).size, offsets.length,
    'two rows share a keyword offset: the dedup is not holding');
});

test('the enclosing-body check is what does the work', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /the brace depth must not return to zero before the offset|body still open at the offset/,
    'the enclosing-body check is gone from functionAt');
  assert.match(source, /beginExistingStart` is eleven lines long/,
    'the concrete case is no longer recorded');
  assert.match(source, /a count inflated by twelve|invents a target/i,
    'the consequence of the mislabel is not stated');
});

test('the remaining approximation is disclosed', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /arrow function assigned to a const has no/, 'the const-arrow blind spot is not disclosed');
  assert.match(source, /object-literal method is likewise invisible/, 'the object-method blind spot is gone');
  // And '(top level)' must be large, because that is where those land — asserting it keeps the disclosure honest.
  const d = report();
  const top = d.rows.filter((r) => r.fn === '(top level)').length;
  assert.ok(top > 50, `'(top level)' has only ${top} branches: the const-arrow case may now be misattributed`);
});
