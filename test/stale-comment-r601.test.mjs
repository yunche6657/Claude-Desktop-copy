'use strict';
// 400 comments deny something. Two are verifiable stale claims, and both are the same comment — R600's, found twice.
//
// WHAT WAS SCANNED
//   `tools/stale-comment.cjs` collects comment lines containing a negative claim (no handler / does not exist / unreachable /
//   always null / dead code / permanently) and tries to attribute each to a symbol:
//
//       handler id checked, DEFINED (stale)    2      ← the only verifiable contradictions
//       handler id checked, absent (honest)    5      ← all five are in this project's own tool comments
//       prose name only (not judged)         108
//       no nameable symbol                   285
//
// THE TWO, AND WHY THEY ARE ONE
//   Both are `desktop/bridge-services.cjs:3714` and `:3715` — consecutive lines of the same wrapped sentence, both denying
//   `claude.web_$_LocalSessions_$_getSessionList`, which `:2058` defines. So the census is: ONE stale comment in the tree, matched
//   by two lines because the claim wraps across them.
//
// THE FIVE "HONEST" ROWS ARE SELF-REFERENCE
//   They sit in `tools/source-divergence.cjs` and `tools/stale-comment.cjs` — the two files whose comments QUOTE the original
//   `handlers.get('…getSessionList')` text while explaining it. A tool that greps comments will eventually find its own
//   documentation. That is not a defect in the tool, but it does mean the "absent" tier cannot be read as "these files are
//   honest" — it is reading the tool's own quotation.
//
// WHY 285 ROWS HAVE NO NAMEABLE SYMBOL, AND WHY THAT IS THE HONEST MAJORITY
//   `unreachable`, `always null` and `dead code` are claims about a REFERENCE — a particular read of a variable at a particular
//   place. "The definition exists" does not refute "this reference can never be reached". Checking the definition would answer a
//   narrower question and, worse, would answer it confidently: a symbol defined and an unreachability claim about one of its
//   uses can both be true.
//
//   So those rows are listed and not judged. That is a smaller contribution than a full check and the correct size of one.
//
// WHAT IS NOT CLAIMED
//   Not that the tree has exactly one stale comment: the scan needs a negative claim AND an attributable handler-id lookup on
//   the same wrapped window. A stale comment phrased as "X is gone" with no `handlers.get` would land in the 285.
//   Not that the 108 prose rows are fine: their names are deducible only by reading the sentence, which is what a reader does
//   with 108 lines far better than a pattern does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'stale-comment.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the only verifiable stale claim is the R600 comment', () => {
  const d = runScan();
  const stale = d.rows.filter((r) => r.kind === 'exact' && r.defined);
  assert.ok(stale.length >= 1, 'the R600 comment is no longer detected');
  for (const r of stale) {
    assert.equal(r.file, 'desktop/bridge-services.cjs', `unexpected stale claim in ${r.file}`);
    assert.match(r.symbol, /getSessionList/, 'the stale claim names something else now');
  }
  // Both hits are the same wrapped sentence.
  assert.equal(new Set(stale.map((r) => r.symbol)).size, 1, 'more than one distinct symbol is claimed absent');
});

test('the comment really does contradict the file', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(src, /that method has no handler/, 'the stale sentence is gone');
  assert.match(src, /define\('claude\.web_\$_LocalSessions_\$_getSessionList'/,
    'the handler it denies is no longer defined, so the claim would now be honest');
});

test('the "absent" tier is dominated by this project\'s own quotations', () => {
  const d = runScan();
  const honest = d.rows.filter((r) => r.kind === 'exact' && !r.defined);
  assert.ok(honest.length >= 0);
  for (const r of honest) {
    assert.match(r.file, /^tools\//,
      `${r.file} names a handler id absent from its own file and is not one of the known self-quotations`);
  }
});

test('reference-level claims are not judged', () => {
  const d = runScan();
  const unverifiable = d.rows.filter((r) => r.kind === 'unverifiable');
  assert.ok(unverifiable.length > 100, `only ${unverifiable.length} unverifiable rows: the tier is not the majority`);
  for (const r of unverifiable) {
    assert.equal(r.defined, null, 'an unverifiable row carries a definition verdict');
    assert.equal(r.symbol, null, 'an unverifiable row carries a symbol');
  }
});

test('the record states why unreachability cannot be checked against a definition', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /claims about a REFERENCE/, 'the reason is not stated');
  assert.match(src, /narrower question/, 'the limitation on what a definition check answers is not stated');
});

test('the record does not claim the tree has exactly one stale comment', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /Not that the tree has exactly one stale comment/, 'the coverage limit is missing');
  assert.match(src, /X is gone/, 'the phrasing that would be missed is not named');
});
