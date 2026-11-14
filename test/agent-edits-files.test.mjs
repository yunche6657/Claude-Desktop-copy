// A targeted edit, verified on disk. Read -> Edit -> Read -> report.
//
// MEASURED LIVE (replica :10330). Seeded .tmp/edit-probe.txt with three lines and asked:
//   "Use the Edit tool to change the line MARKER-BEFORE to MARKER-AFTER ... Do not rewrite
//    the whole file."
//
// The transcript:
//   Read  { path: '.tmp/edit-probe.txt' }         -> '1\tline one\n2\tMARKER-BEFORE\n3\tline three'
//   Edit  { old_string: 'MARKER-BEFORE', new_string: 'MARKER-AFTER' }
//         -> 'Edited C:\\...\\.tmp\\edit-probe.txt (+1 −1)'
//   Read  { path: '.tmp/edit-probe.txt' }         -> '1\tline one\n2\tMARKER-AFTER\n3\tline three'
//   final text: "line 2 now reads MARKER-AFTER; the rest of the file is unchanged."
//
// And the disk: 34 bytes -> 33 bytes (one character shorter), MARKER-AFTER present,
// MARKER-BEFORE absent, 'line one' and 'line three' both still there, still 3 lines.
//
// The `(+1 −1)` in the result matters: it says this was a REPLACEMENT, not a rewrite. A tool
// that silently rewrote the file would also produce the right content while losing whatever
// it did not understand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Edit takes old_string and new_string, and reports a diff', () => {
  // Measured answer: 'Edited <path> (+1 −1)'.
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /old_string/, 'the edit tool has no old_string');
  assert.match(tools, /new_string/, 'the edit tool has no new_string');
  assert.match(tools, /\+\$\{.*added\}/, 'the added-line count is gone');
  assert.match(tools, /−\$\{.*removed\}/, 'the removed-line count is gone');
});

test('an ambiguous old_string is refused instead of editing the wrong place', () => {
  // The measured prompt targeted one unique line; if the text occurred twice the tool must
  // stop rather than pick one. Assert the exact guard and the exact code, not the words:
  // a first version matched /occurrences/ and survived renaming the guard to 'occurrences > 99'.
  const fileTools = read('desktop/file-tools.cjs');
  assert.match(fileTools, /const occurrences = current\.content\.split\(oldText\)\.length - 1;/,
    'the occurrence count is gone');
  assert.match(fileTools, /if \(occurrences > 1\) \{/, 'the ambiguity guard became permissive');
  assert.match(fileTools, /fail\('ambiguous-match'/, 'the ambiguity is not reported');
});

test('a missing old_string reports no-match rather than creating it', () => {
  // The real code is 'no-match' with advice to read the file first.
  const fileTools = read('desktop/file-tools.cjs');
  assert.match(fileTools, /if \(occurrences === 0\) \{/, 'the zero-occurrence branch is gone');
  assert.match(fileTools, /fail\('no-match'/, 'a missing search string is not reported');
});

test('Edit refuses a path outside the workspace roots', () => {
  const fileTools = read('desktop/file-tools.cjs');
  assert.match(fileTools, /outside-root/, 'the edit path has no outside-root guard');
});

test('Read numbers the lines, which is what made the edit addressable', () => {
  // Measured: '2\tMARKER-BEFORE' told the model exactly which line it was changing.
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /readWithLineNumbers/, 'line numbering is gone');
});