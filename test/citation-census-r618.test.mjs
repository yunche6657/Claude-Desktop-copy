// R618: five of 24 evidence references were structurally broken. Two were character offsets written as line numbers — a mistake
// R598 made and this round corrects. The other three are drift, which is expected and is not corrected.
//
// MEASURED, OUTSIDE STATUS.md
//       references                     24   (excluding one illustrative `foo.cjs:123` in prose)
//       file exists, line non-blank    19
//       line past EOF / blank           5
//       file missing                    0
//
// THE FIVE
//       ccb-kernel-wired.md         local-exec.cjs:87         blank line   → drift
//       ccb-permission-protocol.md  local-exec.cjs:87         blank line   → drift
//       conversation-r470.md        main.cjs:355              blank line   → drift
//       pure-key-r598.md            preview-access.cjs:2491   file has 127 → offset-as-line, FIXED to 22
//       pure-key-r598.md            mcp-stdio-relay.cjs:1194  file has 85  → offset-as-line, FIXED to 14
//
// WHAT THE TWO LARGE NUMBERS WERE
//   Character offsets. R598's probes printed `definition at char N`, and the write-up carried the number across with `:` syntax that
//   means a line. The real lines are 22 and 14, found by locating `const key =`.
//
//   That is R617's point made concrete: a coordinate looks precise, is checkable in principle, and is wrong in a way no reader catches
//   without opening the file. The function NAME in the same sentence was right all along.
//
// WHY DRIFT IS NOT CORRECTED
//   A citation landing on a blank line usually means the code moved, not that it was always wrong. Relocating the three would only
//   reset the clock; naming the function would not. The two offsets ARE corrected because they were never line numbers at all.
//
// WHAT IS NOT CLAIMED
//   Not that the 19 non-blank references point at the right thing: this round checked only that the line EXISTS. A spot-check found
//   two that exist and misdescribe (`run-tests.cjs:31` shows `/**`, `tool-absence.cjs:49` shows a comment rather than
//   `contractTools()`), and those are not counted in the five.
//   Not that 24 is the whole population: STATUS.md holds 13 more, in a running log where a stale coordinate is likelier still.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENSUS, BROKEN, DISTINCTION } from '../desktop/citation-census.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The citation census over evidence/, excluding STATUS.md and the illustrative placeholder. */
const census = () => {
  const EV = path.join(ROOT, 'evidence');
  const REF = /((?:desktop|tools|test)\/[\w.-]+\.(?:cjs|mjs|js|json|md)):(\d+)/g;
  let total = 0;
  let nonBlank = 0;
  let broken = 0;
  const brokenList = [];
  for (const f of fs.readdirSync(EV)) {
    if (!f.endsWith('.md') || f === 'STATUS.md') continue;
    const text = fs.readFileSync(path.join(EV, f), 'utf8');
    for (const m of text.matchAll(REF)) {
      if (m[1].includes('foo.cjs')) continue;
      total += 1;
      const p = path.join(ROOT, m[1]);
      if (!fs.existsSync(p)) { broken += 1; brokenList.push(f + ' ' + m[0] + ' missing'); continue; }
      const src = fs.readFileSync(p, 'utf8').split('\n');
      const line = (src[Number(m[2]) - 1] || '').trim();
      if (!line) { broken += 1; brokenList.push(f + ' ' + m[0] + ' blank-or-eof'); continue; }
      nonBlank += 1;
    }
  }
  return { total, nonBlank, broken, brokenList };
};

test('the two offset-as-line citations are corrected and now land on the key definitions', () => {
  const cases = [
    { file: 'desktop/preview-access.cjs', line: 22, fragment: 'const key=' },
    { file: 'desktop/mcp-stdio-relay.cjs', line: 14, fragment: 'const key=' },
  ];
  for (const c of cases) {
    const src = fs.readFileSync(path.join(ROOT, c.file), 'utf8').split('\n');
    const text = (src[c.line - 1] || '').trim();
    assert.ok(text.includes(c.fragment), `${c.file}:${c.line} does not hold ${c.fragment}: ${JSON.stringify(text)}`);
  }
  // And the wrong numbers are gone from the document.
  const doc = fs.readFileSync(path.join(ROOT, 'evidence', 'pure-key-r598.md'), 'utf8');
  assert.ok(!doc.includes('preview-access.cjs:2491'), 'the offset was not replaced');
  assert.ok(!doc.includes('mcp-stdio-relay.cjs:1194'), 'the offset was not replaced');
  // The correction is explained in place.
  assert.ok(doc.includes('字符偏移'), 'the correction note is missing');
});

test('the census matches the record after the correction', () => {
  const c = census();
  // Two were fixed, so the population now has 3 broken rather than 5.
  // The population grows as rounds add references; the record's 24 is the snapshot it measured.
  assert.ok(c.total >= CENSUS.population, `population SHRANK from ${CENSUS.population} to ${c.total}`);
  // Two were fixed; what must hold is that no NEW breakage appeared beyond the three known ones.
  assert.ok(c.broken <= CENSUS.broken - 2,
    `${c.broken} references are broken; at most ${CENSUS.broken - 2} were expected`);
  assert.equal(c.nonBlank + c.broken, c.total, 'the buckets do not sum');
});

test('the five recorded breakages are the five the record names', () => {
  assert.equal(BROKEN.length, CENSUS.broken);
  const targets = BROKEN.map((b) => b.target).sort();
  assert.deepEqual(targets, [
    'desktop/local-exec.cjs:87',
    'desktop/local-exec.cjs:87',
    'desktop/main.cjs:355',
    'desktop/mcp-stdio-relay.cjs:1194',
    'desktop/preview-access.cjs:2491',
  ].sort());
});

test('the two offset cases record the real line and the file length', () => {
  const offsets = BROKEN.filter((b) => b.cause.includes('character offset'));
  assert.equal(offsets.length, 2);
  for (const o of offsets) {
    const [file] = o.target.split(':');
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    assert.equal(o.fileLines, src.length, `${o.target}: recorded ${o.fileLines} lines, file has ${src.length}`);
    assert.ok(o.actualLine <= src.length, `${o.target}: the recorded real line is past EOF`);
  }
});

test('drift and error are distinguished, with different responses', () => {
  assert.match(DISTINCTION.drift, /expected in a live tree/, 'drift is not characterised');
  assert.match(DISTINCTION.error, /offset\/line confusion/, 'the error is not named');
  assert.match(DISTINCTION.response, /naming the function/, 'the recommended response is not stated');
});

test('the record refuses to claim the other 19 are correct', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'citation-census.cjs'), 'utf8');
  assert.match(src, /Not that the 19 non-blank references point at the right thing/, 'the limit is missing');
  assert.match(src, /run-tests\.cjs:31/, 'the misdescribing example is not cited');
});
