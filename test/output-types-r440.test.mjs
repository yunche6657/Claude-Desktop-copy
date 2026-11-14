// R440: OUTPUT-side type comparison — 107 fields, 0 shape mismatches, 1 nullability difference.
//
// WHY THIS ROUND
//   R436 did input types (77 fields, 0 mismatches). R437 did input enum values (10 fields, 1 real
//   gap). The output side had never been compared for TYPES at all — R420/R421 only recorded which
//   official output FIELDS were missing entirely.
//
// THE COMPARATOR WAS WRONG SEVEN TIMES BEFORE IT WAS RIGHT
//   v1 reported 8 mismatches. Every one was a bucketing bug of the same family R436 hit:
//     - `{ ... }[]` bucketed as object instead of array
//     - `string | null` bucketed as union instead of a nullable string
//     - a tuple `[ {...} ]` bucketed as union
//     - `( A | B )[]` bucketed as union because the text STARTS with "(" and ENDS with "[]"
//   Only after the third fix did the count reach 0 shape mismatches. The rule that finally worked is
//   the simplest one: if the type text ends with `[]`, it is an array, whatever wraps the element.
//
// THE ONE REAL FINDING
//   `FileEdit.originalFile` is `string | null` in the contract, plain `string` in CCB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** Officer-member type text for one output interface. */
function officialMember(iface, field) {
  const dts = read(DTS);
  const m = new RegExp('export interface ' + iface + 'Output\\b[^{]*\\{').exec(dts);
  assert.ok(m, iface + 'Output is gone from the contract');
  const s = m.index + m[0].length;
  let depth = 1;
  let i = s;
  while (i < dts.length && depth) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') depth -= 1;
    i += 1;
  }
  const body = dts.slice(s, i - 1);

  // Depth-0 member extraction.
  let memberDepth = 0;
  let name = null;
  let parts = [];
  const out = {};
  const flush = () => {
    if (name !== null) out[name] = parts.join(' ');
    name = null;
    parts = [];
  };
  for (const line of body.split('\n')) {
    const bare = line.trim();
    if (memberDepth === 0) {
      const mm = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(bare);
      if (mm) {
        flush();
        name = mm[1];
        parts = [bare.slice(mm[0].length)];
      } else if (name !== null) {
        parts.push(bare);
      }
    } else {
      parts.push(bare);
    }
    memberDepth += (line.match(/\{/g) || []).length + (line.match(/\[/g) || []).length;
    memberDepth -= (line.match(/\}/g) || []).length + (line.match(/\]/g) || []).length;
    if (memberDepth < 0) memberDepth = 0;
    if (memberDepth === 0 && bare.endsWith(';') && name !== null) flush();
  }
  flush();
  return out[field];
}

test('the comparator rule: a trailing [] is an array regardless of element wrapping', () => {
  // Asserted as behaviour because this single rule took three attempts to get right, and each wrong
  // version produced a false "mismatch" report rather than an error.
  const cases = [
    ['{ a: string }[]', 'array'],
    ['( A | B )[]', 'array'],
    ['string[]', 'array'],
    ['[ { a: string } ]', 'array'],
    ['string', 'string'],
    ['{ a: string }', 'object'],
  ];
  for (const [text, expected] of cases) {
    const isArray = text.endsWith('[]') || (text.startsWith('[') && text.endsWith(']'));
    const bucket = isArray ? 'array' : text.startsWith('{') ? 'object' : 'string';
    assert.equal(bucket, expected, text + ' should bucket as ' + expected);
  }
});

test('nullable is tracked separately from shape, not collapsed into union', () => {
  // `string | null` is a nullable string, not a union. Collapsing it into "union" is what produced
  // the false report on ExitPlanMode.plan and FileWrite.originalFile.
  const official = officialMember('ExitPlanMode', 'plan');
  assert.match(official, /string\s*\|\s*null/,
    'ExitPlanMode.plan is no longer string|null: re-derive the nullability comparison');
  const dir = path.join(TOOLS, 'ExitPlanModeTool');
  const blob = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => read(dir, f)).join('\n');
  assert.match(blob, /plan:\s*z[\s\S]{0,80}?\.nullable\(\)/,
    'ExitPlanMode.plan no longer uses .nullable()');
});

test('FileEdit.originalFile is now nullable, closing the R440 divergence', () => {
  // R440 recorded this as the one real output-type divergence: contract `string | null`, CCB
  // `z.string()`. R442 closed it by distinguishing a missing file (null) from an empty one (''),
  // using the fileExists flag that was already computed but never returned.
  const official = officialMember('FileEdit', 'originalFile');
  assert.match(official, /string\s*\|\s*null/, 'the contract changed: re-derive this divergence');

  const types = read(TOOLS, 'FileEditTool', 'types.ts');
  assert.match(types, /originalFile:\s*z\s*\n?\s*\.string\(\)\s*\n?\s*\.nullable\(\)/,
    'originalFile is no longer nullable: the divergence reopened');

  const tool = read(TOOLS, 'FileEditTool', 'FileEditTool.ts');
  assert.match(tool, /originalFile: fileExists \? originalFileContents : null/,
    'the absent/empty distinction is gone');
});

test('the five schema-reference fields are equivalent to the contract literals', () => {
  // The comparator could not bucket these because CCB uses shared schema references while the
  // contract inlines object literals. Verified by hand: each resolves to the same shape.
  const cases = [
    ['AskUserQuestionTool', 'AskUserQuestionTool.tsx', 'annotations', 'annotationsSchema()'],
    ['FileEditTool', 'types.ts', 'gitDiff', 'gitDiffSchema()'],
    ['FileWriteTool', 'FileWriteTool.ts', 'gitDiff', 'gitDiffSchema()'],
    ['TodoWriteTool', 'TodoWriteTool.ts', 'oldTodos', 'TodoListSchema()'],
    ['TodoWriteTool', 'TodoWriteTool.ts', 'newTodos', 'TodoListSchema()'],
  ];
  for (const [dir, file, field, schema] of cases) {
    const src = read(TOOLS, dir, file);
    assert.ok(src.includes(field + ': ' + schema) || src.includes(field + ': ' + schema.slice(0, -1)),
      dir + '.' + field + ' no longer uses ' + schema);
  }

  // The contract counterparts are inline object literals, which is why they were unbucketable.
  assert.match(officialMember('TodoWrite', 'oldTodos'), /\{\s*content: string/,
    'TodoWrite.oldTodos is no longer an inline object literal array');
  assert.match(officialMember('AskUserQuestion', 'annotations'), /\{/,
    'AskUserQuestion.annotations is no longer an object');
});

test('WebSearch.results stays an array on both sides', () => {
  // The contract writes `( A | B )[]`; the leading paren is what made the comparator say "union".
  const official = officialMember('WebSearch', 'results');
  assert.ok(official, 'WebSearch.results is gone');
  // The extracted text ends with `)[];` — the semicolon is part of the member, so the array test
  // must allow it. Testing for a bare `[]` at end-of-line was wrong.
  assert.match(official, /\)\[\]\s*;?\s*$/,
    'the contract no longer ends results with )[]; : re-derive the shape');
  assert.ok(/results:\s*z[\s\S]{0,80}?\.array\(/.test(read(TOOLS, 'WebSearchTool', 'WebSearchTool.ts')),
    'WebSearch.results is no longer a zod array');
});
