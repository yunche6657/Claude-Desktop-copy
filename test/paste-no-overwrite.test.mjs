// Pasting a file must never overwrite an earlier paste with the same name.
//
// MEASURED BEFORE THE FIX (three sessions sharing one cwd, each pasting "probe2.txt"):
//   exactly ONE file remained on disk, 1 byte — the later pastes silently replaced the
//   earlier ones. The renderer names pastes from the browser (image.png, screenshot.png),
//   so two screenshots in a row collide every time and the first is lost with no error.
//
// The old code looked collision-safe because it contained `Date.now()`, but that only names
// the DEFAULT file when no name is supplied; a supplied name went straight to writeFile,
// which truncates.
//
// MEASURED AFTER THE FIX (three pastes named dup.txt in one session):
//   returned dup.txt, dup-2.txt, dup-3.txt
//   on disk:  content-0, content-1, content-2   — all three preserved
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('a pasted file goes through the unique-name helper', () => {
  const at = SRC.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  assert.ok(at > 0, 'savePastedFile is missing');
  const block = SRC.slice(at, at + 2600);
  assert.match(block, /await uniqueTarget\(root, name\)/, 'the name is not made unique');
});

test('the write refuses to truncate an existing file', () => {
  // 'wx' fails when the path exists; the default would silently truncate.
  const at = SRC.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = SRC.slice(at, at + 2600);
  assert.match(block, /\{ flag: 'wx' \}/, 'the write can still truncate an existing file');
});

test('the unique-name helper keeps the extension', () => {
  // Wrong extension means the OS opens the file with the wrong application.
  const at = SRC.indexOf('const uniqueTarget = async (dir, name) => {');
  assert.ok(at > 0, 'uniqueTarget is missing');
  const block = SRC.slice(at, at + 900);
  assert.match(block, /path\.extname\(name\)/, 'the extension is not preserved');
  assert.match(block, /`\$\{base\}-\$\{attempt \+ 1\}\$\{ext\}`/, 'the numbered suffix is not appended');
});

test('an unknown session is refused instead of writing somewhere arbitrary', () => {
  // Measured: savePastedFile('does-not-exist', ...) answers null.
  const at = SRC.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = SRC.slice(at, at + 1200);
  // Known 3p uses userData staging; the compatibility branch retains its workspace fallback.
  assert.match(block, /savePendingUpload/, '3p staging is missing');
  assert.match(block, /settings\.projectPath \|\| process\.cwd\(\)/, 'no destination fallback');
});

test('the helper gives up rather than looping forever', () => {
  // 100 attempts is the bound; a directory holding all of them means a real problem.
  const at = SRC.indexOf('const uniqueTarget = async (dir, name) => {');
  const block = SRC.slice(at, at + 900);
  assert.match(block, /attempt < 100/);
  assert.match(block, /return null;/);
});
