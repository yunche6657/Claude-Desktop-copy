// Guards for the evidence log: the file that records everything must itself stay whole.
//
// Context: on 2026-10-23 I truncated evidence/STATUS.md from 6216 lines to 1163 by reading it
// (which returns a bounded window, not the whole file), taking indexOf of a missing heading
// (-1), and writing the slice back. Every step was silent: read succeeded, findIndex returned
// -1, slice(0,-1) is legal, write succeeded. Nothing failed. The evidence is in
// evidence/incident-status-truncation.md.
//
// So these tests assert the two properties that would have caught it, on the real file:
//   1. the log is substantially larger than any single read window;
//   2. its section structure is intact (front matter plus the newest rounds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `new URL(...).pathname`: this workspace path contains spaces and
// Chinese characters, which stay percent-encoded in `pathname` and turn every read into
// ENOENT against a nonsense directory name.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'evidence', 'STATUS.md');
const read = () => fs.readFileSync(STATUS, 'utf8');

test('the evidence log exists and is not a stub', () => {
  const text = read();
  assert.ok(text.length > 100_000, 'STATUS.md is ' + text.length + ' bytes; a full one is ~280 KB');
  assert.ok(text.split('\n').length > 3000, 'STATUS.md has ' + text.split('\n').length + ' lines');
});

test('the evidence log still starts at its own heading', () => {
  assert.match(read().split('\n')[0], /^# Reconstruction evidence$/);
});

test('the newest recorded round is still present', () => {
  // A truncation loses the TAIL, so checking a recent heading is what catches it.
  const text = read();
  const rounds = text.match(/^## /gm) || [];
  assert.ok(rounds.length > 50, 'expected many recorded rounds, found ' + rounds.length);
  assert.match(text, /## 第 100 轮/);
  assert.match(text, /## Round 94/);
});

test('reading a bounded window is not the same as reading the file', () => {
  // The exact trap: `read` without a limit returned ~1130 lines of a 6200-line file, and
  // nothing in the call said so. The guard is to always compare against totalLines.
  const text = read();
  const totalLines = text.split('\n').length;
  const window = text.split('\n').slice(0, 2000);
  assert.ok(window.length < totalLines, 'a bounded window must be smaller than the file');
  assert.equal(window.length, Math.min(2000, totalLines));
});

test('a missing heading is an error, not an index', () => {
  // findIndex returning -1 into slice(0, -1) is how the file lost its tail.
  const lines = ['a', 'b', 'c'];
  const idx = lines.findIndex((line) => line === 'missing');
  assert.equal(idx, -1);
  assert.throws(() => {
    if (idx < 0) throw new Error('heading not found: refusing to write a truncated file');
  }, /refusing to write a truncated file/);
});
