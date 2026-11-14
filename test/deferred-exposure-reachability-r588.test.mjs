// R588: is `deferredExposure` reachable in production? Traced through ORDERING, not function names — and yes, by one route.
//
// THE HYPOTHESIS
//   R587 closed by asking whether production ever fills `deferredExposure`. The gate's listeners fire on feature CHANGE, a
//   moment when features are by construction already fresh — so the deferral looked unreachable. Reading `apply`:
//
//       :98    state = kind;              ← state updated FIRST
//       :101   exposure(key, value)       ← then listeners notified
//
//   confirms it: the notify-time `exposure` runs with `state` already network/map-final. And `onFeatureChange`'s immediate
//   call (:301) is gated on `state !== 'none'`. Neither defers.
//
// THE ONE LIVE ROUTE
//       :49   const fresh = () => (state === 'network' || state === 'map-final') && !staleAccount;
//
//   `staleAccount` is set at :121, only when the identity key changes on a REMOTE source. That is the sole condition that
//   makes `fresh()` false while `state` is already settled — and it is reachable from :285/:289 (`getFeatureValue`,
//   `getFeatureOn`), which arbitrary code calls at arbitrary times.
//
//   The gate's own `cli-mcp-host-sources.cjs:60` is exactly such a caller: it runs `getFeatureValue` inside `state()`, which
//   is what decides whether the gate reports complete. So the deferral is not ornament — it is on the path that decides
//   whether the MCP gate answers at all during an account switch.
//
// IS THE TRIGGER LIVE IN THIS APP?
//   Yes: `growthbook-mode-backend.cjs:34` and `:42` build remote sources, and `growthbook-source.cjs:40` uses
//   `identity ?? origin`. The counterfactual was verified — a STATIC-only provider run through init, read and sourceChanged
//   never defers, because a static source never changes identity. Production is not static-only.
//
// WHAT IS NOT SETTLED: FREQUENCY
//   An account switch is rare, so the route is rarely taken. The repository covers it deterministically
//   (`growthbook-freshness-r374.test.mjs`, "fresh transition reports deferred exposure once"), which is the right way to cover
//   a rare branch — but production frequency is unknown here and this round does not estimate it.
//
// WHY THE HYPOTHESIS WAS WORTH TESTING
//   "Unreachable machinery" and "rarely-reached machinery" look identical in the source and have opposite consequences: the
//   first is dead weight, the second is a path that fails only in the situation nobody tests by hand. Telling them apart
//   needed the ordering at :98/:101, not the function names — which is the same lesson as R586's three sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, TRIGGER } from '../desktop/deferred-exposure-reachability.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROV = path.join(ROOT, 'desktop', 'growthbook-provider.cjs');

test('state is set before the change listeners are notified', () => {
  const lines = fs.readFileSync(PROV, 'utf8').split('\n');
  const stateLine = lines.findIndex((l) => /^\s*const old = features; features = project\(map, source\); state = kind;/.test(l));
  assert.ok(stateLine > 0, 'the state assignment moved or changed shape');
  const notifyLine = lines.findIndex((l, i) => i > stateLine && l.includes('exposure(key, value);'));
  assert.ok(notifyLine > stateLine,
    'the change-listener exposure now runs BEFORE state is set, which would make the deferral reachable from there');
});

test('onFeatureChange guards on state, so it cannot defer either', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  assert.match(src, /if \(!disposed && state !== 'none'\) \{ exposure\(key,features\[key\]\); fn\(features\[key\]\); \}/,
    'the onFeatureChange guard changed, so its exposure may now run while state is none');
});

test('staleAccount is set only on a remote identity change', () => {
  const src = fs.readFileSync(PROV, 'utf8');
  assert.match(src, /if \(markStale && identity !== undefined && c\.source\.kind === 'remote'\)/,
    'the staleAccount condition changed');
  assert.match(src, /const fresh = \(\) => \(state === 'network' \|\| state === 'map-final'\) && !staleAccount;/,
    'the fresh() predicate changed, so the reachability analysis no longer applies');
});

test('the record marks exactly one route reachable', () => {
  assert.equal(ROUTES.length, 3);
  const reachable = ROUTES.filter((r) => r.reachable);
  assert.equal(reachable.length, 1, `${reachable.length} routes are reachable, not the one recorded`);
  assert.match(reachable[0].site, /getFeatureValue|getFeatureOn/);
  // And the unreachable ones must each say WHY, not merely that they are.
  for (const r of ROUTES.filter((x) => !x.reachable)) {
    assert.ok(r.why.length > 40, `${r.site} is marked unreachable without a reason`);
  }
});

test('production really does use a remote source', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-mode-backend.cjs'), 'utf8');
  assert.match(backend, /kind:\s*'remote'/, 'the production backend no longer builds a remote source');
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-source.cjs'), 'utf8');
  assert.match(source, /identity\s*\?\?/, 'the source no longer derives an identity that can change');
  assert.equal(TRIGGER.liveInThisApp, true);
});

test('the static counterfactual is recorded as verified, not assumed', () => {
  assert.match(TRIGGER.staticCounterfactual, /verified by running/,
    'the counterfactual is asserted rather than measured');
  assert.match(TRIGGER.staticCounterfactual, /unreachable/, 'the counterfactual conclusion is missing');
});

test('frequency is left unmeasured rather than guessed', () => {
  assert.match(TRIGGER.frequency, /unknown and unmeasured/, 'a frequency is claimed without measurement');
  assert.match(TRIGGER.frequency, /deterministic/, 'the test-coverage substitute is not named');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'deferred-exposure-reachability.cjs'), 'utf8');
  assert.match(src, /rarely-reached machinery|rarely taken/, 'the rarity is not stated');
});
