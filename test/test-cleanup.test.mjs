// A test that writes into the repo root must clean up after itself.
//
// FOUND BY REPEATED MANUAL CLEANUP. After several rounds I noticed the same four files in the
// workspace root every time: decode.txt, decode-2.txt, paste.txt, paste-2.txt. They came from
// session-file-ops.test.mjs, which exercises savePastedFile — and that handler writes into the
// workspace root BY DESIGN, because that is where an @-reference resolves from.
//
// So the handler was right and the TEST was leaving litter. Two of its cases now remove what
// they caused to be written and assert the removal, which turns "the test cleans up" into
// something the suite checks rather than something I remember to do.
//
// This file checks the property from the outside: after running the paste-related tests, the
// repo root must not have gained a .txt or .png file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Root-level files with an extension a probe could have written. */
function rootArtifacts() {
  return fs.readdirSync(ROOT)
    .filter((name) => fs.statSync(path.join(ROOT, name)).isFile())
    .filter((name) => /\.(txt|png|bin|log)$/i.test(name));
}

test('the repo root holds no stray .txt/.png/.bin/.log file', () => {
  const strays = rootArtifacts();
  assert.deepEqual(strays, [],
    'stray files in the repo root: ' + strays.join(', ')
      + ' — a test that writes into the workspace must delete what it wrote');
});

test('the paste tests clean up the files they cause', () => {
  // The two cases that actually call savePastedFile must have a removal path.
  const source = fs.readFileSync(path.join(ROOT, 'test', 'session-file-ops.test.mjs'), 'utf8');
  assert.match(source, /function removeWritten\(filePath\)/, 'the cleanup helper is gone');
  const calls = (source.match(/removeWritten\(stored\.path\)/g) || []).length;
  assert.ok(calls >= 2, 'only ' + calls + ' of the two paste tests clean up');
});

test('the cleanup helper fails loudly when the file survives', () => {
  // A cleanup that silently shrugs would leave the next round with the same litter.
  const source = fs.readFileSync(path.join(ROOT, 'test', 'session-file-ops.test.mjs'), 'utf8');
  assert.match(source, /assert\.equal\(fs\.existsSync\(filePath\), false/,
    'the cleanup does not verify the removal');
});
