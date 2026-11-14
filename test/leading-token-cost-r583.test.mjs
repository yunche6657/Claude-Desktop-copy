// R583: R557 recorded a cost against the leading-token filter. It is real, and it is EMPTY in this tree.
//
// THE CLAIM, SPLIT IN TWO
//   R557 narrowed `list-skeleton-divergence` from 31 groups to 4 and named the price:
//
//       "a real divergence that ALSO changes the leading token is now hidden, and no amount of local text can tell 'one job
//       done differently' from 'two jobs' in general"
//
//   That is two claims wearing one sentence:
//
//       the filter DOES hide such groups   — a property of the RULE
//       such a group EXISTS here           — a property of THIS TREE
//
//   R557 asserted the first and left the second open. Measuring both:
//
//       groups the detector can see (`--min 1`)     19
//       ... all variants share a leading token      19
//       ... leading tokens differ                    0
//
//   So nothing is hidden today. And the rule still bites, verified on synthetic skeletons: `if (a) return 1;` vs
//   `return x;` hides (if vs x); `for (;;) {}` vs `while (true) {}` hides (for vs while). The zero is therefore not a dead
//   clause — it is a live clause with nothing to catch.
//
// A SECOND LENIENCY THE SYNTHETIC CASES EXPOSED
//   `const a = 1;` vs `let a = 1;` is KEPT, because the regex's keyword group is optional and the NAME group captures — both
//   yield the token `a`. So two variants differing only in declaration kind count as one job.
//
//   That errors toward KEEPING, so it cannot hide anything, and it is not the cost R557 recorded. But it means the "leading
//   token" is frequently a name rather than a keyword, which is not what the comment above the function describes. Recorded
//   because it was found by the same measurement, not because it is a hazard.
//
// WHY A ZERO HERE IS WEAKER EVIDENCE THAN A NON-ZERO
//   The clause errs toward hiding. A zero says there is nothing to hide today; it does not say the filter would show a
//   hidden group if one appeared. That is exactly why the synthetic cases belong in the record: they establish the clause
//   still works, so the zero cannot be an artefact of a broken pattern.
//
// WHAT IS NOT CLAIMED
//   Not that the cost is gone: if a group ever appears with `if` in one variant and `for` in another, it will be silently
//   dropped and nothing will report it. The zero is dated, not permanent.
//   Not that 19 is the population the reader cares about: `--min 1` reports what the skeleton detector sees, which is only
//   the groups `duplicated-lists` already found. A drift with no repeated list is invisible to both, as R580 established
//   for a different detector.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC, CENSUS, SECOND_LENIENCY } from '../desktop/leading-token-cost.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'list-skeleton-divergence.cjs');

/** The filter's own rule, so the synthetic cases test the same logic the tool runs. */
function leadingToken(skeleton) {
  const m = /^(?:const|let|var|await|return|if|for|while)?\s*([A-Za-z_$][\w$.]*)?/.exec(skeleton);
  return m && m[1] ? m[1] : (skeleton.match(/^(const|let|var|await|return|if|for|while)/) || ['other'])[0];
}

test('the clause still bites: a mixed pair is hidden, not merged', () => {
  for (const c of SYNTHETIC) {
    assert.equal(leadingToken(c.a), c.tokenA, `token for ${JSON.stringify(c.a)}`);
    assert.equal(leadingToken(c.b), c.tokenB, `token for ${JSON.stringify(c.b)}`);
    const verdict = c.tokenA === c.tokenB ? 'KEPT' : 'HIDDEN';
    assert.equal(verdict, c.verdict, `verdict for ${c.a} vs ${c.b}`);
  }
  // At least one HIDDEN case must exist, or the clause is dead and the census is meaningless.
  assert.ok(SYNTHETIC.some((c) => c.verdict === 'HIDDEN'), 'no hidden case: the clause no longer bites');
});

test('the tree has no mixed-leading-token group today', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json', '--min', '1'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  assert.ok(d.rows.length > 0, 'the tool reports no group at all');
  const mixed = d.rows.filter((g) => new Set(g.variants.map((v) => leadingToken(v.skeleton))).size > 1);
  assert.deepEqual(mixed.map((g) => g.values.join(',')),
    [], `a mixed-leading-token group now exists: ${mixed.map((g) => g.values.join(',')).join(' | ')}`);
  // And the recorded census still describes the tree.
  assert.ok(d.rows.length >= CENSUS.uniformLeadingToken - 5,
    `the tool now sees ${d.rows.length} groups, far fewer than the recorded ${CENSUS.uniformLeadingToken}`);
});

test('the second leniency is real: declaration kind is invisible', () => {
  assert.equal(leadingToken('const a = 1;'), leadingToken('let a = 1;'),
    'declaration kind is now distinguished, so the recorded leniency is stale');
  assert.match(SECOND_LENIENCY.effect, /declaration kind/);
  // And it must be recorded as erring toward KEEPING, not hiding.
  assert.match(SECOND_LENIENCY.direction, /toward KEEPING|cannot hide/);
});

test('the record separates the rule from the tree', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'leading-token-cost.cjs'), 'utf8');
  assert.ok(/property of the rule/.test(src), 'the rule half is not stated');
  assert.ok(/property of this repository/.test(src), 'the tree half is not stated separately');
  assert.ok(/weaker evidence than a non-zero/.test(src), 'the asymmetry of a hiding filter\'s zero is not stated');
});

test('the zero is dated rather than declared permanent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'leading-token-cost.cjs'), 'utf8');
  assert.ok(/silently/.test(src), 'the residual risk is not stated');
  assert.ok(/dated, not permanent/i.test(src), 'the zero is presented as permanent');
});

test('the population caveat from R580 is carried over', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'leading-token-cost.cjs'), 'utf8');
  // The sentence wraps, so the fragment is matched with whitespace tolerance.
  assert.ok(/drift with no\s+[\s\S]{0,40}?repeated list is invisible/.test(src),
    'the tool\'s population limit is not restated');
});
