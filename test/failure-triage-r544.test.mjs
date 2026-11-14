// R544: the four failure groups that were invisible while the "full suite" only ran 65% of its files.
//
// WHAT EACH GROUP TURNED OUT TO BE
//   unparsed-candidates-r529   a TOOL defect, fixed here: 8 reported-unclosed braces -> 0
//   websearch-count-r430       the PRODUCT changed: `error: z` now exists in ReadMcpResourceTool.ts
//   selfmatch-baseline-r522    a DESIGN CONTRADICTION between R522 (no offsets) and R524 (offsets required)
//   test-hygiene               TEST HYGIENE: one of mine, plus nine older guarded assertions
//
// THE FIX IN THIS ROUND, AND WHY IT TOOK FOUR LAYERS
//   `unparsed-candidates.cjs` reports body-shaped braces whose extent it cannot find. Eight were reported, all in
//   `tools/branch-coverage.cjs` — a file that compiles and runs. The brace counter was wrong four times over:
//
//     1. `'{'` / `'}'` character literals counted as syntax     -> skip strings and templates
//     2. `if (cond) {` quoted inside a doc comment read as a body -> skip line and block comments
//     3. the block-comment check looked at an 80-char window, and the `/*` was hundreds of lines up
//                                                                -> scan the whole prefix for the last `/*` vs `*/`
//     4. a quote inside a regex literal opened a string that never closed
//                                                                -> recognise a regex literal after an operator
//
//   Each layer was found by re-running and reading the remaining rows, not by reasoning about what might be wrong.
//
// WHAT IS DELIBERATELY NOT CHANGED
//   `websearch-count-r430` fails because the product gained an `error` field. Its own comment says to update the test
//   and the evidence note if failures start returning data — that is a product decision, not a repair.
//   `selfmatch-baseline-r522` fails because R522 wanted a key without offsets and R524 needed offsets to tell three
//   identical scans apart. Both reasons are sound and they are incompatible in one key.
//   Nine older guarded assertions remain: at least two of them skip legitimately (`firstNonTitle === -1` means there
//   is no non-title row to order), so a blanket rewrite would be wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'unparsed-candidates.cjs');

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

test('no body-shaped brace is reported unclosed, because four kinds of false opener are rejected', () => {
  // The finding was 8; it is 0 after the four fixes. A regression here means one of the four layers broke.
  const d = report();
  assert.equal(d.unmatched, 0,
    `${d.unmatched} brace(s) still unclosed: one of the four lexer layers regressed`);
});

test('braces inside string literals do not count as syntax', () => {
  // Layer 1. `branch-coverage.cjs` compares characters, so it is full of `'{'` literals.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /state = 'str'; quote = c/, 'string state is gone from matchBrace');
  assert.match(src, /if \(c === quote\) \{ state = 'code'/, 'the string terminator check is gone');
});

test('braces inside comments do not count as syntax', () => {
  // Layers 2 and 3. A doc comment quoting `if (cond) {` must not be treated as a body.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /lastOpen > lastClose/, 'the block-comment prefix check is gone');
  assert.match(src, /fullPrefix/, 'the check no longer scans the whole prefix');
  assert.match(src, /lineSoFar\.includes\('\/\/'\)/, 'the line-comment check is gone');
});

test('a regex literal is recognised so a quote inside it does not open a string', () => {
  // Layer 4. `/^'((?:[^'\\]|\\.)*)'$/` contains quotes and must not be lexed as a string.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /state = 'regex'/, 'regex state is gone from matchBrace');
  // Checked as substrings rather than one regex: the condition contains `/`, `[`, `(` and `|`, so embedding it in a
  // regex literal needs escaping that is easy to get wrong and hard to read once wrong.
  assert.ok(src.includes("state = 'regex'"), 'regex state assignment is gone');
  assert.ok(src.includes("if (c === '/' && /[([{,;:=!&|?+\\-*%~^<>]/.test(prev || '('))"),
    'the regex-opener condition is gone: division and regex are indistinguishable again');
});

test('the four layers are documented with their measurements', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /eight of its real braces look unclosed/, 'layer 1 is not described');
  assert.match(src, /doc-comment line whose `\/\*` opened hundreds/, 'layer 3 is not described');
  assert.match(src, /quote inside/, 'layer 4 is not described');
});

test('the product-change failure is recorded as an alarm, not repaired', () => {
  // `websearch-count-r430` is designed to fire when ReadMcpResource gains an `error` field. It fired.
  const doc = fs.readFileSync(path.join(ROOT, 'evidence', 'failure-triage-r544.md'), 'utf8');
  assert.match(doc, /产品真的变了/, 'the product-change group is not classified');
  assert.match(doc, /ReadMcpResourceTool\.ts:46/, 'the concrete evidence for the change is missing');
});

test('the design contradiction names both rounds and both reasons', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'evidence', 'failure-triage-r544.md'), 'utf8');
  assert.match(doc, /R522/, 'the no-offset side is not named');
  assert.match(doc, /R523–R524|R524/, 'the offset-required side is not named');
  // Both justifications have to be present, or the reader cannot see why one key cannot satisfy both.
  assert.match(doc, /改一行注释会移动其下所有 offset/, 'R522 reason is missing');
  assert.match(doc, /三份相同扫描/, 'R524 reason is missing');
});

test('the untouched groups are counted honestly', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'evidence', 'failure-triage-r544.md'), 'utf8');
  assert.match(doc, /只修了一组/, 'the round overstates its repairs');
  assert.match(doc, /9 处/, 'the remaining guarded assertions are not counted');
});
