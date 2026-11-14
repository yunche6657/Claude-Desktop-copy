// R496: the obvious close-out step was checked first, found unsound, and replaced with the verifiable one.
//
// WHAT WAS PLANNED
//   R495 found 157 scripts that no test and no evidence file mentions, and proposed adding
//   `// produced: evidence/<file>.md` headers so they become traceable.
//
// WHY THAT WAS DROPPED
//   Checked before writing: of those 157, ZERO have an evidence file that names them. There is no provenance
//   to record. Writing the header anyway would have meant inventing one — a fabricated claim placed in 157
//   files, each of which would then look sourced to a future reader.
//
//   A file that says where it came from and is wrong is worse than a file that says nothing. So the round
//   reports the one property that IS verifiable instead.
//
// WHAT IS MEASURED INSTEAD
//   Whether each script OPENS with a comment describing itself: the first non-blank line, after skipping a
//   shebang and a `'use strict'` prologue, begins with `//` or `/*`.
//
//       220 scripts — 163 documented, 57 not
//
//   The largest undocumented scripts are the actionable part: proof-hidden-history-import-confirm.cjs at
//   43.3 KB, then a cluster of proof-* files between 10 and 18 KB. Those are round-specific proof harnesses
//   whose purpose exists only in the memory of whoever wrote them.
//
// A DETECTION CORRECTION
//   The first pass reported 90 undocumented, including scripts written this session whose line 1 is
//   `#!/usr/bin/env node` and whose explanation is on line 3. It tested the literal first non-blank line.
//   Skipping shebang and `'use strict'` brought the count to 57.
//
//   This is the same class of error recorded in R486 (recall harness counting its own write-up), R493 (a
//   detector matching its own doc comment), and R495 (an index counting its own output as mentions): the
//   check did not describe the thing being measured, and its number was read as a finding. The response here
//   is that the report prints `firstMeaningful` alongside each count, so the inspection is visible.
//
// WHAT THIS IS NOT
//   Not a usefulness judgement. A one-word comment passes the test; a thorough explanation placed after the
//   first statement fails it. It is a mechanical check of self-description, and it is stated as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'script-docs.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('every script is classified as documented or not', () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 800));
  const r = JSON.parse(result.stdout);

  const onDisk = fs.readdirSync(path.join(ROOT, 'tools')).filter((n) => /\.(cjs|mjs)$/.test(n));
  assert.equal(r.total, onDisk.length, 'the classified count does not match the directory');
  assert.equal(r.documented + r.undocumented.length, r.total,
    'the two buckets do not add up to the total');
  // Every undocumented row must carry what was actually inspected, so the check is auditable.
  for (const row of r.undocumented) {
    assert.ok(row.firstMeaningful, `${row.name} has no recorded first line`);
    assert.ok(!/^(\/\/|\/\*)/.test(row.firstMeaningful),
      `${row.name} is listed undocumented but its first meaningful line is a comment`);
  }
});

test('the shebang and use-strict prologue are skipped before inspection', () => {
  // The bug that made this number 90 instead of 57: scripts whose line 1 is `#!/usr/bin/env node`.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /startsWith\('#!'\)/, 'the shebang skip is gone');
  assert.match(source, /use strict/, 'the use-strict skip is gone');

  // Empirical: the scripts written this session have a shebang then a comment, and must count as documented.
  const r = JSON.parse(run(['--json']).stdout);
  const byName = new Map(r.rows.map((x) => [x.name, x]));
  for (const name of ['artifact-divergence.cjs', 'audit-evidence.cjs', 'contract-compare.cjs',
    'contract-fields.cjs', 'tool-relation.cjs', 'script-docs.cjs']) {
    const row = byName.get(name);
    assert.ok(row, `${name} is not classified`);
    assert.equal(row.documented, true,
      `${name} is a script with a shebang and a description; it must count as documented`);
  }
});

test('the header line count reflects consecutive leading comments', () => {
  // A script with a multi-line explanation should report more than one header line.
  const r = JSON.parse(run(['--json']).stdout);
  const byName = new Map(r.rows.map((x) => [x.name, x]));
  const audited = byName.get('audit-evidence.cjs');
  assert.ok(audited, 'audit-evidence.cjs missing');
  assert.ok(audited.headerLines >= 5,
    `audit-evidence.cjs reports only ${audited.headerLines} header lines; it opens with a long explanation`);

  // And the count must stop at the first statement.
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'audit-evidence.cjs'), 'utf8');
  const firstCode = source.split(/\r?\n/).findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith('#!') && !/^['"]use strict['"];?$/.test(t)
      && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
  });
  assert.ok(audited.headerLines <= firstCode,
    'the header count ran past the first statement');
});

test('the undocumented set is non-trivially empty and the largest are named', () => {
  const r = JSON.parse(run(['--json']).stdout);
  assert.ok(r.undocumented.length > 0,
    'no script lacks a header: either every script gained one or the detector stopped working');
  // The report must surface size, because a 40 KB uncommented script is the real loss.
  const biggest = r.undocumented.slice().sort((a, b) => b.bytes - a.bytes)[0];
  assert.ok(biggest.bytes > 10000,
    `the largest undocumented script is only ${biggest.bytes} bytes: re-derive whether the set changed`);

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /largest scripts with no header/, 'the size ordering is gone from the report');
  assert.match(source, /--list/, 'the name listing is gone');
});

test('the tool states that a header is not a usefulness judgement', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /not of usefulness|not a usefulness judgement/i,
    'the tool no longer disclaims that documentation is not usefulness');
  assert.match(source, /after the first statement fails/,
    'the tool no longer admits the mechanical limitation of the check');
});

test('the abandoned provenance plan is recorded, not silently dropped', () => {
  // A future reader must be able to see why no `produced:` headers were added, or someone will add them.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /ZERO have an evidence file/, 'the reason for dropping the plan is gone');
  assert.match(source, /inventing one|fabricated claim/,
    'the tool no longer explains why a guessed provenance would be worse than none');
});
