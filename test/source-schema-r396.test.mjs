// R396: the five tools R395 could not resolve, answered from CCB SOURCE.
//
// R395 spent a whole round failing to read these out of the minified bundle: the resolver kept
// landing on a nested element's literal. With the pinned source tree checked out
// (commit 77a7934e) the answer is just the file.
//
// Two of R395's findings were WRONG and are corrected here:
//   AskUserQuestion  - answers/annotations/metadata ARE in the input schema, spread in via
//                      `...commonFields()`. R395 reported them as missing.
//   ExitPlanMode     - the internal schema HAS allowedPrompts. R395 reported it missing.
//
// SOURCE TREE LOCATION
//   .tmp/ccb-src (outside the repo, shallow fetch of the pinned commit).
//   tools/setup-agent-core.cjs's setupFromScratch() does `git clone --depth 1`, which takes HEAD
//   and drifts from the pin. Reproducing these results requires:
//     git init; git remote add origin <repo>
//     git fetch --depth 1 origin 77a7934e15d69da13879112ed7db695c9ee7a52a
//     git checkout FETCH_HEAD
//
// WHY THIS TEST FAILS RATHER THAN SKIPS WHEN THE TREE IS ABSENT
//   A skipped test proves nothing, and the whole point of this file is that the previous round's
//   *unverified* claims were wrong. If the tree is gone, the assertions below are unproven and
//   should say so loudly. `test.skip` is deliberately not used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');
const HAVE_SOURCE = fs.existsSync(SRC);

/** Read a source file, asserting the tree exists first. */
function src(rel) {
  assert.ok(HAVE_SOURCE,
    'the pinned CCB source tree is missing at ' + SRC + '. Re-fetch it (see the header) — these '
    + 'assertions cannot be made from the minified bundle, which is exactly what R395 got wrong.');
  const p = path.join(SRC, rel);
  assert.ok(fs.existsSync(p), 'missing source file: ' + rel);
  return fs.readFileSync(p, 'utf8');
}

/**
 * The zod object literal of a `const NAME = lazySchema(() => ... z.strictObject({...}))`.
 *
 * Two things this must get right, both learned by watching it fail:
 *   - `inputSchema` is a PREFIX of other names in the same file (`outputSchema` does not clash,
 *     but `const inputSchema` appears in both a tool file and its neighbours), so the match is
 *     anchored with a word boundary after the name.
 *   - The first `z.object({` AFTER the declaration may belong to a different, later schema. So
 *     the object is taken from the declaration up to the end of THAT statement, not from a
 *     whole-file search.
 */
function schemaBody(text, constName) {
  const declRe = new RegExp('const ' + constName + ' = lazySchema\\(');
  const decl = declRe.exec(text);
  assert.ok(decl, 'no declaration for ' + constName);

  // Bound the search by the next TOP-LEVEL declaration. The schema spans lines with the object
  // starting on a continuation line:
  //   const inputSchema = lazySchema(() =>
  //     z
  //       .strictObject({
  // Two earlier attempts cut the region off before `.strictObject({`:
  //   - `/\n(?:const|type|export) /` matched inside the body (and CRLF made slicing off by one)
  //   - slicing `after.slice(1)` shifted the match index by a character
  // Scanning lines for one that starts at column 0 with a declaration keyword is unambiguous.
  const lines = text.slice(decl.index).split(/\r?\n/);
  const regionLines = [lines[0]];
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(const|type|export|function|class)\b/.test(lines[i])) break;
    regionLines.push(lines[i]);
  }
  const region = regionLines.join('\n');

  // `.strictObject({` is written across lines as:
  //   z
  //     .strictObject({
  // so the literal string 'z.strictObject({' does NOT occur. Search for the method call on its
  // own, which is what the source actually contains.
  //
  // For the non-strict form the source is `lazySchema(() => ({ ... }))` — an arrow returning a
  // BARE parenthesised object, not `z.object({...})`. Looking only for `z.object(` therefore
  // matched a nested `z.object({...})` inside the body (`metadata`'s shape) and returned that
  // sub-object. Both spellings are accepted here, and the earliest one wins.
  const strictAt = region.search(/\.strictObject\(\s*\{/);
  const zObjectAt = region.search(/\bz\.object\(\s*\{/);
  const bareAt = region.search(/=>\s*\(\s*\{/);
  const candidates = [strictAt, zObjectAt, bareAt].filter((n) => n >= 0);
  assert.ok(candidates.length > 0,
    'no object literal in ' + constName + ' (region: ' + JSON.stringify(region.slice(0, 120)) + ')');
  const anchor = Math.min(...candidates);
  const open = region.indexOf('{', anchor);
  let depth = 0;
  for (let i = open; i < region.length; i += 1) {
    if (region[i] === '{') depth += 1;
    else if (region[i] === '}') {
      depth -= 1;
      if (depth === 0) return region.slice(open, i + 1);
    }
  }
  return assert.fail('unbalanced object in ' + constName);
}

test('AskUserQuestion input has FOUR fields: the spread really does add three', () => {
  // This is the correction. R395 reported a 1-field schema because the bundle resolver read
  // questionOptionSchema's label/description/preview/notes instead.
  const text = src(path.join('AskUserQuestionTool', 'AskUserQuestionTool.tsx'));
  const body = schemaBody(text, 'inputSchema');
  const common = schemaBody(text, 'commonFields');

  // questions is declared inline; the other three arrive through the spread.
  assert.match(body, /\bquestions\s*:/, 'questions is no longer declared inline');
  assert.match(body, /\.\.\.commonFields\(\)/,
    'the commonFields spread is gone: the input schema is now 1 field, not 4');

  for (const field of ['answers', 'annotations', 'metadata']) {
    assert.match(common, new RegExp('\\b' + field + '\\s*:'),
      field + ' is no longer declared in commonFields, so the input schema changed');
  }
});

test('TodoWrite input is exactly `todos`', () => {
  // R395's matrix claimed content/status/activeForm — those are TodoListSchema element fields.
  const text = src(path.join('TodoWriteTool', 'TodoWriteTool.ts'));
  const body = schemaBody(text, 'inputSchema');
  assert.match(body, /\btodos\s*:/);
  for (const notTop of ['content', 'status', 'activeForm']) {
    assert.ok(!new RegExp('^\\s*' + notTop + '\\s*:', 'm').test(body),
      notTop + ' appeared at the TOP level of TodoWrite input: re-derive the row');
  }
});

test('ExitPlanMode internal schema HAS allowedPrompts; the SDK face adds two more', () => {
  const text = src(path.join('ExitPlanModeTool', 'ExitPlanModeV2Tool.ts'));
  const internal = schemaBody(text, 'inputSchema');
  assert.match(internal, /\ballowedPrompts\s*:/,
    'the internal schema lost allowedPrompts: R395\'s wrong finding would become true');

  // The SDK/hooks face is a DIFFERENT schema: `_sdkInputSchema` extends with two injected fields.
  const sdkAt = text.indexOf('export const _sdkInputSchema');
  assert.ok(sdkAt > 0, '_sdkInputSchema is gone: the two faces are no longer distinguishible');
  const sdkRegion = text.slice(sdkAt, sdkAt + 900);
  for (const injected of ['plan:', 'planFilePath:']) {
    assert.ok(sdkRegion.includes(injected),
      injected + ' is no longer injected into the SDK face');
  }
});

test('Monitor input is command + description + timeout_ms after R406', () => {
  // WAS: exactly ['command','description'], recording that BOTH official extras were absent.
  // R406 added `timeout_ms`. `ws` stays absent: it needs a WebSocket transport.
  const text = src(path.join('MonitorTool', 'MonitorTool.tsx'));
  const body = schemaBody(text, 'inputSchema');
  const top = [...body.matchAll(/^\s{2,}([a-zA-Z_][\w]*)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(top)].sort(), ['command', 'description', 'timeout_ms'],
    'Monitor input changed: re-derive §1.4');
  assert.ok(!top.includes('ws'),
    'Monitor gained ws: §1.4 is fully closed, update the worklist');
});

test('Agent is base + multi + extend(isolation, cwd); effort added in R406', () => {
  const text = src(path.join('AgentTool', 'AgentTool.tsx'));

  // R406 added `effort` to baseInputSchema, closing the last §1 Agent gap.
  const base = schemaBody(text, 'baseInputSchema');
  assert.deepEqual(
    [...new Set([...base.matchAll(/^\s{4}([a-z_][\w]*)\s*:/gm)].map((m) => m[1]))].sort(),
    ['description', 'effort', 'model', 'prompt', 'run_in_background', 'subagent_type'],
    'baseInputSchema changed: re-derive the Agent row',
  );

  // The multi-agent fields are a const INSIDE fullInputSchema, not a top-level schema.
  const multiAt = text.indexOf('const multiAgentInputSchema');
  assert.ok(multiAt > 0, 'multiAgentInputSchema is gone');
  const multiRegion = text.slice(multiAt, multiAt + 1200);
  for (const field of ['name:', 'team_name:', 'mode:']) {
    assert.ok(multiRegion.includes(field), field + ' left the multi-agent schema');
  }

  // The extend() block carries isolation and cwd.
  const fullAt = text.indexOf('const fullInputSchema');
  const fullRegion = text.slice(fullAt, fullAt + 2500);
  assert.ok(fullRegion.includes('isolation:'),
    'Agent lost isolation: the "missing isolation" claim became true again');
  assert.ok(fullRegion.includes('cwd:'), 'Agent lost cwd');

  // WAS: "effort is the ONE official field genuinely absent from the whole tool". R406 added it,
  // so §1.1 is closed. The assertion flips to require its presence.
  const effAt = text.indexOf('effort:');
  assert.ok(effAt > 0,
    'effort vanished from AgentTool: the R406 addition was lost');
});

test('Agent isolation is narrowed for non-ant users', () => {
  const text = src(path.join('AgentTool', 'AgentTool.tsx'));
  const fullAt = text.indexOf('const fullInputSchema');
  const region = text.slice(fullAt, fullAt + 2500);
  assert.match(region, /USER_TYPE\s*===\s*'ant'[\s\S]{0,160}worktree[\s\S]{0,40}remote/,
    'the USER_TYPE branch around isolation changed: re-derive that差异');
});
