// R465: a validated sweep for describe()-vs-type mismatches — result: none remain.
//
// THE QUESTION
//   R448 fixed Glob.totalMatches, whose describe() said "Every path that matched, before the result
//   limit was applied" while the field is a NUMBER. It noted the scan was not systematic. This round
//   makes it systematic and reports the true count.
//
// THREE EXTRACTION BUGS, EACH CAUGHT BY SELF-TEST RATHER THAN BY READING NUMBERS
//   1. Collection word list contained `path`, `file`, `output` — ordinary field nouns in this code
//      base. 52 false positives, all correct descriptions.
//   2. Chain built with `before.rfind(field)`, which lands on the LAST mention of the name and
//      truncated the chain before `.array(`. `filenames: z.array(z.string())` was classified scalar.
//   3. The prose extractor required the quote immediately after `.describe(`, so it returned None
//      whenever the literal began on the next line — which is 226 of 384 calls here. Every aggregate
//      computed before this fix was meaningless.
//
// THE RULE THAT SURVIVED
//   The tell is a PLURALITY QUANTIFIER in subject position, not a bare noun:
//       "Every path that matched…"  /  "All files…"  /  "List of…"      <- asserts the VALUE is plural
//       "The path to the file"      /  "The standard output of…"        <- does not
//   Anchored to sentence start, this separates them cleanly. Verified both ways below.
//
// MEASURED
//     total .describe( calls          386
//     prose extracted                 384   (99.5%)
//     field resolved                  382
//     shapes: scalar 328, array 19, other 37
//     chain formatting: one-line 158, multi-line 226
//     MISMATCHES                        0
//
//   The two unextracted calls are ternary expressions (process.env.USER_TYPE === 'ant' ? 'A' : 'B'),
//   not string literals — they cannot be judged by this rule and are excluded, not missed.
//
//   So the zero is a real zero: the detector was shown to fire on R448's original text and to stay
//   silent on a correct one, with 99.5% coverage of the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const PLURALITY = /^\s*(?:(?:Every|All|Each|Any)\s+[A-Za-z]+|The\s+(?:list|array|set|collection)\s+of|(?:A|An)\s+(?:list|array|set|collection)\s+of|(?:List|Array)\s+of)/i;
const SCALAR_METHODS = ['number(', 'boolean(', 'string('];

function extractProse(text, callEnd) {
  let i = callEnd;
  while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
  if (i >= text.length || !'\'"`'.includes(text[i])) return null;
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === q) return text.slice(i + 1, j);
    j += 1;
  }
  return null;
}

function extractChain(text, describeStart) {
  const head = text.slice(0, describeStart);
  const decls = [...head.matchAll(/^(\s+)([A-Za-z_$][\w$]*)\s*:\s*/gm)];
  if (decls.length === 0) return [null, ''];
  for (let k = decls.length - 1; k >= 0; k -= 1) {
    const d = decls[k];
    const indent = d[1].length;
    const body = head.slice(d.index + d[0].length);
    let cut = body.length;
    for (const lm of body.matchAll(/^(\s*)(\S)/gm)) {
      if (lm[1].length <= indent && !')]},'.includes(lm[2])) { cut = lm.index; break; }
    }
    const chain = body.slice(0, cut);
    if (/\bz\s*\./.test(chain)) return [d[2], chain];
  }
  return [decls.at(-1)[2], head.slice(decls.at(-1).index)];
}

function scan(text) {
  const hits = [];
  for (const m of text.matchAll(/\.describe\(/g)) {
    const prose = extractProse(text, m.index + m[0].length);
    if (prose === null) continue;
    const [field, chain] = extractChain(text, m.index);
    if (!field) continue;
    const isArray = /z\s*\.\s*array\(/.test(chain) || /\.array\(/.test(chain);
    const isScalar = SCALAR_METHODS.some((s) => chain.includes(s)) && !isArray;
    if (isScalar && PLURALITY.test(prose)) {
      hits.push({ rule: 'collection-prose-on-scalar', field, prose });
    }
  }
  return hits;
}

test('the detector fires on R448s original mismatch', () => {
  // If this test ever stops failing to find the bug, the sweep below proves nothing.
  const bad = `
    totalMatches: z
      .number()
      .optional()
      .describe(
        'Every path that matched, before the result limit was applied',
      ),
`;
  const hits = scan(bad);
  assert.equal(hits.length, 1, 'the detector no longer flags the known-bad description');
  assert.equal(hits[0].field, 'totalMatches');
});

test('the detector stays silent on correct descriptions', () => {
  // These are the shapes that produced 52 false positives with a naive noun list.
  const good = `
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    numFiles: z.number().describe('Total number of files found'),
    filePath: z.string().describe('The path to the file that was read'),
    stdout: z.string().describe('The standard output of the command'),
    originalSize: z.number().describe('Original file size in bytes'),
`;
  assert.deepEqual(scan(good), [],
    'the detector flags correct descriptions: its rules are over-broad again');
});

test('no collection-prose-on-scalar mismatch remains in the tool tree', () => {
  if (!fs.existsSync(TOOLS)) return;
  const hits = [];
  let calls = 0;
  let extracted = 0;
  let arrays = 0;
  let scalars = 0;

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      if (e.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/\.describe\(/g)) {
        calls += 1;
        const prose = extractProse(text, m.index + m[0].length);
        if (prose === null) continue;
        extracted += 1;
        const [field, chain] = extractChain(text, m.index);
        if (!field) continue;
        const isArray = /z\s*\.\s*array\(/.test(chain) || /\.array\(/.test(chain);
        const isScalar = SCALAR_METHODS.some((s) => chain.includes(s)) && !isArray;
        if (isArray) arrays += 1;
        if (isScalar) scalars += 1;
        if (isScalar && PLURALITY.test(prose)) {
          hits.push({ file: path.relative(SRC, p), field, prose: prose.slice(0, 140) });
        }
      }
    }
  };
  walk(TOOLS);

  // Coverage first: a zero result only means something if the detector actually saw the tree.
  assert.ok(calls > 300, `only ${calls} describe() calls found; expected ~386`);
  const coverage = extracted / calls;
  assert.ok(coverage >= 0.95,
    `only ${(coverage * 100).toFixed(1)}% of describe() calls yielded prose; the sweep cannot claim `
    + 'to have checked the tree');
  assert.ok(scalars > 100 && arrays > 10,
    `shape coverage is thin (scalars ${scalars}, arrays ${arrays}): one rule may not have run`);

  assert.deepEqual(hits, [],
    'collection-phrased descriptions on scalar fields: ' + JSON.stringify(hits.slice(0, 5)));
});

test('GlobTool.totalMatches still says what it means', () => {
  // The R448 fix, pinned so it cannot silently revert.
  const glob = fs.readFileSync(
    path.join(TOOLS, 'GlobTool', 'GlobTool.ts'), 'utf8');
  assert.ok(!glob.includes('Every path that matched, before the result limit was applied'),
    'the R448 description came back');
  assert.match(glob, /Total number of matching files before truncation/,
    'totalMatches is no longer described as a count');
});
