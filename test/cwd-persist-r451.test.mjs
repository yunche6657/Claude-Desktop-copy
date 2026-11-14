// R451: the cwd claim is verified — both halves, from one design.
//
// THE CLAIM
//   BashTool prompt: "The working directory persists between commands, but shell state does not.
//                     The shell environment is initialized from the user's profile (bash or zsh)."
//
// R450 recorded this as unverified. It is now verified by reading Shell.ts, and the two halves turn
// out to be consequences of ONE design choice:
//
//   A FRESH SHELL PER COMMAND.
//
//   1. spawn() is called per command (Shell.ts:354), with `env:` rebuilt from subprocessEnv() and
//      `cwd` passed in. No long-lived process is kept.
//      -> shell state cannot survive, because there is no shell to survive in.
//
//   2. At the end of the command, the shell writes its final directory to a file. The parent reads it
//      and adopts it as the new cwd for the next spawn:
//
//          // runs after the command
//          void shellCommand.result.then(async result => {
//            if (result && !preventCwdChanges && !result.backgroundTaskId) {
//              let newCwd = readFileSync(nativeCwdFilePath, ...).trim()
//              if (newCwd.normalize('NFC') !== cwd) {
//                setCwd(newCwd, cwd)
//                ...
//              }
//            }
//          })
//      -> cwd persists, because it is explicitly carried.
//
//   So "cwd persists but shell state does not" is not two rules; it is what a fresh-shell-per-command
//   design produces.
//
// WHAT THE DESCRIPTION DOES NOT SAY
//   `preventCwdChanges = !isMainThread` (BashTool.tsx:808): when the tool runs inside a subagent, cwd
//   changes are NOT adopted. A subagent's `cd` therefore does not leak into the main session. The
//   prompt says "the working directory persists between commands" without that qualifier — accurate
//   for the main thread, incomplete for subagents. Not a defect (isolation is the safer behaviour),
//   but the asymmetry is real and undocumented.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const SHELL = path.join(SRC, 'src', 'utils', 'Shell.ts');
const BASH = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'BashTool.tsx');
const PROMPT = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'prompt.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('a fresh shell is spawned per command — the reason shell state cannot persist', () => {
  const shell = read(SHELL);

  // One spawn call, given env and cwd per invocation.
  assert.match(shell, /spawn\(spawnBinary, shellArgs, \{[\s\S]{0,400}?cwd,/,
    'the spawn signature changed: cwd may no longer be injected per command');

  // env is rebuilt, not inherited from a previous shell.
  assert.match(shell, /env:\s*\{[\s\S]{0,300}?subprocessEnv\(\)/,
    'env is no longer rebuilt from subprocessEnv(): something may now leak between commands');

  // And no long-lived shell handle is kept between calls.
  assert.ok(!/let\s+\w*[Ss]hell\w*\s*=\s*spawn\(/.test(shell),
    'a module-level shell handle appeared: that WOULD make shell state persist, breaking the claim');
});

test('the shell reports its final cwd, and the parent adopts it', () => {
  const shell = read(SHELL);

  // The shell writes `pwd -P` to a file the parent reads.
  assert.match(shell, /pwd -P/, 'the pwd capture is gone: cwd would no longer persist');
  assert.match(shell, /nativeCwdFilePath/, 'the cwd file handle is gone');
  assert.match(shell, /readFileSync\(nativeCwdFilePath/, 'the parent no longer reads the cwd back');
  assert.match(shell, /setCwd\(newCwd, cwd\)/, 'the parent no longer adopts the new cwd');
});

test('only foreground main-thread commands adopt the cwd', () => {
  const shell = read(SHELL);
  // Both guards are load-bearing: a background task's cwd must not hijack the session, and a
  // subagent's cwd change must not leak out.
  assert.match(shell, /if \(result && !preventCwdChanges && !result\.backgroundTaskId\)/,
    'the adoption guard changed: a background task or subagent could now move the main session cwd');

  const bash = read(BASH);
  assert.match(bash, /const preventCwdChanges = !isMainThread/,
    'the subagent restriction is gone: a subagent cd would now persist into the main session');
});

test('the claim text is intact and matches the mechanism', () => {
  const prompt = read(PROMPT);
  assert.match(prompt, /The working directory persists between commands, but shell state does not/,
    'the claim changed: if it was reworded, this verification needs redoing');

  // The mechanism satisfies both halves: adopted cwd (persists) + fresh env (does not persist).
  // Assert the two facts that make it so, so a future refactor cannot silently break one half.
  const shell = read(SHELL);
  assert.match(shell, /setCwd\(newCwd, cwd\)/, 'cwd no longer persists');
  assert.match(shell, /env:\s*\{[\s\S]{0,300}?subprocessEnv\(\)/, 'shell state now persists');
});

test('the subagent asymmetry is real and the prompt does not mention it', () => {
  // Recorded as a documentation gap, not a defect. Isolation is the safer behaviour.
  const bash = read(BASH);
  assert.match(bash, /preventCwdChanges = !isMainThread/,
    'the asymmetry is gone: if subagents now share cwd, this note is obsolete');
  const prompt = read(PROMPT);
  const claimSentence = /The working directory persists between commands[^.]*\./.exec(prompt);
  assert.ok(claimSentence, 'the claim sentence moved');
  assert.ok(!/subagent|agent/i.test(claimSentence[0]),
    'the claim sentence now qualifies subagents: the asymmetry is documented, update this test');
});
