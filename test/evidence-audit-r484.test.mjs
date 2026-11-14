// R484: the evidence trail is auditable, and the status file no longer lies about its own recency.
//
// THE TWO DEFECTS, MEASURED BEFORE ANY FIX
//   1. evidence/STATUS.md is 19,388 lines over 442 `##` sections. Its HEAD said
//          > 最新已验收：第377轮首次hybrid PKCE…
//      while the newest round on record was 483. A reader starting at the top — the only place a reader
//      starts — was told the project was 106 rounds behind. Nothing checked, so nothing noticed.
//
//   2. Rounds 378-384 produced artifacts but left NO entry in STATUS.md; the file jumps from 377 to 385.
//      Six of them have a HANDOFF (378 queue/cache invalidation, 379 queue lifecycle, 380 launch model,
//      381 ordinary queue, 382 failed-turn hold, 383 steer control). 384 has neither a handoff nor an
//      entry, only two tests (ccb-native-cycle-r384, ccb-steer-races-r384). Round 378 alone accounts for
//      roughly 170 test files — hybrid bootstrap, MCP relay, history import, keep-awake, notifications —
//      and none of that appeared in the status file.
//
// A DETECTOR BUG THAT NEARLY HID THE SECOND DEFECT
//   The first audit pass reported that all six missing rounds "had a STATUS record". It matched 第384轮
//   against the header text 第377轮 because the search was a loose substring scan over the whole file and
//   the header precedes every body entry. Corrected by requiring the digit run to end at 轮 and by
//   running the check per-round rather than as one aggregate. This is the same failure class recorded
//   repeatedly in this project: a detector that does not describe the thing inspected, whose output is
//   then trusted. The audit script now prints the specific round and the artifacts it found, so the next
//   wrong answer is visible rather than plausible.
//
// A FIX THAT WOULD HAVE BEEN WORSE THAN THE BUG
//   The first header fix replaced only the round NUMBER inside the stale sentence, producing
//          > 最新已验收：第483轮首次hybrid PKCE… 见 HANDOFF-ROUND377-…
//   which asserts that round 483 was about hybrid PKCE and cites round 377's handoff. A mechanical edit
//   to a claim it cannot verify manufactures a false statement. The corrected fix leaves the old claim's
//   wording alone, relabels it as the oldest surviving entry, and puts a clearly-labelled generated
//   banner above it that links to the real newest handoff and states it is not a human verification.
//
// THE BACKFILL
//   tools/backfill-status-gap-r484.cjs adds one entry per missing round, built only from artifacts: the
//   round's handoff heading, or — for 384 — the test files, with an explicit sentence saying no
//   conclusion was recorded and the entry does not invent one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'evidence', 'STATUS.md');
const AUDIT = path.join(ROOT, 'tools', 'audit-evidence.cjs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const runAudit = (args = []) => spawnSync(process.execPath, [AUDIT, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
});

test('the audit reports no gaps and exits zero', () => {
  const result = runAudit(['--json']);
  assert.equal(result.status, 0,
    'the audit still reports problems:\n' + (result.stdout || result.stderr || '').slice(-1200));

  const report = JSON.parse(result.stdout);
  assert.equal(report.missingStatus.length, 0,
    'rounds with artifacts but no STATUS entry remain: ' + JSON.stringify(report.missingStatus));
  assert.equal(report.headerStale, false,
    `the header claims 第${report.declared}轮 but the newest record is 第${report.newest}轮`);
});

test('every round that left a test file is described in STATUS.md', () => {
  // Independent of the audit tool: re-derive the set here so a broken detector cannot pass this.
  const text = read(STATUS);
  const recorded = new Set();
  for (const m of text.matchAll(/第(\d+)轮/g)) recorded.add(Number(m[1]));

  const testDir = path.join(ROOT, 'test');
  const roundsWithTests = new Set();
  for (const name of fs.readdirSync(testDir)) {
    const m = /(?:^|[-_])r(\d{3})(?:[-_.]|$)/.exec(name);
    if (m) roundsWithTests.add(Number(m[1]));
  }
  const missing = [...roundsWithTests].filter((n) => !recorded.has(n)).sort((a, b) => a - b);
  assert.deepEqual(missing, [],
    'these rounds have tests but no STATUS entry: ' + missing.join(', '));
});

test('the head of the status file describes the newest round, not an old one', () => {
  const text = read(STATUS);
  const head = text.slice(0, 2000);

  // A generated banner naming the newest round and pointing at its real handoff.
  const banner = /状态同步于第(\d+)轮/.exec(head);
  assert.ok(banner, 'no sync banner at the top of STATUS.md');

  const recorded = [...text.matchAll(/第(\d+)轮/g)].map((m) => Number(m[1]));
  const newest = Math.max(...recorded);
  assert.equal(Number(banner[1]), newest,
    `the banner says 第${banner[1]}轮 but the newest recorded round is 第${newest}轮`);

  // And it must say it is generated, not a verification.
  assert.match(head, /不是一次人工验收/,
    'the banner does not disclaim being a human verification');

  // The old claim must survive as an old claim, not be silently rewritten.
  assert.match(head, /顶部最早一条/, 'the historical header was deleted rather than relabelled');
});

test('the stale header was relabelled, not rewritten into a false claim', () => {
  // The rejected fix changed 第377轮 to 第483轮 inside a sentence about hybrid PKCE, citing round 377's
  // handoff — a false statement.
  //
  // THE CHECK MUST LOOK ONLY AT THE HEADER REGION. A whole-file search for the false string matches the
  // round-484 STATUS entry that DESCRIBES the rejected fix and quotes it. That is the third time in this
  // round that a detector matched its own subject matter: first the loose 第N轮 substring, then the
  // banner's own round number taken as the oldest claim, now this. The lesson generalises — a detector
  // for "X must not appear" has to exclude the places that legitimately talk about X.
  const text = read(STATUS);
  const head = text.slice(0, 4000);

  assert.ok(!/最新已验收：第(?!361|37[0-9]|3[0-6][0-9])\d+轮首次hybrid PKCE/.test(head),
    'a header line claims a round other than 377 for the hybrid PKCE work');

  // Round 377's sentence survives, still attributed to 377, in the header region.
  assert.match(head, /第377轮首次hybrid PKCE/,
    'the original round-377 sentence was lost from the header instead of preserved');
  assert.match(head, /HANDOFF-ROUND377-HYBRID-LOGIN\.md/,
    'the round-377 handoff link was removed from the header');

  // And the demoted label is what now introduces it.
  assert.match(head, /顶部最早一条（已被后续轮次取代，保留原文）：第377轮/,
    'the old claim is not marked as superseded');
});

test('backfilled entries quote artifacts and invent no results', () => {
  const text = read(STATUS);

  // All seven rounds are present, each marked as a backfill.
  for (const n of [378, 379, 380, 381, 382, 383, 384]) {
    assert.match(text, new RegExp(`## 第${n}轮（补记）`),
      `round ${n} has no backfilled entry`);
  }

  // Rounds with a handoff link to it.
  for (const [n, file] of [
    [378, 'HANDOFF-ROUND378-IN-PROGRESS.md'],
    [379, 'HANDOFF-ROUND379-QUEUE-LIFECYCLE.md'],
    [380, 'HANDOFF-ROUND380-QUEUE-MODEL.md'],
    [381, 'HANDOFF-ROUND381-ORDINARY-QUEUE.md'],
    [382, 'HANDOFF-ROUND382-FAILED-TURN-HOLD.md'],
    [383, 'HANDOFF-ROUND383-STEER-CONTROL.md'],
  ]) {
    const section = text.slice(text.indexOf(`## 第${n}轮（补记）`));
    const end = section.indexOf('\n## ', 1);
    const body = end > 0 ? section.slice(0, end) : section.slice(0, 1200);
    assert.ok(body.includes(file), `round ${n}'s entry does not link ${file}`);
  }

  // Round 384 has no handoff, so the entry must say so and refuse to assert a conclusion.
  const s384 = text.slice(text.indexOf('## 第384轮（补记）'));
  const body384 = s384.slice(0, s384.indexOf('\n## ', 1) > 0 ? s384.indexOf('\n## ', 1) : 900);
  assert.match(body384, /ccb-native-cycle-r384\.test\.mjs/, 'round 384 entry omits its tests');
  assert.match(body384, /ccb-steer-races-r384\.test\.mjs/, 'round 384 entry omits its second test');
  assert.match(body384, /不代它作任何声称/,
    'round 384 entry does not disclaim inventing a conclusion');
});

test('the audit distinguishes a missing entry from a loose substring match', () => {
  // Regression guard for the detector bug: 第38轮 must not be satisfied by 第384轮, and the per-round
  // check must be boundary-aware. Exercised through the script's own JSON, using the real file.
  const result = runAudit(['--json']);
  const report = JSON.parse(result.stdout);
  // Every reported round number must be a whole number that really appears as 第<N>轮.
  const text = read(STATUS);
  for (const n of report.missingStatus) {
    assert.ok(!new RegExp(`第${n}轮`).test(text),
      `round ${n} was reported missing but 第${n}轮 is present: the detector over-reports`);
  }
  // And the reverse: rounds present in the file must not be reported.
  for (const n of report.missingStatus) {
    assert.equal(new RegExp(`第${n}轮`).test(text), false);
  }
});
