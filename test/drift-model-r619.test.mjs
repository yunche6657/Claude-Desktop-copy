// R619: the drift model is refuted. Of 15 STATUS.md citations, 4 look broken and only ONE is drift — the other three were
// never line citations at all.
//
// THE HYPOTHESIS AND ITS TEST
//   R618 proposed that a running log accumulates stale coordinates, so older rounds should be likelier broken. STATUS.md's 15
//   references span rounds 426–617. Measured:
//
//       426  run-tests.cjs:31                 ok
//       470  main.cjs:355                     BROKEN — blank line, genuine drift
//       529  session-kernel.cjs:2474           ok
//       529  warm-idle-lifecycle.cjs:111       ok
//       550  session-kernel.cjs:2474           ok
//       551  runtime-tools.cjs:165             ok
//       551  tool-absence.cjs:49               ok
//       562  mcp-session-auth.cjs:9            ok
//       562  mcp-plugin-session-auth-r378:24   ok
//       564  contract-union.cjs:24             ok
//       577  keep-awake-activity.cjs:6         ok
//       598  preview-access.cjs:2491           "broken" — a CHARACTER OFFSET
//       598  mcp-stdio-relay.cjs:1194          "broken" — a CHARACTER OFFSET
//       601  bridge-services.cjs:3714          ok
//       617  desktop/foo.cjs:123               "broken" — an ILLUSTRATIVE PLACEHOLDER
//
//   The oldest citation (426) is fine; the newest real one (601) is fine. Breakage sits at 470 and 598 with no trend.
//
// WHY 4 IS REALLY 1
//   Two of the four are the offset-as-line error R598 made and R618 corrected in the evidence document — but not in STATUS.md,
//   because the log is append-only and earlier rounds are not edited.
//
//   One is `desktop/foo.cjs:123`, a placeholder R617 used in prose to mean "a citation looks like this". The regex cannot tell prose
//   from reference.
//
//   So genuine drift is ONE citation in 15 — a blank line in a 1350-line file edited many times. The model predicts a slope; the data
//   has a single point.
//
// WHAT IT MEANS FOR THE PRACTICE
//   Naming a function is not merely more robust than citing a position — it is the only form that survives here. Eleven of fifteen
//   are correct, two are a different error entirely, one is not a citation, one drifted. Citation is not the problem; a number that
//   was never a line was.
//
// WHAT IS NOT CLAIMED
//   Not that citing positions is safe: one in fifteen drifted in 259 rounds, and that citation's sentence still names the function,
//   so a reader is not stranded.
//   Not that STATUS.md should be edited to fix the two offsets: it is an append-only log, and rewriting history to match current line
//   numbers would make the log disagree with the rounds it records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROWS, MODEL } from '../desktop/drift-model.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'evidence', 'STATUS.md');
const REF = /((?:desktop|tools|test)\/[\w.-]+\.(?:cjs|mjs|js|json|md)):(\d+)/g;

test('the census accounts for every reference in STATUS.md', () => {
  const text = fs.readFileSync(STATUS, 'utf8');
  const found = [...text.matchAll(REF)].map((m) => `${m[1]}:${m[2]}`);
  // STATUS.md is append-only, so the population only grows; the record covers the 15 it measured.
  assert.ok(found.length >= ROWS.length, `STATUS.md SHRANK from ${ROWS.length} to ${found.length} references`);
  const actual = new Map();
  for (const f of found) actual.set(f, (actual.get(f) || 0) + 1);
  // Every recorded target must still appear at least as often as recorded. Rounds added later only append.
  const counted = new Map();
  for (const r of ROWS) counted.set(r.target, (counted.get(r.target) || 0) + 1);
  for (const [target, n] of counted) {
    assert.ok(actual.has(target), 'a recorded target vanished from STATUS.md: ' + target);
    assert.ok(actual.get(target) >= n, target + ' appears ' + actual.get(target) + 'x, recorded ' + n + 'x');
  }
});

test('exactly one citation is genuine drift', () => {
  const drift = ROWS.filter((r) => r.verdict === 'drift');
  assert.equal(drift.length, MODEL.genuineDrift);
  assert.equal(drift[0].target, 'desktop/main.cjs:355');
  // And that line really is blank now.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8').split('\n');
  assert.equal((src[354] || '').trim(), '', 'main.cjs:355 is no longer blank, so it is not drift');
});

test('the two offset cases point at the key definitions when read as offsets', () => {
  const offsets = ROWS.filter((r) => r.verdict === 'character-offset');
  assert.equal(offsets.length, MODEL.offsetErrors);
  for (const o of offsets) {
    const [file, lineStr] = o.target.split(':');
    const whole = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const off = Number(lineStr);
    assert.ok(off > whole.split('\n').length, `${o.target} is not past EOF, so it is not an offset`);
    // The recorded real line must hold the key definition.
    const src = whole.split('\n');
    assert.match((src[o.realLine - 1] || '').trim(), /const key\s*=/, `${o.target}: line ${o.realLine} is not the key`);
  }
});

test('the placeholder is a file that does not exist', () => {
  const ph = ROWS.filter((r) => r.verdict === 'illustrative-placeholder');
  assert.equal(ph.length, MODEL.placeholders);
  const [file] = ph[0].target.split(':');
  assert.equal(fs.existsSync(path.join(ROOT, file)), false, 'the placeholder file now exists');
});

test('the counts sum and the trend claim is refuted', () => {
  assert.equal(MODEL.correct + MODEL.genuineDrift + MODEL.offsetErrors + MODEL.placeholders, ROWS.length);
  assert.match(MODEL.verdict, /refuted/, 'the model is not marked refuted');
  // The oldest and newest real citations are both fine — that is what refutes an age trend.
  const sorted = [...ROWS].sort((a, b) => a.round - b.round);
  assert.equal(sorted[0].verdict, 'ok', 'the oldest citation is broken, which would support the model');
  const newest = sorted.filter((r) => r.verdict !== 'illustrative-placeholder').pop();
  assert.equal(newest.verdict, 'ok', 'the newest citation is broken');
});

test('the record explains why STATUS.md is not edited', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'drift-model.cjs'), 'utf8');
  assert.match(src, /append-only/, 'the append-only property is not stated');
  assert.match(src, /disagree with the rounds it records/, 'the consequence of editing is not stated');
});
