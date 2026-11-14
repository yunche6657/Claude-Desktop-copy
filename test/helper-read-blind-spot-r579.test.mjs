// R579: the helper-module blind spot R578 left open is EMPTY. Measured, and the zero is recorded so it is not re-opened.
//
// THE QUESTION, IN THREE CONDITIONS
//   A test is invisible to `group-provenance`'s reading rule only if ALL of these hold:
//
//       it executes a slice          vm.runInNewContext / new Function / eval
//       it does NOT read official material in its own text
//       a module it imports DOES read official material
//
// MEASURED
//       tests importing a project module                306
//       ... reading official material in their own text   62
//       ... importing a module that does                 89   (upper bound, see below)
//       BLIND SPOT                                        0
//
//   The zero is the finding. Every test that runs a slice also reads the bundle in its own file: the two activities are not
//   factored apart anywhere here. So there is no import-graph tool to build, and R578's paragraph does not describe a live
//   hazard.
//
// WHY THE 89 IS ONLY AN UPPER BOUND
//   Counting "project modules that read official material" gave 16, and reading them showed most were false: the pattern
//   matched through an English possessive in comment prose — `'s own renderer/ served over loopback`, `'s init frame`. A
//   quote followed by prose containing `ion-dist` is not a path. That count is therefore not asserted here, and the 89 that
//   depends on it is labelled rather than trusted. The blind-spot zero does not depend on it: it is reached by finding no
//   test that satisfies all three conditions at once.
//
// WHAT IS NOT CLAIMED
//   Not that no test reads official material through a helper — the zero says no test does that WHILE also executing a
//   slice without reading itself. A helper-only read with no exec is a different question.
//   Not that the three conditions cover a helper that BOTH reads and executes: such a helper would make the test's own
//   text contain neither, and this check would report the test as neither executing nor reading — which is correct, because
//   the test itself does neither. The helper would need checking separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLIND_SPOT, MEASUREMENT } from '../desktop/helper-read-blind-spot.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const EXEC = /vm\.runInNewContext|new Function\(|\beval\(/;
const OFFICIAL = /['"][^'"]*(?:ccd-ref|asar[\/\\]\.vite|\.vite[\/\\]build|ion-dist|pinned-ion|agent-core[\/\\]claude-code[\/\\]dist)[^'"]*['"]/;
const READS = /readFileSync\(/;
const IMPORT_LOCAL = /(?:require\(|from\s+|import\()\s*['"]\.\.\/(desktop|tools)\/([A-Za-z0-9_.-]+\.cjs)['"]/g;

/** Does a project module read official material? Re-derived here rather than trusted from the record. */
function moduleReadsOfficial(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8');
  return OFFICIAL.test(text) && READS.test(text);
}

test('the blind spot is still zero', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
  const blind = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    if (!EXEC.test(text)) continue;
    if (OFFICIAL.test(text) && READS.test(text)) continue;
    const imports = [...text.matchAll(IMPORT_LOCAL)].map((m) => `${m[1]}/${m[2]}`);
    if (imports.some((rel) => moduleReadsOfficial(rel) === true)) blind.push(f);
  }
  assert.deepEqual(blind, [],
    `a test now executes a slice and reads official material only through an import: ${blind.join(', ')}`);
});

test('the recorded measurement still matches the tree', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
  let importing = 0;
  let readingSelf = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    const imports = [...text.matchAll(IMPORT_LOCAL)].map((m) => `${m[1]}/${m[2]}`);
    if (imports.length) importing += 1;
    if (OFFICIAL.test(text) && READS.test(text)) readingSelf += 1;
  }
  // Counts move as tests are added, so the assertion is a floor plus the invariant that matters.
  assert.ok(importing >= MEASUREMENT.testsImportingProjectModule,
    `only ${importing} tests import a project module, fewer than the recorded ${MEASUREMENT.testsImportingProjectModule}`);
  assert.ok(readingSelf >= 50, `only ${readingSelf} tests read official material in their own text`);
  assert.equal(MEASUREMENT.blindSpot, 0);
});

test('the three conditions are recorded as conditions, not as prose', () => {
  assert.deepEqual(BLIND_SPOT.requiresAll,
    ['executing', 'not-reading-self', 'imports-a-reader'],
    'the conjunction that defines the blind spot changed');
  for (const k of ['executing', 'officialPath', 'reading']) {
    assert.ok(BLIND_SPOT[k] && BLIND_SPOT[k].length > 5, `${k} is not described`);
  }
});

test('the upper bound is labelled rather than asserted', () => {
  assert.match(MEASUREMENT.note, /upper bound/, 'the 89 is presented as a count instead of a bound');
  assert.match(MEASUREMENT.note, /possessive/, 'the reason it cannot be trusted is not recorded');
  // And the module must not export the discredited module count as a fact.
  assert.equal('modulesReadingOfficial' in MEASUREMENT, false,
    'the discredited module count is recorded as a field');
});

test('the record says what the zero means for the next round', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'helper-read-blind-spot.cjs'), 'utf8');
  // The prose wraps mid-phrase, so the fragments are the words that carry the claim, not the sentences.
  assert.ok(/import-graph tool/.test(src), 'the practical consequence is missing');
  assert.ok(/re-opened in five rounds/.test(src), 'the reason for recording an empty gap is missing');
});

test('the different question is named and left unanswered', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'helper-read-blind-spot.cjs'), 'utf8');
  assert.match(src, /helper-only read with no exec|different question/, 'the adjacent question is not distinguished');
});
