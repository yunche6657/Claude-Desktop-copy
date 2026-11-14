// The Glob tool is the correct way to count files here — and it works.
//
// Measured live this round against the real gateway (deepseek-v4.1-flash):
//
//   prompt: 'Use ONLY the Glob tool (not Bash) to list test/*.test.mjs, count them, tell me'
//   result: 0 approval cards, answer '168 files match test/*.test.mjs'
//   ground truth: fs.readdirSync('test').filter(f => f.endsWith('.test.mjs')).length === 168
//   and our own Glob tool returns 168 entries for the same pattern
//
// The two rounds before this established the contrast:
//   round 174: model chose Bash `ls | wc -l`  -> refused (pipe), retried forever
//   round 175: it then tried `find` -> silently exit 2, retried forever
//   round 176: told to use Glob -> one tool call, correct answer, no prompt
//
// So the failure was never the model's arithmetic; it was that the reliable path looked
// less familiar than the unreliable one. These assertions pin the reliable path.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-count-'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
  return { dir, byName, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Glob returns one entry per matching file, so its length is a correct count', async () => {
  const w = workspace();
  try {
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(w.dir, 'a' + i + '.test.mjs'), '');
    fs.writeFileSync(path.join(w.dir, 'ignore.txt'), '');
    const r = await w.byName.Glob.handler({ pattern: '*.test.mjs' });
    const entries = String(r.content || '').split('\n').filter(Boolean);
    assert.equal(entries.length, 7, 'the entry count is not the match count');
  } finally { w.cleanup(); }
});

test('the live count and our Glob agree on this repository', async () => {
  // If these ever diverge, the model's answer would be right while the tool is wrong (or the
  // reverse), and the discrepancy would be invisible in the transcript.
  const onDisk = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
  );
  // max_results is explicit: the default is 200 and this repository already exceeds it. The
  // default cap is covered separately below; this assertion is about matching, not printing.
  const entries = [];
  let offset = 0;
  do {
    const r = await byName.Glob.handler({ pattern: 'test/*.test.mjs', max_results: onDisk.length + 50, offset });
    assert.equal(r.totalMatches, onDisk.length);
    assert.equal(r.walkTruncated, false);
    entries.push(...String(r.content || '').split('\n').filter(line => line && !line.startsWith('…')));
    assert.equal(r.returnedCount, entries.length - offset);
    offset = r.nextOffset;
  } while (offset !== null);
  assert.equal(entries.length, onDisk.length, 'Glob and the filesystem disagree about the file count');
  assert.equal(new Set(entries).size, entries.length);
  for (const file of onDisk) {
    assert.ok(entries.includes('test/' + file), file + ' was not reported by Glob');
  }
});

test('character-limited pages preserve full paths and enumerate every match exactly once', async () => {
  const w = workspace();
  try {
    const expected = [];
    for (let i = 0; i < 180; i++) {
      const name = `${String(i).padStart(3, '0')}-${'x'.repeat(180)}.txt`;
      fs.writeFileSync(path.join(w.dir, name), '');
      expected.push(name);
    }
    const found = [];
    let offset = 0, pages = 0;
    do {
      const r = await w.byName.Glob.handler({ pattern: '*.txt', max_results: 1000, offset });
      const paths = r.content.split('\n').filter(line => !line.startsWith('…'));
      assert.equal(r.totalMatches, expected.length);
      assert.equal(r.returnedCount, paths.length);
      assert.ok(paths.every(file => expected.includes(file)), 'a returned path was truncated');
      found.push(...paths);
      if (r.nextOffset !== null) assert.ok(r.nextOffset > offset);
      offset = r.nextOffset;
      pages++;
    } while (offset !== null);
    assert.ok(pages > 1);
    assert.deepEqual(found.sort(), expected.sort());
    const end = await w.byName.Glob.handler({ pattern: '*.txt', offset: 1000 });
    assert.equal(end.returnedCount, 0);
    assert.equal(end.nextOffset, null);
    for (const input of [{max_results: -1}, {max_results: 0}, {offset: -1}, {offset: 1.5}]) {
      await assert.rejects(w.byName.Glob.handler({ pattern: '*.txt', ...input }), /positive integer/);
    }
  } finally { w.cleanup(); }
});

test('a depth-limited branch still allows Glob to find shallow siblings', async () => {
  const w = workspace();
  try {
    const deep = path.join(w.dir, 'a', ...Array(14).fill('d'));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'hidden.txt'), '');
    fs.writeFileSync(path.join(w.dir, 'visible.txt'), '');
    const result = await w.byName.Glob.handler({ pattern: '*.txt' });
    assert.equal(result.walkTruncated, true);
    assert.equal(result.totalMatches, 1);
    assert.match(result.content, /^visible\.txt\n/);
    assert.match(result.content, /incomplete/);
    const absent = await w.byName.Glob.handler({ pattern: '*.missing' });
    assert.equal(absent.walkTruncated, true);
    assert.match(absent.content, /incomplete/);
  } finally { w.cleanup(); }
});

test('Glob does not need Bash, so it cannot be blocked by the executor', async () => {
  // The whole point: the reliable path has no approval card and no platform-specific binary.
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dir, 'x.test.mjs'), '');
    const r = await w.byName.Glob.handler({ pattern: '*.test.mjs' });
    assert.match(String(r.content || ''), /x\.test\.mjs/);
  } finally { w.cleanup(); }
});
test('a capped result says how many matches were omitted', async () => {
  // Measured: `test/*.test.mjs` matched 201 files and returned 200 silently. The dropped file
  // sorted last, so "does write-path-end-to-end.test.mjs exist?" answered no.
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
  );
  const total = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  assert.ok(total > 5, 'this repository no longer has enough test files for the test');
  const r = await byName.Glob.handler({ pattern: 'test/*.test.mjs', max_results: 5 });
  const text = String(r.content || '');
  assert.match(text, /\[\d+ more matches? not shown/, 'a truncated result hides that it was cut');
  assert.ok(text.includes(String(total - 5)), 'the omitted count is wrong');
});

test('raising max_results returns the files the default cap hides', async () => {
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
  );
  const count = (content) => String(content || '')
    .split('\n')
    .filter((line) => line && !line.startsWith('…'))
    .length;
  const capped = count((await byName.Glob.handler({ pattern: 'test/*.test.mjs' })).content);
  const raisedText = String((await byName.Glob.handler({ pattern: 'test/*.test.mjs', max_results: 5000 })).content || '');
  // Compare ENTRY counts, not byte length: the capped result carries an extra notice line,
  // so it can be longer overall while listing fewer files.
  assert.ok(count(raisedText) > capped, 'raising the cap returned no additional files');
  // A raised entry limit may still require pages under the output character budget.
  assert.equal(/\[truncated \d+ characters\]/.test(raisedText), false, 'Glob cut a path mid-line');
});

test('a complete result carries no omission notice', async () => {
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
  );
  const r = await byName.Glob.handler({ pattern: 'package.json' });
  assert.equal(/more matches? not shown/.test(String(r.content || '')), false,
    'a complete result claims it was truncated');
});
