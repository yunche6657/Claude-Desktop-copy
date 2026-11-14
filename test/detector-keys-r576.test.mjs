// R576: four detectors failed the same way — the idea was right, the KEY was wrong. The registry makes the next one check
// against the list before producing a work queue.
//
// THE FOUR, AND WHAT EACH COST
//       R557  list-skeleton-divergence   keyed by member SET, flagged 31 of 31 — a fixture name shared by nineteen
//                                        unrelated tests looked like nineteen spellings of one rule. Narrowed 31 -> 4,
//                                        with the narrowing cost recorded.
//       R571  live-branch-audit          keyed by "is the name produced", three wrong versions, withdrawn. The question
//                                        is about SCOPE and needs a parser; the third version flagged 356 of 3346.
//       R574  strict-contract-audit      keyed by FIELD NAME, `ok` on top — a Response property merged with a project
//                                        return value. Re-keyed by receiver.
//       R575  strict-contract-audit      re-keyed by RECEIVER, better, but `b.isCurrent` still reports three phantom reads.
//
// THE SYMPTOMS, WHICH ARE MORE USEFUL THAN THE NAMES
//       every item flagged                          the key is so coarse nothing can differ
//       the top row is absurd                        the key merged two subjects that share only a name
//       three fixes, three new defeating shapes      the key asks a question text cannot answer
//       the count barely moves when the rule changes the key is not measuring what the rule does
//
//   A new detector can be checked against those four shapes before it is trusted, which is the whole point: this project
//   spent four rounds learning them one at a time.
//
// WHY `untested` IS THE MOST DANGEROUS STATE
//   `sound` means the key was read against real rows and held. `falsified` means it was wrong and the lesson is written
//   down. `untested` means nobody has asked the question — and an untested key looks exactly like a sound one until it
//   produces a queue somebody acts on. Two entries are in that state, and both are named rather than left implicit.
//
// WHAT THIS FILE DOES NOT DO
//   It does not enforce anything. There is no test that fails when a new detector appears without an entry — that would be
//   a gate, and a gate invites a stub entry. What it offers is a question already answered four times, available to be
//   read before the fifth.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_KEYS, FAILURE_SYMPTOMS } from '../desktop/detector-keys.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every entry names a tool that exists', () => {
  for (const d of DETECTOR_KEYS) {
    assert.ok(fs.existsSync(path.join(ROOT, d.tool)), `${d.tool} does not exist`);
  }
});

test('every entry states a key, a status, and what it learned', () => {
  for (const d of DETECTOR_KEYS) {
    assert.ok(d.key.length > 10, `${d.tool} has no key recorded`);
    assert.ok(['sound', 'falsified', 'untested'].includes(d.status), `${d.tool} has status "${d.status}"`);
    assert.ok(d.lesson.length > 30, `${d.tool} does not say what it learned`);
    assert.ok(d.symptom.length > 5, `${d.tool} does not say what the symptom was`);
  }
});

test('the four failures are all recorded as falsified', () => {
  const falsified = DETECTOR_KEYS.filter((d) => d.status === 'falsified');
  assert.ok(falsified.length >= 3, `only ${falsified.length} falsified keys recorded`);
  const rounds = falsified.map((d) => d.round);
  assert.ok(rounds.includes(557), 'the 31-of-31 case is not recorded');
  assert.ok(rounds.includes(571), 'the withdrawn liveness rule is not recorded');
  assert.ok(rounds.includes(574), 'the field-name key is not recorded');
});

test('a falsified key records the symptom that revealed it', () => {
  const skeleton = DETECTOR_KEYS.find((d) => d.tool.includes('list-skeleton-divergence'));
  assert.match(skeleton.symptom, /31 of 31|every group/, 'the too-coarse symptom is not recorded');
  const contract = DETECTOR_KEYS.find((d) => d.round === 574);
  assert.match(contract.symptom, /top row|absurd|ok/, 'the merged-name symptom is not recorded');
});

test('the re-keyed detector is now sound, because R581 explained and fixed its bad row', () => {
  // R576 recorded it as `untested` — a key nobody had read a row of. R581 read the row and found the pairing was correct
  // and the CLASSIFICATION wrong: `typeof b.isCurrent === 'function'` is a type check, and the `&&` pattern read it as a
  // truthiness test. Stripping `typeof x.f` and excluding the call form removed all three phantoms.
  const rekeyed = DETECTOR_KEYS.find((d) => d.round === 581);
  assert.ok(rekeyed, 'the updated entry is missing');
  assert.equal(rekeyed.status, 'sound',
    'the receiver key is still marked untested after its bad row was explained and fixed');
  assert.match(`${rekeyed.symptom} ${rekeyed.lesson}`, /b\.isCurrent/,
    'the phantom that motivated the change is not named');
});

test('a sound key is one that was read against real rows', () => {
  const sound = DETECTOR_KEYS.filter((d) => d.status === 'sound');
  assert.ok(sound.length >= 4, `only ${sound.length} sound keys`);
  // Each sound entry must say what was checked, not merely that it is fine.
  for (const d of sound) {
    assert.ok(/held|has held|is the tool that|Both were|the key —/.test(d.lesson),
      `${d.tool} is marked sound without saying what held`);
  }
});

test('the failure symptoms are four distinct shapes', () => {
  assert.equal(FAILURE_SYMPTOMS.length, 4);
  const keys = FAILURE_SYMPTOMS.map((f) => f.symptom);
  assert.equal(new Set(keys).size, 4, 'two symptoms are the same');
  for (const f of FAILURE_SYMPTOMS) assert.ok(f.means.length > 15, `${f.symptom} has no explanation`);
});

test('the registry does not claim to enforce anything', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'detector-keys.cjs'), 'utf8');
  assert.match(src, /does not enforce|It does not enforce/, 'the limit is not stated');
  assert.match(src, /gate invites a stub entry|cannot.*enforce/, 'the reason for not gating is missing');
});

test('each falsified entry says what replaced it or why it was withdrawn', () => {
  for (const d of DETECTOR_KEYS.filter((x) => x.status === 'falsified')) {
    assert.ok(/Narrowed|Withdrawn|Re-keyed/.test(d.lesson),
      `${d.tool} is falsified without saying what replaced the key`);
  }
});
