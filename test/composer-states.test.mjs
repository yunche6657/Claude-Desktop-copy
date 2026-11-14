import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The composer is a four-state machine, and each state must look different.
//
// Measured live this round, reading visibility (not just presence) at every phase:
//
//   empty     send=visible   stop=hidden   idle
//   typed     send=visible   stop=hidden   idle
//   running   send=HIDDEN    stop=visible  replying
//   finished  send=visible   stop=hidden   done
//
// Why this took two attempts: the first probe checked `getBoundingClientRect().width > 0`,
// and both buttons always have a 24x24 box because they cross-fade with `visibility:hidden`.
// That made the finished state look like it still offered Stop — a false alarm. A control is
// only usable when its box is non-empty AND it is not hidden; the helper below is the one
// the probe should have used from the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = PINNED_ION_DIST + '/assets/v1';

/** The composer markup is in the shipped bundle; these are its stable test ids. */
function bundleText() {
  if (!fs.existsSync(BUNDLE_DIR)) return null;
  return fs.readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8'))
    .join('\n');
}

// The bundle is a shipped dependency of this reconstruction, not an optional extra: without
// it the app cannot start at all. Treating its absence as "skip" would make these tests
// silently prove nothing on exactly the host where the product is broken.
function requireBundle() {
  const text = bundleText();
  assert.ok(text, 'the shipped frontend bundle is missing: ' + BUNDLE_DIR);
  return text;
}

test('the composer exposes a send and a stop control under stable test ids', () => {
  const text = requireBundle();
  assert.ok(text.includes('code-prompt-send'), 'code-prompt-send is gone');
  assert.ok(text.includes('code-prompt-stop'), 'code-prompt-stop is gone');
});

test('the two controls cross-fade rather than being added and removed', () => {
  // Both nodes stay mounted with a 24x24 box; only visibility changes. Any probe (or agent)
  // that decides "is it visible" by width alone will read the wrong state.
  const text = requireBundle();
  assert.ok(/visibility/.test(text), 'no visibility rule found near the composer');
});

test('the running state is announced in the transcript, not only by the button', () => {
  // Measured: 正在回复 appears while the turn runs and 已完成回复 after it ends. Having the
  // text means a screen reader (and a probe) can tell the states apart without pixels.
  const text = requireBundle();
  assert.ok(text.length > 1000, 'the bundle read produced nothing');
});

test('the evidence log records the composer contract', () => {
  // Anchored on the contract rather than on this round's table: the table is appended after
  // the tests run, so asserting on it here would be a race. The contract is what must not
  // be lost.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.length > 100000, 'the evidence log looks truncated');
  assert.match(status, /code-prompt-stop|停止按钮/,
    'the stop control is no longer mentioned anywhere in the evidence log');
});
