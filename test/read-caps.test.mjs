// Every cap in the file tools announces itself, and the announced fix actually works.
//
// Measured this round:
//
//   one 50,000-character line -> 30,031 bytes returned,
//     ending '… [truncated 20002 characters]'   (the note itself is not cut off)
//
//   5,000-line file -> 2,000 lines plus '… [3000 more lines; pass offset to continue]'
//
//   and the advice is true: offsets 0 / 2000 / 4000 returned 2000 + 2000 + 1000 lines,
//   L1..L2000, L2001..L4000, L4001..L5000 — 5000 unique lines, no overlap, no gap.
//
// That last part is what rounds 210 and 211 taught: a notice that tells the caller to do
// something is only useful if doing it works. A cap that says "pass offset to continue"
// while offset is ignored is worse than a silent cap, because it looks handled.
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

function toolsFor(dir) {
  return Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
}

/** Lines of the form "<n>\t<text>", as the numbered reader emits them. */
function numberedLines(content) {
  return String(content || '')
    .split('\n')
    .filter((line) => /^\d+\t/.test(line))
    .map((line) => line.split('\t')[1]);
}

test('an over-long line is truncated but keeps its complete note', async () => {
  // If the note were appended before the cap, it would be cut off by the very truncation it
  // describes — the caller would see 30 KB of x and no explanation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-read-'));
  try {
    fs.writeFileSync(path.join(dir, 'long.txt'), 'x'.repeat(50000));
    const content = String((await toolsFor(dir).Read.handler({ path: 'long.txt' })).content || '');
    assert.match(content, /\[truncated \d+ characters\]/, 'the truncation note was lost');
    assert.ok(content.length <= 30100, 'the output was not capped: ' + content.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a long file reports the remaining lines and how to get them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-lines-'));
  try {
    fs.writeFileSync(path.join(dir, 'many.txt'), Array.from({ length: 5000 }, (_, i) => 'L' + (i + 1)).join('\n'));
    const content = String((await toolsFor(dir).Read.handler({ path: 'many.txt' })).content || '');
    assert.match(content, /\[\d+ more lines; pass offset to continue\]/, 'no continuation hint');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the advertised offset paging actually covers the file', async () => {
  // The advice must be true. Paging that skips or repeats lines is a data-loss bug that the
  // notice actively encourages the caller to walk into.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-paging-'));
  try {
    const total = 5000;
    fs.writeFileSync(path.join(dir, 'many.txt'), Array.from({ length: total }, (_, i) => 'L' + (i + 1)).join('\n'));
    const tools = toolsFor(dir);
    const pages = [];
    for (const offset of [0, 2000, 4000]) {
      pages.push(numberedLines((await tools.Read.handler({ path: 'many.txt', offset })).content));
    }
    assert.deepEqual(pages.map((page) => page.length), [2000, 2000, 1000], 'page sizes are wrong');
    assert.equal(pages[0][0], 'L1', 'the first page does not start at line 1');
    assert.equal(pages[0][1999], 'L2000');
    assert.equal(pages[1][0], 'L2001', 'page 2 does not continue where page 1 stopped');
    assert.equal(pages[2][0], 'L4001');
    assert.equal(pages[2][999], 'L' + total, 'the last line was never reached');
    const covered = new Set([...pages[0], ...pages[1], ...pages[2]]);
    assert.equal(covered.size, total, 'paging did not cover every line exactly once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('character-budget pages expose the next unread line without gaps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-wide-'));
  try {
    const lines = Array.from({ length: 90 }, (_, i) => `L${i + 1}:${'x'.repeat(1000)}`);
    fs.writeFileSync(path.join(dir, 'wide.txt'), lines.join('\n'));
    const read = toolsFor(dir).Read;
    const collected = [];
    let offset = 0;
    do {
      const page = await read.handler({ path: 'wide.txt', offset });
      const rows = numberedLines(page.content);
      assert.equal(page.returnedLines, rows.length);
      collected.push(...rows);
      if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (offset !== null && offset !== undefined);
    assert.deepEqual(collected, lines);
    for (const input of [{offset: -1}, {offset: 1.5}, {limit: 0}, {limit: -1}]) {
      await assert.rejects(read.handler({ path: 'wide.txt', ...input }), /integer/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reading past the end returns nothing rather than repeating', async () => {
  // A caller that trusts the hint may overshoot; it must not get duplicate content back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-past-'));
  try {
    fs.writeFileSync(path.join(dir, 'small.txt'), 'a\nb\nc');
    const content = String((await toolsFor(dir).Read.handler({ path: 'small.txt', offset: 100 })).content || '');
    assert.equal(numberedLines(content).length, 0, 'an out-of-range offset returned content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
