// R501: a plausible mechanism for the last three absences was found, tested, and REFUTED by the data.
//
// WHAT WAS PROPOSED
//   R500 ended with three contract tools still unexplained: ListMcpResources, Mcp, ReadMcpResource. All are
//   listed unconditionally in src/tools.ts, all are present in the shipped bundle, and none appear in the
//   runtime's init frame.
//
//   R498's debug log offered a lead — "Dynamic tool loading: 0/16 deferred tools in API tools array (all via
//   ExecuteExtraTool)" — and the bundle confirmed the flag:
//       var ListMcpResourcesTool = buildTool({
//         isConcurrencySafe() { return true; },
//         isReadOnly() { return true; },
//         shouldDefer: true,
//         name: LIST_MCP_RESOURCES_TOOL_NAME,
//         searchHint: "list resources from connected MCP servers",
//   ReadMcpResourceTool has the same flag, while RefreshMcpToolsTool has none — and RefreshMcpTools is exactly
//   the one of the three that DOES appear in the runtime list. Sixteen tools were said to be deferred.
//
//   So the hypothesis wrote itself: `shouldDefer: true` withholds a tool from the init frame, to be reached
//   later through SearchExtraTools/ExecuteExtraTool. That would explain the three remaining absences and close
//   the whole R488–R501 thread.
//
// WHY IT IS WRONG
//   The cross-check says eleven deferred tools ARE registered:
//       AskUserQuestion, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree,
//       NotebookEdit, TaskOutput, TaskStop, TodoWrite, WebFetch, WebSearch
//   Every one of those sets `shouldDefer: true` and every one appears in the init frame. So the flag does not
//   control frame membership at all. It controls whether a tool is ALSO reachable through the search/execute
//   pair — a different thing.
//
//   Nine deferred tools are absent: Artifact, Config, LSP, ListMcpResources, ReadMcpResource, and the four
//   Task* tools. The four Task ones were already explained in R499 by isTodoV2Enabled, so the flag was never
//   doing the work there either. That leaves five, of which three are the MCP pair plus the contract's phantom
//   `Mcp` (a symbol collision with RefreshMcpToolsTool).
//
// A CROSS-CHECK THAT WAS ITSELF BROKEN FIRST
//   The first version compared `runtime.has('AskUserQuestionTool')` — always false, because the runtime
//   registers `AskUserQuestion`. It therefore printed the reassuring sentence "no deferred tool appears in the
//   init frame — consistent" while AskUserQuestion, WebFetch, WebSearch, NotebookEdit and artifact were all
//   sitting in that frame. The fix maps a buildTool variable name to its registered name by stripping the
//   `Tool`/`V2` suffix.
//
//   This is the fourth instance in this session of the same failure — R488's phantom tools, R493's detector
//   matching its own comment, R495's index counting its own output, R498's name-mismatch — and in every case
//   the wrong version produced a confident, self-consistent-looking result.
//
// WHAT IS RECORDED
//   The refutation, not the hypothesis. A tool that kept the hypothesis and quietly dropped the contradicted
//   rows would be worse than one that reports "nine absent, five unexplained" — because the next reader would
//   inherit a false explanation instead of an open question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'deferred-tools.cjs');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

const run = (args = []) => spawnSync(process.execPath, [TOOL, '--json', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

const haveAll = fs.existsSync(DIST)
  && fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'));

test('deferred tools are read from the bundle, not guessed', { skip: !haveAll }, () => {
  const result = run();
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 800));
  const d = JSON.parse(result.stdout);

  assert.ok(d.scanned > 20, `only ${d.scanned} buildTool definitions scanned`);
  assert.ok(d.deferred.length > 0, 'no deferred tool found');

  // Both MCP tools carry the flag; that part of the lead was real.
  for (const name of ['ListMcpResourcesTool', 'ReadMcpResourceTool']) {
    assert.ok(d.deferred.includes(name), `${name} no longer reports shouldDefer: true`);
  }
  // RefreshMcpToolsTool has no flag — and it is the one that IS registered.
  assert.ok(!d.deferred.includes('RefreshMcpToolsTool'),
    'RefreshMcpToolsTool now reports shouldDefer: the discriminating observation is gone');
});

test('the hypothesis is reported as refuted, not as confirmed', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  // More deferred tools are registered than absent. That is the refutation.
  assert.ok(d.deferredButRegistered.length >= 10,
    `only ${d.deferredButRegistered.length} deferred tools are registered: `
    + 're-derive whether shouldDefer withholds a tool from the init frame');
  for (const name of ['AskUserQuestionTool', 'WebFetchTool', 'NotebookEditTool']) {
    assert.ok(d.deferredButRegistered.includes(name),
      `${name} is no longer reported as deferred-but-registered`);
  }

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /REFUTED/, 'the tool no longer states that the hypothesis is refuted');
  assert.match(source, /does not control frame membership|not whether it appears in the frame/,
    'the tool no longer states what shouldDefer actually controls');
});

test('the cross-check maps buildTool names to registered names', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /runtimeNameOf/, 'the name mapping is gone: the cross-check will be vacuous again');
  assert.match(source, /\.replace\(\/Tool\$\/, ''\)/, 'the Tool-suffix strip is gone');
  assert.match(source, /\.replace\(\/V2\$\/, ''\)/, 'the V2-suffix strip is gone');
});

test('a deferred tool with no flag is not attributed one', { skip: !haveAll }, () => {
  // Region bounding: each buildTool call must be delimited by the next one, or a tool without a flag inherits
  // its neighbour's.
  const d = JSON.parse(run().stdout);
  assert.ok(!d.deferred.includes('SendFeedbackTool'),
    'SendFeedbackTool sets shouldDefer: false and must not be listed as deferred');
  assert.ok(!d.deferred.includes('BashTool'), 'BashTool has no flag and must not be listed as deferred');
  assert.ok(!d.deferred.includes('FileReadTool'), 'FileReadTool has no flag and must not be listed as deferred');

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /anchorRe/, 'the anchor scan is gone');
  assert.match(source, /anchors\[i \+ 1\]/, 'the next-anchor bound is gone');
});

test('the unexplained remainder is stated, not smoothed over', { skip: !haveAll }, () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /did not\s+identify|did not identify/,
    'the tool no longer admits which absences remain unexplained');
  assert.match(source, /isEnabled/, 'the tool no longer records that isEnabled was checked as an alternative');
});
