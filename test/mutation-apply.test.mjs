// The mutation helper refuses ambiguity instead of silently mutating everything.
//
// WHY. `original.split(find).join(replace)` replaces EVERY occurrence. When the same statement
// appears in several functions, mutating all of them can cancel out and the suite stays green —
// which reads as 'the test does not cover this' when the mutation was never real.
//
// MEASURED on desktop/session-kernel.cjs:
//   'transcripts.delete(sessionId);'  -> 1 match   (unique, safe to mutate)
//   'running.delete(sessionId)'       -> 3 matches (ambiguous, must be refused)
//
// And through the helper:
//   unique anchor      -> { applied: true, matches: 1 }
//   ambiguous anchor   -> { applied: false, reason: 'anchor is ambiguous (3 matches); pass occurrence' }
//   occurrence: 2      -> { applied: true, matches: 3 }   and the remaining count drops 3 -> 2
//   missing anchor     -> { applied: false, reason: 'anchor not found', matches: 0 }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = await import(pathToFileURL(path.join(ROOT, 'tools', 'mutation-apply.mjs')).href);

/** A throwaway file with the given content. */
function tempFile(content) {
  const file = path.join(os.tmpdir(), 'dsh-mut-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('a unique anchor is applied', () => {
  const file = tempFile('alpha beta gamma');
  try {
    const result = helper.applyMutation({ file, find: 'beta', replace: 'BETA' });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(result.matches, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'alpha BETA gamma');
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});

test('an ambiguous anchor is refused, not applied everywhere', () => {
  // This is the exact failure that produced a false 'mutation survived' reading.
  const file = tempFile('x.delete(1); x.delete(2); x.delete(3);');
  try {
    const result = helper.applyMutation({ file, find: 'x.delete(', replace: 'void (' });
    assert.equal(result.applied, false, 'an ambiguous anchor was mutated');
    assert.equal(result.matches, 3);
    assert.match(String(result.reason), /ambiguous/, 'the refusal does not explain itself: ' + result.reason);
    // The file must be untouched.
    assert.equal(fs.readFileSync(file, 'utf8'), 'x.delete(1); x.delete(2); x.delete(3);');
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});

test('an explicit occurrence mutates only that one', () => {
  const file = tempFile('a a a');
  try {
    const result = helper.applyMutation({ file, find: 'a', replace: 'b', occurrence: 2 });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(file, 'utf8'), 'a b a', 'the wrong occurrence was changed');
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});

test('a missing anchor is refused', () => {
  const file = tempFile('nothing to see');
  try {
    const result = helper.applyMutation({ file, find: 'absent', replace: 'x' });
    assert.equal(result.applied, false);
    assert.equal(result.matches, 0);
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});

test('a no-op replacement is refused rather than reported as applied', () => {
  // Otherwise a 'survived' mutation could be a mutation that never changed anything.
  const file = tempFile('same text');
  try {
    const result = helper.applyMutation({ file, find: 'same', replace: 'same' });
    assert.equal(result.applied, false, 'a no-op was reported as applied');
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});

test('snapshot and restore put the file back exactly', () => {
  const file = tempFile('original content here');
  try {
    const snap = helper.snapshot(file);
    helper.applyMutation({ file, find: 'original', replace: 'mutated' });
    helper.restore(file, snap);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original content here');
  } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
});
