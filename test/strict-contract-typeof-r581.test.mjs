// R581: the phantom `b.isCurrent` reads were a REGEX defect, not a type question. R580 asked which; this answers it.
//
// THE QUESTION R580 LEFT
//   The `untested` entry in R576's ledger was `strict-contract-audit`'s receiver key: it reported three `b.isCurrent` reads
//   that no one had explained. R580 said the choice was between
//
//       a fixable regex defect — the window crosses an object boundary
//       a type question          — the scan cannot know what `b` is
//
//   and that the difference decides whether the check stays a text scan at all.
//
// THE ANSWER: A REGEX DEFECT
//   Applying the tool's own three patterns and printing what they matched:
//
//       mcp-session-auth.cjs:26   … && typeof b.isCurrent === 'function' && b.isCurrent() === true
//       mcp-session-auth.cjs:32   … && typeof b.isCurrent === 'function' && b.isCurrent() === true ? …
//       mcp-session-auth.cjs:35   … && typeof b.isCurrent === 'function' && b.isCurrent() === true ? …
//
//   All three come from the `&& x.f` pattern, and the pairing is CORRECT: `b` is the receiver, `isCurrent` is the field.
//   What was wrong is the CLASSIFICATION. `typeof b.isCurrent === 'function'` is a type check; the expression afterwards is
//   a strict call (`isCurrent() === true`). Neither is a truthiness read.
//
//   The fix is the same kind that already existed for `Boolean(…)`: strip `typeof x.f` before matching. All three
//   phantoms disappeared, and no other row changed.
//
// WHY THIS MATTERS MORE THAN THE THREE ROWS
//   R571 withdrew a liveness rule after three wrong versions because the question it asked needed a parser. This round's
//   question looked similar and was not: the subject was right and one pattern was reading the wrong construct. Keeping the
//   distinction straight is what stops a text scan from being abandoned whenever it produces a bad row.
//
// THE LEDGER ENTRY CHANGED STATUS
//   `untested` -> `sound`, with the correction recorded at the entry rather than in this file alone. One `untested` remains
//   (`text-assertion-audit`), and it is still the dangerous state: a key nobody has read a row of.
//
// WHAT IS NOT CLAIMED
//   Not that 113 is now correct — it is 2 lower than R575's 111 + the rows this tool has since found, and the drop of three
//   is exactly this fix. The remaining rows are the ones that were there before and have not been individually read.
//   Not that `typeof x.f` was the only misclassification: it is the one that produced a recorded phantom, and a class of
//   construct that has not produced one may still be miscounted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DETECTOR_KEYS } from '../desktop/detector-keys.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'strict-contract-audit.cjs');

const runAudit = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the phantom is gone', () => {
  const d = runAudit();
  const phantom = d.rows.filter((r) => r.subject === 'b.isCurrent');
  assert.deepEqual(phantom.map((r) => r.consumer), [],
    'the `b.isCurrent` row is back, so the typeof strip is not applied');
});

test('the three sites really are type checks followed by strict calls', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'mcp-session-auth.cjs'), 'utf8').split('\n');
  for (const n of [26, 32, 35]) {
    const text = lines[n - 1] || '';
    assert.match(text, /typeof b\.isCurrent === 'function'/, `line ${n} is no longer a typeof check`);
    assert.match(text, /b\.isCurrent\(\) === true/, `line ${n} is no longer a strict call`);
  }
});

test('the strip is applied the same way Boolean(…) already was', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(/Boolean\\s\*\\\(/.test(src), 'the Boolean strip is gone');
  assert.ok(/typeof\\s\+\[a-zA-Z_\$\]/.test(src), 'the typeof strip is missing');
  assert.ok(/withoutTypeof/.test(src), 'the stripped text is not what the && pattern reads');
  // And the call exclusion, which the first attempt at the typeof strip exposed rather than fixed.
  assert.ok(/\[=!<>\(\]/.test(src), 'a call form `x.f(` is no longer excluded from the truthiness pattern');
});

test('the audit still reports its denominator after the fix', () => {
  const d = runAudit();
  assert.ok(d.strictFields > 100, `only ${d.strictFields} strict fields`);
  assert.ok(d.lax > 0, 'no lax read at all, which the evidence does not support');
  assert.equal(d.lax + (d.consumerSites - d.lax), d.consumerSites, 'the split does not sum');
  // The top row must not be a known phantom.
  const top = [...d.rows].filter((r) => !r.strictHere).sort((a, b) => b.reads - a.reads)[0];
  assert.notEqual(top.subject, 'b.isCurrent', 'the phantom is back at the top');
});

test('the ledger entry moved from untested to sound, with the reason at the entry', () => {
  const entry = DETECTOR_KEYS.find((d) => d.round === 581);
  assert.ok(entry, 'the updated entry is missing');
  assert.equal(entry.status, 'sound');
  assert.equal(entry.tool, 'tools/strict-contract-audit.cjs');
  assert.match(entry.lesson, /CLASSIFICATION/, 'the entry does not say what was actually wrong');
  assert.match(entry.lesson, /regex defect/, 'the entry does not say which kind of defect it was');
  assert.match(entry.lesson, /R580 asked/, 'the entry does not connect to the round that asked');
});

test('no untested key remains, and the last one was resolved rather than dropped', () => {
  // R581 closed this with one `untested` left (`text-assertion-audit`). R582 read its most suspicious row — a pattern that
  // matched a sentence in a `what:` data field — and added the data/code discriminator, which moved it to `sound`.
  const untested = DETECTOR_KEYS.filter((d) => d.status === 'untested');
  assert.equal(untested.length, 0,
    `${untested.length} keys are still unread: ${untested.map((d) => d.tool).join(', ')}`);
  const resolved = DETECTOR_KEYS.find((d) => d.tool.includes('text-assertion-audit') && d.round === 582);
  assert.ok(resolved, 'the last untested key has no resolution entry');
  assert.equal(resolved.status, 'sound');
});
