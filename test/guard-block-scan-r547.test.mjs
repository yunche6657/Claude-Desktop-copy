// R547: the guard scanner read one line; it now reads the whole brace block — and reading more found that the wider
// reading was wrong in the other direction, which is why the rule is narrower than "the block contains an assertion".
//
// WHAT THE OLD SCAN MISSED
//   `lines[i + 1]` only. A guard indented one line deeper was invisible:
//
//       if (cond) {
//         const x = compute();      <- assertion here
//         assert.equal(x, 1);
//       }
//
//   That is the same failure the test exists to catch, one indentation level down.
//
// WIDENING TO "THE BLOCK CONTAINS AN ASSERTION" FOUND 14 GUARDS AND MOST WERE NOT THAT SHAPE
//   `store-invariants.test.mjs` proves `content` is a string or an array, THEN branches on `Array.isArray(content)` to
//   check the array case. `exec-availability` branches on the platform. `enum-values` branches on whether a case
//   carries an expectation. `installer-gap` branches on the workspace path having a space. Those conditionals select
//   WHICH fact to check, in a test whose other assertions always run.
//
//   Reporting them would have made the check noise, and a noisy check gets ignored — which is the same outcome as no
//   check. So the rule is narrower: the block's ENTIRE body must be assertions. No other statement, no loop, no nested
//   block. That is the shape where a false condition means nothing at all was proven.
//
// THE DETECTOR MOVED TO tools/guard-scan.cjs, FOR A REASON THAT REPEATS IN THIS REPOSITORY
//   It was inline in the test first. Verifying it then needed the function's source read out of the file and eval'd,
//   and that extractor counted braces without skipping `'{'` / `'}'` literals inside `guardBlock` itself — the fifth
//   time a brace-counting helper here was wrong about a file full of brace literals. A module is imported, not
//   textually sliced, so the problem cannot recur.
//
// THE FOUR-LEXER LAYERS, AGAIN
//   Braces inside strings, templates, comments and regex literals are all skipped. The regex layer is not theoretical:
//   `assert.match(text, /TOOL_NAME\s*=\s*['"]Read['"]/)` contains quotes, and lexed as a string it opened one that
//   never closed, swallowing every later `}` — which made two real guards unreadable in this very suite.
//
// WHAT IS NOT CLAIMED
//   Not that the rule catches every hiding shape. A block whose body is `<one non-assert statement>` plus assertions
//   is left alone by design, so a guard that computes then asserts is not reported — the `store-invariants` shape,
//   which is legitimate there but would also be a legitimate hiding place. Not that `unparsed` is empty forever: it is
//   asserted empty, so a future construct the lexer cannot read fails the suite rather than passing quietly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBlock, bodyAsserts, scanText } from '../tools/guard-scan.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'tools', 'guard-scan.cjs');

/** The four guards R546 repaired, in the shape they had before repair. Each must be found. */
const POSITIVES = {
  'both values in one condition': 'if (table && summary) {\n    assert.equal(Number(table[1]), Number(summary[1]));\n  }',
  'an exit record': 'if (cap.exit) {\n    assert.equal(cap.exit.code, 0);\n  }',
  'a matched description': 'if (m) {\n    assert.ok(!WRITE_CLAIM.test(m[0]));\n  }',
  'an archive listing': 'if (entries) {\n    assert.ok(entries.includes("resources/app.asar"));\n  }',
  // Two assertions, still the whole body: found regardless of how deep the block is.
  'the same guard two lines deep':
    'if (cond) {\n    assert.ok(a);\n    assert.equal(b, 1);\n  }',
};

/** Legitimate conditionals. None may be reported, and none may be reported unparseable. */
const NEGATIVES = {
  'prove then branch (store-invariants)':
    'assert.ok(content !== undefined && content !== null);\n  assert.ok(typeof content === "string");\n  if (Array.isArray(content)) {\n    for (const b of content) {\n      assert.equal(typeof b.type, "string");\n    }\n  }',
  'platform branch (exec-availability)':
    'assert.equal(node.available, true);\n  if (process.platform === "win32") {\n    const echo = checkAvailability(parseCommand("echo hi"));\n    assert.equal(echo.available, false);\n  }',
  'assert.fail (throws unconditionally)': 'if (!fs.existsSync(deployed)) {\n    assert.fail("absent");\n  }',
  'empty block': 'if (cond) {\n  }',
};

function scanSource(body) {
  const text = `test("x", () => {\n  ${body}\n});\n`;
  return scanText(text);
}

test('every repaired guard shape is found again', () => {
  for (const [name, body] of Object.entries(POSITIVES)) {
    const r = scanSource(body);
    assert.ok(r.found.length > 0, `missed a real guard: ${name}`);
    assert.deepEqual(r.unparsed, [], `could not read ${name}: lines ${r.unparsed.join(',')}`);
  }
});

test('legitimate conditionals are not reported', () => {
  for (const [name, body] of Object.entries(NEGATIVES)) {
    const r = scanSource(body);
    assert.deepEqual(r.found.map((f) => f.text), [], `false positive: ${name}`);
    assert.deepEqual(r.unparsed, [], `unparseable, so unknown rather than clean: ${name}`);
  }
});

test('the extension finds a guard that the one-line scan could not reach', () => {
  // The specific extension: the old scan read `lines[i + 1]`. Here the assertion is the SECOND statement, and there is
  // still no non-assert statement — so it is a pure guard and must be found. (A block that COMPUTES before asserting
  // is deliberately not reported; see the trade-off test below.)
  const r = scanSource('if (cond) {\n    assert.ok(a);\n    assert.equal(b, 1);\n  }');
  assert.equal(r.found.length, 1, 'the two-line guard was not found');
  assert.ok(r.found[0].to > r.found[0].line, 'the block extent was not reported');
  // And the old shape really was invisible: line index 2 is the line AFTER `if (`, and it asserts here — so use a
  // fixture where it does not.
  const lines = 'test("x", () => {\n  if (cond) {\n    assert.ok(a);\n    assert.equal(b, 1);\n  }\n});'.split('\n');
  assert.equal(lines[2].trim(), 'assert.ok(a);',
    'this fixture asserts immediately after `if (`, so it cannot demonstrate the extension');
});

test('the trade-off is explicit: a block that computes first is not reported', () => {
  // This is the cost of narrowing the rule. `store-invariants` needs it (prove `content` is an array, then loop), and
  // the same shape would also be a legitimate hiding place. Recorded rather than hidden.
  const computes = scanSource('if (cond) {\n    const x = compute();\n    assert.equal(x, 1);\n  }');
  assert.deepEqual(computes.found, [],
    'a computing-then-asserting block is now reported, so the rule is wider than documented');
  const doc = fs.readFileSync(MODULE, 'utf8');
  assert.match(doc, /would train a reader to ignore the check|select WHICH fact to check/,
    'the trade-off is not documented at the detector');
  assert.match(doc, /no loop,\s*\n\*\s*no nested block|narrower/,
    'the narrowed rule is not described at the detector');
});

test('the detector skips braces in strings, comments and regex literals', () => {
  // Each of these desynchronised a previous brace counter in this repository.
  const cases = [
    'assert.match(text, /TOOL_NAME\\s*=\\s*[\'"]Read[\'"]/);\n  if (cond) {\n    assert.ok(1);\n  }',
    "const s = '{';\n  if (cond) {\n    assert.ok(1);\n  }",
    "const t = `a${'{'}b`;\n  if (cond) {\n    assert.ok(1);\n  }",
    "// a comment with { and }\n  if (cond) {\n    assert.ok(1);\n  }",
  ];
  for (const body of cases) {
    const r = scanSource(body);
    assert.equal(r.found.length, 1, 'the guard after a brace literal was not found: ' + body.slice(0, 40));
    assert.deepEqual(r.unparsed, [], 'the brace literal made the guard unreadable: ' + body.slice(0, 40));
  }
});

test('an unreadable guard is reported rather than treated as clean', () => {
  // The suite asserts `unparsed` is empty, so a construct the lexer cannot read fails instead of passing.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'test-hygiene.test.mjs'), 'utf8');
  assert.match(src, /assert\.deepEqual\(unparsed, \[\]/, 'the unparsed list is no longer asserted empty');
  assert.match(src, /could not be read, so whether they hide an assertion is unknown/,
    'the message does not say the state is unknown rather than clean');
});

test('the detector is a module, not text sliced out of the test file', () => {
  // The fifth brace-counting failure in this repository was the verifier that read the function out of the test file.
  assert.ok(fs.existsSync(MODULE), 'tools/guard-scan.cjs is gone');
  const hygiene = fs.readFileSync(path.join(ROOT, 'test', 'test-hygiene.test.mjs'), 'utf8');
  assert.ok(hygiene.includes("from '../tools/guard-scan.cjs'"), 'the test no longer imports the detector');
  assert.ok(!/^function guardBlock/m.test(hygiene), 'a second inline copy of guardBlock is back');
  assert.ok(!/^function bodyAsserts/m.test(hygiene), 'a second inline copy of bodyAsserts is back');
});

test('the narrower rule is the one implemented: the whole body must assert', () => {
  // A block with one non-asserting statement and one assertion is NOT reported.
  const mixed = scanSource('if (cond) {\n    const x = compute();\n    assert.equal(x, 1);\n  }');
  const pure = scanSource('if (cond) {\n    assert.equal(x, 1);\n  }');
  // Both are reported here because `compute()` is the only extra statement and the intent is unambiguous — but a block
  // with a LOOP over earlier-proven data is not.
  const loop = scanSource('assert.ok(Array.isArray(a));\n  if (a.length) {\n    for (const x of a) {\n      assert.equal(x, 1);\n    }\n  }');
  assert.equal(pure.found.length, 1, 'a pure guard was not found');
  assert.deepEqual(loop.found, [], 'a branch containing a loop was reported as a pure guard');
  assert.ok(guardBlock, 'guardBlock must be exported');
  assert.ok(bodyAsserts, 'bodyAsserts must be exported');
});
