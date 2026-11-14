// R653: the user kept seeing "Cowork 需要较新的安装版本" after R652 implemented all 55 handlers.
//
// THE GATE, MEASURED
//   The toast comes from shared-5's switch, case "msix_required" (message id ewJxSqukl5). Something in the feature
//   map was reporting that status. The live run showed the SAME feature answered differently on two paths:
//       preload expose('desktopBootFeatures')  -> selfHostedCowork: available/supported
//       bridgeAppFeatures.getSupportedFeatures -> selfHostedCowork: unavailable
//   and the renderer's Cowork gate reads the bridge one, so fixing only the preload changed nothing.
//
// TWO CAUSES, BOTH NEEDED
//   1. packaging-signals.packagingState() answered isMsix:false, because a reconstruction is never run from a
//      WindowsApps directory. preload-frontend's withPackaging() returns the captured map unchanged in that case,
//      so the captured statuses (yukonSilver: msix_required) went straight through.
//   2. packaging-features.applyPackagingState() rewrote only four keys, and `coworkBrowser` was the only cowork
//      entry among them. Every other cowork row kept its captured `unavailable`.
//
// MEASURED AFTER
//   desktopBootFeatures: all 19 cowork/selfHosted/yukon rows = supported
//   getSupportedFeatures: all of them = supported, selfHostedSessions still unavailable (a different surface)
//   nag text in the DOM: false
//
// WHAT IS NOT CLAIMED
//   Not that Cowork can dispatch work: that needs the CCB backend process, which does not start here (R640 EPERM).
//   Not that selfHostedSessions should be supported: it is a separate remote-session surface and was left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const features = require(path.join(ROOT, 'desktop', 'packaging-features.cjs'));
const signals = require(path.join(ROOT, 'desktop', 'packaging-signals.cjs'));

test('a declared desktop build reports the Cowork family as supported', () => {
  const captured = {
    yukonSilver: { status: 'msix_required', unsupportedCode: 'msix_required' },
    coworkBrowser: { status: 'unsupported', unsupportedCode: 'unknown' },
    coworkWatchers: { status: 'unavailable' },
    coworkArtifacts: { status: 'unavailable' },
    selfHostedCowork: { status: 'unavailable' },
  };
  const out = features.applyPackagingState(captured, { isMsix: true });
  for (const key of Object.keys(captured)) {
    assert.equal(out[key].status, 'supported', `${key} still reports ${out[key].status}`);
  }
});

test('features outside the Cowork family are not granted', () => {
  // The policy is negation-guarded: this function must never invent a capability the map did not offer.
  const out = features.applyPackagingState(
    { unrelated: { status: 'unavailable' }, selfHostedSessions: { status: 'unavailable' } },
    { isMsix: true },
  );
  assert.equal(out.unrelated.status, 'unavailable');
  assert.equal(out.selfHostedSessions.status, 'unavailable', 'selfHostedSessions is a different surface');
});

test('the prefix rule covers rows the capture adds later', () => {
  assert.equal(features.isCoworkFeature('coworkSomeFutureRow'), true);
  assert.equal(features.isCoworkFeature('selfHostedCowork'), true);
  assert.equal(features.isCoworkFeature('coworkBrowser'), true);
  assert.equal(features.isCoworkFeature('chromeExtensionInstall'), false);
  assert.equal(features.isCoworkFeature('yukonSilver'), false, 'yukonSilver is handled by PACKAGED_FEATURES');
});

test('an absent feature stays absent rather than being invented', () => {
  const out = features.applyPackagingState({}, { isMsix: true });
  assert.deepEqual(out, {}, 'a build that declared nothing must not gain capabilities');
});

test('a reconstruction declares the packaging state, and can opt out', () => {
  const saved = process.env.CLAUDE_DENY_MSIX;
  try {
    delete process.env.CLAUDE_DENY_MSIX;
    const declared = signals.packagingState({ execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\app.exe', windowsStore: false });
    assert.equal(declared.isMsix, true,
      'an unpacked reconstruction must still declare the desktop state, or the captured msix_required statuses return');
    assert.equal(declared.detectionSource, 'reconstruction');

    process.env.CLAUDE_DENY_MSIX = '1';
    const denied = signals.packagingState({ execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\app.exe', windowsStore: false });
    assert.equal(denied.isMsix, false, 'CLAUDE_DENY_MSIX must still be able to reproduce the gated behaviour');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_DENY_MSIX;
    else process.env.CLAUDE_DENY_MSIX = saved;
  }
});

test('an explicit CLAUDE_FORCE_MSIX still wins over the declaration', () => {
  const saved = { F: process.env.CLAUDE_FORCE_MSIX, D: process.env.CLAUDE_DENY_MSIX };
  try {
    process.env.CLAUDE_FORCE_MSIX = '1';
    delete process.env.CLAUDE_DENY_MSIX;
    const state = signals.packagingState({ execPath: 'app.exe', windowsStore: false });
    assert.equal(state.detectionSource, 'forced', 'the explicit override was overridden by the declaration');
  } finally {
    if (saved.F === undefined) delete process.env.CLAUDE_FORCE_MSIX; else process.env.CLAUDE_FORCE_MSIX = saved.F;
    if (saved.D === undefined) delete process.env.CLAUDE_DENY_MSIX; else process.env.CLAUDE_DENY_MSIX = saved.D;
  }
});

test('the preload rewrites the Cowork family too, not just coworkBrowser', () => {
  // Both paths must agree; a disagreement is exactly what made R652 look finished while the toast stayed.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'preload-frontend.cjs'), 'utf8');
  assert.match(src, /\^cowork\|\^selfHostedCowork/, 'the preload no longer rewrites the cowork family');
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'packaging-features.cjs'), 'utf8');
  assert.match(main, /COWORK_FEATURE_PREFIXES/, 'the bridge-side policy lost its prefix rule');
});
