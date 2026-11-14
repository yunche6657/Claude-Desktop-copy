// The scratch directory must not accumulate orphans.
//
// .tmp is where probes write throwaway files. Over many rounds it collected 11 of them, none
// referenced by any test or tool (checked by grepping test/, tools/ and desktop/ for each
// filename). Deleting all 11 and re-running the suite gave 1770 pass / 0 fail, which is what
// proves they were inert rather than load-bearing.
//
// This test keeps the directory from silently filling again: a probe that leaves a file behind
// will fail here on the NEXT round, when the file is still unreferenced.
//
// Scope note: this checks the scratch directory only. .data is real user state and is never
// cleaned by this project (measured stable at 156 sessions / 1515 rows while .data/chromium,
// which is Electron's own cache, grew to 33 MB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp');

/** Files in .tmp, or [] when the directory does not exist. */
function scratchFiles() {
  if (!fs.existsSync(TMP)) return [];
  return fs.readdirSync(TMP).filter((name) => fs.statSync(path.join(TMP, name)).isFile());
}

/** True when any source file under the given dirs mentions the scratch path. */
function isReferenced(name) {
  const needle = '.tmp/' + name;
  for (const dir of ['test', 'tools', 'desktop']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      const file = path.join(abs, entry);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (fs.readFileSync(file, 'utf8').includes(needle)) return true;
      } catch { /* unreadable files cannot reference anything */ }
    }
  }
  return false;
}

test('the scratch directory holds no unreferenced file', () => {
  const orphans = scratchFiles().filter((name) => !isReferenced(name));
  assert.deepEqual(orphans, [],
    'unreferenced scratch files left behind: ' + orphans.join(', ')
      + ' — delete them, or reference them from a test');
});

test('the scratch directory stays small enough to inspect', () => {
  // A directory with hundreds of files means a probe is writing per-run output.
  const files = scratchFiles();
  assert.ok(files.length <= 20, 'the scratch directory has grown to ' + files.length + ' files');
});
