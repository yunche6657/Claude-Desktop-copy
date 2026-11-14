// R624: the check found no falsified claim. The closest candidate — R591's "38" against the tool's 41 — was already disclaimed by
// its own author one paragraph below the number.
//
// THE CHECK
//   Six tools re-run; 45 evidence lines naming a tool and a number compared against live output. Fifteen agreed. Thirty did not, and
//   reading them showed the comparison was wrong every time:
//
//       emit-flag-ratio-r604.md:11    `clear-asymmetry | 1 | 1` — the "0" read is a different column
//       sort-census-r613.md:10        `6 组 / 32 文件` — 32 is a FILE count
//       sort-totality-r611.md:18      `31 组` — a tie count, not the map count
//       position-index-r616.md:42     `55 里 49 是...` — a position count, not a tool output
//
//   Proximity again. R620 reached the same conclusion about function names; this is the third round where the probe was the error.
//
// THE ONE REAL CANDIDATE, AND WHY IT IS NOT AN ERROR
//   `set-lifetimes-r591.md:5` states 38; the tool now reports 41 (R596 widened the comma-declaration match). But line 41 of the SAME
//   document says: 不声称 38 是稳定的 —— 计数随文件增删而变，记录是工具本身.
//
//   The author declared the number a snapshot and named the tool as the authority, in the document carrying the number. Nothing is
//   falsified — the reader is told which artefact to trust.
//
// THE RESIDUAL GAP, PRECISELY
//   The caveat says the count MOVES; it does not say it HAS MOVED. A reader wanting the current figure must re-run the tool. That is
//   the right division of labour for a record that cannot run code, and it is why R623's 71% is a standing property, not a debt.
//
// WHAT IS NOT CLAIMED
//   Not that every published number survives this well: one of 45 had a disclaimer, found only because the number was checked. The
//   other 44 agreeing proves they were recomputed at some point, not that a disclaimer exists.
//   Not that proximity can be rescued: three rounds tried, and each misread a table column, a file count, or a tie count as a row
//   count.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECK, DISCLAIMED } from '../desktop/disclaimed-numbers.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('set-lifetimes really reports 41 now, not 38', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'set-lifetimes.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(0, 300));
  const d = JSON.parse(r.stdout);
  assert.equal(d.rows.length, DISCLAIMED.toolNow, `the tool reports ${d.rows.length}, record says ${DISCLAIMED.toolNow}`);
});

test('the disclaimer is still in the same document as the number', () => {
  const src = fs.readFileSync(path.join(ROOT, 'evidence', 'set-lifetimes-r591.md'), 'utf8');
  assert.ok(src.includes('38 个'), 'the 38 figure is gone from the document');
  assert.ok(src.includes('不声称 38 是稳定的'), 'the disclaimer was removed');
  assert.ok(src.includes('记录是工具本身'), 'the authority statement was removed');
});

test('the four probe-error examples are recorded with their real kind', () => {
  assert.equal(CHECK.examples.length, 4);
  for (const e of CHECK.examples) {
    assert.ok(e.includes('.md:'), `${e} is not a file:line reference`);
    assert.match(e, /column|file count|tie count|position count/, `${e} does not name what was misread`);
  }
});

test('the check arithmetic is consistent', () => {
  assert.equal(CHECK.agreed + CHECK.disagreed, CHECK.linesExamined);
  assert.equal(CHECK.disagreementsAreProbeErrors, CHECK.disagreed);
  assert.equal(CHECK.toolsRerun, 6);
});

test('the verdict is "not falsified", with the reason', () => {
  assert.match(DISCLAIMED.verdict, /not falsified/, 'the verdict is not stated');
  assert.match(DISCLAIMED.verdict, /named the tool as the authority/, 'the reason is not stated');
  assert.match(DISCLAIMED.residualGap, /HAS moved/, 'the residual gap is not distinguished from the disclaimer');
});

test('the record does not overclaim the other 44', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'disclaimed-numbers.cjs'), 'utf8');
  assert.match(src, /Not that every published number survives this well/, 'the sample limit is missing');
  assert.match(src, /Not that proximity can be rescued/, 'the probe limit is missing');
});
