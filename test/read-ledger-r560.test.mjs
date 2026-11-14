// R560: the reading this project did was real but unrecorded, so "no shared rules remain" had no denominator.
//
// THE CYCLE THAT NEEDED BREAKING
//   Six rounds ran the same loop: find duplicated lists, read a few, conclude "not a defect", find the next. Each round
//   re-derived "which groups are interesting" from a ranking instead of from what had already been looked at, and the
//   reading itself lived only in prose scattered across six evidence files. The question "how much of the list has been
//   examined" was unanswerable.
//
//   `tools/read-ledger.cjs` is the denominator. Keyed by the SORTED MEMBER SET — the same signature the detectors group
//   by — so a group whose contents change becomes a new, unread entry, which is correct: its new shape has not been read.
//
// MEASURED, AFTER TWO DETECTOR FIXES
//       live groups (3+ files)   28
//       read                      7
//       unread                   21
//
//   So the cumulative conclusion "no shared rules remain" was a statement about 25% of the population.
//
// TWO SELF-INFLICTIONS FOUND BY DOING THIS
//   1. `duplicated-lists` counted lists inside COMMENTS. Every downstream tool filtered prose for itself, so the numbers
//      each of them inherited were wrong. `tools/proof-list-order.cjs` documents the environment lists in its header and
//      appeared as a site, inflating that group from 4 files to 5. The filter now lives in the shared source.
//   2. Having fixed comments, the LEDGER ITSELF appeared as a site — it stores each group's members as its key, which is
//      its job. That required the other distinction: a file that must name a list to describe it is not duplicating it.
//      `RECORDS_NOT_USES` is an explicit exclusion with a reason, not a heuristic.
//
//   Both are the same shape as every defect this project has recorded: a pattern that does not describe the thing it
//   inspects, with its output trusted anyway.
//
// WHAT IS NOT CLAIMED
//   Not that 7 of 28 is adequate — it is the measurement, not a defence. What changed is that the fraction is now
//   visible instead of implied.
//   Not that a ledger entry means "correct": each records what a round CONCLUDED, and one records a conclusion later
//   corrected (R553's claim about `LocalSessions`, fixed in R554 — the entry says so).
//   Not that the ledger is complete: entries were written from the evidence files, and a round that read a group without
//   leaving a trace would be missing here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READ, sig } from '../tools/read-ledger.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'tools', 'read-ledger.cjs');
const LISTS = path.join(ROOT, 'tools', 'duplicated-lists.cjs');

const runNode = (file, args = []) => spawnSync(process.execPath, [file, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

test('every ledger entry still matches a live group, except the ones recording a fix', () => {
  const r = runNode(LEDGER, ['--verify']);
  assert.equal(r.status, 0, 'the ledger has stale entries:\n' + (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /every non-fix entry still matches a live group/);
});

test('the ledger reports a read fraction, not just a list', () => {
  const r = runNode(LEDGER, ['--json']);
  assert.equal(r.status, 0, 'the ledger failed');
  const d = JSON.parse(r.stdout);
  assert.ok(d.liveGroups > 10, `only ${d.liveGroups} live groups`);
  assert.equal(d.read + d.unread, d.liveGroups,
    `read ${d.read} + unread ${d.unread} does not equal ${d.liveGroups}`);
  assert.ok(d.read > 0, 'nothing is recorded as read');
  assert.ok(d.unread > 0, 'everything is recorded as read, which the evidence files do not support');
});

test('a list inside a comment is not a site', () => {
  // `proof-list-order.cjs` names the environment lists in its header and used to be counted as carrying them.
  const src = fs.readFileSync(LISTS, 'utf8');
  assert.match(src, /A LIST INSIDE A COMMENT IS NOT A SITE/, 'the comment filter is not explained');
  const r = runNode(LISTS, ['--json']);
  const d = JSON.parse(r.stdout);
  for (const g of d.rows) {
    for (const s of g.sites) {
      const lines = fs.readFileSync(path.join(ROOT, s.file), 'utf8').split('\n');
      const t = (lines[s.line - 1] || '').trim();
      assert.ok(!/^(\/\/|\*|\/\*)/.test(t),
        `${s.file}:${s.line} is a comment but is counted as a site`);
    }
  }
});

test('a file that records a list is not duplicating it', () => {
  const src = fs.readFileSync(LISTS, 'utf8');
  assert.match(src, /RECORDS_NOT_USES/, 'the records-not-uses exclusion is gone');
  assert.match(src, /writing `'APPDATA'` there is\s*\n?\s*\*?\s*data, not a second copy|data, not a second copy/,
    'the reason for the exclusion is not recorded');
  // The ledger must not appear as a site of any group.
  const r = runNode(LISTS, ['--json']);
  const d = JSON.parse(r.stdout);
  for (const g of d.rows) {
    for (const s of g.sites) {
      assert.ok(!s.file.startsWith('tools/read-ledger.cjs'),
        'the ledger is being counted as a carrier of the lists it records');
    }
  }
});

test('the ledger key is the sorted member set, so a changed group is a new entry', () => {
  assert.equal(sig(['b', 'a']), sig(['a', 'b']), 'the signature is order-dependent');
  assert.notEqual(sig(['a', 'b']), sig(['a', 'b', 'c']), 'the signature ignores membership');
  // Every entry has the fields the report reads.
  for (const e of READ) {
    assert.ok(Array.isArray(e.members) && e.members.length >= 2, 'an entry has fewer than two members');
    assert.ok(Number.isInteger(e.round), `an entry has no round: ${e.members.join(',')}`);
    assert.ok(typeof e.verdict === 'string' && e.verdict.length > 10, 'an entry has no verdict');
  }
});

test('the corrected conclusion is recorded as corrected', () => {
  // R553 claimed the LocalSessions array existed only in tests; R554 found it eight times in production.
  const entry = READ.find((e) => e.members.includes('LocalAgentModeSessions'));
  assert.ok(entry, 'the LocalSessions entry is gone');
  assert.match(entry.note, /R554 corrected R553/, 'the correction is not recorded in the ledger');
});

test('the ledger states that an entry is a conclusion, not a correctness claim', () => {
  const src = fs.readFileSync(LEDGER, 'utf8');
  assert.match(src, /Not "it is correct"/, 'the limit of an entry is not stated');
  assert.match(src, /counted but never read|statement about the read ones only/,
    'the output does not say what an unread count means');
});
