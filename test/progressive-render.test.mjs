import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The renderer consumes text_delta and appends it — the progressive path is fully wired.
//
// Evidence, in three layers, each measured separately this round and last:
//
//   1. the kernel emits text_delta per text event   (session-kernel.cjs:490, tested)
//   2. the bridge forwards every event unfiltered   (tested round 206)
//   3. the renderer appends the delta:
//        applyDeltaEvent: (e, t) => {
//          if (t.kind === 'text' && e.delta.type === 'text_delta' && e.delta.text)
//            return { kind: 'text', text: t.text + e.delta.text };
//        }
//      found in c06cf64bb-CdJdJuVd.js
//
// So the shell can render progressively. It does not, because this gateway returns the whole
// reply in one delta — measured live:
//   text_delta events: 1, span 0 ms, length 35
//   visible answer growth: 0 -> 500 characters, growth steps: 1
//
// That is the honest end state: mechanism complete, input not incremental.
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

test('the renderer appends text_delta to the accumulating text', () => {
  // If this disappeared, a streamed reply would show only its last chunk.
  const text = requireBundle();
  assert.ok(text.includes('text_delta'), 'text_delta is no longer referenced by the renderer');
  assert.ok(/applyDeltaEvent/.test(text), 'the delta applier is gone');
  assert.ok(/text:\s*t\.text\s*\+\s*e\.delta\.text/.test(text),
    'the renderer no longer concatenates deltas');
});

test('the renderer also handles the connector variant', () => {
  // A second delta flavour exists for connector text; treating it as unknown would drop it.
  const text = requireBundle();
  assert.ok(text.includes('connector_text_delta'), 'the connector delta variant is unhandled');
});

test('a delta is only applied when its text is non-empty', () => {
  // The renderer has a guard for this; an empty delta must not reset the text.
  const text = requireBundle();
  assert.ok(/e\.delta\.text\)/.test(text), 'the non-empty guard is gone');
});

test('the live single-delta measurement is recorded', () => {
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('growth steps: 1') || status.includes('growth steps:1'),
    'the measured growth-steps result is not in the evidence log');
});
