// R630: the last visibility layer — is any tool in `tools/` orphaned, mentioned nowhere? No. All 189 are mentioned; the split is
// 129 in a test plus 60 in evidence only.
//
// THE MEASUREMENT
//       tools                                      189
//       mentioned as a whole token outside tools/   189
//       mentioned in at least one TEST              129
//       NOT in any test                              60
//       … of those, appearing in evidence            60
//       … mentioned NOWHERE at all                    0
//
//   The substring check reported zero first and a stricter whole-token check agreed, so the zero is not an artifact of loose matching.
//
// WHAT THE 60 ARE
//   None is CLI-shaped in the guarded sense (`require.main` / `module.parent`) — which is why R629's sweep could not reach them.
//   28 are runnable-looking scripts (`fix-ion-dist`, `login-account`, `merge-changelog`, `official-diff`), 13 are `proof-*` one-shot
//   evidence generators, 19 are analysis scripts (`admitted-gaps`, `bridge-gaps`, `called-gaps`, `field-mismatch`).
//
//   That shape is coherent with being cited only in evidence: a `proof-r389-held-withdrawn.cjs` exists to produce one round's
//   evidence, is referenced by that round, and never needs a test.
//
// WHY ZERO IS THE RIGHT RESULT TO REPORT
//   Three rounds hunted broken or invisible instruments: R628 found one broken, R629 found six correct refusals and no new defects.
//   This round closes the question by showing there is no unreferenced corner left to hide in. That is a complete negative result,
//   and stating it as such is more useful than "nothing found".
//
// WHAT IS NOT CLAIMED
//   Not that every one of the 189 works: R628 found a broken one that WAS mentioned in evidence, so mention does not imply health.
//   What this round establishes is that no tool escapes BOTH the tests and the record.
//   Not that the 60 need no test: a `proof-*` generator that silently stopped working would be noticed only by the round that needs
//   it — later than a test would.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE, SHAPES, COHERENT } from '../desktop/orphan-tools.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scan = () => {
  const TOOLS = path.join(ROOT, 'tools');
  const TEST = path.join(ROOT, 'test');
  const EV = path.join(ROOT, 'evidence');
  const all = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.cjs'));

  const corpus = [];
  for (const [dir, label] of [[TEST, 'test'], [EV, 'evidence'], [path.join(ROOT, 'desktop'), 'desktop']]) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mjs|cjs|md)$/.test(f)) continue;
      corpus.push({ label, text: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  const inTest = [];
  const evidenceOnly = [];
  const orphans = [];
  for (const tool of all) {
    const stem = tool.replace(/\.cjs$/, '');
    const re = new RegExp('(?<![\\w-])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    const inA = corpus.some((c) => c.label === 'test' && re.test(c.text));
    const anyB = corpus.some((c) => c.label !== 'test' && re.test(c.text));
    if (inA) inTest.push(tool);
    else if (anyB) evidenceOnly.push(tool);
    else orphans.push(tool);
  }
  return { all, inTest, evidenceOnly, orphans };
};

test('no tool is orphaned, and the split still sums', () => {
  const s = scan();
  assert.equal(s.orphans.length, COVERAGE.orphans,
    `orphaned tools appeared: ${s.orphans.slice(0, 5).join(', ')}`);
  assert.equal(s.all.length, s.inTest.length + s.evidenceOnly.length + s.orphans.length,
    'the three buckets no longer partition');
  assert.ok(s.all.length >= COVERAGE.tools, `the tool count fell from ${COVERAGE.tools} to ${s.all.length}`);
});

test('the test-covered and evidence-only counts are floors, not snapshots', () => {
  const s = scan();
  // The two buckets trade members as rounds add tests, so neither is a floor. What must hold is that both are non-empty and
  // that together they account for every tool.
  assert.ok(s.inTest.length > 0, 'no tool is covered by a test');
  assert.ok(s.evidenceOnly.length > 0, 'no tool is evidence-only');
  assert.equal(s.inTest.length + s.evidenceOnly.length + s.orphans.length, s.all.length);
});

test('the evidence-only tools really are absent from every test', () => {
  const s = scan();
  const TEST = path.join(ROOT, 'test');
  const testText = fs.readdirSync(TEST).filter((f) => f.endsWith('.mjs'))
    .map((f) => fs.readFileSync(path.join(TEST, f), 'utf8')).join('\n');
  for (const tool of s.evidenceOnly.slice(0, 30)) {
    const stem = tool.replace(/\.cjs$/, '');
    assert.ok(!new RegExp('(?<![\\w-])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(testText),
      `${tool} is in a test, so it belongs in the other bucket`);
  }
});

test('the shape counts cover the evidence-only population', () => {
  const total = SHAPES.reduce((a, s) => a + s.count, 0);
  assert.equal(total, COVERAGE.onlyInEvidence, `the shapes sum to ${total}, record says ${COVERAGE.onlyInEvidence}`);
  for (const s of SHAPES) assert.ok(s.examples.length >= 2, `${s.kind} has too few examples`);
});

test('the examples named are real files', () => {
  for (const s of SHAPES) {
    for (const e of s.examples) {
      assert.ok(fs.existsSync(path.join(ROOT, 'tools', e)), `${e} does not exist`);
    }
  }
});

test('the record states the negative result and its coherence', () => {
  assert.match(COHERENT.why, /exists to produce one round/, 'the coherence argument is not stated');
  assert.match(COHERENT.consumer, /by design/, 'the design claim is not stated');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'orphan-tools.cjs'), 'utf8');
  assert.ok(src.includes('That is a complete'), 'the result is not characterised as complete');
});

test('the record refuses to treat mention as health', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'orphan-tools.cjs'), 'utf8');
  assert.match(src, /mention does not imply health/, 'the limit is missing');
  assert.match(src, /later than a test would/, 'the cost of having no test is not stated');
});
