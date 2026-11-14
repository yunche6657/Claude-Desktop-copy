// R620: the reverse test — do the FUNCTION-NAME citations in evidence/ ever name a function that is not there? No. All 19
// candidates were artifacts of the check, and the reason is worth recording.
//
// THE METHOD, IN TWO STAGES
//   Stage 1: every call-shaped token in evidence/ against every name defined in the repo. Result: 3711 mentions, 755 "undefined",
//   and the head of that list is `join`, `catch`, `require`, `readFileSync`, `deepEqual`, `spawn` — library methods. Named
//   functions are a small minority of what a technical document writes.
//
//   Stage 2 narrowed it: only a name that DOES exist somewhere, on a line that ALSO cites a repo file. Result: 45 checks, 19
//   failures. Reading all 19 by hand, none is a wrong citation:
//
//       blank, contract-union-r552.md        defined in tools/lexer.cjs:39; the cited file IMPORTS it
//       blank, shared-lexer-r550.md          the sentence is ABOUT two copies of blank(); naming the files is the subject
//       isCurrent, snapshot-shape-r555.md    defined at history-import-manifest.cjs:17 — the extractor missed it
//       contractTools, STATUS.md:30178       the sentence discusses contractTools, not a claim about the cited file
//       handlers.get, stale-comment-r601.md  QUOTED TEXT being explained, not an assertion
//       get/set/json/page/bridge/tokens      ordinary words that happen to be in-repo names
//
//   So the 19 measure the check, not the record.
//
// WHY A PROXIMITY RULE CANNOT WORK
//   A name mention is a claim only when the sentence says "X does Y" about a named file — that needs the sentence's grammar.
//   Proximity joins a citation to whatever identifier shares its line, and technical prose does that constantly.
//
// WHAT THIS ADDS TO R619, AND WHAT IT DOES NOT
//   R619 concluded that naming a function is the only form that survives. This round tried to falsify it and could not — but that
//   is weaker than a clean measurement: it shows THE CHECK cannot find a wrong name, not that none exists.
//
// WHAT IS NOT CLAIMED
//   Not that every name in the evidence resolves: 45 of 3711 call-shaped mentions were examined.
//   Not that `blank` is defined once: R550's point was that two copies existed. The citation is right about the copies AND the
//   definition lives in lexer.cjs — both hold, which is why proximity misreads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK, ARTIFACTS, LIMIT } from '../desktop/name-citation-check.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('blank is really defined in the lexer, which the cited file uses', () => {
  const lexer = fs.readFileSync(path.join(ROOT, 'tools', 'lexer.cjs'), 'utf8');
  assert.match(lexer, /function blank\s*\(/, 'blank is no longer defined in tools/lexer.cjs');
  // And the artefact record points there.
  const a = ARTIFACTS.find((x) => x.name === 'blank' && x.doc === 'contract-union-r552.md');
  assert.ok(a, 'the blank artefact is missing');
  assert.match(a.why, /lexer\.cjs/, 'the defining file is not named');
});

test('isCurrent is defined in the file the document discusses', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'history-import-manifest.cjs'), 'utf8');
  assert.match(src, /isCurrent:\s*\(\)/, 'isCurrent is no longer defined there');
  const a = ARTIFACTS.find((x) => x.name === 'isCurrent');
  assert.ok(a, 'the isCurrent artefact is missing');
  assert.match(a.why, /extractor missed it/, 'the cause is not stated as an extractor miss');
});

test('the two stage counts are consistent with each other', () => {
  assert.ok(CHECK.stage1.mentions > CHECK.stage2.checks * 50, 'stage 1 is no longer far larger than stage 2');
  assert.ok(CHECK.stage1.distinctUndefined > 500, 'stage 1 no longer over-reports');
  assert.ok(CHECK.stage2.failures < CHECK.stage2.checks, 'every check failed, which would be a real finding');
  assert.match(CHECK.stage1.verdict, /join, catch, require/, 'the library-method character is not stated');
});

test('the record calls the failures artifacts rather than clean citations', () => {
  assert.equal(ARTIFACTS.length, 6);
  for (const a of ARTIFACTS) assert.ok(a.why.length > 15, `${a.name} has no real explanation`);
  assert.match(CHECK.stage2.verdict, /all 19 are artifacts/, 'the conclusion is not stated');
});

test('the limit of the check is stated as a grammar problem', () => {
  assert.match(LIMIT.needs, /sentence grammar/, 'the requirement is not named');
  assert.match(LIMIT.failsBecause, /shares its line/, 'the proximity failure is not named');
  assert.match(LIMIT.soWhat, /measure the check, not the record/, 'the consequence is not stated');
});

test('the record does not overclaim what it proves', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'name-citation-check.cjs'), 'utf8');
  assert.match(src, /Not that every name in the evidence resolves/, 'the sample limit is missing');
  assert.match(src, /shows the check cannot find a wrong name, not that no wrong name exists/,
    'the weaker-evidence caveat is not stated');
  assert.match(src, /Not that `blank` is defined once/, 'the two-copies counter-example is missing');
});
