// The allowlist must not name a command whose local binary means something ELSE.
//
// Measured on this host this round: `find` resolved to C:\Windows\System32\find.exe and
// passed the availability check — but that binary is the Windows TEXT search tool, not Unix
// find. A model writing the natural `find test -name *.test.mjs` got exit 2 with no output,
// and retried it. A wrong-but-present binary defeats the entire refusal design: nothing
// tells the caller the tool is not what it thinks.
//
// After removing it from the allowlist:
//   find ... -> 'executable "find" is not in the allowlist'
//
// The same file already handles the opposite case well: `ls`, `cat`, `echo`, `grep`, `wc`
// are allowlisted names with no spawnable .exe on Windows, and checkAvailability reports
// 'allowlisted but this machine has no spawnable binary for it' BEFORE any consent prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = require(path.join(ROOT, 'desktop', 'local-exec.cjs'));

test('find is not allowlisted, because on Windows it is a different program', () => {
  // If someone re-adds it, that file gets a comment explaining exactly why not.
  assert.equal(exec.ALLOWED_EXECUTABLES.has('find'), false,
    'find is allowlisted again; on Windows that binary is a text search tool');
  assert.throws(() => exec.parseCommand('find test -name *.test.mjs'), /not in the allowlist/);
});

test('a name that exists but cannot be spawned is reported before consent', () => {
  // The refusal must be a clear answer, not an ENOENT after the user clicked Allow.
  const parsed = exec.parseCommand('ls -1 test');
  const verdict = exec.checkAvailability(parsed);
  assert.equal(typeof verdict.available, 'boolean');
  assert.equal(typeof verdict.reason === 'string' || verdict.reason === null, true);
  if (!verdict.available) {
    assert.match(verdict.reason, /no spawnable binary|shell alias/, 'the reason is not actionable');
  }
});

test('commands this host can actually run stay usable', () => {
  // Guards against an over-eager cleanup that removes the working entries too.
  for (const name of ['node', 'git']) {
    const parsed = exec.parseCommand(name + ' --version');
    const verdict = exec.checkAvailability(parsed);
    assert.equal(verdict.available, true, name + ' should be spawnable on this host');
  }
});

test('every allowlisted name has a documented availability answer', () => {
  // Each name must answer yes or no — never 'unknown', which would mean no consent path.
  for (const name of exec.ALLOWED_EXECUTABLES) {
    const verdict = exec.checkAvailability({ executable: name, args: [], display: name });
    assert.equal(typeof verdict.available, 'boolean', name + ' has no answer');
    if (!verdict.available) {
      assert.ok(verdict.reason, name + ' is unavailable but gives no reason');
    }
  }
});
