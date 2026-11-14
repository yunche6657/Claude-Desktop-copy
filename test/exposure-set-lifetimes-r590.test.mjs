// R590: three dedup sets declared three lines apart, and one of them is never cleared. The signature omits the account.
//
// THE CENSUS (counted by pattern over desktop/growthbook-provider.cjs)
//       set                        has  add  delete  clear
//       seenFeatureExposure         1    1     0       0      ← never reset
//       seenExperimentExposure      1    1     1       1      ← delete on rejection (:81), clear on switch (:260)
//       deferredExposure            —    1     —       2      ← clear after replay (:88), on switch (:261)
//
// THE SHAPE THAT MAKES IT CONCRETE
//       :69   const signature = `${key}:${item.on}:${item.source}`;
//
//   Two of the three components are properties of the FEATURE; none names the ACCOUNT. So the same flag, on, from the same
//   source, produces the same signature for a different account — and the second exposure is suppressed.
//
//   `seenExperimentExposure` is cleared on exactly that event. The asymmetry is two adjacent lines:
//
//       :260   if (lastAccount !== undefined && lastAccount !== context.accountKey) seenExperimentExposure.clear();
//       :261   lastAccount = context.accountKey; deferredExposure.clear();
//
//   One clears conditionally, the next clears unconditionally, and the third set is not mentioned here at all.
//
// WHAT THIS IS NOT
//   Not a live defect. R587 established no production caller supplies `onExposure`, so nothing is reported either way today.
//   The finding is about the mechanism's shape: when a reporter IS wired, an account switch suppresses the first feature
//   exposure per flag per account.
//   Not a claim that the suppression is unintended. It may be deliberate — a feature exposure is arguably about the flag
//   being served rather than about who received it. But if so, the neighbouring experiment set would not need a clear on the
//   same event, and the two would not be declared on one line.
//
// WHY THE THIRD SET IS A DIFFERENT FINDING FROM THE FIRST TWO
//   R587: `onExposure` is absent — nothing is called. R588: `deferredExposure` is reachable but rare. Both asked whether a
//   path is travelled. This asks whether two sets travel the SAME distance on the same event, which is visible only by
//   counting operations. Asking "does this code run" would have answered yes for all three and revealed nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, CONSEQUENCE } from '../desktop/exposure-set-lifetimes.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROV = path.join(ROOT, 'desktop', 'growthbook-provider.cjs');

/** Count operations on a set name, from the live source rather than from the record. */
function countOps(name) {
  const lines = fs.readFileSync(PROV, 'utf8').split('\n');
  const ops = { has: 0, add: 0, delete: 0, clear: 0 };
  for (const l of lines) {
    const re = new RegExp(`\\b${name}\\b`);
    if (!re.test(l)) continue;
    if (new RegExp(`\\b${name}\\.has\\(`).test(l)) ops.has += 1;
    if (new RegExp(`\\b${name}\\.add\\(`).test(l)) ops.add += 1;
    if (new RegExp(`\\b${name}\\.delete\\(`).test(l)) ops.delete += 1;
    if (new RegExp(`\\b${name}\\.clear\\(`).test(l)) ops.clear += 1;
  }
  return ops;
}

test('seenFeatureExposure is still never cleared', () => {
  const ops = countOps('seenFeatureExposure');
  assert.equal(ops.clear, 0, 'seenFeatureExposure now has a clear — the asymmetry is closed');
  assert.equal(ops.delete, 0, 'seenFeatureExposure now has a delete');
  assert.equal(ops.has, 1);
  assert.equal(ops.add, 1);
});

test('both sibling sets still have a reset path', () => {
  const exp = countOps('seenExperimentExposure');
  assert.equal(exp.clear, 1, 'the experiment set lost its clear');
  assert.equal(exp.delete, 1, 'the experiment set lost its retry delete');
  const def = countOps('deferredExposure');
  assert.ok(def.clear >= 2, `deferredExposure has ${def.clear} clears, fewer than the recorded 2`);
});

test('the recorded counts match the live source', () => {
  for (const s of SETS) {
    const live = countOps(s.name);
    assert.deepEqual(live, s.ops, `${s.name}: recorded ${JSON.stringify(s.ops)}, live ${JSON.stringify(live)}`);
  }
});

test('the signature still omits the account', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  const line = src.split('\n')[68];
  assert.match(line, /const signature = `\$\{key\}:\$\{item\.on\}:\$\{item\.source\}`/,
    'the signature changed, so the account-omission analysis may no longer apply');
  assert.ok(!/account/i.test(line), 'the signature now names the account, closing the asymmetry');
  assert.deepEqual(CONSEQUENCE.signatureParts, ['key', 'item.on', 'item.source']);
});

test('the account-switch clear is still adjacent to the unconditional one', () => {
  const lines = fs.readFileSync(PROV, 'utf8').split('\n');
  assert.match(lines[259], /seenExperimentExposure\.clear\(\)/, 'the conditional clear moved');
  assert.match(lines[260], /deferredExposure\.clear\(\)/, 'the unconditional clear moved');
  assert.ok(!/seenFeatureExposure/.test(lines[259] + lines[260]),
    'seenFeatureExposure is now cleared at the switch, so the finding is stale');
});

test('the record states the finding is not currently live', () => {
  assert.equal(CONSEQUENCE.live, false);
  assert.match(CONSEQUENCE.why, /onExposure/, 'the absent reporter is not named as the reason');
  assert.match(CONSEQUENCE.whenItWouldMatter, /wiring onExposure/, 'the trigger is not stated');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-set-lifetimes.cjs'), 'utf8');
  assert.ok(/Not a claim that exposures are being lost/.test(src), 'the not-live caveat is missing');
});

test('the record allows for the suppression being deliberate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-set-lifetimes.cjs'), 'utf8');
  assert.match(src, /may be deliberate/, 'the deliberate-possibility is not allowed for');
  assert.match(src, /declared on one line/, 'the counter-evidence is not stated');
});

test('the finding is distinguished from the two earlier rounds', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-set-lifetimes.cjs'), 'utf8');
  assert.ok(/path is travelled/.test(src), 'the contrast with R587/R588 is not stated');
  assert.ok(/DIFFERENT distances/.test(src), 'the distinguishing question is not named');
});
