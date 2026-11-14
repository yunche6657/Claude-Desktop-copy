// Availability probing must be cached, and the cache must not swallow injected stubs.
//
// Measured this round: defaultResolve shells out to `where.exe`, ~100 ms per name. The
// allowlist test that checks all 29 names took 3694 ms of pure subprocess time, and every
// Bash tool call paid one probe again at runtime.
//
// After caching: cold 1686 ms, warm 1 ms (1686x).
//
// The subtle part is the stub: checkAvailability ALWAYS supplies a resolver (the default when
// none is given), so isSpawnable cannot detect a custom one by identity. The first attempt at
// this cache did exactly that and never hit — warm stayed at 1651 ms. The flag is now passed
// explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = require(path.join(ROOT, 'desktop', 'local-exec.cjs'));

test('a repeated availability check does not re-probe the filesystem', () => {
  // Timing-based, but scoped to ONE name so the test does not itself pay for 29 probes.
  //
  // The first version warmed all 29 allowlisted names before measuring — 3.8 s of
  // `where.exe` calls to prove that a second pass is cheap. The test cost more than the
  // behaviour it verified.
  const name = 'node';
  exec.checkAvailability({ executable: name, args: [], display: name }); // cold: one probe
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    exec.checkAvailability({ executable: name, args: [], display: name });
  }
  const warm = Date.now() - start;
  // 20 cached lookups must be far cheaper than a single `where.exe` (~100 ms here).
  assert.ok(warm < 50, '20 warm lookups took ' + warm + 'ms, so results are not cached');
});

test('a caller-supplied resolver is consulted every time', () => {
  // Tests inject stubs to simulate other machines; a cached answer would make them lie.
  let calls = 0;
  const resolve = () => { calls++; return null; };
  exec.checkAvailability({ executable: 'node', args: [], display: 'node' }, { resolve });
  exec.checkAvailability({ executable: 'node', args: [], display: 'node' }, { resolve });
  assert.equal(calls, 2, 'the custom resolver was cached after the first call');
});

test('a stub can report an executable as available even when it is not', () => {
  // The cache must not leak a real answer into a stubbed run.
  const verdict = exec.checkAvailability(
    { executable: 'definitely-not-here', args: [], display: 'definitely-not-here' },
    { resolve: () => 'C:\\fake\\definitely-not-here.exe' },
  );
  assert.equal(verdict.available, true);
});
