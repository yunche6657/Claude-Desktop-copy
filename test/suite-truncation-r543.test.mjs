// R543: two batches of failures that turned out to be STALE EXPECTATIONS rather than product defects — and the
// reason they were invisible for many rounds.
//
// WHY THEY WERE INVISIBLE
//   R542 measured that a single `node --test` invocation over all 734 files stops after 2615 tests — exactly the
//   cumulative declaration count of the first 478 files — and exits 0 with no summary line. So every "0 failing"
//   report covered 65% of the suite. The files below are in the other 35%.
//
// THE TWO GROUPS EXAMINED HERE
//   `tool-relation-r493` (9 failures) and `tool-absence-r500` (7 failures) are the two largest groups. Both are
//   downstream of one later discovery:
//
//       R507 established that the init frame reports 39 tools while the request body carries 23 — 17 are withheld,
//       and `EnterWorktree` is among them.
//
//   So R493's classification of the 44 CONTRACT tools no longer matches: `EnterWorktree` left the comparison set,
//   same-tool went 19 -> 20, and the divergent set lost it (Artifact, Bash, WebSearch remain). And R500's word
//   "absent" now conflates two states — not in the build at all, versus in the build but withheld from the request.
//
//   Neither is a product defect. Both are tests asserting a snapshot taken before a measurement that changed what the
//   snapshot means.
//
// WHAT THIS ROUND DID AND DID NOT DO
//   It recorded both as corrections with the evidence for the shift, and applied the banners.
//   It did NOT edit the assertions: deciding whether 44, 39 or 23 is the right subject for these classifications, and
//   whether "absent" should split into two words, are design judgements rather than repairs. Patching the numbers to
//   make them pass would erase the question.
//
// THE REMAINING GROUPS
//   Four other files still fail: selfmatch-baseline-r522, test-hygiene, unparsed-candidates-r529, websearch-count-r430.
//   They were not examined. Two of them look like the same class (a baseline snapshot that drifted), but that is a
//   guess, and this round does not claim otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'evidence', 'corrections.json');

test('the full-suite truncation is recorded with its measurements', () => {
  // Without this, a later round reads "0 failing" and believes the suite is green.
  const doc = path.join(ROOT, 'evidence', 'suite-truncation-r542.md');
  assert.ok(fs.existsSync(doc), 'the truncation finding is not recorded');
  const text = fs.readFileSync(doc, 'utf8');
  assert.match(text, /2615/, 'the reported total is missing');
  assert.match(text, /4026/, 'the declared total is missing');
  assert.match(text, /478/, 'the cut index is missing');
  // And it must say what was NOT verified, which is the fix.
  assert.match(text, /不声称修复有效/, 'the document claims a fix it could not verify');
});

test('both stale-expectation groups carry a correction naming R507 as the cause', () => {
  const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const file of ['tool-relation-r493.md', 'tool-absence-r500.md']) {
    const entry = d.corrections.find((c) => c.file === file && c.round === 543);
    assert.ok(entry, `${file} has no R543 correction`);
    assert.equal(entry.kind, 'conclusion', `${file} is registered as ${entry.kind}`);
    assert.match(entry.detail, /R507/, `${file}'s correction does not name the discovery that invalidated it`);
    assert.match(entry.detail, /EnterWorktree|17 个被扣下|未提供/,
      `${file}'s correction does not name the concrete shift`);
  }
});

test('the banners landed on both copies', () => {
  for (const name of ['tool-relation-r493.md', 'tool-absence-r500.md']) {
    const text = fs.readFileSync(path.join(ROOT, 'evidence', name), 'utf8');
    // The marker is NOT necessarily on line 1: a file can already carry several banners, and a new one is inserted in
    // round order inside that block. Requiring the marker at the start of the file failed on tool-relation-r493, which
    // already had superseded-r502 and an addendum — the banner was there, the assertion was wrong about where.
    assert.ok(text.includes('<!-- superseded-r543 -->'), `${name} has no R543 banner`);
    // And it must precede the title, so it is inside the banner block rather than appended to the evidence body.
    assert.ok(text.indexOf('<!-- superseded-r543 -->') < text.indexOf('\n# '),
      `${name}'s R543 banner sits below the title`);
  }
  // The HANDOFF twins are registered too, so the copy a reader opens carries it.
  const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const handoffs = d.corrections.filter((c) => c.round === 543 && c.file.startsWith('HANDOFF'));
  assert.ok(handoffs.length >= 2, 'the HANDOFF copies were not registered for these corrections');
});

test('the classification shift is stated as numbers, not as a claim', () => {
  const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entry = d.corrections.find((c) => c.file === 'tool-relation-r493.md' && c.round === 543);
  assert.match(entry.detail, /19/, 'the previous same-tool count is missing');
  assert.match(entry.detail, /20/, 'the current same-tool count is missing');
  assert.match(entry.detail, /Artifact.*Bash.*WebSearch|`Artifact`、`Bash`、`WebSearch`/,
    'the remaining divergent set is not named');
});

test('the unexamined failure groups are named rather than implied solved', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'evidence', 'suite-truncation-r542.md'), 'utf8');
  for (const f of ['selfmatch-baseline-r522', 'test-hygiene', 'unparsed-candidates-r529', 'websearch-count-r430']) {
    assert.match(doc, new RegExp(f), `${f} is not listed among the unexamined groups`);
  }
  assert.match(doc, /没有修那 24 个失败|没有改测试/, 'the round implies it repaired more than it did');
});
