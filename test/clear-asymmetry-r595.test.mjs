// R595: the inverse of R590's criterion. Two sets, one event, one cleared — and both keys omit the dimension.
//
// THE STRONGER FORM OF THE CRITERION
//   R590 used "a sibling is cleared on an event the key cannot see". That is one half. The decisive form is:
//
//       both keys omit the dimension, AND only one of the two sets is reset on the event that changes it
//
//   When both keys omit it, the CLEAR is the only thing separating the two behaviours — so the set without it is the one whose
//   history crosses the boundary. That is confirmable without guessing at intent.
//
// WHAT IT FOUND: ONE PAIR, THE SAME ONE
//       desktop/growthbook-provider.cjs  (event: exposure)
//           cleared: seenExperimentExposure   key id
//           kept:    seenFeatureExposure      key signature
//
//   `id` is `${experiment}:${variation}`; `signature` is `${key}:${item.on}:${item.source}`. NEITHER names the account. Only the
//   experiment side is cleared on the switch, so only the feature side suppresses across it. The criterion in its stronger form
//   reproduces R590's finding from the other direction.
//
// THE BUG THIS ROUND HIT, AND WHY IT MATTERED
//   The first run reported ZERO pairs. The declaration pattern was `const NAME = new Set(`, and the file reads
//
//       const seenFeatureExposure = new Set(), seenExperimentExposure = new Set();
//
//   — the second declaration has no `const`, so it was invisible. The tool was looking for the one pair it was built to find and
//   could not see half of it. Measured: `decls found: [{seenFeatureExposure}]`, second absent, 0 pairs.
//
//   A zero from a scan that cannot see its subject is indistinguishable from a zero of absence — the same distinction R593 drew
//   between a comparison-zero and an absence-zero. Here it was neither: it was a zero from a blind spot, which is the worst of
//   the three because it looks like a finding.
//
// WHAT IS NOT CLAIMED
//   Not that one pair is the whole population of asymmetric clears: the "read together" condition requires both names on one
//   line, so a pair used in two adjacent lines is missed. Loosening it would raise false pairs against a population of 273 sets.
//   Not that the kept set is wrong: R587 established no production caller supplies `onExposure`, so nothing is reported from
//   either side today. The asymmetry is a fact about the mechanism's shape, not a live defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'clear-asymmetry.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the R590 pair is found, with both keys shown', () => {
  const d = runScan();
  assert.ok(d.pairs >= 1, 'no asymmetric pair found: the comma-declaration bug is back');
  const hit = d.rows.find((r) => r.file === 'desktop/growthbook-provider.cjs');
  assert.ok(hit, 'the growthbook pair is not reported');
  assert.equal(hit.cleared.name, 'seenExperimentExposure');
  assert.equal(hit.kept.name, 'seenFeatureExposure');
  assert.equal(hit.kept.key, 'signature');
  assert.equal(hit.cleared.key, 'id');
  assert.equal(hit.event, 'exposure', 'the shared feeding function is not identified');
});

test('a comma-separated declaration is not invisible', () => {
  // The bug: `const a = new Set(), b = new Set();` — only `a` matched. Assert both are now seen.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-provider.cjs'), 'utf8');
  assert.match(src, /const seenFeatureExposure = new Set\(\), seenExperimentExposure = new Set\(\);/,
    'the comma declaration changed, so this test no longer demonstrates the bug');
  const d = runScan();
  const names = d.rows.flatMap((r) => [r.cleared.name, r.kept.name]);
  assert.ok(names.includes('seenExperimentExposure'),
    'the second declaration in a comma list is still invisible');
});

test('both keys still omit the account — the condition the criterion rests on', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-provider.cjs'), 'utf8');
  assert.match(src, /const signature = `\$\{key\}:\$\{item\.on\}:\$\{item\.source\}`/,
    'the feature signature changed');
  assert.match(src, /const id = `\$\{experiment\}:\$\{variation\}`/, 'the experiment id changed');
  // Neither names the account.
  assert.ok(!/account/i.test(/const signature = [^\n]+/.exec(src)[0]), 'the feature key now names the account');
  assert.ok(!/account/i.test(/const id = `[^`]+`/.exec(src)[0]), 'the experiment key now names the account');
});

test('only one side is cleared, on the account switch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-provider.cjs'), 'utf8');
  assert.match(src, /seenExperimentExposure\.clear\(\)/, 'the experiment clear is gone');
  assert.ok(!/seenFeatureExposure\.clear\(\)/.test(src), 'the feature set now has a clear');
});

test('the scan reports keys side by side rather than a verdict', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cleared:/, 'the cleared set is not labelled');
  assert.match(r.stdout, /kept:/, 'the kept set is not labelled');
  assert.match(r.stdout, /only puts the two keys side by side/, 'the output claims more than it measures');
});

test('the blind-spot zero is recorded as its own kind, distinct from absence', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /reported ZERO pairs/, 'the bug is not recorded');
  assert.ok(/zero from a BLIND SPOT|zero from a blind spot/.test(src), 'the kind of zero is not named');
  assert.ok(/looks like a finding/.test(src), 'why it is the worst of the three is not stated');
});

test('the population limit of the read-together condition is stated', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /two adjacent lines is missed/, 'the limit is not stated');
  assert.match(src, /273 sets/, 'the cost of loosening it is not quantified');
});
