// R589: in the stale window, `state()` DEFERS an exposure and then answers "incomplete". Both, and that is the design.
//
// THE QUESTION
//   `state()` (cli-mcp-host-sources.cjs:55-63):
//
//       :60   runtime.getFeatureValue('513873720', undefined);      ← records exposure
//       :61   if (… || !runtime.isSecurityFreshForCurrentSource()) return { complete: false };
//
//   R588 asked which runs first and whether the exposure is real. The ordering plus what `synchronize()` does on the SECOND
//   call settles it.
//
// THE SEQUENCE
//       :60   getFeatureValue → synchronize()
//                 identity !== key → change branch: staleAccount = true, securityIdentity = undefined, identity = key
//                 then exposure()
//                     fresh() is false (staleAccount just set) → deferredExposure.add(key), return
//                     THE EXPOSURE IS DEFERRED, NOT DROPPED
//
//       :61   isSecurityFreshForCurrentSource() → synchronize() again
//                 identity === key now → branch does not run, nothing reset, staleAccount STAYS true
//                 securityFresh() false (securityIdentity is undefined) → return { complete: false }
//
//   Two facts hold at once: the exposure is queued for replay, and the gate answers "incomplete". `freshTransition` replays
//   every deferred key when the account becomes fresh again — the exact window this path exists for.
//
// WHAT R588 GOT HALF WRONG
//   It framed the choice as "a real exposure OR one for an answer that will be discarded". Those are not alternatives. The
//   answer IS discarded — `complete: false` makes the consumer ignore `featureEnabled` — and the exposure is still real,
//   because DEFERRAL DECOUPLES IT from that answer. The mechanism is built for this asymmetry.
//
// AND R587'S FACT STILL STANDS
//   No production caller supplies `onExposure`, so the replay feeds a set nothing reads. That is not a contradiction: the
//   path is live and its output currently goes nowhere. Both are true, and the second is the reason a mistyped id at :60 is
//   inert today (R587) even though the path is reachable (R588).
//
// WHAT IS NOT CLAIMED
//   Not that answering "incomplete" during a switch is the right policy — R586 covered what the gate reports, not whether
//   reporting that is correct.
//   Not that the deferred path is exercised often: R588 recorded the frequency as unmeasured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEQUENCE, CORRECTION } from '../desktop/stale-window-ordering.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'desktop', 'cli-mcp-host-sources.cjs');
const PROV = path.join(ROOT, 'desktop', 'growthbook-provider.cjs');

test('getFeatureValue still runs before the freshness check', () => {
  const lines = fs.readFileSync(CLI, 'utf8').split('\n');
  const call = lines.findIndex((l) => l.includes("runtime.getFeatureValue('513873720'"));
  const guard = lines.findIndex((l) => l.includes('isSecurityFreshForCurrentSource()'));
  assert.ok(call > 0 && guard > 0, 'one of the two lines is gone');
  assert.ok(call < guard, 'the freshness check now runs before the exposure call, reversing the sequence');
});

test('the change branch sets staleAccount and clears securityIdentity before exposure runs', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  const sync = src.slice(src.indexOf('function synchronize'), src.indexOf('const current = token'));
  assert.match(sync, /staleAccount = true/, 'the change branch no longer sets staleAccount');
  assert.match(sync, /securityIdentity = undefined/, 'the change branch no longer clears securityIdentity');
  // And the guard that makes it remote-only.
  assert.match(sync, /markStale && identity !== undefined && c\.source\.kind === 'remote'/);
});

test('the second synchronize call does nothing, because identity now equals key', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  const sync = src.slice(src.indexOf('function synchronize'), src.indexOf('const current = token'));
  assert.match(sync, /if \(identity !== key\) \{/, 'the change branch is no longer conditional on identity !== key');
  // The accessor calls synchronize and then reads securityFresh — so the second call cannot undo the first.
  const accessor = src.slice(src.indexOf('isSecurityFreshForCurrentSource'));
  assert.match(accessor.slice(0, 160), /synchronize\(\); return securityFresh\(\)/,
    'the accessor no longer synchronises before reading');
});

test('fresh() consults staleAccount, which is what makes the exposure defer', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  assert.match(src, /const fresh = \(\) => \(state === 'network' \|\| state === 'map-final'\) && !staleAccount;/);
  assert.match(src, /if \(!fresh\(\)\) \{ if \(item !== undefined && state !== 'map-fallback'\) deferredExposure\.add\(key\); return; \}/,
    'exposure no longer defers when not fresh');
});

test('the four steps are recorded in order, each with a site and an effect', () => {
  assert.equal(SEQUENCE.length, 4);
  assert.deepEqual(SEQUENCE.map((s) => s.step), [1, 2, 3, 4]);
  for (const s of SEQUENCE) {
    assert.ok(s.site.includes(':'), `step ${s.step} has no line reference`);
    assert.ok(s.effect.length > 40, `step ${s.step} has no substantive effect`);
  }
  assert.match(SEQUENCE[1].effect, /DEFERRED, not dropped/, 'the deferral is not distinguished from a drop');
  assert.match(SEQUENCE[3].effect, /queued for replay/, 'the surviving exposure is not stated');
});

test('the half-correction to R588 is recorded as a correction', () => {
  assert.match(CORRECTION.r588Said, /discarded/, 'the original framing is not quoted');
  assert.match(CORRECTION.actual, /both happen/, 'the correction is not stated as a conjunction');
  assert.match(CORRECTION.why, /asymmetry|record while stale/, 'the design reason is missing');
});

test('R587\'s fact is carried forward rather than contradicted', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'stale-window-ordering.cjs'), 'utf8');
  assert.match(src, /onExposure/, 'the absent callback is not mentioned');
  assert.match(src, /Both are true|goes nowhere yet/, 'the coexistence of "live path" and "unused output" is not stated');
});
