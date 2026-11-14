// R584: the skeleton detector SPLITS where it should merge, when a rule is written twice with different variable names.
// Capable of it, and empty in this tree.
//
// THE HYPOTHESIS
//   R583 found that `const a` and `let a` both yield the token `a`, because the keyword group is optional and the NAME
//   group captures. Follow-up: if the declaration name is never normalised away, a rule written twice under different
//   variable names cannot be recognised as one rule.
//
// MEASURED
//   Stripping only what `skeletonAt` strips (member values -> `<LIST>`, quotes unified, whitespace removed):
//
//       const alpha = ['A','B'];   ->   constalpha=[<LIST>];   token: alpha
//       const beta  = ['A','B'];   ->   constbeta=[<LIST>];    token: beta
//
//   Unequal skeletons, different tokens: TWO GROUPS from one rule.
//
//   That is the SPLIT direction. R557's recorded cost was about MERGING unrelated groups and hiding a divergence. This is
//   the opposite failure — separating related ones — and it lives in the same filter.
//
// THIS TREE
//       variants reported (`--min 1`)                  43
//       ... skeleton begins `const NAME =`              4
//       new pairs that would merge if the name blanked  0
//
//   The four are two pairs — `base`/`base`, `g`/`g` — where the name already matches. Nothing is split today.
//
// WHY RECORD AN EMPTY CASE
//   A reader who knows only the hiding direction would assume unrelated groups merge and related ones survive. Both
//   directions are live in the rule; only one has instances. Recording the empty one stops the next round from discovering it
//   as new — which is the same reason R579 recorded an empty import-graph gap.
//
//   It also names the fix if a case appears: blank the declaration name after `const`/`let`/`var`, as loop variables were
//   normalised in R557.
//
// WHY THAT FIX WOULD NOT BE SAFE TODAY
//   The two `base` variants prove it. They are already one group, and their skeletons differ AFTER `const base =`:
//
//       constbase=schemaFields('baseInputSchema');…
//       constbase=schemaBody(text,'baseInputSchema');assert.deepEqual(…
//
//   Same name, same list, different INPUT. That is the interesting divergence, not a duplication — and blanking the name
//   would leave the verdict unchanged while changing what the comparison is about. So the fix is only correct for cases
//   where the divergence is purely the name; the detector has no way to tell which is which.
//
// WHAT IS NOT CLAIMED
//   Not that 4 of 43 is the real rate: `--min 1` sees only lists that repeat, so a declaration whose middle is not a repeated
//   list is invisible to this detector entirely. The split could be commoner in code this tool cannot see.
//   Not that normalising is right: it would be the third edit to this filter, and R571 withdrew a rule after three.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NORMALISATION, SPLIT_EXAMPLE, CENSUS } from '../desktop/declaration-name-split.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'list-skeleton-divergence.cjs');

/** The normalisation `skeletonAt` performs, reproduced so the split is demonstrated rather than asserted. */
function normalise(stmt, values) {
  for (const v of values) stmt = stmt.split(`'${v}'`).join('<v>').split(`"${v}"`).join('<v>');
  stmt = stmt.replace(/(<v>[\s,]*)+/g, '<LIST>');
  return stmt.replace(/"/g, "'").replace(/\s+/g, '');
}

function leadingToken(skeleton) {
  const m = /^(?:const|let|var|await|return|if|for|while)?\s*([A-Za-z_$][\w$.]*)?/.exec(skeleton);
  return m && m[1] ? m[1] : (skeleton.match(/^(const|let|var|await|return|if|for|while)/) || ['other'])[0];
}

test('the declared name survives normalisation, which is what splits the group', () => {
  const a = normalise(SPLIT_EXAMPLE.a.source, ['A', 'B']);
  const b = normalise(SPLIT_EXAMPLE.b.source, ['A', 'B']);
  assert.equal(a, SPLIT_EXAMPLE.a.skeleton, 'the reproduced normalisation no longer matches the record');
  assert.equal(b, SPLIT_EXAMPLE.b.skeleton);
  assert.equal(leadingToken(a), SPLIT_EXAMPLE.a.token);
  assert.equal(leadingToken(b), SPLIT_EXAMPLE.b.token);
  // The two facts that make it a split: unequal skeletons AND unequal tokens.
  assert.notEqual(a, b, 'the two skeletons are now equal, so nothing is split');
  assert.notEqual(leadingToken(a), leadingToken(b));
});

test('the tool still does not normalise the declaration name', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  // The only name normalisation present is the loop variable (R557). A declaration-name rule would show up here.
  assert.ok(!/replace\(\/\^\(const\|let\|var\)[^/]*\/,/.test(src),
    'a declaration-name normalisation appeared: the recorded split may be closed');
  assert.match(src, /LOOP VARIABLE NAME IS NOT PART OF THE OPERATION/,
    'the loop-variable normalisation R557 added is gone');
});

test('the tree has no instance of the split today', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json', '--min', '1'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  const variants = d.rows.flatMap((g) => g.variants.map((v) => v.skeleton));
  assert.ok(variants.length > 20, `only ${variants.length} variants to examine`);

  // Blank the declaration name and count how many NEW shared shapes appear.
  const blank = (s) => s.replace(/^(const|let|var)[A-Za-z_$][\w$]*=/, '$1<NAME>=');
  const raw = new Map();
  const blanked = new Map();
  for (const s of variants) {
    raw.set(s, (raw.get(s) || 0) + 1);
    const b = blank(s);
    blanked.set(b, (blanked.get(b) || 0) + 1);
  }
  const rawMerged = [...raw.values()].filter((n) => n > 1).length;
  const blankedMerged = [...blanked.values()].filter((n) => n > 1).length;
  assert.equal(blankedMerged, rawMerged,
    `blanking the declaration name created ${blankedMerged - rawMerged} new shared shapes: the split now has an instance`);
});

test('the record names the fix and refuses to apply it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'declaration-name-split.cjs'), 'utf8');
  assert.ok(/blank the declaration name/.test(src), 'the fix is not named');
  assert.ok(/WOULD NOT BE SAFE/.test(src), 'the reason it was not applied is missing');
  assert.ok(/R571 withdrew a rule after three/.test(src), 'the precedent against a third edit is missing');
});

test('the opposite direction to R557 is stated', () => {
  assert.equal(NORMALISATION.declarationName, 'NOT normalised');
  assert.equal(NORMALISATION.loopVariable, 'normalised since R557');
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'declaration-name-split.cjs'), 'utf8');
  assert.match(src, /SPLIT direction/, 'the direction is not named');
  assert.match(src, /MERGING unrelated groups|hiding a divergence/, 'the opposite failure is not distinguished');
});

test('the population limit is restated rather than assumed', () => {
  assert.match(CENSUS.note, /no\s+instance|nothing is split/);
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'declaration-name-split.cjs'), 'utf8');
  assert.match(src, /invisible to this detector entirely|sees only lists that repeat/,
    'the population limit is not stated');
});
