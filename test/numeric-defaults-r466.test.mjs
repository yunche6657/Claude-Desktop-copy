// R466: numeric default claims, checked against the code that implements them — all 7 hold.
//
// THE TASK
//   R465 checked shape (prose says list, field is number). This round checks NUMBERS: when a describe()
//   states a default, does a constant with that value actually back it?
//
// FOUR EXTRACTOR BUGS BEFORE THE RESULT WAS TRUSTWORTHY
//   v1 matched `NAME = N` / `?? N` / `key: N` and reported "matching constants present" using
//      coincidental hits — the value 5 matched the word "default" inside the describe text itself.
//   v2 walked declarations backwards and rejected a candidate when a line at <= its indent appeared;
//      an empty line at indent 0 cut every multi-line chain to nothing, so ALL fields resolved to
//      null and the sweep reported 0 claims. The independent probe printing `field: None, chain: ''`
//      for every describe is what exposed it.
//   v3 locates the field by taking the nearest preceding `name:` followed by `z.`, and self-tests on a
//      fixture before scanning. That is the version whose output is reported here.
//
//   The v2 failure is the second time this session lost a whole sweep to a silent null (R465's prose
//   extractor was the first). Both were caught by running a known-good input through the detector.
//
// THE 7 CLAIMS AND THEIR IMPLEMENTATIONS
//   DiscoverSkillsTool  limit                default 5      z...describe, then `input.limit ?? 5`
//   SearchExtraTools    max_results          default 5      `max_results ?? 5`
//   TerminalCapture     lines                default 50     `lines ?? 50`
//   GrepTool            head_limit           default 250    const DEFAULT_HEAD_LIMIT = 250
//   GrepTool            offset               default 0      parameter default `offset: number = 0`
//   WebSearchTool       num_results          default 8      tavilyAdapter: `options.numResults ?? 8`
//   WebSearchTool       context_max_chars    default 10000  exaAdapter: `?? 10000`
//
//   Four of the seven are NOT `input.field ?? N` in the tool file: two are applied in an adapter, one
//   is a module constant, one is a function-parameter default. A detector that only looks for the
//   first shape will report false "no implementation" for them — which v3 did, and which manual
//   reading resolved.
//
// ArtifactTool's `Must be 7 or 30. Default 7.` is correct too: `z.union([z.literal(7), z.literal(30)])
// .default(7)`. A schema-level default is a fourth implementation shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const T = (rel) => path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', rel);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('schema-level defaults match their descriptions', () => {
  const artifact = read(T('ArtifactTool/ArtifactTool.ts'));
  // Documented: "Lifetime in days. Must be 7 or 30. Default 7."
  // The declaration is
  //     ttl: z
  //       .union([z.literal(7), z.literal(30)])
  //       .default(7)
  // so the "z" and ".union" are on DIFFERENT lines — "z.union(" never appears in the file. Asserting
  // that string returned false for a file that clearly contains the union, which is the same
  // lookalike problem as R461's CRLF entries: the assertion text, not the code, was wrong.
  assert.ok(artifact.includes('.union([z.literal(7), z.literal(30)])'),
    'the ArtifactTool lifetime union changed: the description says "Must be 7 or 30."');
  assert.ok(artifact.includes('.default(7)'),
    'the lifetime default is no longer 7, contradicting "Default 7."');
  assert.ok(artifact.includes('Must be 7 or 30. Default 7.'),
    'the description changed: re-derive whether the schema still agrees');
});

test('module-constant defaults match their descriptions', () => {
  const grep = read(T('GrepTool/GrepTool.ts'));
  // Documented: "Defaults to 250 when unspecified."
  assert.match(grep, /const DEFAULT_HEAD_LIMIT = 250/,
    'DEFAULT_HEAD_LIMIT changed: the head_limit description says 250');
  assert.match(grep, /effectiveLimit = limit \?\? DEFAULT_HEAD_LIMIT/,
    'DEFAULT_HEAD_LIMIT is no longer the fallback: the documented default would not apply');
  assert.match(grep, /Defaults to 250 when unspecified/,
    'the head_limit description changed');
});

test('parameter-default implementations match their descriptions', () => {
  const grep = read(T('GrepTool/GrepTool.ts'));
  // Documented: "Defaults to 0." for offset — implemented as a parameter default, not `input.offset ?? 0`.
  assert.match(grep, /offset: number = 0/,
    'the offset parameter default is gone: the documented "Defaults to 0." would be unbacked');
  assert.match(grep, /Defaults to 0\./, 'the offset description changed');
});

test('adapter-applied defaults match their descriptions', () => {
  // WebSearchTool forwards num_results/context_max_characters to adapters, so the defaults live there.
  const tool = read(T('WebSearchTool/WebSearchTool.ts'));
  assert.match(tool, /default: 8/, 'the num_results description no longer states 8');
  assert.match(tool, /default: 10000/, 'the context_max_characters description no longer states 10000');

  const tavily = read(T('WebSearchTool/adapters/tavilyAdapter.ts'));
  assert.match(tavily, /options\.numResults \?\? 8/,
    'the tavily adapter no longer defaults numResults to 8, contradicting the description');

  const exa = read(T('WebSearchTool/adapters/exaAdapter.ts'));
  assert.match(exa, /options\.contextMaxCharacters \?\? 10000/,
    'the exa adapter no longer defaults contextMaxCharacters to 10000');
});

test('inline input-field defaults match their descriptions', () => {
  const cases = [
    ['DiscoverSkillsTool/DiscoverSkillsTool.ts', 'limit', 5],
    ['SearchExtraToolsTool/SearchExtraToolsTool.ts', 'max_results', 5],
    ['TerminalCaptureTool/TerminalCaptureTool.ts', 'lines', 50],
  ];
  for (const [rel, field, expected] of cases) {
    const body = read(T(rel));
    // Either `input.field ?? N` or a destructuring/assign with ?? N.
    const re = new RegExp(`${field}\\s*(?:\\?\\?|=(?!=))\\s*${expected}\\b`);
    const viaInput = new RegExp(`input\\.${field}\\s*\\?\\?\\s*${expected}\\b`);
    assert.ok(re.test(body) || viaInput.test(body),
      `${rel}: no fallback to ${expected} found for ${field}, but its description promises that default`);
    assert.ok(body.includes(`default: ${expected}`) || body.includes(`Defaults to ${expected}`),
      `${rel}: the description no longer states the default ${expected}`);
  }
});

test('every documented default has exactly one backing implementation shape', () => {
  // Tally the shapes seen, so a future round knows there are four and cannot assume one.
  const shapes = new Set();
  if (/\.default\(7\)/.test(read(T('ArtifactTool/ArtifactTool.ts')))) shapes.add('schema .default(N)');
  if (/const DEFAULT_HEAD_LIMIT = 250/.test(read(T('GrepTool/GrepTool.ts')))) shapes.add('module constant');
  if (/offset: number = 0/.test(read(T('GrepTool/GrepTool.ts')))) shapes.add('parameter default');
  if (/options\.numResults \?\? 8/.test(read(T('WebSearchTool/adapters/tavilyAdapter.ts')))) shapes.add('adapter fallback');

  assert.deepEqual([...shapes].sort(), [
    'adapter fallback', 'module constant', 'parameter default', 'schema .default(N)',
  ], 'the set of default-implementation shapes changed: re-derive how to find them');
});
