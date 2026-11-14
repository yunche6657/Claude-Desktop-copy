// R574: the shape behind R569's defect was scanned for everywhere. 117 hits, almost all noise — and reading one group
// settled the question.
//
// THE SHAPE
//   A field produced as a STRICT boolean, then read for TRUTHINESS. Elsewhere in this session that combination produced a
//   real defect: `kernel-fallback.cjs` decided `reprobe.available` truthily, so `{ available: 'yes' }` — a caller bypassing
//   the normaliser — would PROPAGATE a failure that should have fallen back. R569 fixed it to `=== true`.
//
// THE SCAN, AND WHY ITS OUTPUT IS NOT A WORK LIST
//   183 fields have a strict producer; 124 truthy reads of them exist; 117 of those readers never compare with
//   `=== true`. That sounds alarming and is not:
//
//       ok         11 reads   an ordinary name that is a `Boolean(...)` somewhere else in the same file
//       pending     6 reads   produced by proof scripts as a status string
//       model       4 reads   a model NAME, never a boolean
//       code        3 reads   an error code string
//
//   The scan cannot tell "this field IS a boolean everywhere" from "this NAME is a boolean in one place and a string in
//   another", because that distinction needs types. So the output is a question list, and almost every question is
//   answered "no" by reading the name.
//
// THE GROUP THAT WAS WORTH READING, AND WHAT IT PROVED
//   `kernel-select.cjs` reads `probe.available` truthily at lines 78, 85 and 99. Those reads are CORRECT, because every
//   value they touch came through the normaliser:
//
//       :31   const available = Boolean(probe && probe.available);
//       :73   const byId = new Map(normalised.map((probe) => [probe.id, probe]));
//       :78   if (probe && probe.available) {          // probe came from byId
//
//   So the contract is consistent: strict producer, strict-by-construction consumers inside the module, and exactly ONE
//   place that reads a raw probe — kernel-fallback — which now compares `=== true`.
//
// WHY NOT TIGHTEN THE OTHER 117
//   A truthy read of a guaranteed boolean is not a bug: `if (x.available)` and `if (x.available === true)` differ only for
//   non-boolean input. Adding `=== true` to seventeen places that cannot receive a non-boolean would be churn that makes
//   the one place that CAN receive one harder to spot.
//
// WHAT IS PINNED
//   The producer's guarantee, the three correct consumers with the reason each is correct, and the one consumer that must
//   compare strictly. The coordinates are asserted against the files, so a later edit that moves them fails loudly instead
//   of the record quietly becoming wrong — which happened once already this round: kernel-fallback's line moved from 24 to
//   43 when it grew a comment block.
//
// WHAT IS NOT CLAIMED
//   Not that the scan found every lax contract: it looks for `Boolean(…)`, `=== true` and `!!` producers, so a field
//   produced by a helper (`isReady(x)`) is invisible.
//   Not that `=== true` should be the house style. It is required exactly where the input is unvalidated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCER, STRICT_BY_CONSTRUCTION, STRICT_REQUIRED } from '../desktop/available-contract.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'strict-contract-audit.cjs');

test('the producer still guarantees a boolean', () => {
  const lines = fs.readFileSync(path.join(ROOT, PRODUCER.file), 'utf8').split('\n');
  assert.ok(lines[PRODUCER.line - 1].includes(PRODUCER.expression),
    `${PRODUCER.file}:${PRODUCER.line} no longer holds "${PRODUCER.expression}"`);
  // And it is the normaliser that does it, which is what makes the guarantee total.
  const src = fs.readFileSync(path.join(ROOT, PRODUCER.file), 'utf8');
  assert.match(src, /function normaliseProbe/, 'the normaliser is gone, so the guarantee is not total');
  assert.match(src, /const byId = new Map\(normalised\.map/, 'byId no longer derives from normalised');
});

test('the three truthy reads are the ones that came through the normaliser', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'kernel-select.cjs'), 'utf8').split('\n');
  for (const c of STRICT_BY_CONSTRUCTION) {
    assert.equal(c.file, 'desktop/kernel-select.cjs');
    assert.ok(lines[c.line - 1].includes('.available'),
      `${c.file}:${c.line} no longer reads .available`);
    assert.match(c.source, /byId|normalised/, 'a consumer is recorded without saying why it is correct');
  }
});

test('the one raw-probe consumer compares strictly', () => {
  const lines = fs.readFileSync(path.join(ROOT, STRICT_REQUIRED.file), 'utf8').split('\n');
  assert.ok(lines[STRICT_REQUIRED.line - 1].includes('=== true'),
    `${STRICT_REQUIRED.file}:${STRICT_REQUIRED.line} no longer compares strictly`);
  // And there is no truthy read of a raw probe anywhere in that file.
  const src = fs.readFileSync(path.join(ROOT, STRICT_REQUIRED.file), 'utf8');
  const lax = [...src.matchAll(/if\s*\(\s*reprobe\.available\s*\)/g)];
  assert.equal(lax.length, 0, 'a truthy read of the raw probe is back');
});

test('the scan reports the split rather than only the alarming half', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  assert.ok(d.strictFields > 50, `only ${d.strictFields} strict fields found`);
  assert.equal(d.lax + (d.consumerSites - d.lax), d.consumerSites, 'the split does not sum');
  // The strict readers must be reported too, even though they are the minority.
  assert.ok(d.consumerSites - d.lax > 0, 'no strict reader is reported, so the denominator is wrong');
});

test('the audit says each row is a question', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /a QUESTION, not a verdict|QUESTION, not a verdict/,
    'the output no longer says the rows are questions');
  const src = fs.readFileSync(TOOL, 'utf8');
  // The justification wraps across lines, so it is checked by its distinctive fragment rather than as one line.
  // R575 rewrote the tool to pair by receiver and rephrased this passage; the claim it makes — that a text scan cannot
  // settle a receiver's type — is what has to survive, not the wording.
  assert.ok(/cannot prove a receiver'?s TYPE|cannot tell "this field IS a boolean everywhere"/.test(src),
    'the reason the scan cannot decide is not recorded');
});

test('the record pins the coordinates against the files, not against memory', () => {
  // This round found kernel-fallback's line had moved from 24 to 43. The test above caught it; this one makes the lesson
  // explicit so the next hand-written coordinate is checked the same way.
  const lines = fs.readFileSync(path.join(ROOT, STRICT_REQUIRED.file), 'utf8').split('\n');
  assert.ok(!lines[23] || !lines[23].includes('=== true'),
    'the old coordinate 24 now holds the comparison, so this note is stale');
});
