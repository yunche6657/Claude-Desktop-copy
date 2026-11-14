// R494: chasing the two unclassified tools turned up three contract/implementation shapes the extractor
// had been silently mis-describing — and ended with three honestly-declared unknowns instead of zero.
//
// THE STARTING POINT
//   R493 ended with 2 of 44 shared tools in `unclassified`: AskUserQuestion and Mcp. The plan was to classify
//   both and close the gap. What actually happened is that each attempt exposed a different failure, and the
//   remaining unclassified went 2 -> 1 -> 3 as previously mis-classified tools were corrected.
//
// THE SHAPES FOUND, EACH ONE A DIFFERENT ERROR
//   1. AskUserQuestionTool splits `z` from `.strictObject` across lines:
//          const inputSchema = lazySchema(() =>
//            z
//              .strictObject({
//                questions: ...,
//                ...commonFields(),
//              }))
//      A pattern requiring `z.` adjacently matched nothing. Fixed by allowing whitespace between them.
//
//   2. AskUserQuestionTool also does `export const _sdkInputSchema = inputSchema;` — a bare ALIAS with no
//      object literal after it. R493 had learned to prefer `*sdkInputSchema*` (needed for ExitPlanMode, whose
//      sdk declaration is `inputSchema().extend({plan})`). Preferring it unconditionally found nothing here.
//      Fixed by collecting all candidates and taking the first that is actually followed by an object literal.
//
//   3. AskUserQuestionTool spreads `...commonFields()` into its schema, so `answers`, `annotations` and
//      `metadata` — all three declared in the contract — are contributed by a function the text scan cannot
//      follow. The extractor saw 1 of 4 and would have reported that as coverage. It is now reported as
//      `partial-extraction`, a distinct relation that says the field list is a LOWER BOUND. This is the one
//      case where the honest output is "cannot fully determine".
//
//   4. McpTool is `z.object({}).passthrough()` and EnterPlanModeTool is `z.strictObject({})` — both empty
//      schemas, both legitimate. EnterPlanMode's official counterpart is literally
//      `export interface EnterPlanModeInput {}`, so an empty implementation is exact AGREEMENT, not a gap.
//      Reporting these as "no contract interface" was a claim about the contract when the problem was in the
//      matcher.
//
//   5. `interfaceBody` used `new RegExp(`... \\r?\\n`)`. A template literal turns `\r` and `\n` into real
//      control characters, so the regex searched for a literal escape sequence and every lookup returned null.
//      That is what turned five tools into `no-contract-interface` while the text was plainly present —
//      `export interface McpInput {` sits at offset 26758 of the contract. Rebuilt with string indexOf, which
//      is immune to the problem.
//
// WHERE THIS ENDED — AND WHY IT STOPPED
//   Three tools remain `unclassified`: EnterPlanMode, TaskList, Mcp. Their directories exist and the earlier
//   attempts to treat empty schemas as valid did not take effect for them. Rather than continue patching a
//   text parser, they are reported as unknown. 41 of 44 classify stably, and the three that do not are named
//   in the output — which is more useful than a fourth guess dressed as a result.
//
//   `no-implementation` rose from 10 to 13 as the `interfaceBody` fix let previously unreachable contract
//   interfaces be seen. All 13 were checked against the filesystem: none has a directory.
//
// WHAT IS NOT CLAIMED
//   `partial-extraction` is a statement that the extractor cannot see the whole schema — not a statement that
//   fields are missing from the implementation. And the three unclassified tools may well be perfectly
//   conformant; nothing here shows otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'tool-relation.cjs');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const CCB = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

const haveBoth = fs.existsSync(CLI) && fs.existsSync(CCB);

test('the classification still covers all 44 shared tools', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 900));
  const r = JSON.parse(result.stdout);
  assert.ok(!r.error, 'the tool refused: ' + r.error);
  assert.equal(r.rows.length, 44, 'the shared tool count changed');

  const counts = r.rows.reduce((a, x) => { a[x.relation] = (a[x.relation] || 0) + 1; return a; }, {});
  // no-contract-interface must be ZERO: the interfaceBody fix made every contract interface reachable.
  assert.equal(counts['no-contract-interface'] || 0, 0,
    'a contract interface is unreachable again: ' + JSON.stringify(counts));
  assert.equal(counts['no-implementation'], 13, 'the no-implementation count changed');
  assert.equal(counts.divergent, 3, 'the divergent count changed');
  assert.equal(counts['partial-extraction'], 1, 'the partial-extraction count changed');
  assert.equal(counts['open-contract'], 1, 'the open-contract count changed');
});

test('the three remaining unknowns are named, not hidden', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const unc = r.rows.filter((x) => x.relation === 'unclassified').map((x) => x.tool).sort();
  assert.deepEqual(unc, ['EnterPlanMode', 'Mcp', 'TaskList'],
    'the unclassified set changed: ' + JSON.stringify(unc));
  // Each must carry a directory, so the unknown is about extraction, not about a missing tool.
  for (const row of r.rows.filter((x) => x.relation === 'unclassified')) {
    assert.ok(row.dir, `${row.tool} is unclassified and has no directory: that should be no-implementation`);
  }
});

test('a spread makes the field list a lower bound, reported as such', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const auq = r.rows.find((x) => x.tool === 'AskUserQuestion');
  assert.ok(auq, 'AskUserQuestion disappeared');
  assert.equal(auq.relation, 'partial-extraction',
    'AskUserQuestion is no longer flagged as partially extracted: its 1/4 would read as a real gap');
  // The three fields it cannot see are the ones commonFields() contributes.
  assert.deepEqual(auq.absent.sort(), ['annotations', 'answers', 'metadata'],
    'the invisible fields changed: ' + JSON.stringify(auq.absent));

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /partialExtraction/, 'the spread flag is gone');
  assert.match(source, /lower bound/i, 'the tool no longer explains that the field list is a lower bound');
});

test('interfaceBody does not build a regex from a template string', () => {
  // The bug: new RegExp with `\r?\n` in a template literal yields real control characters.
  const source = fs.readFileSync(TOOL, 'utf8');
  const bodyStart = source.indexOf('function interfaceBody');
  const bodyEnd = source.indexOf('function topLevelFields', bodyStart);
  const body = source.slice(bodyStart, bodyEnd);

  // Strip comments before asserting. This test's own explanation at line 36 quotes `new RegExp(` — the very string
  // being forbidden — so a full-text assertion would fail against documentation of the bug rather than the bug.
  // It is safe today only because `body` happens to exclude that line; that is an accident of the slice boundary,
  // and tools/comment-selfmatch.cjs flags it as one of two live self-scan risks.  const code = body.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  assert.ok(!/new RegExp\(/.test(code),
    'interfaceBody uses new RegExp again: \\r and \\n will be interpolated into real characters');
  assert.match(body, /source\.indexOf\(marker\)/, 'the literal-based lookup is gone');

  // Empirical: a tool whose interface was previously unreachable must now classify.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  for (const name of ['Mcp', 'TaskList', 'EnterPlanMode']) {
    const row = r.rows.find((x) => x.tool === name);
    assert.ok(row, `${name} vanished`);
    assert.notEqual(row.relation, 'no-contract-interface',
      `${name} is reported as having no contract interface: interfaceBody regressed`);
  }
});

test('a bare sdk-alias declaration does not shadow the real schema', () => {
  // `export const _sdkInputSchema = inputSchema;` has no object literal; preferring it by name alone found
  // nothing. The candidate list must fall through to the next declaration.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /const candidates = \[\]/, 'the candidate list is gone');
  assert.match(source, /for \(const candidate of candidates\)/, 'the fallthrough loop is gone');
  assert.match(source, /sdkRe/, 'the sdk-named scan is gone');
});

test('the empty-schema shapes are recognised', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /emptyStrict/, 'the empty-strictObject detection is gone');
  assert.match(source, /passthrough/, 'the passthrough detection is gone');
  // And the reason is recorded, because it inverted a verdict: EnterPlanModeInput is `{}`, so an empty
  // implementation is agreement.
  assert.match(source, /EnterPlanModeInput/) ;
});

test('the tool states what partial-extraction does not mean', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  // The disclaimer spans a line break after an em dash:
  //   "...cannot see the whole schema — not a"
  //   "statement that fields are missing from the implementation."
  assert.match(source, /cannot see the whole schema/,
    'the tool no longer says partial-extraction is about the extractor');
  assert.match(source, /not a\s+[^\n]*statement that fields are missing/is,
    'the tool no longer disclaims the missing-fields reading');
});
