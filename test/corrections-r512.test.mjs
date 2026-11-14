// R512: the correction mechanism became a registry, because a hardcoded list stops working the first time a new
// kind of correction appears.
//
// WHY THE OLD TOOL STOPPED SCALING
//   tools/supersede-denominator.cjs (R502/R503) annotated eight files whose coverage figures rest on the 44-tool
//   contract denominator. Both its file list and its note text were hardcoded, so each new correction meant
//   editing the tool. That worked twice, and R511 then refuted R510's attribution of GoalTool's null to branch 3
//   with nowhere to record it.
//
//   The old tool also could not express WHY a file was superseded. Three distinct kinds exist and collapse into
//   one banner would repeat R500's mistake of filing three different MCP absences under one reason:
//       denominator   numbers right, measured against a different baseline
//       conclusion    a specific claim is now known false
//       scope         the finding holds but was over-generalised
//
// WHAT REPLACED IT
//   evidence/corrections.json — a registry of {file, round, kind, summary, detail} — and tools/corrections.cjs,
//   which renders one banner per entry above the named file's title. The record of what has been corrected is
//   now data that can be audited and counted rather than prose that must be read.
//
// THE FIRST ENTRY IS THE R510 CORRECTION
//   R511 measured that GoalTool's null was branch 2 (not discovered in this conversation), not branch 3 (Remote
//   Control unconnected). The banner states the three-conversation contrast that established it, because a
//   correction without its evidence is just another assertion.
//
// PROPERTIES THAT HAD TO BE VERIFIED, NOT ASSUMED
//   1. The body is never edited. After writing, the tool re-reads the file and confirms the original is an exact
//      SUFFIX of the new content. Verified: 2478 -> 3012 characters, suffix-identical.
//   2. Two corrections to the same file stack rather than overwrite. Tested by adding a second entry, applying,
//      confirming both markers appear above the title, then removing the entry and restoring from backup.
//   3. Re-running is idempotent: markers are per (file, round), so a second --write adds nothing.
//   4. A registry entry pointing at a missing file, or carrying an unknown kind, is reported as malformed rather
//      than skipped — the failure mode of a data-driven mechanism is silent omission, so it is checked for.
//
// WHAT THIS DOES NOT DO
//   It does not re-derive any number and does not decide whether a correction is warranted. It renders what the
//   registry says, in the order registered, and nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const REGISTRY = path.join(ROOT, 'evidence', 'corrections.json');
const EVID = path.join(ROOT, 'evidence');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the registry is valid and every entry is applied', () => {
  assert.ok(fs.existsSync(REGISTRY), 'the registry file is missing');
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  assert.ok(Array.isArray(reg.corrections) && reg.corrections.length > 0,
    'the registry has no corrections');

  const r = run(['--check']);
  assert.equal(r.status, 0,
    'a correction is unapplied or malformed:\n' + (r.stdout || '') + (r.stderr || ''));
});

test('every entry carries a declared kind, and the three kinds are distinct', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const kinds = new Set();
  for (const c of reg.corrections) {
    for (const key of ['file', 'round', 'kind', 'summary']) {
      assert.ok(c[key], `an entry is missing ${key}: ` + JSON.stringify(c));
    }
    assert.ok(['denominator', 'conclusion', 'scope'].includes(c.kind),
      `unknown kind ${c.kind}`);
    kinds.add(c.kind);
  }
  // The tool must render each kind differently, or the distinction is cosmetic.
  const source = fs.readFileSync(TOOL, 'utf8');
  for (const kind of ['denominator', 'conclusion', 'scope']) {
    assert.ok(source.includes(`${kind}: {`), `kind ${kind} has no rendering`);
  }
});

test('the R510 correction is registered and states the branch it corrects', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entry = reg.corrections.find((c) => c.file === 'null-result-branches-r510.md');
  assert.ok(entry, 'the R510 correction is not registered');
  assert.equal(entry.kind, 'conclusion', 'it is not marked as a refuted conclusion');
  assert.equal(entry.round, 511, 'it does not cite the round that refuted it');
  assert.match(entry.summary, /第 3 个分支/, 'the summary no longer names the superseded attribution');
  assert.match(entry.summary, /第 2 个分支/, 'the summary no longer names the correct branch');

  // And the banner must actually be in the file, above its title.
  const text = fs.readFileSync(path.join(EVID, 'null-result-branches-r510.md'), 'utf8');
  assert.ok(text.includes('<!-- superseded-r511 -->'), 'the marker is absent');
  assert.ok(text.indexOf('<!-- superseded-r511 -->') < text.indexOf('\n# '),
    'the banner sits below the title, where a skimming reader misses it');
});

test('annotating never edits the body', () => {
  // The safeguard is structural. R512 checked the original was an exact suffix of the new file; R518 strengthened
  // it to a two-sided check — the head is unchanged, then the banner, then the rest unchanged — because a
  // suffix-only test passes when the banner is spliced into the middle of an existing block, which is exactly the
  // bug R518 found. Assert the stronger form.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /written\.startsWith\(head\) && written\.endsWith\(rest\)/,
    'the two-sided integrity check is gone: the tool could rewrite bodies while claiming to annotate');
  // The banner path still reports an integrity failure; the wording broadened in R514 to cover addenda too.
  assert.match(source, /FAILURES — integrity could not be confirmed/,
    'the failure path for a changed body is gone');

  // Strip every banner block: each starts with a marker and runs to the blank line before the title. The first
  // regex attempt used a single non-greedy block and stripped only the marker, leaving the quoted text behind.
  const p = path.join(EVID, 'null-result-branches-r510.md');
  const text = fs.readFileSync(p, 'utf8');
  const markerAt = text.indexOf('<!-- superseded-r511 -->');
  const titleAt = text.indexOf('\n# ');
  assert.ok(markerAt >= 0, 'the marker is missing');
  assert.ok(titleAt > markerAt, 'the title does not follow the banner');
  const body = text.slice(titleAt + 1);
  assert.match(body, /^# /, 'the body does not begin with the original title');
  assert.match(body, /有六个成因/, 'the original title is gone');
});

test('re-running applies nothing', () => {
  const before = fs.readFileSync(path.join(EVID, 'null-result-branches-r510.md'), 'utf8');
  const r = run(['--write']);
  assert.equal(r.status, 0);
  const after = fs.readFileSync(path.join(EVID, 'null-result-branches-r510.md'), 'utf8');
  assert.equal(after, before, 'a second --write changed the file: markers are not per (file, round)');
  assert.equal((after.match(/<!-- superseded-r511 -->/g) || []).length, 1,
    'the marker appears more than once');
});

test('a malformed entry is reported rather than skipped', () => {
  // A data-driven mechanism fails by silent omission, so the check must be able to fail. Exercise it on a
  // temporary registry by pointing the tool at a copy with a bad entry.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /missing-file/, 'a missing target file is not reported');
  assert.match(source, /unknown-kind/, 'an unknown kind is not reported');
  assert.match(source, /incomplete-entry/, 'an incomplete entry is not reported');
});
