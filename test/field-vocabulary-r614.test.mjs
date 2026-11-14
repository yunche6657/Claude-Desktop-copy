// R614: the field-name survey came out the opposite way round. `file` is perfectly uniform; the five "line" names are four
// tools already agreeing plus three different meanings.
//
// THE MEASUREMENT
//       file-path field names      1   `file`, in all eight tools
//       line-number field names    5   declaredAt, coMentionLine, line, denialLine, witnessLine
//
//   The naive reading is "five names for line numbers, so the vocabulary is fragmented". What the values MEAN refutes it:
//
//       declaredAt       178   where the SET is declared           FOUR tools, same name and same meaning
//       coMentionLine     45   where two names appear together     a co-occurrence
//       line              10   the comment line being examined     the subject itself
//       denialLine       275   the denying comment's line          subject, first of a pair
//       witnessLine      728   the observing comment's line        subject, second of a pair
//
//   Four tools already agreed on `declaredAt` before this round looked. The three remaining names are three distinct meanings, and
//   merging them would be the mistake: `denialLine` and `witnessLine` are two ends of a comparison, and calling both `line`
//   destroys the only thing the row says.
//
// WHY THE SURVEY WAS STILL WORTH IT
//   The hypothesis was cheap and the answer is now a fact. `map-key-reach` shows `declaredAt` and `stale-comment` shows `line`,
//   which READS like divergence and is not.
//
// THE ONE REAL ASYMMETRY
//   `file` is uniform but `path` is absent, so no tool emits a bare path — every subject is `file` plus a line-ish field. That is
//   a coherent convention stated nowhere, and a reader writing cross-tool code would find it by trying.
//
// WHAT IS NOT CLAIMED
//   Not that a shared vocabulary is desirable: denialLine/witnessLine earn their names. The finding is that no unification is
//   needed — a different result from "the names are inconsistent", and a more useful one.
//   Not that the survey is complete: it looked at numeric fields named like lines and string fields named like files. A `col`,
//   `offset` or `range` field would not be found — and none of the eight emits one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOCABULARY, MEANINGS, CONCLUSION } from '../desktop/field-vocabulary.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOLS = [
  'set-lifetimes.cjs', 'set-reset-reach.cjs', 'set-key-symmetry.cjs', 'map-key-reach.cjs',
  'clear-asymmetry.cjs', 'source-divergence.cjs', 'stale-comment.cjs', 'denial-vs-witness.cjs',
];

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

/** Collect the numeric line-ish field names and the string file field names from one tool's rows. */
const fieldsOf = (rows) => {
  const line = new Set();
  const file = new Set();
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') { visit(v); continue; }
      if (/line|Line|declaredAt|at$/i.test(k) && typeof v === 'number') line.add(k);
      if (/^(file|path|rel)$/i.test(k) && typeof v === 'string') file.add(k);
    }
  };
  for (const row of rows) visit(row);
  return { line, file };
};

test('every tool emits `file` and no tool emits a bare `path`', () => {
  const names = new Set();
  for (const tool of TOOLS) {
    const d = runJson(tool);
    const f = fieldsOf(d.rows || d.sites || []).file;
    for (const n of f) names.add(n);
  }
  assert.deepEqual([...names], ['file'], `the file field names are ${[...names].join(', ')}`);
  assert.equal(VOCABULARY.file.uniform, true);
  assert.equal(VOCABULARY.file.tools, TOOLS.length);
});

test('four tools share `declaredAt` exactly', () => {
  const users = [];
  for (const tool of TOOLS) {
    const d = runJson(tool);
    const l = fieldsOf(d.rows || d.sites || []).line;
    if (l.has('declaredAt')) users.push(tool.replace('.cjs', ''));
  }
  assert.deepEqual(users.sort(), [...VOCABULARY.line.alreadyShared.tools].sort(),
    `the declaredAt users are now ${users.join(', ')}`);
});

test('the five line names are five distinct meanings, each with an example', () => {
  assert.equal(MEANINGS.length, 5);
  const names = MEANINGS.map((m) => m.field).sort();
  assert.deepEqual(names, [...VOCABULARY.line.names].sort());
  for (const m of MEANINGS) {
    assert.equal(typeof m.example, 'number', `${m.field} has no example value`);
    assert.ok(m.meaning.length > 10, `${m.field} has no stated meaning`);
    assert.ok(m.kind.length > 3, `${m.field} has no kind`);
  }
  // The three non-declaration meanings must be distinct kinds, not three spellings.
  const kinds = new Set(MEANINGS.filter((m) => m.field !== 'declaredAt').map((m) => m.kind));
  assert.equal(kinds.size, 4, `the non-declaration kinds collapse to ${kinds.size}: they may be mergeable`);
});

test('denialLine and witnessLine really are the two ends of one comparison', () => {
  const d = runJson('denial-vs-witness.cjs');
  assert.ok(d.rows.length >= 1);
  for (const row of d.rows) {
    assert.equal(typeof row.denialLine, 'number');
    assert.equal(typeof row.witnessLine, 'number');
    assert.notEqual(row.denialLine, row.witnessLine, 'a pair whose two lines coincide would collapse the distinction');
  }
});

test('the conclusion states the hypothesis and its refutation', () => {
  assert.match(CONCLUSION.hypothesis, /fragmented/, 'the hypothesis is not stated');
  assert.match(CONCLUSION.refuted, /share `declaredAt`/, 'the refutation is not stated');
  assert.match(CONCLUSION.mergingWouldBreak, /destroys what the row says/, 'the cost of merging is not stated');
});

test('the real asymmetry is recorded', () => {
  assert.match(CONCLUSION.realAsymmetry, /`path` is absent/, 'the missing counterpart is not named');
  assert.match(CONCLUSION.realAsymmetry, /stated nowhere/, 'the undocumented convention is not named');
});

test('the record does not recommend unification', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'field-vocabulary.cjs'), 'utf8');
  assert.match(src, /Not that a shared vocabulary is desirable/, 'the scope limit is missing');
  assert.ok(src.includes('no unification is'), 'the actual conclusion is not stated');
});
