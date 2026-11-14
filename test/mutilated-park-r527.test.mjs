// R527: the empty `if` block that was making two tests fail, and the reason nobody noticed.
//
// WHAT WAS THERE
//   desktop/session-kernel.cjs, in cancel() with the default `keepHeldInput = true`:
//
//       if (backend && keepHeldInput) {
//         /* MUTATED: held inputs are no longer handed back before the turn is torn down */
//       }
//
//   The whole hand-back call had been replaced by that comment. `parkHeldSteers` was never invoked, so a stop
//   dropped every held steer on the floor — the exact behaviour the surrounding comment block describes fixing.
//
// WHY IT SURVIVED
//   A comment that describes an omission is not the omission being tracked. Nothing asserted the call, so nothing
//   failed. And the one test that did assert it — `cancel-discard-scope-r385`, "a stop still hands held inputs back
//   instead of discarding them" — had been failing on every run and was being read as noise. R516 named the milder
//   version of this ("a check never invoked is indistinguishable from one that cannot fail"); this is the harsher
//   one, where the check runs, fails, and is ignored.
//
// HOW IT WAS FOUND, AND WHAT MADE THE DIFFERENCE
//   Reading `cancel()` was not enough — the guard structure ahead of it is genuinely intricate, and the first guess
//   (the `pending && !pending.started` early return) was wrong. Instrumenting a temporary copy to print the guard
//   state settled it in one line:
//       [dbg] controller=true pending=true started=true
//       cancel: {"ok":true} calls: []
//   The controller existed, the turn had started, cancel returned success, and the stub's `parkHeldSteers` was never
//   reached. That pointed at the body, not the guards.
//
// WHY THE TEST IS THE RIGHT SHAPE
//   It waits for the turn to start before cancelling, which matters: an earlier attempt called cancel immediately
//   after sendMessage and hit the `!pending.started` early return instead. A test that cancelled too early would
//   pass against the broken code for the wrong reason.
//
// WHAT IS NOT CLAIMED
//   Not that this is the only emptied block: no search for other `MUTATED` markers was done this round. Not that
//   `parkHeldSteers` itself behaves correctly — only that it is now called; its wiring to `steers.atBoundary()` in
//   ccb-kernel.cjs was not exercised end to end. Not that the stub-based tests cover real CCB semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL = path.join(ROOT, 'desktop', 'session-kernel.cjs');

test('the hand-back branch has a body, not a comment describing its absence', () => {
  const source = fs.readFileSync(KERNEL, 'utf8');
  const at = source.indexOf('if (backend && keepHeldInput) {');
  assert.ok(at >= 0, 'the keepHeldInput branch is gone entirely');

  // The window must exceed the explanatory comment above the call — it is ~700 characters, and an earlier 700-char
  // slice stopped one character short, so the assertion failed against a file that was correct. Slicing to the next
  // branch (which is known to follow) removes the arbitrary bound.
  const nextBranch = source.indexOf('if (backend && !keepHeldInput) {', at);
  assert.ok(nextBranch > at, 'the discard branch no longer follows the hand-back branch');
  const body = source.slice(at, nextBranch);

  // Match the CALL, not the identifier: `parkHeldSteers` also appears in the comment explaining the fix.
  assert.match(body, /backend\.parkHeldSteers\?\.\(sessionId\)/,
    'the branch no longer calls parkHeldSteers');
  assert.equal(/MUTATED: held inputs are no longer handed back/.test(source.replace(/\/\/.*$/gm, '')),
    false, 'the mutation marker is back as live code: the call has been removed again');
});

test('the discard branch is still separate and still guards on !keepHeldInput', () => {
  const source = fs.readFileSync(KERNEL, 'utf8');
  assert.match(source, /if \(backend && !keepHeldInput\) \{/,
    'the rewind/discard branch changed shape');
  // Both branches must exist: restoring hand-back must not have swallowed the discard path.
  const park = source.indexOf('if (backend && keepHeldInput) {');
  const discard = source.indexOf('if (backend && !keepHeldInput) {');
  assert.ok(park >= 0 && discard > park, 'the two branches are no longer distinct and ordered');
});

test('the hand-back is wrapped so a throwing backend cannot abort the cancel', () => {
  // parkHeldSteers is optional and may throw; if it did, `controller.abort()` below would never run and the turn
  // would stay alive. The try/catch is what makes restoring the call safe.
  const source = fs.readFileSync(KERNEL, 'utf8');
  const at = source.indexOf('if (backend && keepHeldInput) {');
  const nextBranch = source.indexOf('if (backend && !keepHeldInput) {', at);
  const body = source.slice(at, nextBranch);
  assert.match(body, /try\s*\{[\s\S]*parkHeldSteers[\s\S]*\}\s*catch/,
    'the hand-back is not guarded: a throwing backend would leave the turn running');
});

test('the reason the omission survived is recorded', () => {
  const source = fs.readFileSync(KERNEL, 'utf8');
  assert.match(source, /A comment that describes an omission is not the omission being tracked/,
    'the lesson is not recorded at the site');
  assert.match(source, /had been failing on every run and was not being read/,
    'the fact that the failing test was ignored is not recorded');
});

test('the two tests that were red are green', async () => {
  // Pinned directly rather than by trusting the suite: these are the assertions that were failing, and they are
  // cheap here because they build their own stub backend.
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npm', ['test', '--', 'test/cancel-discard-scope-r385.test.mjs',
    'test/cancel-purpose-r385.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, shell: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 0, 'the previously failing cancel tests are still failing:\n' + out.slice(-1500));
  assert.equal(/✖/.test(out), false, 'a test in those files is still marked failing');
});
