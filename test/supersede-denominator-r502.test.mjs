// R502: seven evidence files now say, at the top, that their denominator was superseded — without a word of
// their bodies being changed.
//
// WHY THIS IS A FIX AND NOT A REWRITE
//   R488–R494 compared the CLI contract (44 tools) against CCB source and reported coverage, divergence and
//   relations against that 44. Every figure is arithmetically right and every one invites a wrong reading,
//   because R498 measured what the shipped CLI actually registers: 39 tools, 26 corresponding to a contract
//   tool, with five of the eighteen "missing" merely under another name
//   (FileRead→Read, FileEdit→Edit, FileWrite→Write, Artifact→artifact, Agent→Task).
//
//   A reader opening contract-vs-impl-r491.md today meets "26 of 44 covered" with no way to know the shortfall
//   is not eighteen absences. The number is true; the inference it invites is false.
//
// WHY THE BODIES ARE NOT TOUCHED
//   R484 recorded this the hard way: the first attempt to "fix" a stale STATUS header rewrote a sentence about
//   hybrid PKCE to name a different round, producing a false statement citing the wrong evidence. Editing a
//   claim produces a new claim needing its own proof. Flagging a claim at the top leaves the original intact
//   and puts the correction in front of the reader.
//
//   So the tool prepends a banner and verifies, per file, that the original text is still an exact SUFFIX of
//   the new file. That check is what makes "original unchanged" a measurable property rather than a promise.
//
// THE NOTES ARE PER-FILE, BECAUSE THE DAMAGE IS PER-FILE
//   A single generic banner would be lazy and would also be wrong in places. artifact-divergence-r492 is barely
//   affected — it compares the schemas of one tool that both sides call artifact, and R500 only refined the
//   casing. tool-relation-r494's "2 unclassified" has since become something entirely different under R499/R500.
//   contract-compare-r489 compares two contract FILES and is untouched by runtime behaviour but needs the
//   reminder that it never spoke about the runtime at all. Blanket text would have flattened all of that.
//
// A TYPO THAT WAS FIXED IN THE SOURCE, NOT IN THE FILE
//   The first application rendered "登记39 个工具" with the space eaten. Patching the annotated file would have
//   broken the suffix property that proves the body is untouched, so the note text in this tool was corrected
//   and the banner re-applied from the backup. That is the only way to keep both properties.
//
// WHAT THIS DOES NOT DO
//   It does not re-derive any number. It does not claim the R488–R494 figures are wrong — they are right about
//   the contract. It only says what the denominator is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'supersede-denominator.cjs');
const EVID = path.join(ROOT, 'evidence');

const AFFECTED = [
  'contract-denominator-r488.md',
  'contract-compare-r489.md',
  'contract-fields-r490.md',
  'contract-vs-impl-r491.md',
  'artifact-divergence-r492.md',
  'tool-relation-r493.md',
  'tool-relation-r494.md',
];

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

/**
 * The banner marker for a file, read from the corrections registry.
 *
 * These tests originally asserted a fixed string, `<!-- superseded-denominator-r502 -->`. R513 migrated the eight
 * denominator corrections into evidence/corrections.json and re-applied them with the registry's marker format,
 * `<!-- superseded-r<round> -->`. The properties under test — marker above the title, idempotent application, one
 * distinct note per file — are unchanged; only where the marker text comes from changed. Deriving it from the
 * registry keeps the assertions tied to the real source rather than to a second copy of the convention.
 */
function markerFor(file) {
  const reg = JSON.parse(fs.readFileSync(path.join(EVID, 'corrections.json'), 'utf8'));
  const entry = reg.corrections.find((c) => c.file === file);
  assert.ok(entry, `${file} has no registry entry`);
  return `<!-- superseded-r${entry.round} -->`;
}

test('every affected file carries the banner', () => {
  const result = run();
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 600));

  for (const file of AFFECTED) {
    const p = path.join(EVID, file);
    assert.ok(fs.existsSync(p), `${file} is missing`);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.startsWith(markerFor(file)),
      `${file} does not begin with the banner marker`);
    // The banner must come before the title, or a reader skimming headings misses it.
    const titleIdx = text.indexOf('\n# ');
    assert.ok(titleIdx > 0, `${file} has no markdown title`);
    assert.ok(text.indexOf(markerFor(file)) < titleIdx,
      `${file} places the banner after its title, where it will be skipped`);
  }
});

test('the check mode fails when a banner is absent', () => {
  const result = run(['--check']);
  assert.equal(result.status, 0,
    '--check reports a file without the banner:\n' + (result.stdout || '') + (result.stderr || ''));
});

test('annotation is idempotent', () => {
  // The write path moved to tools/corrections.cjs in R513, so idempotence is verified through that tool. The
  // deprecated one refuses to write, which is asserted separately in corrections-migrate-r513.
  const before = new Map(AFFECTED.map((f) => [f, fs.readFileSync(path.join(EVID, f), 'utf8').length]));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'corrections.cjs'), '--write'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.equal(result.status, 0, 'corrections --write failed:\n' + (result.stderr || ''));
  // Nothing written, so no file grew.
  const after = new Map(AFFECTED.map((f) => [f, fs.readFileSync(path.join(EVID, f), 'utf8').length]));
  for (const file of AFFECTED) {
    assert.equal(after.get(file), before.get(file),
      `${file} changed size on a second --write: the banner would stack`);
  }
  // And the marker appears exactly once per file.
  for (const file of AFFECTED) {
    const text = fs.readFileSync(path.join(EVID, file), 'utf8');
    const count = text.split(markerFor(file)).length - 1;
    assert.equal(count, 1, `${file} carries the marker ${count} times`);
  }
});

test('each file gets its own note rather than one shared sentence', () => {
  // The per-file notes now live in evidence/corrections.json rather than in a `NOTES` map inside the tool (R513).
  // The property under test is unchanged: the banners must differ per file, or the annotation is boilerplate
  // that says nothing about the specific rows it is warning about.
  const reg = JSON.parse(fs.readFileSync(path.join(EVID, 'corrections.json'), 'utf8'));
  const details = AFFECTED.map((f) => {
    const entry = reg.corrections.find((c) => c.file === f);
    assert.ok(entry, `${f} has no registry entry`);
    assert.ok(entry.detail && entry.detail.length > 50, `${f}'s detail is empty or too short`);
    return entry.detail;
  });
  const unique = new Set(details);
  assert.equal(unique.size, AFFECTED.length,
    `only ${unique.size} distinct details across ${AFFECTED.length} files: the notes were flattened`);

  // And at least one note must name the specific renames, because that is the concrete correction.
  const r491 = fs.readFileSync(path.join(EVID, 'contract-vs-impl-r491.md'), 'utf8');
  assert.match(r491, /改名|renamed/, 'the r491 note no longer mentions the renames');
});

test('the notes point at the rounds that superseded them', () => {
  for (const file of AFFECTED) {
    const text = fs.readFileSync(path.join(EVID, file), 'utf8');
    const head = text.slice(0, 1800);
    assert.match(head, /r49[89]|r50[0123]/,
      `${file}'s banner does not cite any of R498–R503, the rounds that measured the runtime`);
  }
});

test('the tool states that it re-derives nothing', () => {
  // The disclaimer is now in the deprecated tool's header and in corrections.cjs, which owns the write path.
  const old = fs.readFileSync(TOOL, 'utf8');
  assert.match(old, /DEPRECATED/i,
    'the tool no longer declares itself deprecated');
  const current = fs.readFileSync(path.join(ROOT, 'tools', 'corrections.cjs'), 'utf8');
  assert.match(current, /It never edits the body/,
    'the replacement tool no longer disclaims editing the body');
  assert.match(current, /original text stays byte-identical/,
    'the replacement tool no longer states that the original stays byte-identical');
  // A correction flags a claim; it does not rewrite it. The tool must say so.
  assert.match(current, /It does not re-derive any number/,
    'the replacement tool no longer disclaims deriving numbers');
});
