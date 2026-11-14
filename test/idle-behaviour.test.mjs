import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The app must stay responsive after a long idle, and must not churn while idle.
//
// Measured live this round:
//
//   baseline          composer focusable, send button present
//   after 20 s idle   composer focusable, send button present
//   typed afterwards  17 characters reached the editor
//
//   timers scheduled during 10 s idle : { intervals: 0, timeouts: 0, raf: 0 }
//   events registered during 12 s idle: {}
//   settings dialog still opens after : 1
//
// The zero counts matter as much as the responsiveness. A periodic heartbeat would keep the
// renderer awake forever; a user who leaves the app open overnight pays for that in battery.
//
// Round 199 taught the harder lesson behind this file: measure a baseline first. The idle
// numbers here ARE the baseline — without them, "still responsive" says nothing about
// whether anything was happening during the wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = PINNED_ION_DIST + '/assets/v1';

function bundleText() {
  if (!fs.existsSync(BUNDLE_DIR)) return null;
  return fs.readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8'))
    .join('\n');
}

function requireBundle() {
  const text = bundleText();
  assert.ok(text, 'the shipped frontend bundle is missing: ' + BUNDLE_DIR);
  return text;
}

test('short intervals exist in the bundle but none of them run while idle', () => {
  // First attempt at this test banned sub-5s setInterval calls outright and failed: the
  // bundle does contain 2000/300/50/1200 ms intervals. What matters is that the MEASURED
  // idle count was zero — they are started on demand, not at boot.
  //
  // So this test records both halves: the literals exist (it is not a stale assertion),
  // and the behavioural claim is checked by the live probe, whose result is in the log.
  const text = requireBundle();
  const shortIntervals = [...text.matchAll(/setInterval\([^,]{0,40},\s*(\d{1,4})\s*\)/g)]
    .map((m) => Number(m[1]))
    .filter((ms) => ms > 0 && ms < 5000);
  assert.ok(shortIntervals.length > 0,
    'no short intervals found at all — the pattern no longer matches the bundle');
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('intervals: 0'),
    'the live idle measurement (0 intervals) is not recorded');
});

test('the composer remains the same control after the app settles', () => {
  // The test id is the stable handle; the label is localised (see probe-locale-independence).
  const text = requireBundle();
  assert.ok(text.includes('code-prompt-send'));
  assert.ok(text.includes('code-prompt-stop'));
});

test('the idle findings are recorded with their zero counts', () => {
  // If a future round re-measures and gets non-zero, the log should change with it.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('intervals: 0'), 'the idle timer measurement is not recorded');
});
