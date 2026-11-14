// Extensions report disabled — and that is the CAPTURED upstream value, not a reconstruction bug.
//
// THE INVESTIGATION. The fallback log showed claude.settings.Extensions.isExtensionsEnabled called
// 18 times and always answering through the generic fallback. Live measurement confirmed:
//
//   Extensions namespace          27 methods registered
//   isExtensionsEnabled()         false
//   getInstalledExtensionsWithState()  []
//
// The shipped consumer (c51dd312d-DzbHW52m.js) is:
//
//   function m(){
//     if(!s) return { isExtensionsEnabled:true,  ... };            // namespace absent -> ALLOW
//     let e = c();                                                  // policy object
//     return typeof e?.extensionsEnabled==='boolean' && ...
//       ? { isExtensionsEnabled: e.extensionsEnabled, ... }         // configured -> USE IT
//       : { isExtensionsEnabled:false, policyLoaded:false };        // unknown -> DENY
//   }
//
// and c() ultimately reads desktopManagedConfig?.extensionsEnabled (shared-0-DDOOdL6P.js, OC).
//
// THE MISTAKE I ALMOST SHIPPED. I read 'false' as a defect caused by a missing field and added an
// override that forced extensionsEnabled/localExtensionInstallAllowed true. Then I checked the
// source of truth: bridge-map.json's __desktopManagedConfig ALREADY contains all three fields,
// and all three are FALSE in the captured payload. That payload is observed data from a real
// instance, so false is the faithful value — my 'fix' would have diverged from the original.
// Reverted, and this file records the real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const MAP = JSON.parse(read('desktop/shim/bridge-map.json'));
const MANAGED = MAP.__desktopManagedConfig || {};

test('the captured managed config carries the three extension policy fields', () => {
  // These are observed values, not defaults this project invented.
  for (const key of ['extensionsEnabled', 'localExtensionInstallAllowed', 'unpackedExtensionInstallAllowed']) {
    assert.equal(typeof MANAGED[key], 'boolean', key + ' is missing from the captured payload');
  }
});

test('the captured policy disables extensions, and the reconstruction preserves that', () => {
  // Faithfulness over convenience: the original instance reported false.
  assert.equal(MANAGED.extensionsEnabled, false, 'the captured extensionsEnabled changed');
  assert.equal(MANAGED.localExtensionInstallAllowed, false, 'the captured install policy changed');
});

test('the preload does not override the captured extension policy', () => {
  // The override I briefly added forced these true; reverted because the payload is authoritative.
  const preload = read('desktop/preload-frontend.cjs');
  assert.doesNotMatch(preload, /out\.extensionsEnabled\s*=/, 'an extension policy override came back');
  assert.doesNotMatch(preload, /out\.localExtensionInstallAllowed\s*=/, 'an install-policy override came back');
});

test('the Extensions namespace is still registered in full', () => {
  // 28 methods: the FEATURE surface is present even though policy reports it disabled.
  const settings = MAP['claude.settings'] || {};
  const ext = settings.Extensions;
  assert.ok(Array.isArray(ext), 'Extensions is no longer an array of method names');
  assert.equal(ext.length, 28, 'the Extensions surface changed size: ' + ext.length);
  assert.ok(ext.includes('isExtensionsEnabled'), 'isExtensionsEnabled disappeared');
  assert.ok(ext.includes('getInstalledExtensionsWithState'), 'the list call disappeared');
});

test('extension policy and plugin policy are independent dimensions', () => {
  // The captured config looks self-contradictory: extensionsEnabled false while
  // userPluginUploadsEnabled / userPluginMarketplacesEnabled are true. It is not a contradiction —
  // the shipped policy schema documents them as separate controls.
  //
  // MEASURED, from the policy description in c6f6cf4c2-DnfurqXo.js:
  //   'plugins users uploaded are governed by `userPluginUploadsEnabled`, not this key'
  //
  // So extensionsEnabled gates DXT extensions, and the two plugin keys gate marketplace/upload.
  // Disabling one does not imply the other.
  assert.equal(MANAGED.extensionsEnabled, false, 'extension policy changed');
  assert.equal(MANAGED.userPluginUploadsEnabled, true, 'plugin upload policy changed');
  assert.equal(MANAGED.userPluginMarketplacesEnabled, true, 'plugin marketplace policy changed');
});

test('the captured policy blocks nothing that the schema calls a data boundary', () => {
  // disableEssentialTelemetry / disableNonessentialTelemetry are data-boundary switches and both
  // are false, i.e. telemetry is NOT suppressed by policy. Worth pinning: a reconstruction that
  // silently turned these true would look privacy-friendly while diverging from the original.
  assert.equal(MANAGED.disableEssentialTelemetry, false);
  assert.equal(MANAGED.disableNonessentialTelemetry, false);
});

test('the three managed-config blocks agree with each other', () => {
  // __desktopManagedConfig, __desktopEnterpriseConfig and __desktopTelemetryConfig are separate
  // captured payloads that happen to carry the same policy shape. If one drifts, the frontend's
  // 'which block wins' logic changes behaviour, so the equality is the invariant.
  const managed = MAP.__desktopManagedConfig || {};
  const enterprise = MAP.__desktopEnterpriseConfig || {};
  const telemetry = MAP.__desktopTelemetryConfig || {};
  for (const key of ['extensionsEnabled', 'localExtensionInstallAllowed', 'userPluginUploadsEnabled']) {
    assert.equal(managed[key], enterprise[key], key + ' differs between managed and enterprise');
    assert.equal(managed[key], telemetry[key], key + ' differs between managed and telemetry');
  }
});
