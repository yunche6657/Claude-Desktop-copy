// R452: "environment is initialized from the user's profile" — true, once, via a snapshot.
//
// THE SENTENCE
//   BashTool prompt: "The shell environment is initialized from the user's profile (bash or zsh)."
//
// HOW IT IS SATISFIED
//   bashProvider.getSpawnArgs():
//       const skipLoginShell = lastSnapshotFilePath !== undefined
//       return ['-c', ...(skipLoginShell ? [] : ['-l']), commandString]
//
//   First command  (no snapshot): ['-c', '-l', cmd]  -> login shell -> .bashrc / .zshrc IS read
//   Later commands (snapshot):    ['-c', cmd]        -> no login    -> profile is NOT re-read
//
//   The login shell's result is captured ONCE into a snapshot file (ShellSnapshot.ts) containing
//   exported variables, shell functions, aliases, shell options and PATH. Later shells source that
//   snapshot instead of the profile.
//
// THE FALLBACK, WHICH I FIRST MISREAD
//   `lastSnapshotFilePath` is never assigned a bare `undefined`. Instead:
//
//       if (snapshotFilePath) {
//         try { await access(snapshotFilePath) }
//         catch { snapshotFilePath = undefined }        // snapshot vanished (tmpdir cleanup)
//       }
//       lastSnapshotFilePath = snapshotFilePath          // assignment does the clearing
//
//   So the snapshot IS invalidated when the file disappears — just via the assignment rather than a
//   literal reset. My first test looked for `lastSnapshotFilePath = undefined` and wrongly concluded
//   the clearing never happens. The upstream comment at :88 explains exactly why the access() check
//   exists: without it, `source ... || true` would silently fail and commands would run with NO init
//   at all — neither snapshot nor profile.
//
// WHAT REMAINS TRUE
//   Editing the profile mid-session still has no effect. The only invalidation path is the SNAPSHOT
//   file vanishing, never the profile changing. A model told "the environment comes from your
//   profile" may assume a newly added alias works in the next command. It will not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const PROVIDER = path.join(SRC, 'src', 'utils', 'shell', 'bashProvider.ts');
const SNAPSHOT = path.join(SRC, 'src', 'utils', 'bash', 'ShellSnapshot.ts');
const PROMPT = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'prompt.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the first command uses a login shell, later ones skip it', () => {
  const p = read(PROVIDER);
  // Assert the two statements separately; a single brace-scoped regex missed the return line because
  // the function body contains a nested block.
  assert.match(p, /const skipLoginShell = lastSnapshotFilePath !== undefined/,
    'the snapshot gate changed: re-derive whether a login shell is still used at all');
  assert.match(p, /return \['-c', \.\.\.\(skipLoginShell \? \[\] : \['-l'\]\), commandString\]/,
    'the -l injection changed: the profile may no longer be loaded on the first command');
});

test('the snapshot is created with an explicit login shell', () => {
  // Without this, skipping -l on later commands would be pointless: nothing would have been captured.
  const s = read(SNAPSHOT);
  assert.match(s, /\['-c', '-l', snapshotScript\]/,
    'the snapshot no longer spawns a login shell: the profile would never be read');
});

test('the snapshot captures variables, functions, aliases and options', () => {
  const s = read(SNAPSHOT);
  const captures = [
    [/echo "# Functions" >> "\$SNAPSHOT_FILE"/, 'function section'],
    [/declare -f|typeset -f/, 'function bodies'],
    [/shopt -s expand_aliases/, 'alias expansion'],
    [/setopt \| sed|shopt -p/, 'shell options'],
  ];
  for (const [re, label] of captures) {
    assert.match(s, re, 'the snapshot no longer captures ' + label);
  }
  const aliasCount = (s.match(/alias/g) || []).length;
  assert.ok(aliasCount > 10, 'alias handling shrank to ' + aliasCount + ' mentions');
});

test('the profile file is chosen per shell type', () => {
  const s = read(SNAPSHOT);
  assert.match(s, /'\.zshrc'/, 'the zsh profile path is gone');
  assert.match(s, /'\.bashrc'/, 'the bash profile path is gone');
});

test('a vanished snapshot falls back to a login shell — via the access() check', () => {
  // The mechanism I first misread. It matters: without this fallback, a tmpdir cleanup would leave
  // commands running with neither snapshot nor profile initialisation.
  const p = read(PROVIDER);
  assert.match(p, /await access\(snapshotFilePath\)/,
    'the snapshot existence check is gone: a cleaned-up tmpdir would silently break initialisation');
  assert.match(p, /catch \{\s*[\s\S]{0,300}?snapshotFilePath = undefined/,
    'the fallback no longer clears the path, so getSpawnArgs would keep skipping -l');
  assert.match(p, /lastSnapshotFilePath = snapshotFilePath/,
    'the assignment that propagates the fallback is gone');
});

test('a mid-session profile edit is NOT picked up — the undocumented consequence', () => {
  const p = read(PROVIDER);
  // There is exactly one WRITE to lastSnapshotFilePath (the assignment at ~:103) plus one read (the
  // gate). Counting writes, not assignments of any kind: the gate uses `!==`, which my first regex
  // wrongly counted as a write.
  const writes = [...p.matchAll(/lastSnapshotFilePath\s*=(?!=)\s*[^;\n]+/g)].map((m) => m[0].trim());
  assert.equal(writes.length, 1,
    'expected a single write to lastSnapshotFilePath, found ' + writes.length + ': ' + writes.join(' | '));
  assert.match(writes[0], /lastSnapshotFilePath = snapshotFilePath/,
    'the single write is no longer the snapshot propagation');

  // Nothing in the provider watches or stats a profile file, so a profile edit cannot invalidate it.
  assert.ok(!/watch|statSync\([^)]*(?:bashrc|zshrc)|fs\.watch/i.test(p),
    'the provider now watches something: if it watches the profile, a mid-session edit IS picked up '
    + 'and this consequence no longer holds');
});

test('the description still makes the claim without the snapshot caveat', () => {
  const prompt = read(PROMPT);
  assert.match(prompt, /The shell environment is initialized from the user's profile \(bash or zsh\)\./,
    'the claim sentence changed or was removed');
  // If the snapshot behaviour gets documented, update this test deliberately rather than silently.
  const sentences = prompt.split(/\.\s+/);
  const idx = sentences.findIndex((s) => /initialized from the user's profile/.test(s));
  const nearby = sentences.slice(idx, idx + 2).join(' ');
  assert.ok(!/snapshot|cached|once per session|not re-read/i.test(nearby),
    'the prompt now explains the snapshot: the documentation gap is closed, update this note');
});
