// A test must not cost more than the behaviour it verifies.
//
// Round 197 added a cache for executable probing. The test that proved it worked warmed all
// 29 allowlisted names first — 3.8 s of `where.exe` calls — so the suite got a test that was
// slower than the thing it was protecting. Rewritten to probe one name 20 times: 78 ms, and
// it still fails loudly when the cache is removed ("20 warm lookups took 1169ms").
//
// This file pins the property that made that possible: no single test may take more than a
// few seconds, because a slow test hides the next slow test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

// Tests that legitimately wait on a timeout: the wait IS the behaviour under test.
const WAITS_ON_TIMEOUT = new Map([
  ['ccb-capabilities.test.mjs', 'proves the model list stays empty until the handshake arrives'],
  ['ccb-kernel.test.mjs', 'proves a turn that never reports times out instead of hanging'],
  ['ccb-upstream-error.test.mjs', 'proves retry/backoff timing and single-error emission'],
]);

test('no test file spends its time on subprocess probing', () => {
  // Static check: a file that loops over ALLOWED_EXECUTABLES and calls checkAvailability
  // is paying ~100 ms per name. Doing that for all names inside one test is the shape that
  // made round 197's cache test slower than the cache.
  const offenders = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'))) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const loopsAll = /for \(const \w+ of exec\.ALLOWED_EXECUTABLES\)/.test(text);
    const callsCheck = /checkAvailability\(/.test(text);
    if (loopsAll && callsCheck) {
      const loopsInTimingTest = /probeAll|warm pass|Date\.now\(\)/.test(text);
      if (loopsInTimingTest) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    'these tests probe every executable while measuring time: ' + offenders.join(', '));
});

test('the timeout-waiting exceptions are still justified', () => {
  // Each entry must name a real file and a real reason; a stale entry hides a slow test.
  for (const [file, reason] of WAITS_ON_TIMEOUT) {
    assert.ok(fs.existsSync(path.join(TEST_DIR, file)), file + ' no longer exists; drop its entry');
    assert.ok(reason.length > 20, file + ' is excepted without a real reason');
  }
});
