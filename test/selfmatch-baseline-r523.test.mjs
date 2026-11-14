// R523: the baseline becomes a gate — `--baseline-check` now runs as part of the suite.
//
// THE GAP THIS CLOSES
//   R522 built the baseline and verified four drift paths by injection. But nothing invoked it. A drift check that
//   only runs when someone remembers is worth exactly as much as that memory — which is the same defect R516 named
//   when three of its own checks had only ever been observed passing. The baseline existed; the gate did not.
//
// WHY A SEPARATE TEST RATHER THAN A HOOK IN package.json
//   `npm test` runs files through tools/run-tests.cjs, so a failing test fails the suite with a readable message. A
//   `pre`-hook would run before the tests and could be skipped by calling the runner directly, which this repo's
//   AGENTS.md says people do. Putting it in the suite means the assertion travels with the suite.
//
// THE ORDERING PROBLEM, AND HOW IT IS HANDLED
//   Other tests write probe files into tools/ and test/ — the very directories the scanner walks. A probe that
//   exists while this test runs would appear as NEW and fail it, for a reason unrelated to real drift. So this test
//   does not assert a frozen count: it asserts that the check EXITS 0, and when it does not, prints the diff so the
//   reader sees what moved. A transient probe produces a diff naming `zz-` files, which is diagnosable in one look;
//   a real drift produces a diff naming real files.
//
//   It was tempting to make the test tolerate `zz-*` rows. That would have been wrong: it would also hide a real
//   probe accidentally left behind, which is a genuine defect of the same kind the baseline exists to catch.
//
// WHAT FAILING MEANS
//   Exit 1 means the scan set moved. That is not automatically a bug — R522 said so explicitly — but it must be
//   examined rather than absorbed. The failure message says this in the same words, so nobody reads a red suite as
//   "something broke" when the answer may be "review and re-baseline".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');
const BASE = path.join(ROOT, 'evidence', 'SELFMATCH-BASELINE.json');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the baseline exists and the current tree matches it', () => {
  assert.ok(fs.existsSync(BASE),
    'evidence/SELFMATCH-BASELINE.json is missing — run: node tools/comment-selfmatch.cjs --baseline-write');

  const r = run(['--baseline-check']);
  const out = (r.stdout || '') + (r.stderr || '');

  // A missing baseline is exit 2, not a pass. Assert the distinction so a deleted baseline cannot read as clean.
  assert.notEqual(r.status, 2, 'the baseline could not be read:\n' + out);

  if (r.status !== 0) {
    // Report the diff verbatim. A bare "expected 0, got 1" would tell a reader nothing about what moved.
    assert.fail(
      'the whole-file regex scan set drifted from its baseline.\n'
      + 'This is not automatically a defect — but it must be examined, not absorbed.\n'
      + 'If the change is intended, re-baseline with: node tools/comment-selfmatch.cjs --baseline-write\n\n'
      + out,
    );
  }
});

test('a deliberately drifted baseline fails the same assertion path', () => {
  // Proves the assertion above can fail, rather than merely passing today. R516's lesson: a check never seen to fail
  // is indistinguishable from one that cannot.
  //
  // The removal is keyed on file + pattern + occurrence, NOT on array index. Two earlier versions failed:
  //   dropping `rows[0]` removed a real scan and the diff reported NEW instead of VANISHED;
  //   dropping by file+pattern alone removed all three copies of a repeated pattern, because R522's key had no
  //   occurrence component — 111 rows collapsed into 92 distinct keys.
  //
  // A THIRD FAILURE, AND THE REAL CONSTRAINT IT EXPOSED
  //   Removing a row whose (file, pattern) repeats shifts the occurrence index of everything after it: what was
  //   occurrence 1 becomes occurrence 0, so the diff reports those rows as NEW and the removed one never appears as
  //   VANISHED. That is inherent to index-based identity, not a bug to patch — so the test must choose a victim
  //   whose (file, pattern) appears exactly once, and say why.
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  assert.ok(baseline.rows.length > 10, 'the baseline has too few rows to doctor meaningfully');

  const counts = new Map();
  for (const r of baseline.rows) {
    const k = `${r.file}\u0000${r.pattern}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const victim = baseline.rows.find((r) => r.verdict.reason === 'not-self'
    && counts.get(`${r.file}\u0000${r.pattern}`) === 1);
  assert.ok(victim, 'no unique-key not-self row exists to remove: the doctoring cannot be unambiguous');

  const doctored = JSON.parse(JSON.stringify(baseline));
  doctored.rows = doctored.rows.filter(
    (r) => !(r.file === victim.file && r.pattern === victim.pattern
      && r.occurrence === victim.occurrence),
  );
  assert.equal(doctored.rows.length, baseline.rows.length - 1,
    'the doctored baseline did not lose exactly one row');

  const tmp = path.join(ROOT, '..', '.tmp', 'r523-gate-baseline.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(doctored, null, 2), 'utf8');

  try {
    const r = run(['--baseline-check', '--baseline', tmp]);
    assert.equal(r.status, 1, 'a baseline missing a row did not fail the check');
    // DIRECTION MATTERS, AND THE FIRST ASSERTION HAD IT BACKWARDS.
    //   The doctored baseline has one FEWER row than the live tree. The live tree therefore contains a scan the
    //   baseline does not know about — which the tool reports as NEW, not VANISHED. VANISHED is the opposite case:
    //   the baseline lists something the tree no longer has. Asserting VANISHED here failed against correct
    //   behaviour, and the tool's message ("a scan that did not exist in the baseline") was already right.
    assert.match(r.stdout, /NEW: 1/,
      'the extra row was not reported as new:\n' + (r.stdout || ''));
    assert.match(r.stdout, new RegExp(victim.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the affected row is not named in the report');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('the opposite direction reports VANISHED', () => {
  // The companion to the test above. Appending a row the live tree does not have makes the baseline know about a
  // scan that is gone, which is the VANISHED case — and the one whose absence would hide a broken finder.
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const doctored = JSON.parse(JSON.stringify(baseline));
  doctored.rows.push({
    file: 'tools/zz-ghost-r523.cjs',
    pattern: '/function\\s+ghost\\(/',
    occurrence: 0,
    kind: 'structural',
    verdict: { reason: 'not-self', note: 'doctored for the test' },
  });
  const tmp = path.join(ROOT, '..', '.tmp', 'r523-gate-ghost.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(doctored, null, 2), 'utf8');

  try {
    const r = run(['--baseline-check', '--baseline', tmp]);
    assert.equal(r.status, 1, 'a ghost baseline row did not fail the check');
    assert.match(r.stdout, /VANISHED: 1/,
      'the ghost row was not reported as vanished:\n' + (r.stdout || ''));
    assert.match(r.stdout, /zz-ghost-r523/,
      'the vanished row is not named in the report');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('the gate reports rather than silently tolerating probe files', () => {
  // Documents the deliberate decision NOT to whitelist `zz-*` rows: a leftover probe is a real defect.
  const source = fs.readFileSync(path.join(ROOT, 'test', 'selfmatch-baseline-r523.test.mjs'), 'utf8');
  assert.match(source, /It was tempting to make the test tolerate/,
    'the reasoning against whitelisting probes is gone');

  // The absence-of-whitelist assertion is built without a regex literal in this file. Written as
  // `assert.equal(/zz-|exclude/i.test(tool), false)` it became a NEW scan of THIS file — the finder paired it with
  // the readFileSync above — and failed the very baseline it was protecting. Third occurrence of that trap in three
  // rounds, which is why it is now handled by construction rather than by remembering.
  const tool = fs.readFileSync(TOOL, 'utf8');
  const whitelistTerms = ['ignore', 'exclude'].map((s) => `${s}Probe`);
  for (const term of whitelistTerms) {
    assert.equal(tool.includes(term), false,
      `the tool whitelists probe files via "${term}", which would hide a leftover probe`);
  }
});
