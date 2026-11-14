// R569: `chooseKernel` turned out NOT to need a test, and the fallback next to it did.
//
// THE CHECK R568 LEFT OPEN
//   R568 extracted `withPackagingState` because no test named it, and closed by asking whether `chooseKernel` — the other
//   unnamed function — was a real gap. The answer is NO, and it was settled by reading rather than counting:
//
//       kernel-select.cjs exports KERNEL_IDS, selectKernel, probeCcb, probeLocal, normaliseProbe
//       test/kernel-select.test.mjs            13 tests, 38 assertions, including
//           "probeCcb reports the exact missing file rather than a generic failure"
//           "an explicit CCB_DISABLE switch is honoured even when the files are there"
//           "requesting an unavailable kernel substitutes, and says so"
//
//   `chooseKernel` only assembles `process.env` and two probe calls around a function that IS tested. Having no test of its
//   own is proportionate.
//
// THE GAP THAT WAS THERE INSTEAD
//   Six lines below it, inside `kernelFactory`, a thrown CCB construction decides whether to propagate or fall back:
//
//       const unavailable = probeCcb({ env, root });
//       if (unavailable.available) throw error;   // runtime present: a REAL failure
//       kernelSelection = selectKernel({ … });    // runtime absent: re-decide and say so
//       backend = null;
//
//   `test/kernel-wiring.test.mjs:35` covered it with four regular expressions matched against main.cjs's TEXT. That proves
//   the lines exist and nothing about what they decide — and it broke the instant the logic moved, which is exactly what a
//   text assertion does when it is not describing behaviour.
//
//   So the decision is now `desktop/kernel-fallback.cjs:fallbackDecision(reprobe)`, and the wiring test asserts the three
//   inputs as values plus the fact that main.cjs acts on the result.
//
// WHY "PROPAGATE WHEN AVAILABLE" IS THE RIGHT RULE
//   A missing runtime is expected on a machine without the bundle: falling back gives a slower turn with a stated reason.
//   A throw WITH the runtime present means something is broken, and papering over it converts a loud failure into a quiet
//   one. The cost asymmetry decides the malformed-input case too: a bad probe result falls back, because a slow turn beats
//   a failed boot.
//
// WHAT IS NOT CLAIMED
//   Not that the fallback path is now end-to-end tested: nothing here constructs a real CCB backend and watches it throw.
//   What is pinned is the decision the caller makes with the probe result, which was previously pinned by nothing.
//   Not that text assertions are wrong in general — the ones remaining in kernel-wiring check WIRING (is the approval hook
//   passed), where the presence of a call is the fact under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackDecision, FALLBACK_LOG } from '../desktop/kernel-fallback.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a throw with the runtime present propagates', () => {
  assert.equal(fallbackDecision({ available: true }), 'propagate');
});

test('a throw with the runtime absent falls back', () => {
  assert.equal(fallbackDecision({ available: false }), 'fallback');
});

test('a missing or malformed probe result falls back, because the costs are not symmetric', () => {
  for (const bad of [undefined, null, {}, { available: 'yes' }, 0, 'x']) {
    assert.equal(fallbackDecision(bad), 'fallback',
      `${JSON.stringify(bad)} did not fall back: a failed boot is worse than a slow turn`);
  }
});

test('chooseKernel is assembly over a tested function, so its having no test is proportionate', () => {
  // The evidence for R568's open question, asserted so a future round does not re-ask it.
  const sel = fs.readFileSync(path.join(ROOT, 'desktop', 'kernel-select.cjs'), 'utf8');
  for (const name of ['selectKernel', 'probeCcb', 'probeLocal']) {
    assert.match(sel, new RegExp(`\\b${name}\\b`), `${name} is no longer in kernel-select.cjs`);
  }
  const testFile = fs.readFileSync(path.join(ROOT, 'test', 'kernel-select.test.mjs'), 'utf8');
  const cases = (testFile.match(/^test\(/gm) || []).length;
  assert.ok(cases >= 13, `kernel-select.test.mjs has ${cases} tests, fewer than the 13 recorded`);
  assert.match(testFile, /CCB_DISABLE/, 'the switch case is gone, so kernel-select lost its strongest test');
});

test('main.cjs delegates the decision instead of spelling it out', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/kernel-fallback\.cjs'\)/, 'main.cjs does not import the decision');
  assert.match(main, /fallbackDecision\(unavailable\) === 'propagate'/, 'the decision is not consulted');
  assert.ok(!/if \(unavailable\.available\) throw error;/.test(main),
    'main.cjs still spells the rule out inline, so the module is decorative');
});

test('the fallback stays visible in the log', () => {
  // main.cjs has a comment about an earlier draft that logged one backend while building another. The log line is what
  // makes a fallback readable rather than inferred, so it is pinned by name.
  assert.equal(FALLBACK_LOG, 'ccb construction failed, using local');
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /'\[kernel\] ' \+ FALLBACK_LOG/, 'the log composition changed, so the message may not appear');
  assert.match(main, /backend = null;/, 'the failure path no longer clears the backend');
});
