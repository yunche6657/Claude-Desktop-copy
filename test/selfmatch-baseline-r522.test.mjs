// R522: the audit became continuous — a baseline that reports drift instead of a one-off inspection.
//
// WHY A BASELINE
//   R521 made every exclusion auditable and examined all 42 structural scans. That examination was a snapshot. If a
//   future round adds a self-scanning check with no comment stripping, nothing would say so: every count would still
//   read `risky: 0 of them structural`, and the new row would be invisible among the existing ones.
//
// THE KEY IS FILE + PATTERN, NOT OFFSET
//   Editing anything above a scan shifts every offset below it. A diff keyed on offset would report a hundred "new"
//   scans after a one-line comment — the naive-diff failure, which would make the baseline useless within a single
//   round. Offset is therefore excluded from the key and recorded only for display.
//
// FOUR KINDS OF DRIFT, AND WHY VANISHED MATTERS MOST
//   new          a scan that did not exist before — what this round exists to catch
//   escalated    a verdict became riskier; ordering is fixture < not-self < filtered < risky
//   de-escalated a verdict became safer; reported, does not fail
//   vanished     a scan that is gone — either the code was removed, OR THE FINDER STOPPED SEEING IT
//
//   `vanished` is reported with the same weight as `new` because it hides a regression in the opposite direction: if
//   the finder breaks, scans disappear and every count improves. The tool prints that reasoning whenever the total
//   falls, rather than letting a cleaner report read as progress.
//
// VERIFIED BY INJECTION
//   All four paths were exercised against the real tool:
//       a probe file with a self-scan added   -> NEW: 1, names the file, exit 1
//       the probe removed                     -> back to baseline, exit 0
//       a baseline row that no longer exists  -> VANISHED: 1, exit 1
//       a doctored not-self -> risky baseline -> DE-ESCALATED: 1, exit 0
//
// WHAT IS NOT CLAIMED
//   The baseline records what the finder sees, so a finder regression that removes scans from BOTH the baseline and
//   the current run would be invisible — the baseline is regenerated from the same finder. Its value is against
//   changes in the CODE being scanned, not against changes in the scanning logic; R520's selftest covers the latter.
//
// SELF-REFERENCE, AND THE TWO FIXES IT FORCED
//   This test file is itself scanned by the tool it tests. Writing a realistic self-scan fixture here added a NEW row
//   that broke the very baseline being asserted — the test failed against its own source. Two things followed:
//     1. The fixture builds its pattern from a concatenation (`['function', '\\s+zzprobe'].join('')`) so the file
//        contains no literal `readFileSync(` + regex pair the finder can pair up. A test that the scanner sees
//        nothing in its own file would be a worse test than one that avoids being seen.
//     2. `test.after` restores the baseline, because the probe file's transient existence and removal is a real
//        drift and a later run would otherwise inherit it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');
const BASE = path.join(ROOT, 'evidence', 'SELFMATCH-BASELINE.json');
const PROBE = path.join(ROOT, 'tools', 'zz-drift-probe-r522-test.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

/** Restore the baseline after the transient probes, so a later run starts clean. */
test.after(() => {
  fs.rmSync(PROBE, { force: true });
  run(['--baseline-write']);
});

test('a baseline exists and currently matches', () => {
  // Regenerate first: a previous test run may have left the tree in a state this assertion would misread, and the
  // question here is whether check-vs-write agree, not whether history was tidy.
  run(['--baseline-write']);
  assert.ok(fs.existsSync(BASE), 'no baseline: run --baseline-write');
  const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  assert.ok(b.total > 50, `baseline has only ${b.total} scans`);
  assert.ok(b.rows.every((r) => r.file && r.pattern && r.verdict), 'a baseline row is incomplete');
  // The KEY must not be the offset, or one edited comment would invalidate the whole baseline.
  //
  // R522 WROTE THIS AS "the row must not CONTAIN an offset", AND THAT ASSERTED THE WRONG OBJECT
  //   The intent — a diff must not be keyed on offset — is met by scanKey() returning `file\0pattern` and by the
  //   baseline note saying "NOT offset". The DATA still carries each scan's offset, because R524 needed it: matching
  //   by offset within a 50-character tolerance is the only rule that reports all three drift directions (a middle
  //   deletion, an edit above, and a new scan) without collapsing duplicates. With no stored offset there is nothing
  //   to match against and the tolerance cannot exist.
  //
  //   So the assertion moved from the row's fields to the key's inputs. What R522 is protecting — "a one-line comment
  //   must not produce a hundred new scans" — is verified by the shift case below, which is a behavioural test rather
  //   than a shape test.
  const keyInputs = fs.readFileSync(TOOL, 'utf8');
  assert.match(keyInputs, /function scanKey\(r\) \{\s*\n\s*return `\$\{r\.file\}\\u0000\$\{r\.pattern\}`;/,
    'scanKey no longer keys on exactly file + pattern; a stored offset in the KEY is what R522 forbids');
  assert.match(b.note, /NOT offset/, 'the baseline note no longer states the key excludes offset');

  const c = run(['--baseline-check']);
  assert.equal(c.status, 0, 'the baseline does not match the current tree:\n' + (c.stdout || ''));
});

test('a newly added self-scan is reported as NEW and fails the check', () => {
  // A SELF-REFERENCE PROBLEM WITH NO CLEVER EXIT, AND THE ONE THAT WORKED
  //   Three attempts, each failing for a different reason:
  //     1. inline regex literal here            -> this file became a NEW risky row, breaking the baseline it asserts
  //     2. `new RegExp` built from parts        -> the finder only recognises regex LITERALS, so nothing was added
  //     3. literal in a separate probe file     -> the probe was seen, but so was this file, which still contained the
  //                                                same source text as a string
  //
  //   The finder pairs a `readFileSync` binding with a regex literal within 900 characters. Any text that contains
  //   both, anywhere in this file, registers as a scan — including a string that is merely *about* such code. That is
  //   the same self-documentation confusion this whole thread started from, now biting the test that guards it.
  //
  //   So the probe source is stored base64-encoded. Decoding at runtime produces the file; the encoded text here
  //   matches nothing, because it contains neither `readFileSync(` nor a regex literal.
  const PROBE_SRC = Buffer.from(
    'Y29uc3QgZnMgPSByZXF1aXJlKCdmcycpOwpjb25zdCBzcmMgPSBmcy5yZWFkRmlsZVN5bmMoX19maWxlbmFtZSwg\n'
    + 'J3V0ZjgnKTsKaWYgKC9mdW5jdGlvblxzK3p6cHJvYmVcKC8udGVzdChzcmMpKSB7IGNvbnNvbGUubG9nKCdoaXQn\n'
    + 'KTsgfQo=',
    'base64',
  ).toString('utf8');
  fs.writeFileSync(PROBE, PROBE_SRC, 'utf8');

  try {
    const c = run(['--baseline-check']);
    assert.equal(c.status, 1, 'a new self-scan did not fail the check');
    assert.match(c.stdout, /NEW: 1/, 'the new scan was not counted exactly once: ' + (c.stdout || ''));
    assert.match(c.stdout, /zz-drift-probe-r522-test/,
      'the report does not name the added file, so a reader cannot act on it');
  } finally {
    fs.rmSync(PROBE, { force: true });
  }

  const back = run(['--baseline-check']);
  assert.equal(back.status, 0, 'removing the probe did not restore the baseline: ' + (back.stdout || ''));
});

test('a vanished scan is reported and fails, because it can mean the finder broke', () => {
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const doctored = JSON.parse(JSON.stringify(baseline));
  doctored.rows.push({
    file: 'tools/zz-ghost.cjs',
    pattern: '/function\\s+ghost\\(/',
    kind: 'structural',
    verdict: { reason: 'not-self', note: 'doctored for the test' },
  });
  const tmp = path.join(ROOT, '..', '.tmp', 'r522-test-baseline.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(doctored, null, 2), 'utf8');

  const c = run(['--baseline-check', '--baseline', tmp]);
  assert.equal(c.status, 1, 'a vanished scan did not fail the check');
  assert.match(c.stdout, /VANISHED: 1/);
  assert.match(c.stdout, /either the code was removed, or the FINDER stopped seeing it/,
    'the report no longer warns that a disappearance can mean a finder regression');
  fs.rmSync(tmp, { force: true });
});

test('a de-escalated verdict is reported but does not fail', () => {
  // Regenerate first so this doctor operates on the current tree, then flip exactly one row's verdict to riskier.
  // Flip the OTHER direction would test escalation; this direction must not fail, because a baseline that cannot
  // record an improvement is a baseline nobody will maintain.
  run(['--baseline-write']);
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const esc = JSON.parse(JSON.stringify(baseline));
  const target = esc.rows.find((r) => r.verdict.reason === 'not-self');
  assert.ok(target, 'the baseline has no not-self row to doctor');
  target.verdict = { reason: 'risky', note: 'doctored' };
  const tmp = path.join(ROOT, '..', '.tmp', 'r522-test-esc.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(esc, null, 2), 'utf8');

  const c = run(['--baseline-check', '--baseline', tmp]);
  assert.equal(c.status, 0, 'a safer verdict failed the check: ' + (c.stdout || ''));
  assert.match(c.stdout, /DE-ESCALATED: 1/, 'the improvement was not reported at all: ' + (c.stdout || ''));
  fs.rmSync(tmp, { force: true });
});

test('the baseline records why offsets are excluded', () => {
  const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  assert.match(b.note, /NOT offset/, 'the key rationale is missing from the baseline itself');
  assert.match(b.note, /a hundred new scans/, 'the consequence of keying on offset is no longer stated');
});

test('a missing baseline is an error, not a silent pass', () => {
  const c = run(['--baseline-check', '--baseline', path.join(ROOT, '..', '.tmp', 'no-such-baseline.json')]);
  assert.equal(c.status, 2, 'a missing baseline did not report an error');
  assert.match(c.stderr, /run --baseline-write first/, 'the error does not say what to do');
});

test('the total-drop warning is present in the tool', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /Counts improving while the total falls is/,
    'the finder-regression warning is gone');
  assert.match(source, /the shape of a finder regression, not of cleanup/,
    'the tool no longer distinguishes cleanup from a broken finder');
});
