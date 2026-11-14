// R517: two branches had never been exercised, and one of them turned out to be masking a real inconsistency.
//
// WHAT WAS UNTESTED
//   `--write` had no failure-path test at all, and `incomplete-addendum` existed as a status that nothing ever
//   triggered. R516 recorded both gaps explicitly rather than claiming coverage.
//
// THE INCONSISTENCY FOUND WHILE CLOSING THEM
//   A scratch file with no markdown title was given a banner AND an addendum. What happened:
//       apply()          -> "annotated", ok:true           (banner prepended above the first line of prose)
//       applyAddendum()  -> refused: "no markdown title to anchor on"
//   So the two writers disagreed about what "the top of the file" means. `apply()` never checked for a title: it
//   prepended the banner to whatever the first line was and reported success because the original text was still
//   an exact suffix. The suffix property held while the placement was wrong — which is exactly the class of defect
//   the suffix check cannot catch on its own.
//
//   Fixed by giving apply() the same title requirement, so a titleless file is refused by BOTH writers and left
//   untouched. Verified: `0 banner(s) applied`, the addendum reported as `skipped`, exit 1, file unchanged, and
//   the correction's status stays `needs-banner`.
//
// THE SKIP LOGIC, WHICH HAD ALSO BEEN UNREACHABLE
//   Before this round, banners were always applied before addenda, so `applyAddendum`'s banner guard could never
//   fire. It is now a genuine second line of defence: when a banner fails to apply, its addendum is skipped with a
//   printed reason rather than attempted. That guard is still not itself exercised by a test — reaching it requires
//   bypassing the caller's skip, which would test the harness rather than the tool — and the source says so.
//
// WHAT THIS ESTABLISHES ABOUT THE SUFFIX CHECK
//   The suffix check proves the body was not edited. It does NOT prove the banner landed in a sensible place, and
//   a placement rule has to be checked separately. That distinction is the substance of this round.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVID = path.join(ROOT, 'evidence');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrections-r517-'));
const SCRATCH = 'zz-scratch-r517-test.md';
const scratchPath = path.join(EVID, SCRATCH);

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
}

function registry(name, data) {
  const p = path.join(tmpdir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

test.after(() => {
  fs.rmSync(scratchPath, { force: true });
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('a titleless file is refused by both writers and left untouched', () => {
  const original = '没有标题的文件。\n';
  fs.writeFileSync(scratchPath, original, 'utf8');

  const reg = registry('notitle', {
    corrections: [{ file: SCRATCH, round: 9980, kind: 'scope', summary: 's', detail: 'd' }],
    addenda: [{ file: SCRATCH, round: 9981, text: '依据 R504 的实测。' }],
  });

  const w = run(['--write', '--registry', reg]);
  assert.equal(w.status, 1, '--write did not fail on a titleless file');
  assert.match(w.stderr, /no markdown title to place a banner above/,
    'the banner refusal does not name the reason');
  assert.match(w.stdout, /skipped:.*r9981/,
    'the addendum was attempted despite its banner not landing');

  // The file must be byte-identical: a refusal that still writes would be worse than no check.
  assert.equal(fs.readFileSync(scratchPath, 'utf8'), original,
    'the file was modified despite both writers refusing');

  const d = JSON.parse(run(['--json', '--registry', reg]).stdout);
  assert.equal(d.rows[0].status, 'needs-banner', 'the correction is not reported as unapplied');
  assert.equal(d.addenda[0].status, 'needs-addendum', 'the addendum is not reported as unapplied');
});

test('apply() and applyAddendum() agree on the title requirement', () => {
  // The inconsistency this round fixed: one writer required a title, the other did not.
  //
  // R518 then moved both onto a shared `splitAtTitle()` helper, so the assertion no longer looks for the anchor
  // expression in each function — it looks for the shared helper, which is a stronger property: the two cannot
  // disagree about where the banner block ends if neither computes it.
  const source = fs.readFileSync(TOOL, 'utf8');
  const applyBody = source.slice(source.indexOf('function apply(entry)'),
    source.indexOf('function applyAddendum'));
  const addBody = source.slice(source.indexOf('function applyAddendum'));

  assert.match(applyBody, /no markdown title to place a banner above/,
    'apply() no longer requires a title');
  assert.match(addBody, /no markdown title to anchor on/,
    'applyAddendum() no longer requires a title');
  assert.match(applyBody, /splitAtTitle\(original\)/,
    'apply() does not use the shared title splitter');
  assert.match(addBody, /splitAtTitle\(original\)/,
    'applyAddendum() does not use the shared title splitter');
});

test('an incomplete addendum is reported for each missing field', () => {
  const reg = registry('incomplete', {
    corrections: [{ file: 'tool-absence-r500.md', round: 9990, kind: 'scope', summary: 's', detail: 'd' }],
    addenda: [
      { file: 'tool-absence-r500.md', round: 9991 },  // no text
      { file: 'tool-absence-r500.md', text: '依据 R504。' }, // no round
      { round: 9992, text: '依据 R505。' },            // no file
    ],
  });
  const d = JSON.parse(run(['--json', '--registry', reg]).stdout);
  assert.equal(d.addenda.length, 3);
  for (const a of d.addenda) {
    assert.equal(a.status, 'incomplete-addendum',
      'a missing field produced a different status: ' + JSON.stringify(a));
  }
  assert.equal(run(['--check', '--registry', reg]).status, 1,
    '--check passed despite incomplete addenda');
});

test('the addendum guard is documented as defence, not as verified', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /second line of defence, not the primary one/i,
    'the guard is no longer described as defensive');
  assert.match(source, /NOT exercised by any test/,
    'the tool no longer admits the guard is unexercised');
  assert.match(source, /described as verified would be a claim nobody checked/,
    'the distinction between defensive and verified is gone');
});

test('the suffix check is documented as not checking placement', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /It does NOT prove the banner landed in a sensible place/,
    'the tool no longer distinguishes body integrity from placement');
  // Wraps as: "So a\n//   placement rule has to be checked separately"
  assert.match(source, /placement rule has to be checked separately/,
    'the consequence is no longer stated');
});
test('the real registry still passes after the title requirement', () => {
  const c = run(['--check']);
  assert.equal(c.status, 0, 'the real registry now fails:\n' + (c.stdout || '') + (c.stderr || ''));
});

test('every evidence file the registry names has a markdown title', () => {
  // The new requirement would refuse any file without one, so this is the invariant behind it.
  const reg = JSON.parse(fs.readFileSync(path.join(EVID, 'corrections.json'), 'utf8'));
  for (const c of reg.corrections) {
    const p = path.join(EVID, c.file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.indexOf('\n# ') >= 0, `${c.file} has no markdown title`);
  }
});
