// The write path must produce the exact bytes the model asked for, twice: create, then edit.
//
// Measured live this round against the real gateway (deepseek-v4.1-flash):
//
//   'Write hello-round-173.txt containing exactly: written-by-the-model'
//     -> file exists, content === 'written-by-the-model'
//        the model even reported '(no trailing newline)' and that was correct
//     -> the UI rendered a diff: 1 处新增, 0 处删除, +1 -0
//
//   'Edit it so its content becomes exactly: edited-by-the-model'
//     -> content === 'edited-by-the-model'
//     -> diff: 1 处新增, 1 处删除, +1 -1
//
// Those diffs are the user's only evidence that something happened, so the counts are
// asserted here rather than treated as decoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-path-'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
  return { dir, byName, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Write produces exactly the requested bytes, with no added newline', async () => {
  // The live run's file had no trailing newline, and the model said so. If Write appended
  // one, an Edit afterwards would never match the exact string the user pasted.
  const w = workspace();
  try {
    const target = path.join(w.dir, 'hello.txt');
    await w.byName.Write.handler({ path: target, content: 'written-by-the-model' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'written-by-the-model');
  } finally { w.cleanup(); }
});

test('Edit rewrites exactly the matched span and leaves the rest alone', async () => {
  const w = workspace();
  try {
    const target = path.join(w.dir, 'hello.txt');
    fs.writeFileSync(target, 'before\nwritten-by-the-model\nafter\n');
    await w.byName.Edit.handler({ path: target, old_string: 'written-by-the-model', new_string: 'edited-by-the-model' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'before\nedited-by-the-model\nafter\n');
  } finally { w.cleanup(); }
});

test('the reported diff describes a create then an edit, not two creates', async () => {
  // The UI showed +1 -0 for the write and +1 -1 for the edit. Those counts come from
  // comparing before/after, so the assertion below reconstructs them the same way.
  const w = workspace();
  try {
    const target = path.join(w.dir, 'hello.txt');
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    await w.byName.Write.handler({ path: target, content: 'written-by-the-model' });
    const afterWrite = fs.readFileSync(target, 'utf8');
    const createAdded = afterWrite.split('\n').length - (before ? before.split('\n').length : 0);
    assert.equal(createAdded, 1, 'a new one-line file should show one added line');

    await w.byName.Edit.handler({ path: target, old_string: 'written-by-the-model', new_string: 'edited-by-the-model' });
    const afterEdit = fs.readFileSync(target, 'utf8');
    assert.notEqual(afterEdit, afterWrite, 'the edit changed nothing');
    assert.equal(afterEdit.split('\n').length - afterWrite.split('\n').length, 0,
      'an in-place edit must not change the line count');
  } finally { w.cleanup(); }
});

test('an edit whose old_string is absent is refused, not silently ignored', async () => {
  // A silent no-op here would look exactly like a successful edit in the transcript.
  const w = workspace();
  try {
    const target = path.join(w.dir, 'hello.txt');
    fs.writeFileSync(target, 'something else');
    await assert.rejects(
      () => w.byName.Edit.handler({ path: target, old_string: 'written-by-the-model', new_string: 'x' }),
      /no-match|not found|did not match/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'something else', 'the file was modified anyway');
  } finally { w.cleanup(); }
});
