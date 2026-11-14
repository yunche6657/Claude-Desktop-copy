// R609: R608's mask introduced a regression — the value was read from blanked text, so 22 string literals classified as
// `unknown`. Found and fixed here. R608's own declared-unfixed bug turned out to be inert.
//
// THE REGRESSION R608 CAUSED
//       const masked = blank(text);
//       for (const m of masked.matchAll(re)) { … provenance: provenance(m[1]) }
//
//   `blank()` replaces string literals with whitespace, so `const gate = '513873720', fixed = …` becomes
//   `const gate =            , fixed = …`, and `provenance('')` is `unknown` where `'513873720'` must be `internal`.
//
//   Measured before the fix: 22 declarations, headed by `growthbook-provider.cjs:170` — the flag id this line of work started
//   from.
//
// THE FIX
//   The mask decides WHETHER a span is an assignment; the ORIGINAL decides WHAT the value is. Same length, same offsets:
//
//       const rhsStart = m.index + m[0].indexOf(m[1]);
//       const rhs = text.slice(rhsStart, rhsStart + m[1].length);
//
//   Population unchanged at 2 — none of the 22 had both provenances — so this is a classification repair, not a count change.
//   That is exactly why R608's tests did not catch it: they assert on candidates, and a misclassified non-candidate is
//   invisible to them.
//
// THE PUNCTUATION BUG R608 DECLARED UNFIXED IS INERT
//   R608 recorded that `mcp-session-auth.cjs:107` reports `row.config?.url, transport = row.config?.type` as url's value. This
//   round measured the blast radius:
//
//       multi-variable declarations with different provenances   89
//       misreported by the concatenation                          0
//
//   Structural reason: a combined value always BEGINS with the first value, so a head-inspecting classifier sees what it would
//   have seen alone. The tail could lead only with an empty first value, and all six such cases are string literals — which the
//   fix above now reads correctly.
//
// WHAT IS NOT CLAIMED
//   Not that 89 is every multi-variable declaration: the pattern needs two `name = value` pairs on one statement; a
//   four-variable declaration matches on its first two.
//   Not that the display text is tidy: it still shows the trailing declaration, which is cosmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank } from '../tools/lexer.cjs';
import { REGRESSION, PUNCTUATION_BUG } from '../desktop/mask-value-regression.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'source-divergence.cjs');

test('the tool reads the value from the original text, not the masked text', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const masked = blank\(text\);/, 'the mask is gone');
  assert.match(src, /const rhsStart = m\.index \+ m\[0\]\.indexOf\(m\[1\]\);/, 'the offset recovery is gone');
  assert.match(src, /const rhs = text\.slice\(rhsStart, rhsStart \+ m\[1\]\.length\);/, 'rhs no longer comes from text');
  assert.match(src, /provenance: provenance\(rhs\)/, 'provenance no longer uses the recovered value');
  // And the match still runs over the masked text, which is the half R608 got right.
  assert.match(src, /masked\.matchAll\(re\)/, 'the mask no longer decides what is an assignment');
});

test('blanking a literal would have produced whitespace, which is the mechanism', () => {
  const sample = "const gate = '513873720', fixed = context.source.features;";
  const masked = blank(sample);
  const maskedValue = masked.slice(masked.indexOf('=') + 1, masked.indexOf(',')).trim();
  const realValue = sample.slice(sample.indexOf('=') + 1, sample.indexOf(',')).trim();
  assert.equal(maskedValue, '', 'blank() no longer erases the literal, so the regression mechanism changed');
  assert.equal(realValue, "'513873720'");
  // The regression is that '' and "'513873720'" classify differently.
  assert.notEqual(maskedValue.slice(0, 1), realValue.slice(0, 1));
});

test('the population is unchanged by the repair', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(0, 400));
  const d = JSON.parse(r.stdout);
  assert.equal(d.candidates, REGRESSION.populationUnchanged,
    `the tool reports ${d.candidates}, record says ${REGRESSION.populationUnchanged}`);
});

test('the regression record names the round that introduced it and the count', () => {
  assert.match(REGRESSION.introducedBy, /R608/, 'the introducing round is not named');
  assert.equal(REGRESSION.measured, 22);
  assert.match(REGRESSION.example, /513873720/, 'the example lost the flag id');
  assert.match(REGRESSION.whyUnnoticed, /misclassified non-candidate/, 'why the tests missed it is not stated');
});

test('the punctuation bug is measured as inert, with the structural reason', () => {
  assert.equal(PUNCTUATION_BUG.misreported, 0);
  assert.ok(PUNCTUATION_BUG.declarationsWithDifferentProvenance > 50,
    'the measured population shrank, so the inertness claim needs redoing');
  assert.match(PUNCTUATION_BUG.why, /begins with the first value/, 'the structural reason is not stated');
  assert.match(PUNCTUATION_BUG.tailCouldLeadOnlyIf, /empty/, 'the exception is not named');
});

test('the count of 22 is reproducible from the tree', () => {
  // Re-derive it: declarations whose first value is a string literal, in desktop/ and tools/.
  const DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^,;\n]+),/g;
  let n = 0;
  for (const dir of ['desktop', 'tools']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.cjs')) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      const lines = text.split('\n');
      const masked = blank(text);
      for (const m of masked.matchAll(DECL)) {
        if (m[2].trim()) continue;
        const line = masked.slice(0, m.index).split('\n').length;
        const orig = lines[line - 1] || '';
        const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('\\b' + esc + "\\s*=\\s*['\"`]").test(orig)) n += 1;
      }
    }
  }
  assert.ok(n >= 20, `only ${n} blanked-literal declarations remain; the 22 measurement no longer holds`);
});

test('the record does not overstate the 89', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'mask-value-regression.cjs'), 'utf8');
  assert.match(src, /Not that 89 is every multi-variable declaration/, 'the population limit is missing');
  assert.match(src, /cosmetic/, 'the display caveat is missing');
});
