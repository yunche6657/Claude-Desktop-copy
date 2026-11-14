// R539: replacing a hand-written twin table with content-derived pairing, and listing what the table could not.
//
// THE DEFECT INHERITED FROM R538
//   R538 fixed six addenda that had reached only the evidence copy, by adding an `alsoFile` field to each. That is a
//   hand-written mapping — the same shape as R534's nine-entry mutation table, which could not say what it omitted.
//   A seventh addendum written later would sit on one side again, the registry would still read `appended`, and
//   nothing would name the omission.
//
// WHAT THIS ROUND BUILT
//   `tools/handoff-twins.cjs` pairs by content: two files are twins when they share the same `# ` markdown title.
//   That needs no table, is checkable by a reader, and produces the one output a table cannot — a LIST of files with
//   no twin.
//
// MEASURED
//   191 evidence files, 187 HANDOFF files.
//       paired     113
//       unpaired    77
//       no-title     1  (evidence/official-changelog.md, which starts at `## 2.1.304` — it is a collected
//                        changelog with no top-level heading, so content pairing cannot apply to it)
//       ambiguous    0
//   critical: 0 — no file that carries a correction is unpaired.
//
//   The 77 unpaired files are not defects: many evidence files were written for a round whose HANDOFF was never made,
//   or was made under a different title. They are listed rather than counted, because the point of this round is that
//   the list is what makes the gap visible.
//
// WHAT IS NOT CLAIMED
//   Not that title matching is complete: a HANDOFF whose heading was edited no longer pairs, and one evidence file
//   legitimately has no title at all. Not that `critical: 0` means every addendum is on both sides — it means every
//   file the registry points at can be paired, which is a weaker statement. R538's own test checks the markers.
//   Not that the 77 unpaired files should get HANDOFFs: that is a judgement about which rounds deserve one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'handoff-twins.cjs');
const REGISTRY = path.join(ROOT, 'evidence', 'corrections.json');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('no file carrying a correction is missing its twin', () => {
  // This is the assertion the whole round exists for. R538 found six corrections on one side only; if a seventh is
  // ever written against an evidence file with no HANDOFF, it appears here.
  const d = report();
  assert.deepEqual(d.critical, [],
    'these files carry a correction but have no twin to propagate it to: '
    + JSON.stringify(d.critical.map((c) => `${c.evidence} (${c.status})`)));
});

test('every addendum target and every corrected file is paired', () => {
  // Stated independently of the tool's own flag, so the check does not depend on the tool's bookkeeping being right.
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const d = report();
  const byEvidence = new Map(d.rows.map((r) => [path.basename(r.evidence), r]));

  const targets = new Set();
  for (const a of reg.addenda || []) { targets.add(a.file); if (a.alsoFile) targets.add(a.alsoFile); }
  for (const c of reg.corrections || []) targets.add(c.file);

  const unpaired = [];
  for (const name of targets) {
    const row = byEvidence.get(name);
    // A HANDOFF registered directly as its own correction has no evidence-side twin to find; only evidence files are
    // indexed here, so absence from this map is expected for those and is not a failure.
    if (!row) continue;
    if (row.status !== 'paired') unpaired.push(`${name} (${row.status})`);
  }
  assert.deepEqual(unpaired, [], 'registered evidence files with no twin: ' + unpaired.join(', '));
});

test('the pairing is content-derived, not a table', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  // No hardcoded map of filenames may exist: that is exactly the defect being replaced. Written with a plain substring
  // loop rather than a regex applied to the file text — that pairing is what tools/comment-selfmatch.cjs flags as a
  // self-scan, and this file became a NEW risky row when it was written that way.
  const forbidden = ['const PAIRS = ', 'const TWINS = ', 'const MAP = '];
  const found = forbidden.filter((needle) => src.includes(needle));
  assert.deepEqual(found, [], 'the tool has gone back to a hand-written mapping table: ' + found.join(', '));
  assert.ok(src.includes('function titleOf('), 'title extraction is gone');
  assert.ok(src.includes('byTitle'), 'pairing no longer indexes by title');
});

test('a titleless file is reported, not silently skipped', () => {
  // evidence/official-changelog.md is a collected changelog starting at `## 2.1.304`. Content pairing cannot apply,
  // and the honest outcome is a named status rather than an assumed pass.
  const d = report();
  const noTitle = d.rows.filter((r) => r.status === 'no-title');
  assert.equal(noTitle.length, 1, `expected exactly one titleless file, found ${noTitle.length}`);
  assert.match(noTitle[0].evidence, /official-changelog\.md$/,
    'a different file lost its title: ' + noTitle[0].evidence);
  // And it really has no top-level heading.
  const text = fs.readFileSync(path.join(ROOT, noTitle[0].evidence), 'utf8');
  assert.equal(text.split('\n').some((l) => l.startsWith('# ')), false,
    'the file now has a `# ` heading, so it should pair like any other');
});

test('unpaired files are listed rather than counted away', () => {
  const d = report();
  assert.ok(d.byStatus.unpaired > 0, 'no unpaired files: the tool may not be scanning');
  // The list must be available, because a count cannot tell a reader which round lacks a HANDOFF.
  const listed = d.rows.filter((r) => r.status === 'unpaired');
  assert.equal(listed.length, d.byStatus.unpaired, 'the reported count and the listed rows disagree');
  for (const r of listed) {
    assert.ok(r.evidence.startsWith('evidence/'), `unexpected path in the unpaired list: ${r.evidence}`);
  }
});

test('--check exits non-zero only when a correction has nowhere to go', () => {
  const d = report();
  const r = run(['--check']);
  // Written WITHOUT an if/else around the asserts: test/test-hygiene.test.mjs rejects "guard-condition assertions",
  // because `if (a) { assert } else { assert }` reads fine and silently skips a branch the moment the condition is
  // neither expected state. The expected code is derived and compared in one assertion instead.
  const expected = d.critical.length === 0 ? 0 : 1;
  assert.equal(r.status, expected,
    `--check exited ${r.status} with ${d.critical.length} critical file(s), expected ${expected}`);
});

test('the limits of title matching are stated', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /An unpaired file is not a defect/, 'the caveat about unpaired files is gone');
  assert.match(src, /cannot say what it omits/, 'the reason a table was replaced is not recorded');
});
