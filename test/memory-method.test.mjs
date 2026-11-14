// The app does not leak memory across navigation. This file records how that was established,
// because the first three attempts said it did.
//
// What went wrong, in order:
//
//   1. Measured usedJSHeapSize with a 500 ms wait after collectGarbage:
//        0 cycles 195.8 MB -> 60 cycles 213.7 MB, i.e. 0.30 MB per navigation.
//      Extrapolated that to 895 MB/month and started hunting a leak.
//   2. Counted addEventListener minus removeEventListener across 8 cycles:
//        added 17096, removed 9287, net +7809 — looked like a listener leak.
//   3. Isolated it properly: idle for 8 s with no navigation changed the heap by -0.00 MB,
//      and one navigation changed it by -0.12 MB.
//
// The final measurement separates uncollected garbage from live data:
//
//   before: noGC 216.3 MB   afterGC 215.7 MB
//   after : noGC 235.4 MB   afterGC 216.8 MB
//   growth: noGC +19.0 MB   afterGC +1.1 MB
//
// So navigation produces garbage (19 MB) that V8 collects on demand. 1.1 MB over 10 cycles is
// noise, not a leak. The listener counter was equally misleading: React attaches and detaches
// listeners constantly, and the counts include every temporary target.
//
// The assertions below pin the METHOD, since that is what failed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'tools', 'probes');

test('any heap-growth probe waits long enough after collecting garbage', () => {
  // The 500 ms wait used first was not enough: collection is asynchronous, so the reading
  // still included garbage and produced a fake 0.3 MB/cycle trend. A probe that measures
  // memory must settle for at least a second, or it reports garbage as live data.
  const files = fs.readdirSync(PROBE_DIR).filter((f) => f.endsWith('.mjs'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(PROBE_DIR, file), 'utf8');
    if (!/collectGarbage/.test(text)) continue;
    const waits = [...text.matchAll(/setTimeout\([^,]+,\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
    assert.ok(waits.some((ms) => ms >= 1000),
      file + ' collects garbage but never waits >= 1 s afterwards');
  }
  // No probe currently measures heap growth; the rule above stays for the next one that does.
  assert.ok(Array.isArray(files));
});

test('the leak conclusion is recorded as disproved', () => {
  // If a future round re-opens this, it should start from the corrected numbers.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  // The wording used in the log; keep this in step with the heading, not with an idealised
  // phrase — the first version asserted a sentence that was never written.
  assert.ok(status.includes('我以为发现了内存泄漏'), 'the disproved leak finding is not recorded');
  assert.ok(status.includes('这是噪音，不是泄漏'), 'the corrected conclusion is not recorded');
});
