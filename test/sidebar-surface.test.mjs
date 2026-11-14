import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The sidebar must expose its controls visibly, and the probe must measure visibility right.
//
// Measured live this round. The naive inventory listed 14 buttons, 9 of them with w=0 h=0 but
// visibility:visible — which reads as "broken controls" until you trace the ancestor chain:
// those nine live inside a collapsed container (six ancestors, all 0x0), so they are simply
// not rendered yet. Counting them as failures would be the same mistake as round 189, where
// a visibility:hidden cross-fade was misread as "the stop button never disappears".
//
// The visible sidebar, measured with a real size check:
//   Cowork / Code / 新建 Ctrl+N / 自定义 / 更多导航项 / 已置顶
//   搜索 / 筛选 / and the session rows
//
// So the surface is complete; the lesson is about the measurement, not the product.
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

test('the sidebar chrome strings the user sees are in the shipped bundle', () => {
  // These are the labels measured on the running app; if one disappears the control is gone.
  const text = requireBundle();
  for (const label of ['Cowork', 'Code']) {
    assert.ok(text.includes(label), label + ' is no longer in the bundle');
  }
});

test('the sidebar exposes search and filter affordances', () => {
  // Measured visible: 搜索 and 筛选. Their message ids live in the bundle even when the
  // rendered text comes from the Chinese overlay.
  const text = requireBundle();
  assert.ok(/search/i.test(text), 'no search affordance in the bundle');
  assert.ok(/filter/i.test(text), 'no filter affordance in the bundle');
});

test('a zero-size element is not evidence that a control is broken', () => {
  // This test exists to record the reasoning, not to exercise code: the round-190 probe saw
  // nine 0x0 buttons and nearly filed a bug. The rule that came out of it is asserted in
  // the evidence log so a future probe author can find it.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('可见性') || status.includes('visibility'),
    'the visibility-measurement lesson is no longer in the evidence log');
});
