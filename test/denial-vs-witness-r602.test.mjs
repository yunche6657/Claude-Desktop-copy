'use strict';
// Twelve same-function pairs between "unreachable" and "observed". All twelve are two unrelated comments in one big body.
// The cross produces no signal here, and that is worth recording as a measured negative rather than a silence.
//
// WHAT WAS CROSSED
//   R601 measured 285 comments making reference-level claims (unreachable / always null / dead code / never called) and did not
//   judge them, since "the definition exists" cannot refute "this reference is never reached".
//   R571 measured 121 branches whose own comment records an observed outcome.
//
//   Neither can be contradicted alone. Together they could: if one comment says a path cannot be reached and another inside the
//   same function records that a branch there WAS observed, one of the two is wrong. Measured:
//
//       comments denying reachability            44
//       comments recording an observation        42
//       same-function pairs                      12
//       files excluded as minified                2
//
// THE PAIRS ARE NOT CONTRADICTIONS, AND THE BEST ONE SHOWS WHY
//       desktop/bridge-services.cjs  registerBridgeServices()
//           L1580  "added a handler here; it was never registered and would have been dead code."
//           L1646  "MEASURED BEFORE: no handler, so it answered the generic `null`."
//
//   Both describe a PAST FIX in the same registration function. :1580 is about the `on*` methods, which are deliberately skipped
//   because the frontend transport satisfies them through event channels. :1646 is about `showSessionFileInFolder`, which now
//   has a handler. Two different symbols, two different repairs, one large function.
//
//   The remaining eleven have the same shape: `registerBridgeServices` holds hundreds of `define(...)` calls, and
//   `bridge-services.cjs` minifies several unrelated handlers into `ck()`. A function-level locator cannot separate comments
//   1,100 lines apart in a body that large.
//
// WHY THE LOCATOR FAILS THIS WAY
//   R586 used the same "nearest preceding `function NAME(`" locator for three call sites and it worked, because those sat inside
//   small factories. Here the functions are the largest in the codebase, so "same function" degenerates to "same file" — and a
//   file-level cross is exactly the cheap heuristics this work has already rejected twice (R591's nine false candidates from
//   "does this file reset a set", R594's 33 false Map keys from "do the two names match").
//
// WHAT WOULD ACTUALLY DECIDE IT
//   The denial and the witness have to be about the SAME REFERENCE, which needs the identifier and the branch condition on both
//   sides — a dataflow question, not a comment-position question. That is the parser R571 withdrew from after three failures.
//
// WHAT IS NOT CLAIMED
//   Not that no such contradiction exists in the tree: 44 denials and 42 witnesses is a small population, and the ones phrased
//   without landing inside a witness's function were never compared.
//   Not that the twelve are benign BECAUSE they describe past fixes: one of them could still be stale about its own fix. Reading
//   all twelve is what would settle that, and this round read one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'denial-vs-witness.cjs');
const BRIDGE = path.join(ROOT, 'desktop', 'bridge-services.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('both populations are non-trivial, so the cross has something to compare', () => {
  const d = runScan();
  assert.ok(d.denialSites >= 20, `only ${d.denialSites} denial comments`);
  assert.ok(d.witnessSites >= 20, `only ${d.witnessSites} witness comments`);
  // The witness count is far below R571's 121 because a witness here must be a COMMENT naming an outcome, while R571 also
  // counted the outcome recorded in code. The difference is expected, not a regression.
  assert.ok(d.witnessSites < 121, 'witness counting changed shape');
});

test('every pair really shares a file and a function name', () => {
  const d = runScan();
  for (const p of d.rows) {
    assert.ok(p.file && p.fn, 'a pair is missing its location');
    assert.ok(p.denialLine > 0 && p.witnessLine > 0);
    assert.notEqual(p.denialLine, p.witnessLine, 'a line is paired with itself');
  }
});

test('the best pair is two different symbols, not one reference', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const lines = src.split('\n');
  // The denial is about the `on*` methods being skipped.
  assert.match(lines[1579], /never registered and would have been dead code/);
  assert.match(lines.slice(1574, 1578).join(' '), /skips every `on\*` method/,
    'the subject of the denial is no longer the on* methods');
  // The witness is about showSessionFileInFolder.
  assert.match(lines[1645], /MEASURED BEFORE: no handler/);
  const nearby = lines.slice(1640, 1644).join(' ');
  assert.match(nearby, /define\('claude\.web_\$_LocalSessions_\$_createSessionFile'/,
    'the witness no longer sits among the define() calls it describes');
});

test('the locator is honest about degenerating to file level', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(/DEGENERATES TO "same file"|collapses to "same file"/.test(src), 'the degeneracy is not stated');
  assert.match(src, /R591|R594/, 'the earlier rejected file-level heuristics are not cited');
});

test('the scan reports no verdict', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Reporting the pair, not a verdict/, 'the output claims a verdict');
});

test('what would actually decide it is named, and it is not a comment-position check', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /SAME REFERENCE/, 'the real requirement is not stated');
  assert.match(src, /dataflow question/, 'the kind of question is not named');
  assert.match(src, /R571 withdrew/, 'the prior failure is not cited');
});

test('the two coverage limits are declared', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /Not that no such contradiction exists/, 'the population limit is missing');
  assert.match(src, /this round read one/, 'how many were read is not stated');
});
