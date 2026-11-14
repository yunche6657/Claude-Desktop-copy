// R585: a flag id repeated across five files and fifteen sites — a container no detector in this project can see.
//
// HOW IT SURFACED
//   R580 measured that 78% of replica-shaped test files never appear in a repeated-list group. Reading one of them —
//   `test/cli-mcp-host-sources-r378.test.mjs` — showed what the list detectors miss:
//
//       '513873720'   test/cli-mcp-host-sources-r378.test.mjs           2 sites
//                     test/growthbook-cli-security-r378.test.mjs        8
//                     test/growthbook-cli-security-extra-r378.test.mjs  1
//                     desktop/cli-mcp-host-sources.cjs                  3
//                     desktop/growthbook-provider.cjs                   1
//
//   No bracketed list, so `duplicated-lists` never sees it and `group-provenance` is never asked. Measured population:
//   eight pure-numeric ids in two or more files, led by `513873720` at 5 files / 15 uses.
//
// WHY A FLAG ID IS WORSE THAN A LIST TO DUPLICATE
//   A list with a typo usually fails loudly — the entry does not match, a branch stops firing. A flag id with a typo fails
//   SILENTLY: a wrong id reads `undefined`, the gate reports "off", and the feature stays dark with no error anywhere. The
//   failure is a missing behaviour, not a wrong one — the class this project has spent many rounds learning to distrust.
//
//   `desktop/cli-mcp-host-sources.cjs` has the id at three code sites plus a comment (39, 50, 51, 60). A typo at one leaves
//   one observation path watching a flag that does not exist while the other keeps working.
//
// WHY THE COUNT IS NOT A WORK LIST
//   This is R563's reasoning applied to a string: `cli-mcp-host-sources-r378.test.mjs` exists to assert that the PRODUCTION
//   module reads the right flag, so it must name the same id. Extract the id into a shared constant and the test asserts a
//   constant equals itself — true for any value. So finding these CHANGES WHERE A READER LOOKS, not what they change.
//
// THE FIRST VERSION OF THE SCAN WAS TOO WIDE, AND ITS TOP ROWS SAID SO
//   Ranking literals by file count alone returned 3585 rows headed by `"--json"` (127 files), `"user"` (118), `"fixture"`
//   (113) — test vocabulary and CLI flags. A word used in ninety fixtures is a convention, not a value that must change in
//   one place. Narrowing by SHAPE — a digit, or hyphen/underscore segments, or camelCase, and 6+ characters — cut it to 1281
//   and made the numeric ids visible at 8. Function names repeated across two files still number 632, which is why they are
//   not enumerated: a set that size is not a finding.
//
// WHAT IS NOT CLAIMED
//   Not that any id is currently mistyped: nothing here compares characters, only literal equality.
//   Not that eight is all: the scan needs a quoted literal of 6+ characters, so an id built by concatenation, read from
//   configuration, or formatted into a template is invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FLAG_IDS, WORST, WHY_NOT_EXTRACT } from '../desktop/flag-id-repetition.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'repeated-constants.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 512 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the flag id is still repeated across five files', () => {
  const d = runScan();
  const hit = d.rows.find((r) => r.value === '513873720');
  assert.ok(hit, 'the flag id is no longer found at all');
  assert.ok(hit.fileCount >= 5, `the id is now in ${hit.fileCount} files, fewer than the recorded 5`);
  assert.ok(hit.occurrences >= 15, `only ${hit.occurrences} occurrences, fewer than the recorded 15`);
  // The production module must still be one of them, or the "typo is silent" argument loses its subject.
  assert.ok(hit.files.some((f) => f.startsWith('desktop/cli-mcp-host-sources.cjs')),
    'the production module no longer names the id');
});

test('the production module carries the id at more than one code site', () => {
  const lines = fs.readFileSync(path.join(ROOT, WORST.productionFile), 'utf8').split('\n');
  const sites = lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.includes(WORST.id) && !x.l.trim().startsWith('//'));
  assert.ok(sites.length >= 3, `only ${sites.length} code sites in ${WORST.productionFile}`);
  for (const s of sites) assert.match(s.l, /513873720/, `line ${s.n} no longer names the id`);
});

test('every recorded id is still found, and no numeric id was invented', () => {
  const d = runScan();
  const numeric = d.rows.filter((r) => /^[0-9]{6,}$/.test(r.value)).map((r) => r.value).sort();
  for (const f of FLAG_IDS) {
    assert.ok(numeric.includes(f.id), `${f.id} is recorded but no longer found`);
  }
  // Allow growth, but a recorded id that vanished means the record is stale or the scan broke.
  assert.ok(numeric.length >= FLAG_IDS.length, `only ${numeric.length} numeric ids found, fewer than recorded`);
});

test('the scan separates constants from vocabulary by shape', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(/function looksLikeConstant/.test(src), 'the shape filter is gone');
  // The measurement sentence wraps, so the fragment is matched with tolerance.
  assert.ok(/returned 3585 literals/.test(src), 'the first version\'s failure is not recorded');
  assert.ok(/--json/.test(src), 'the vocabulary example is not named');
  // And the effect: vocabulary must not dominate the output.
  const d = runScan();
  const top = [...d.rows].sort((a, b) => b.fileCount - a.fileCount)[0];
  assert.notEqual(top.value, '--json', 'the scan has widened back to vocabulary');
  assert.notEqual(top.value, 'user');
});

test('the record refuses to treat the count as a work list', () => {
  assert.match(WHY_NOT_EXTRACT.rule, /deliberate duplication/);
  assert.match(WHY_NOT_EXTRACT.reason, /agree with itself/);
  assert.match(WHY_NOT_EXTRACT.precedent, /R563/);
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'flag-id-repetition.cjs'), 'utf8');
  assert.match(src, /not a to-do list|not a work list/i, 'the refusal is not stated');
});

test('the silent-failure argument is specific rather than generic', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'flag-id-repetition.cjs'), 'utf8');
  assert.match(src, /reads `undefined`/, 'the failure mechanism is not named');
  assert.match(src, /missing behaviour/, 'the character of the failure is not stated');
});

test('the scan limitation is stated', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'flag-id-repetition.cjs'), 'utf8');
  assert.ok(/built by concatenation/.test(src), 'the blind spot is not stated');
  assert.ok(/literal equality/.test(src), 'the no-typo-check caveat is missing');
});
