// R537: the denominator four rounds of evidence were built on was wrong, and the correction has to be visible where
// the wrong number was published.
//
// WHAT WAS WRONG
//   `desktop/session-kernel.cjs` was reported as having 367 branches in R532, and R533/R534/R535 all divided by it.
//   R536 deduplicated: `else if (x) {` matched both the `if` and the `else if` pattern, and `.catch(() => {})` matched
//   the handler pattern while being a promise method. Eleven lines carried two rows. The real count is 352.
//
// WHY IT SURVIVED THREE ROUNDS
//   The two rows shared a LINE NUMBER, so any line-based dedup saw one row. The tool did not report offsets until
//   R536, so nothing else could have noticed. This is the same family as every other defect in this thread — a
//   detector that did not describe its input — with the input being the branch enumeration itself.
//
// WHY A CORRECTION BANNER AND NOT AN EDIT
//   The four evidence files state their numbers as part of an argument. Rewriting 367 to 352 in place would leave the
//   argument claiming a number it never measured, and a reader could not tell which conclusions were re-derived and
//   which were patched. `tools/corrections.cjs` prepends a superseded banner and leaves the original text untouched,
//   so the wrong figure and the correction sit together.
//
// WHAT THIS ROUND VERIFIES
//   That the banner exists in all four files, that the original text is still there (the banner is a prepend, not a
//   replace), that the registry has no pending entries, and that the banner names the replacement number.
//
// WHAT IS NOT CLAIMED
//   Not that every downstream document has been corrected: STATUS.md is append-only, so rounds 532-535 still contain
//   367 in their own historical entries, with a correction note appended after them rather than inside them. Not that
//   the four conclusions are unaffected — only that their DIRECTION is: R534's ranking input changed even though its
//   headline finding did not. Not that 352 is permanent: it is what this tool counts today, and R536 changed the
//   counting logic to get there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const REGISTRY = path.join(ROOT, 'evidence', 'corrections.json');

const CORRECTED = [
  'branch-coverage-r532.md',
  'condition-coverage-r533.md',
  'function-risk-r534.md',
  'branch-attribution-r535.md',
];

// The HANDOFF copies live at the repository root, not under evidence/, and the tool initially resolved only under
// evidence/ — so these three reported `missing-file` and `--write` applied nothing. That is the copy a reader is told
// to open, so correcting only the evidence side leaves the visible number uncorrected while the registry claims
// otherwise. Both sides are asserted below, and the resolution order is its own test.
const HANDOFFS = [
  'HANDOFF-ROUND532-BRANCH-COVERAGE.md',
  'HANDOFF-ROUND533-CONDITION-COVERAGE.md',
  'HANDOFF-ROUND534-FUNCTION-RISK.md',
  'HANDOFF-ROUND535-BRANCH-ATTRIBUTION.md',
];

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

test('the registry has no pending banners', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  const pending = d.rows.filter((x) => x.status === 'needs-banner').map((x) => x.file);
  assert.deepEqual(pending, [],
    'these files still carry an uncorrected number: ' + pending.join(', '));
});

test('each of the four files carries a superseded banner naming 352', () => {
  for (const f of CORRECTED) {
    const text = fs.readFileSync(path.join(ROOT, 'evidence', f), 'utf8');
    assert.match(text, /^<!-- superseded-r536 -->/,
      `${f} has no superseded banner at the top`);
    assert.match(text, /352/, `${f}'s banner does not name the replacement figure`);
    // The banner has to say what was wrong, not merely that something was.
    assert.match(text, /367/, `${f}'s banner does not name the figure it supersedes`);
  }
});

test('the original text is intact behind the banner', () => {
  // A prepend, not a replace. Every file must still contain its own heading after the banner block.
  for (const f of CORRECTED) {
    const text = fs.readFileSync(path.join(ROOT, 'evidence', f), 'utf8');
    const afterBanner = text.slice(text.indexOf('\n# '));
    assert.ok(afterBanner.length > 200,
      `${f}'s body is missing or too short: the banner may have replaced rather than prepended`);
    assert.match(afterBanner, /367/,
      `${f}'s body no longer contains the original figure: the banner overwrote the evidence it corrects`);
  }
});

test('the correction states the mechanism, not just the verdict', () => {
  const text = fs.readFileSync(path.join(ROOT, 'evidence', 'branch-coverage-r532.md'), 'utf8');
  // The two causes have to be named, because "the number was wrong" without a mechanism cannot be re-checked.
  assert.match(text, /else if/, 'the else-if double-count is not named');
  assert.match(text, /catch/, 'the promise-method miscount is not named');
  // And why it survived: the shared line number.
  assert.match(text, /同一行号|shared the same line|同一行/,
    'the reason it went unnoticed for three rounds is not recorded');
});

test('the append-only log carries a correction rather than a rewrite', () => {
  // STATUS.md must still contain the historical 367 entries — rewriting them would destroy the record of what was
  // published — and must ALSO contain the correction note that tells a reader how to read them.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.match(status, /367/, 'the historical entries were rewritten: the log is not append-only any more');
  assert.match(status, /第537轮更正|改读 352/,
    'no correction note was appended after the entries that still say 367');
});

test('the registry records which round superseded which', () => {
  const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const f of [...CORRECTED, ...HANDOFFS]) {
    const entry = d.corrections.find((c) => c.file === f && c.summary.includes('367'));
    assert.ok(entry, `${f} has no registry entry`);
    assert.equal(entry.round, 536, `${f} is attributed to round ${entry.round}, not 536`);
    assert.equal(entry.kind, 'denominator', `${f} is registered as ${entry.kind}`);
  }
});

test('the HANDOFF copies are corrected too, because that is the file a reader opens', () => {
  for (const f of HANDOFFS) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(text, /^<!-- superseded-r536 -->/,
      `${f} has no superseded banner: the handoff a reader is pointed at still shows the wrong figure`);
    assert.match(text, /352/, `${f}'s banner does not name the replacement`);
    // And the original heading survives, so the correction is additive.
    assert.match(text, /\n# /, `${f}'s body heading is gone`);
  }
});

test('a corrected file at the repository root is found, not reported missing', () => {
  // The resolution order this round added. Without it the HANDOFF entries silently resolved to nothing.
  const r = run(['--json']);
  const d = JSON.parse(r.stdout);
  const missing = d.rows.filter((x) => x.status === 'missing-file').map((x) => x.file);
  assert.deepEqual(missing, [], 'these registered files could not be resolved: ' + missing.join(', '));
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /function resolveEntryPath/, 'the two-location resolver is gone');
});
