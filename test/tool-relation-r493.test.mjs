// R493: generalising the Artifact finding to all 44 tools — and the extractor failing four times on the way.
//
// THE QUESTION
//   R492 characterised Artifact and found it is not an incomplete implementation but a different, narrower
//   tool: the official side dispatches 13 actions over one input, CCB performs a single upload, the only
//   shared field is file_path, and CCB adds hash and ttl the contract lacks. That was one tool, read by hand.
//   This round asks whether it generalises, and what the right discriminator is.
//
// THE DISCRIMINATOR
//   Not the coverage ratio. Three shapes look alike in a percentage but mean different things:
//     same-tool     every official field declared
//     subset        all declared fields are official, some official fields absent, no CCB-only fields —
//                   the implementation lags; adding coverage is coherent
//     divergent     CCB declares fields the contract lacks — the two sides model different operations, so
//                   "add the missing fields" is the wrong response
//   A tool at 1/9 with no extra fields is lagging. A tool at 18/20 with two extra fields is different.
//   Reporting only the ratio hides that distinction, which is the whole point of the round.
//
// A FOURTH RELATION THE DATA FORCED
//   ExitPlanMode's contract is `{ allowedPrompts? (deprecated), [k: string]: unknown }`. That index
//   signature says the contract deliberately accepts any field. So CCB's `plan` is legitimate under the
//   contract, not an invented extension. This is reported as `open-contract`, not `divergent`. Without it
//   the tool would have accused ExitPlanMode of fabrication for doing exactly what the contract allows.
//
// FOUR FAILED EXTRACTORS — EACH ONE PRODUCED PLAUSIBLE NUMBERS
//   v1  slice to `const inputSchema`.
//       Agent 0/10, FileRead 0/5, contradicting R491's 10/10 and 5/5. AgentTool names its schemas
//       baseInputSchema/fullInputSchema; FileReadTool's object line has no such prefix.
//   v2  scan the whole tool directory as one blob.
//       ArtifactTool reported 32 fields including Authorization, headers, method, uploadUrl — HTTP client
//       shapes, not inputs.
//   v3  union every `z.object({...})` block.
//       Bash acquired 15 CCB-only fields (stdout, stderr, returnCodeInterpretation, timedOutAfterMs) — that is
//       Bash's OUTPUT schema. FileRead has seven z.object blocks and only the first is input.
//   v4  locate a name containing `inputSchema`, then take the first object literal after it — but the indent
//       calculation included the opening `{` line, whose indent can be 0, so the minimum was 0 and no field
//       line matched. Every tool became `unclassified` while the locator reported success.
//
//   Then two more corrections once fields appeared at all:
//     - Prefer a `*sdkInputSchema*` declaration over a plain `inputSchema`. ExitPlanMode declares both, and
//       the SDK one is what a contract caller sees; taking the internal one reported `plan` as invented.
//     - Accept `.extend({` and `.merge({` as schema literals. `_sdkInputSchema` is
//       `inputSchema().extend({...})`, so a `z.object`-only pattern found nothing and ExitPlanMode stayed
//       wrong even after the sdk preference was added.
//
//   The recurring failure: numbers that looked like findings about the codebase were findings about the
//   parser. What ended it was cross-checking against R491's independently produced figures — two runs
//   disagreeing is what exposed each error.
//
// THE RESULT
//   19 same-tool, 4 divergent (Artifact, Bash, EnterWorktree, WebSearch), 3 subset (Agent, Monitor,
//   RemoteTrigger), 1 open-contract (ExitPlanMode), 2 unclassified, 10 no-implementation,
//   5 no-contract-interface.
//
//   So Artifact is not unique, but it is not the norm either: 4 of the 29 tools that have both sides are
//   divergent, and the coverage percentage alone would have hidden all four.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'tool-relation.cjs');
const { schemaFields } = createRequire(import.meta.url)(TOOL);
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const CCB = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

const haveBoth = fs.existsSync(CLI) && fs.existsSync(CCB);

test('the classification covers all 44 shared tools', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 900));
  const r = JSON.parse(result.stdout);
  assert.ok(!r.error, 'the tool refused: ' + r.error);
  assert.equal(r.rows.length, 44, 'the shared tool count changed');

  const counts = r.rows.reduce((a, x) => { a[x.relation] = (a[x.relation] || 0) + 1; return a; }, {});
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), 44,
    'classification dropped or duplicated a tool');
  assert.ok((counts['same-tool'] || 0) >= 16, 'the parser lost known matching tools');
  assert.ok((counts.divergent || 0) >= 3, 'known divergent schemas disappeared');
  assert.ok((counts.subset || 0) >= 1, 'known missing fields disappeared');
  assert.ok((counts['no-implementation'] || 0) >= 9, 'missing runtime tool directories were fabricated');
  assert.ok((counts.unclassified || 0) <= 4,
    'too many unclassified tools: ' + JSON.stringify(counts));
});

test('the divergent set is exactly the tools that add fields', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const divergentRows = r.rows.filter((x) => x.relation === 'divergent');
  const divergent = divergentRows.map((x) => x.tool).sort();
  for (const name of ['Artifact', 'Bash', 'WebSearch']) {
    assert.ok(divergent.includes(name), name + ' lost a confirmed extra input field');
  }
  for (const row of divergentRows) {
    assert.ok(row.extra.length > 0, row.tool + ' is divergent without extra fields');
  }
  for (const row of r.rows.filter(x => x.present && x.relation !== 'partial-extraction')) {
    if (row.relation === 'divergent') continue;
    if (row.relation === 'open-contract') continue;
    assert.deepEqual(row.extra, [], row.tool + ' has extras but is classified as ' + row.relation);
  }
  const worktree = r.rows.find(x => x.tool === 'EnterWorktree');
  assert.ok(worktree && !divergent.includes('EnterWorktree'),
    'the current schema must not inherit the stale EnterWorktree divergence');
});

test('an index signature makes a CCB-only field legitimate, not invented', { skip: !haveBoth }, () => {
  // ExitPlanMode's contract is { allowedPrompts? (deprecated), [k: string]: unknown }, so `plan` is allowed.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const ep = r.rows.find((x) => x.tool === 'ExitPlanMode');
  assert.ok(ep, 'ExitPlanMode disappeared');
  assert.equal(ep.relation, 'open-contract',
    'ExitPlanMode is no longer classified as open-contract: it would be accused of inventing plan');

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /officialOpen/, 'the index-signature check is gone');
  assert.match(source, /open-contract/, 'the open-contract relation is gone');
});

test('the extractor reads object, strictObject, extend and merge schemas from inputs', () => {
  const examples = [
    ['z.object', `const inputSchema = lazySchema(() => z.object({
  alpha: z.string(),
}));`],
    ['z.strictObject', `const inputSchema = lazySchema(() => z.strictObject({
  alpha: z.string(),
}));`],
    ['.extend', `const _sdkInputSchema = schema().extend({
  alpha: z.string(),
});`],
    ['.merge', `const _sdkInputSchema = schema().merge({
  alpha: z.string(),
});`],
  ];
  for (const [label, source] of examples) {
    const fields = schemaFields(source);
    assert.ok(fields?.has('alpha'), label + ' was not parsed');
  }
  const source = `const inputSchema = z.object({
  wrong: z.string(),
});
const _sdkInputSchema = inputSchema.extend({
  expected: z.string(),
});`;
  const fields = schemaFields(source);
  assert.equal(fields?.has('expected'), true);
  assert.equal(fields?.has('wrong'), false);
});

test('the indent calculation excludes the opening brace line', { skip: !haveBoth }, () => {
  // v4's bug: including the `{` line made the minimum indent 0, so no field matched and every tool became
  // unclassified while the locator reported success.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /span\.split\('\\n'\)\.slice\(1, -1\)/,
    'the brace line is included again: every tool will report zero fields');

  // Prove it empirically on a tool whose schema shape was read by hand.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const read = r.rows.find((x) => x.tool === 'FileRead');
  assert.ok(read, 'FileRead missing');
  assert.ok(read.present.length >= 4,
    `FileRead reports only ${read.present.length} official fields: the indent fix regressed`);
  assert.ok(read.present.includes('file_path'), 'FileRead no longer finds file_path');
});

test('failed extraction and a genuine empty schema are distinguishable', () => {
  assert.equal(schemaFields('const unrelated = z.object({ x: z.string() })'), null,
    'a schema without an input declaration must not be classified');
  const empty = schemaFields('const inputSchema = z.strictObject({})');
  assert.ok(empty instanceof Set, 'genuinely empty input schema was treated as unclassified');
  assert.equal(empty.size, 0);
  const open = schemaFields('const inputSchema = z.object({}).passthrough()');
  assert.ok(open instanceof Set);
  assert.equal(open.openEnded, true, 'an open empty schema lost its index signature');
});

test('the tool states what divergent does and does not mean', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /SCHEMAS, not about runtime behaviour/i,
    'the tool no longer limits its claim to schemas');
  assert.match(source, /different operations|model different operations/,
    'the behavioural reading is gone');
});
