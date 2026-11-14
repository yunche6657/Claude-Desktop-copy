// R518: the banner-ordering hypothesis from R517 was correct, and fixing it broke the first-apply path — which
// only a second probe caught.
//
// THE HYPOTHESIS, AND THE MEASUREMENT
//   R517 closed by noting that `apply()` matched existing banners with a non-greedy `[\s\S]*?\n\n` — the same shape
//   that had already produced two false readings in this session. Tested with a file carrying two banners (r100,
//   r200) and a third correction (r300) applied:
//       offsets: 0 superseded-r100 | 26 superseded-r300 | 160 superseded-r200
//       order above the title: ['100', '300', '200']
//   The new banner landed BETWEEN the two existing ones. Non-greedy matching stops at the first banner's trailing
//   blank line, so `head` held only r100, `rest` began at r200, and r300 was spliced into the gap. Confirmed, not
//   theorised.
//
// THE FIX, AND THE REGRESSION IT CAUSED
//   Anchoring `head` on the title — the rule R513 arrived at for the body check after the identical failure — put
//   the banners in order: ['100', '200', '300'].
//
//   But the first version of that fix used `indexOf('\n# ')`, which returns -1 when the title is on LINE 1 with no
//   preceding newline. A brand-new evidence file has exactly that shape. The probe on a bare file reported:
//       exit: 1, "0 banner(s) applied", marker offset: -1
//   So the fix had broken the most common case while repairing the rarer one. A second, simpler fix — accepting
//   either shape — was needed, and `slice(0, idx + 1)` with idx 0 then ate the `#`, so a third idiom was wrong too.
//
//   What finally holds: `splitAtTitle()`, which returns `{ head, rest }`, handles line-1 titles, and is used by
//   BOTH writers. One helper removes the chance of them disagreeing about where the banner block ends, which is
//   the class of bug this file has now produced three times (R513 comparison, R517 title requirement, R518 order).
//
// TWO PROBES WERE NECESSARY
//   The ordering probe passed after the fix. Only the first-apply probe — a separate scenario, written because the
//   ordering probe could not reach that path — exposed the regression. A single happy-path test would have recorded
//   this round as a clean fix.
//
// WHAT IS NOT CLAIMED
//   Not that every ordering case is covered: addenda interleaved among banners, banners already out of order, and
//   CRLF line endings are all untested. The helper makes those *less* likely, it does not prove them handled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVID = path.join(ROOT, 'evidence');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrections-r518-'));
const SCRATCH = 'zz-scratch-r518-test.md';
const scratchPath = path.join(EVID, SCRATCH);

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
}

function registry(name, data) {
  const p = path.join(tmpdir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

/** Rounds of the superseded markers above the title, in file order. */
function bannerOrder(text) {
  const split = splitTitle(text);
  return [...split.head.matchAll(/<!-- superseded-r(\d+) -->/g)].map((m) => Number(m[1]));
}

function splitTitle(text) {
  if (text.startsWith('# ')) return { head: '', rest: text };
  const idx = text.indexOf('\n# ');
  return { head: text.slice(0, idx + 1), rest: text.slice(idx + 1) };
}

test.after(() => {
  fs.rmSync(scratchPath, { force: true });
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('a third banner is appended after the existing two, not between them', () => {
  const initial = [
    '<!-- superseded-r100 -->', '', '> 第一条。', '',
    '<!-- superseded-r200 -->', '', '> 第二条。', '',
    '# 标题', '', '正文。', '',
  ].join('\n');
  fs.writeFileSync(scratchPath, initial, 'utf8');

  const reg = registry('order', {
    corrections: [
      { file: SCRATCH, round: 100, kind: 'scope', summary: 's1', detail: 'd1' },
      { file: SCRATCH, round: 200, kind: 'scope', summary: 's2', detail: 'd2' },
      { file: SCRATCH, round: 300, kind: 'scope', summary: 's3', detail: 'd3' },
    ],
    addenda: [],
  });

  const w = run(['--write', '--registry', reg]);
  assert.equal(w.status, 0, 'write failed:\n' + (w.stdout || '') + (w.stderr || ''));

  const order = bannerOrder(fs.readFileSync(scratchPath, 'utf8'));
  assert.deepEqual(order, [100, 200, 300],
    'the new banner was not appended at the end: order is ' + JSON.stringify(order));
  // And it must be above the title, or it is not in the banner block at all.
  const text = fs.readFileSync(scratchPath, 'utf8');
  assert.ok(text.indexOf('<!-- superseded-r300 -->') < text.indexOf('\n# '),
    'the appended banner is below the title');
});

test('the body is untouched when a banner is appended to an existing block', () => {
  const text = fs.readFileSync(scratchPath, 'utf8');
  const split = splitTitle(text);
  assert.match(split.rest, /^# 标题/, 'the title is gone');
  assert.match(split.rest, /正文。/, 'the body is gone');
  // Every existing banner must still be present.
  for (const r of [100, 200, 300]) {
    assert.ok(text.includes(`<!-- superseded-r${r} -->`), `r${r} banner was lost`);
  }
});

test('a title on line 1 is accepted, not rejected', () => {
  // The regression the first fix introduced: `indexOf('\n# ')` returns -1 for a file starting with `# `.
  const bare = '# 标题\n\n正文第一段。\n';
  fs.writeFileSync(scratchPath, bare, 'utf8');

  const reg = registry('first', {
    corrections: [{ file: SCRATCH, round: 400, kind: 'scope', summary: 's', detail: 'd' }],
    addenda: [],
  });

  const w = run(['--write', '--registry', reg]);
  assert.equal(w.status, 0, 'a line-1 title was rejected:\n' + (w.stdout || '') + (w.stderr || ''));
  assert.match(w.stdout, /annotated:.*r400/, 'no banner was applied');

  const after = fs.readFileSync(scratchPath, 'utf8');
  assert.ok(after.startsWith('<!-- superseded-r400 -->'),
    'the banner did not land at the very top');
  assert.ok(after.indexOf('<!-- superseded-r400 -->') < after.indexOf('\n# '),
    'the banner landed below the title');
  // The '# ' prefix must survive: slicing one character too far ate it in an earlier attempt.
  assert.match(after, /\n# 标题/, 'the title marker was consumed');
  assert.ok(after.endsWith(bare.slice(1)), 'the body after the title changed');
});

test('both writers share one title splitter', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /function splitAtTitle\(text\)/, 'the shared helper is gone');
  // Both call sites must use it; neither may re-implement the offset arithmetic.
  const applyBody = source.slice(source.indexOf('function apply(entry)'),
    source.indexOf('function applyAddendum'));
  const addBody = source.slice(source.indexOf('function applyAddendum'));
  assert.match(applyBody, /splitAtTitle\(original\)/, 'apply() does not use the shared helper');
  assert.match(addBody, /splitAtTitle\(original\)/, 'applyAddendum() does not use the shared helper');
  assert.equal(/original\.indexOf\('\\n# '\)/.test(applyBody), false,
    'apply() re-implements the title lookup');
  assert.equal(/original\.indexOf\('\\n# '\)/.test(addBody), false,
    'applyAddendum() re-implements the title lookup');
});

test('the non-greedy banner match is gone', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  // Check CODE only: the comment deliberately quotes the old line to explain what was wrong, and a whole-file
  // scan matches that quotation. The first version of this test did scan the whole file and failed against its
  // own documentation — a detector reading the explanation as the thing it describes.
  const code = source.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  assert.equal(/\[\\s\\S\]\*\?\\n\\n\)\+/.test(code), false,
    'the non-greedy banner block match survives in executable code');
  assert.match(source, /THE SAME BUG AS R513/,
    'the tool no longer records that this was a repeat');
});

test('the real registry is unaffected', () => {
  const c = run(['--check']);
  assert.equal(c.status, 0, 'the real registry fails:\n' + (c.stdout || '') + (c.stderr || ''));
});
