// R486: the topic index was measured against a literal grep, and two real defects fell out.
//
// WHY THIS ROUND EXISTS
//   R485 built the index and reported plausible counts. Plausible is not useful: nobody had asked it a
//   question and checked the answer. A classifier nobody has validated is exactly the artifact this project
//   has learned not to trust.
//
// THE METHOD — two independent paths
//   For each question, the ground truth is computed by a LITERAL regex over the raw HANDOFF and evidence
//   text, with no vocabulary and no scoring. The index's answer is read by parsing the rendered markdown
//   the way a reader would. The two paths share no code, so the measurement cannot be circular.
//
// THE FIRST MEASUREMENT: 5 of 6 questions at 100%, one at 27%
//   The 27% was "which round dealt with treeSha256?" — 83 rounds mention it, the index surfaced 22. That
//   number turned out to be two separate defects wearing one costume.
//
// DEFECT 1: sorting by recency instead of strength
//   The table was sorted newest-first with title hits as a mere tiebreak, so round 485 (body score 3)
//   outranked round 462 (body score 11). With a 40-row cap in place, the strongest matches fell off the
//   bottom. Fixed to: title hit, then body score, then round number descending as a stable tiebreak.
//   Measured effect: round 397 moved from position 23 to position 1.
//
// DEFECT 2: the index truncated at 40 rows
//   Even with correct ordering, "…另有 43 个未列出" made the question unanswerable for a broad topic.
//   Removing the cap took the file from 68 KB to 91 KB and recall from 65% to 96%, precision to 80%.
//   A row costs ~80 bytes; completeness is worth more than brevity in an index whose purpose is finding.
//
// A CALIBRATION MISTAKE INSIDE THE FIX
//   Adding a "distinctive pattern counts on one hit" exemption — needed because rounds that mention
//   treeSha256 exactly once were failing the two-pattern rule — pushed the agent-core topic from 42 to 100
//   of 125 handoffs. Breakdown: 58 of those were admitted solely by a single treeSha256 hit.
//   That is not a regression, it is the correct trade: the question "which rounds mention this identifier?"
//   genuinely has 80 answers. But it has to be stated, not hidden, so the index says broad topics are broad.
//   `\bpin(ned)?\b` was first included in the exemption and immediately showed why not every specific-looking
//   token qualifies — "pin" is an ordinary verb in unrelated prose (pin a dependency, pin a window).
//
// A STALE ASSUMPTION THAT ANNOUNCED ITSELF
//   After removing the cap, mean recall read 117%. Recalled exceeded the denominator because the harness
//   still divided by min(truth, 40) — a cap that no longer existed. The formula now divides by the full
//   truth set, and the over-100% result is retained in this note as the reason to check denominators.
// DEFECT 3: the `notif` ground truth was too loose, and a correct round was scored as a miss
//   `ground: /通知权限|desktop-notification-permission-banner|横幅/i` treats the bare word 横幅 as evidence that a
//   round is about the notification-permission banner. R536 discusses a CORRECTIONS banner — an unrelated use of the
//   same word — so it entered the truth set, was correctly not indexed under `notifications`, and the question read
//   4/5.
//
//   The failure direction matters: the index was right and the MEASURE was wrong. Loosening the index to admit that
//   round would have made the number pass while making retrieval worse, which is the calibration mistake this file's
//   own note already documents. So the ground truth is what changed: the notification banner is named by its compound
//   forms, and 横幅 alone no longer counts.
//
//   Verified before changing: the round set for `notif` was [378,477,478,484,536]; 536 is the false member, and the
//   other four are unchanged by the tighter pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECALL = path.join(ROOT, 'tools', 'index-recall.cjs');
const INDEXER = path.join(ROOT, 'tools', 'topic-index.cjs');
const INDEX = path.join(ROOT, 'evidence', 'TOPIC-INDEX.md');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const runRecall = () => spawnSync(process.execPath, [RECALL], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});

test('the index answers all six retrieval questions at high recall', () => {
  const result = runRecall();
  assert.equal(result.status, 0, 'the recall harness failed:\n' + (result.stderr || '').slice(0, 800));

  const out = result.stdout;
  // Parse per-question recall lines: "recalled:  N/M achievable (X%)"
  const recalls = [...out.matchAll(/recalled:\s+(\d+)\/(\d+) achievable \((\d+)%\)/g)]
    .map((m) => ({ got: Number(m[1]), of: Number(m[2]), pct: Number(m[3]) }));
  assert.ok(recalls.length >= 6, `expected 6 measured questions, found ${recalls.length}`);

  for (const r of recalls) {
    assert.ok(r.got <= r.of,
      `recalled ${r.got} exceeds the achievable ${r.of}: the denominator is stale again`);
    assert.ok(r.pct >= 90,
      `a question recalled only ${r.pct}% (${r.got}/${r.of}) — the index points a reader past the answer`);
  }
});

test('the measure can never exceed 100 percent', () => {
  // The 117% reading is the reason this assertion exists: a percentage above 100 means the harness is
  // dividing by something smaller than what it counted.
  const result = runRecall();
  const pcts = [...result.stdout.matchAll(/\((\d+)%\)/g)].map((m) => Number(m[1]));
  for (const p of pcts) {
    assert.ok(p <= 100, `a recall figure of ${p}% is impossible; the denominator is wrong`);
  }
});

test('the index is not truncated, so a broad topic is fully answerable', () => {
  // Defect 2. The generated index must not contain a "…另有 N 个未列出" row.
  const text = read(INDEX);
  assert.ok(!/另有 \d+ 个未列出/.test(text),
    'the index truncates again: a genuine answer can sit behind a summary line');

  // The agent-core section must list every round its own report says it matched.
  const start = text.indexOf('<a id="agent-core"></a>');
  assert.ok(start > 0, 'the agent-core section is missing');
  const rest = text.slice(start);
  const section = rest.slice(0, rest.indexOf('\n## ', 1));
  const listed = (section.match(/\| 第\d+轮 \|/g) || []).length;
  assert.ok(listed >= 80,
    `the agent-core section lists only ${listed} rounds; a truncated table was the retrieval defect`);
});

test('rounds are ranked by match strength, not by recency', () => {
  // Defect 1. Within a section, body scores must be non-increasing after title hits are exhausted.
  const text = read(INDEX);
  const start = text.indexOf('<a id="agent-core"></a>');
  const rest = text.slice(start);
  const section = rest.slice(0, rest.indexOf('\n## ', 1));

  const rows = [...section.matchAll(/\| 第(\d+)轮 \| \[[^\]]+\]\([^)]+\) \| ([^|]*) \| (\d+) \|/g)]
    .map((m) => ({ title: m[2].trim() === '是', body: Number(m[3]) }));
  assert.ok(rows.length > 10, `expected many rows, found ${rows.length}`);

  const titleRows = rows.filter((r) => r.title).length;
  // All title-hit rows must come first.
  const firstNonTitle = rows.findIndex((r) => !r.title);
  if (firstNonTitle >= 0) {
    assert.ok(rows.slice(firstNonTitle).every((r) => !r.title),
      'a title-hit row appears after a non-title row: title hits are no longer prioritised');
    assert.equal(firstNonTitle, titleRows, 'title-hit rows are not contiguous at the top');
  }

  // Body scores among the non-title rows must be non-increasing.
  const bodies = rows.slice(titleRows).map((r) => r.body);
  for (let i = 1; i < bodies.length; i += 1) {
    assert.ok(bodies[i] <= bodies[i - 1],
      `body score rose from ${bodies[i - 1]} to ${bodies[i]} at row ${i}: sorting by strength is broken`);
  }
});

test('a distinctive identifier qualifies on a single hit, an ordinary word does not', () => {
  const source = read(INDEXER);

  // The exemption list exists and contains the identifiers that forced it.
  assert.match(source, /DISTINCTIVE_PATTERNS/, 'the distinctive-pattern list is gone');
  assert.match(source, /treeSha256/, 'treeSha256 is no longer treated as distinctive');
  assert.match(source, /checkTrust/, 'checkTrust is no longer treated as distinctive');

  // And the exclusion list, which is what `pin` taught.
  assert.match(source, /NOT_DISTINCTIVE/, 'the exclusion list is gone: ordinary words can be exempted again');
  assert.match(source, /\\bpin\(ned\)\?\\b/, 'pin is no longer excluded, so 100/125 over-matching can return');

  // The two-pattern rule still governs everything else.
  assert.match(source, /matchedInBody >= 2/, 'the two-pattern rule is gone');
  assert.match(source, /distinctiveHit > 0/, 'the distinctive exemption is not wired into qualification');
});

test('the ground truth is computed without the index vocabulary', () => {
  // If the harness reused the indexer's scoring, the measurement would be circular and always pass.
  // Ground truth must be a plain regex over raw text.
  const source = read(RECALL);
  assert.match(source, /function groundTruth\(/, 'the ground-truth function is gone');
  // It must not import the indexer.
  assert.ok(!/require\(['"].*topic-index/.test(source),
    'the recall harness imports the indexer: the measurement is circular');
  assert.ok(!/import .*topic-index/.test(source),
    'the recall harness imports the indexer: the measurement is circular');
  // Reading the index must go through the rendered markdown, not the scoring functions.
  assert.match(source, /TOPIC-INDEX\.md/, 'the harness does not read the rendered index');
});
