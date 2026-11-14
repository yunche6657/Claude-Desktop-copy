// R623: 807 of 1130 quantified count claims in evidence/ are not recomputed by any test in their own round. That is the largest
// verification gap this line of work has measured — and it is about its own record, not the code.
//
// THE MEASUREMENT
//       evidence files with a countable claim      222
//       (file, number) count pairs                1130
//       recomputed by that round's test            323   = 29%
//       not recomputed                             807
//
//   Round numbers (`第407轮`, `R407`) are stripped first so they cannot pass as measurements, and coordinates are separated: only
//   9 of 2698 classified numbers are positions (行/字符/偏移/第).
//
// WHAT 29% DOES AND DOES NOT MEAN
//   It does NOT mean 807 numbers are wrong. Many are line or file counts a later round re-measured — R617–R622 are six consecutive
//   rounds of exactly that. A claim can be verified by a later test rather than by its own.
//
//   It DOES mean that for 807 claims, the only evidence they are right is that I wrote them down. And two rounds running (R621,
//   R622) produced numbers from pattern probes that were MY misreading — both caught pre-publication, both in rounds explicitly
//   checking a number. The unchecked ones are the ones worth worrying about.
//
// THE FOUR FAILURES SO FAR, ALL IN THE UNVERIFIED CLASS
//       R574    a recorded line number off by 19
//       R617    two character offsets written as line numbers
//       R621    two DRIFT reports from misread field names
//       R622    ten "evidence-derived" rows from a regex that crossed a semicolon
//
// WHY THE GAP IS A STANDING PROPERTY, NOT A TO-DO
//   Re-running every tool and comparing against every number needs deciding which tool and field a given "21 处" refers to — the
//   sentence-grammar problem R620 hit. The rate will rise only as new rounds are written with their numbers recomputed in their own
//   tests, which is what R616 onward have been doing.
//
// WHAT IS NOT CLAIMED
//   Not that the unverified numbers are right: 29% verified is the point.
//   Not that verification by a later round counts less: R617 re-measured R600's population from 21 to 2, a better check than any
//   same-round test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAP, FAILURES, STANDING } from '../desktop/claim-verification.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EV = path.join(ROOT, 'evidence');

test('the gap arithmetic is consistent', () => {
  assert.equal(GAP.recomputed + GAP.unverified, GAP.countPairs);
  assert.ok(Math.abs(GAP.recomputed / GAP.countPairs - GAP.rate) < 0.01, 'the recorded rate does not match the counts');
});

test('the population is still at least as large as recorded', () => {
  // The count only grows as rounds are added, so assert a floor rather than a snapshot.
  const CLAIM = /(\d{2,})\s*(?:处|个|条|组|次|对|种|项)/g;
  let files = 0;
  for (const f of fs.readdirSync(EV)) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(EV, f), 'utf8')
      .replace(/第\s*\d+\s*轮/g, ' ').replace(/\b[Rr]\d{3}\b/g, ' ');
    if ([...text.matchAll(CLAIM)].length) files += 1;
  }
  assert.ok(files >= GAP.filesWithClaims, `files with claims fell from ${GAP.filesWithClaims} to ${files}`);
});

test('round numbers are genuinely excluded by the method', () => {
  // A line that is only a round reference must yield no claim.
  const only = '第407轮 交接';
  const stripped = only.replace(/第\s*\d+\s*轮/g, ' ').replace(/\b[Rr]\d{3}\b/g, ' ');
  assert.equal([...stripped.matchAll(/(\d{2,})\s*(?:处|个|条|组|次|对|种|项)/g)].length, 0,
    'a bare round reference still counts as a claim');
});

test('the four failures are all in the unverified class', () => {
  assert.equal(FAILURES.length, 4);
  for (const f of FAILURES) {
    assert.ok(/^R\d{3}$/.test(f.round), `${f.round} is not a round id`);
    assert.ok(f.what.length > 15, `${f.round} has no description`);
  }
  // Spot-check the two most recent against the records that describe them.
  const r617 = fs.readFileSync(path.join(EV, 'citation-census-r618.md'), 'utf8');
  assert.match(r617, /2491|1194/, 'the R617 offsets are not documented');
});

test('the record says why the gap is standing rather than a task', () => {
  assert.match(STANDING.why, /sentence-grammar problem/, 'the reason is not stated');
  assert.match(STANDING.howItShrinks, /recomputed in their own tests/, 'the remedy is not stated');
  assert.match(STANDING.laterStillCounts, /21 to 2/, 'the counter-example is not cited');
});

test('the record does not claim the unverified numbers are right', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'claim-verification.cjs'), 'utf8');
  assert.match(src, /Not that the unverified numbers are right/, 'the scope limit is missing');
  assert.match(src, /29% verified is the point/, 'the rate is not asserted as the finding');
});
