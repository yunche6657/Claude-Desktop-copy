// R587: `exposure()` assembles state with care and reports to nobody — the callbacks are optional and never supplied.
//
// THE QUESTION R586 LEFT
//   R586 said a typo at `cli-mcp-host-sources.cjs:60` would have "no behavioural difference" while corrupting exposure
//   attribution. Checking whether `exposure` has a consumer decides how much that matters.
//
// WHAT IS ACTUALLY WIRED (growthbook-provider.cjs)
//       :66   exposure(key, item)
//       :67     if (!fresh()) → deferredExposure.add(key) and return
//       :72     onExposure?.({ feature_hash:key, on, feature_source, in_experiment, … })       ← OPTIONAL
//       :80     queueExperimentExposure?.({ experiment_id, variation_id, … })                  ← OPTIONAL
//       :89   freshTransition replays every deferred key through exposure()
//
//   Three live mechanisms — freshness deferral, per-signature dedup, deferred replay — whose last step on each path is an
//   OPTIONAL CALL. Measured:
//
//       production callers of createGrowthBookProvider     1   (main.cjs:1039 → main-growthbook-runtime.cjs:10)
//       providerOptions passed at that call site            none — only getContext and userData are named
//       consumers of onExposure / queueExperimentExposure   none anywhere in this repository
//
// SO THE TYPO AT :60 IS INERT, NOT MERELY SILENT
//   R586's direction was right and its reason was wrong. Nothing reads the attribution, so nothing is corrupted: the dedup
//   sets are populated for the real id by :50/:51, and the typo adds one signature for a key no report will mention.
//   `synchronize()` runs regardless because it takes no key.
//
// WHY THIS IS WORTH A ROUND
//   Reading the machinery suggests reporting happens. It does not. That is the same shape as `recordingListeners` in an
//   earlier round — state assembled with care, consumed by nobody — and it has a consequence: if a future caller DOES pass
//   `onExposure`, the typo stops being inert, and no test would notice, because the tests that build the provider pass no
//   callback and therefore assert nothing about reporting.
//
// WHAT IS NOT CLAIMED
//   Not that the machinery is dead code: `queueExperimentExposure` is the SDK's documented path and a caller outside this
//   repository could supply it. The claim is about this repository's production wiring.
//   Not that R586 was wrong: it said "no behavioural difference", which holds. Its stated REASON — corrupted attribution —
//   describes a corruption that goes nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPOSURE_STATE, LATENT } from '../desktop/exposure-consumers.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROV = path.join(ROOT, 'desktop', 'growthbook-provider.cjs');
const MAIN = path.join(ROOT, 'desktop', 'main.cjs');
const RUNTIME = path.join(ROOT, 'desktop', 'main-growthbook-runtime.cjs');

test('both report paths are optional calls', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  assert.match(src, /onExposure\?\.\(/, 'onExposure is no longer an optional call');
  assert.match(src, /queueExperimentExposure\?\.\(|typeof queueExperimentExposure === 'function'/,
    'the experiment queue is no longer guarded');
});

test('the production call site supplies no exposure callback', () => {
  const main = fs.readFileSync(MAIN, 'utf8');
  const lines = main.split('\n');
  const at = lines.findIndex((l) => l.includes('createMainGrowthBookRuntime'));
  assert.ok(at > 0, 'the production call site is gone');
  const block = lines.slice(at, at + 4).join(' ');
  assert.ok(!/providerOptions/.test(block), 'providerOptions is now passed, so a callback could be too');
  assert.ok(!/onExposure/.test(block), 'onExposure is now supplied');
  // And the runtime forwards only what it is given.
  const rt = fs.readFileSync(RUNTIME, 'utf8');
  assert.match(rt, /\.\.\.providerOptions/, 'the runtime no longer forwards providerOptions');
});

test('the reporting path is COVERED by one test, which is why the absence is about production only', () => {
  // This assertion replaced an over-wide one: the first version claimed nothing in the repository injects a callback and
  // failed on `growthbook-freshness-r374.test.mjs`, which does — and asserts dedup and retry. The machinery is live and
  // verified; what is absent is a PRODUCTION caller, which is a different and narrower fact.
  const t = fs.readFileSync(path.join(ROOT, 'test', 'growthbook-freshness-r374.test.mjs'), 'utf8');
  assert.match(t, /function setup\(context,extra=\{\}\)/, 'the injectable setup is gone');
  assert.match(t, /experiment exposure deduplicates and retries rejected queue/,
    'the test that covers reporting is gone');
  assert.match(EXPOSURE_STATE.testedBy, /growthbook-freshness-r374/, 'the covering test is not recorded');

  // And the narrow claim: the production call site supplies nothing.
  const main = fs.readFileSync(MAIN, 'utf8');
  assert.ok(!/onExposure\s*:/.test(main), 'production now supplies a callback');
  assert.equal(EXPOSURE_STATE.callbackSuppliedInProduction, false);
});

test('no PRODUCTION module supplies an exposure callback', () => {
  for (const name of fs.readdirSync(path.join(ROOT, 'desktop'))) {
    if (!name.endsWith('.cjs')) continue;
    const rel = `desktop/${name}`;
    if (rel === 'desktop/growthbook-provider.cjs' || rel === 'desktop/exposure-consumers.cjs') continue;
    const text = fs.readFileSync(path.join(ROOT, 'desktop', name), 'utf8');
    assert.ok(!/onExposure\s*:/.test(text), `${rel} now supplies onExposure`);
    assert.ok(!/queueExperimentExposure\s*:/.test(text), `${rel} now supplies queueExperimentExposure`);
  }
});

test('the deferred replay still routes through exposure', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  assert.match(src, /for \(const key of keys\) exposure\(key, features\[key\]\)/,
    'freshTransition no longer replays deferred exposures');
  assert.match(src, /deferredExposure\.add\(key\)/, 'the deferral no longer records the key');
  assert.match(EXPOSURE_STATE.deferredSet, /deferredExposure/);
});

test('the record states the inert conclusion rather than "corrupted"', () => {
  assert.match(EXPOSURE_STATE.consequence, /never read out|unused signature/,
    'the consequence is not stated as inert');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-consumers.cjs'), 'utf8');
  assert.match(src, /INERT, NOT MERELY SILENT|inert, not merely silent/i, 'the distinction is not named');
  assert.match(src, /goes nowhere/, 'the correction of R586\'s reason is missing');
});

test('the latent consequence of a future PRODUCTION callback is recorded', () => {
  assert.match(LATENT.trigger, /passes onExposure/);
  assert.match(LATENT.then, /stops being inert/);
  assert.match(LATENT.detection, /none/, 'the lack of detection is not stated');
});

test('the round does not claim the machinery is dead code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-consumers.cjs'), 'utf8');
  assert.match(src, /Not that the exposure machinery is dead code/, 'the scope limit is missing');
  assert.match(src, /SDK's documented path|caller outside this repository/, 'the external-caller case is not allowed for');
});
