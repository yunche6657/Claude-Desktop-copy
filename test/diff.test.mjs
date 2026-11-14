// Diff engine tests.
//
// The engine decides what the user is asked to approve, so the assertions are
// about correctness, not shape: identical inputs produce no hunks, a single
// changed line produces one add and one delete with the right line numbers, and
// insertion-only edits never report a phantom deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { diffText, formatUnified, splitLines, MAX_LINES } = await import('../desktop/diff.cjs');

test('splitLines keeps trailing-newline information', () => {
  assert.deepEqual(splitLines('a\nb'), { lines: ['a', 'b'], endsWithNewline: false });
  assert.deepEqual(splitLines('a\nb\n'), { lines: ['a', 'b'], endsWithNewline: true });
  assert.deepEqual(splitLines(''), { lines: [], endsWithNewline: false });
  assert.deepEqual(splitLines('a'), { lines: ['a'], endsWithNewline: false });
});

test('identical text yields no hunks', () => {
  const diff = diffText('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(formatUnified('x.txt', diff), '');
});

test('one changed line is one add and one delete', () => {
  const diff = diffText('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);

  const hunk = diff.hunks[0];
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.oldCount, 3);
  assert.equal(hunk.newStart, 1);
  assert.equal(hunk.newCount, 3);

  const types = hunk.lines.map(line => line.type);
  assert.deepEqual(types, ['context', 'del', 'add', 'context']);
  assert.equal(hunk.lines[1].text, 'b');
  assert.equal(hunk.lines[2].text, 'B');
});

test('a pure insertion reports no deletion', () => {
  const diff = diffText('a\nc\n', 'a\nb\nc\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  const texts = diff.hunks[0].lines.map(line => `${line.type}:${line.text}`);
  assert.deepEqual(texts, ['context:a', 'add:b', 'context:c']);
});

test('a pure deletion reports no insertion', () => {
  const diff = diffText('a\nb\nc\n', 'a\nc\n');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 1);
});

test('creating a file from nothing is all additions', () => {
  const diff = diffText('', 'x\ny\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
});

test('deleting every line is all deletions', () => {
  const diff = diffText('x\ny\n', '');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 2);
});

test('distant changes become separate hunks with correct headers', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const newLines = oldText.split('\n');
  newLines[1] = 'CHANGED1';
  newLines[35] = 'CHANGED2';
  const diff = diffText(oldText, newLines.join('\n'));

  assert.equal(diff.hunks.length, 2, 'two distant edits must not be merged');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  // First hunk centres on line 2, second on line 36 (1-based).
  assert.equal(diff.hunks[0].oldStart, 1);
  assert.ok(diff.hunks[1].oldStart >= 33 && diff.hunks[1].oldStart <= 36,
    `second hunk start was ${diff.hunks[1].oldStart}`);
});

test('nearby changes merge into one hunk', () => {
  const oldText = 'a\nb\nc\nd\ne\nf\n';
  const diff = diffText(oldText, 'a\nB\nc\nD\ne\nf\n');
  assert.equal(diff.hunks.length, 1, 'edits two lines apart should share a hunk');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
});

test('formatUnified renders standard headers and prefixes', () => {
  const diff = diffText('a\nb\n', 'a\nB\n');
  const text = formatUnified('src/x.js', diff);
  assert.match(text, /^--- a\/src\/x\.js$/m);
  assert.match(text, /^\+\+\+ b\/src\/x\.js$/m);
  assert.match(text, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(text, /^-b$/m);
  assert.match(text, /^\+B$/m);
});

test('an oversized file is reported as truncated, not diffed partially', () => {
  const big = Array.from({ length: MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
  const diff = diffText(big, big + '\nextra');
  assert.equal(diff.truncated, true);
  assert.equal(diff.hunks.length, 0);
  assert.match(diff.reason, /line diff limit/);
  assert.match(formatUnified('big.txt', diff), /truncated|exceeds/);
});

test('CRLF content is diffed literally without mangling', () => {
  const diff = diffText('a\r\nb\r\n', 'a\r\nB\r\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks[0].lines[1].text, 'b\r');
});
