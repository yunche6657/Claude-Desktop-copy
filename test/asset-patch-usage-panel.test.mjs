// The usage panel is gated by a build-time constant in the shipped frontend.
//
//   var <gate>=!1,<keys>=["epitaxy","period-usage"];
//   useQuery({ queryKey: <keys>, queryFn: <fn>, enabled: <gate>, ... })
//
// With enabled:false the queryFn never runs, so ClaudeCode.getPeriodUsage is never called
// and the quota panel can never render.
//
// Two lessons are baked into these tests:
//   1. Match STRUCTURE, not the minifier's variable names. The patch once hard-coded one name
//      and went silently inert when an upgrade renamed it.
//   2. A patch that matches the chunk but not the code inside it is a MISS, and a miss must
//      be reported. Returning null quietly meant the app still booted and the feature just
//      stopped working with no trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchUsagePanelGate, applyAssetPatches, ASSET_PATCHES } = require('../desktop/app-protocol.cjs');

// The form the current shipped chunk actually uses (variables renamed by the minifier).
const SAMPLE = 'var MVe=!1,NVe=["epitaxy","period-usage"];function x(){}';
// The older form the patch was originally written against.
const LEGACY = 'var vRe=!1,yRe=["epitaxy","period-usage"];function x(){}';

test('the gate constant is flipped to true', () => {
  const result = patchUsagePanelGate(SAMPLE);
  assert.ok(result, 'the shipped pattern must be recognised');
  assert.equal(result.changed, true);
  assert.equal(result.text.includes('MVe=!1'), false, 'the false form must be gone');
  assert.equal(result.text.includes('MVe=!0'), true, 'the true form must be present');
});

test('the patch survives a minifier rename', () => {
  // This is the regression: a hard-coded name made the patch silently inert after an upgrade.
  const legacy = patchUsagePanelGate(LEGACY);
  assert.ok(legacy, 'the older name form must still match');
  assert.equal(legacy.text.includes('vRe=!0'), true);
  const renamed = patchUsagePanelGate('var aaa=!1,bbb=["epitaxy","period-usage"];');
  assert.ok(renamed, 'any variable names must match');
  assert.equal(renamed.text.includes('aaa=!0'), true);
});

test('unrelated code is left alone', () => {
  assert.equal(patchUsagePanelGate('var other=1;'), null);
  // The query key is the anchor; without it this is not the usage gate.
  assert.equal(patchUsagePanelGate('var vRe=!1;'), null);
  // Already true: nothing to flip.
  assert.equal(patchUsagePanelGate('var MVe=!0,NVe=["epitaxy","period-usage"];'), null);
});

test('the patch only applies to the chunk that owns the query', () => {
  const buf = Buffer.from(SAMPLE, 'utf8');
  const onTarget = applyAssetPatches(buf, '/assets/v1/c96d752d0-CWv_7-n9.js');
  assert.ok(onTarget);
  assert.deepEqual(onTarget.applied, ['usage-panel-gate']);
  assert.deepEqual(onTarget.missed, []);
  const offTarget = applyAssetPatches(buf, '/assets/v1/c71860c77-BGYi2kLk.js');
  assert.equal(offTarget, null, 'other chunks must be untouched');
});

test('a miss on the target chunk is REPORTED, not swallowed', () => {
  // The chunk name matches, the code inside does not: exactly what a package upgrade
  // produces. This used to return null and nothing else.
  const buf = Buffer.from('function unrelated(){}', 'utf8');
  const result = applyAssetPatches(buf, '/assets/v1/c96d752d0-CWv_7-n9.js');
  assert.ok(result, 'a matched-but-unapplied patch must not look like an unrelated asset');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.missed, ['usage-panel-gate']);
});

test('a miss leaves the body untouched', () => {
  const original = 'function unrelated(){}';
  const result = applyAssetPatches(Buffer.from(original, 'utf8'), '/assets/v1/c96d752d0-CWv_7-n9.js');
  assert.equal(result.body.toString('utf8'), original, 'a miss must not rewrite anything');
});

test('the patch table names its target explicitly', () => {
  const usage = ASSET_PATCHES.find((p) => p.name === 'usage-panel-gate');
  assert.ok(usage, 'the usage gate patch must be registered');
  assert.match('c96d752d0-CWv_7-n9.js', usage.pathMatch);
  assert.doesNotMatch('c71860c77-BGYi2kLk.js', usage.pathMatch);
});

test('the returned body actually differs from the input', () => {
  const buf = Buffer.from(SAMPLE, 'utf8');
  const result = applyAssetPatches(buf, '/assets/v1/c96d752d0-CWv_7-n9.js');
  assert.notEqual(result.body.toString('utf8'), SAMPLE);
  assert.equal(result.body.toString('utf8').includes('MVe=!0'), true);
});
