// R443: the contract's OWN tool list — and a correction to last round's suggestion.
//
// LAST ROUND'S SUGGESTION WAS WRONG
//   R442 proposed comparing `isEnabled` / `checkPermissions` as "the contract's third dimension".
//   Neither name appears in sdk-tools.d.ts. They are members of CCB's internal `Tool` interface
//   (src/Tool.ts:415-418), not part of the published contract.
//
//   That was a guess presented as a plan. The correction matters more than the guess: a round spent
//   comparing a dimension that does not exist would have produced confident nonsense.
//
// WHAT THE CONTRACT ACTUALLY CONTAINS
//   81 interfaces + 9 types, and every interface is a `*Input` or `*Output`. There is no tool
//   descriptor, no availability flag, no permission predicate. The only two non-Input/-Output
//   declarations are:
//       export type ToolInputSchemas  = | AgentInput | BashInput | ...
//       export type ToolOutputSchemas = | AgentOutput | ...
//
//   Those unions ARE the contract's enumeration of tools — a better source than counting interfaces
//   by hand, which is how R417 arrived at 44.
//
// THE RESULT
//   44 tools, 34 present, 10 absent — identical to R417's count, now derived from the contract
//   itself. Plus one detail R417 could not see: `Projects` has an Input but no Output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const TOOL_TS = path.join(SRC, 'src', 'Tool.ts');

const dtsLines = () => fs.readFileSync(DTS, 'utf8').split('\n');

/** Members of the contract's union type, read line by line. */
function unionMembers(name) {
  const lines = dtsLines();
  const start = lines.findIndex((l) => new RegExp('^export type ' + name + '\\s*=').test(l));
  assert.ok(start >= 0, name + ' union is gone from the contract');
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*\|\s*([A-Za-z_$][\w$]*)\s*$/.exec(line);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const strip = (names, suffix) =>
  names.map((n) => (n.endsWith(suffix) ? n.slice(0, -suffix.length) : n));

test('the contract enumerates 44 tools, and the two lists differ by exactly one', () => {
  // This is the authoritative count. R417 arrived at 44 by counting interfaces by hand; the union
  // says 44 directly, which is a stronger basis for the same number.
  const inputTools = strip(unionMembers('ToolInputSchemas'), 'Input');
  const outputTools = strip(unionMembers('ToolOutputSchemas'), 'Output');
  assert.equal(inputTools.length, 44, 'the contract tool count changed');
  assert.equal(outputTools.length, 43, 'the output union changed size');

  const onlyInput = inputTools.filter((n) => !outputTools.includes(n));
  assert.deepEqual(onlyInput, ['Projects'],
    'the input/output asymmetry changed: re-derive which tool lacks an output schema');
});

test('34 of the 44 are implemented, and the absent 10 are named', () => {
  const ALL = [...new Set([...strip(unionMembers('ToolInputSchemas'), 'Input'),
    ...strip(unionMembers('ToolOutputSchemas'), 'Output')])];
  const DIR_OVERRIDE = {
    ExitPlanMode: 'ExitPlanModeTool',
    FileEdit: 'FileEditTool', FileRead: 'FileReadTool', FileWrite: 'FileWriteTool',
    CronCreate: 'ScheduleCronTool', CronDelete: 'ScheduleCronTool', CronList: 'ScheduleCronTool',
    ListMcpResources: 'ListMcpResourcesTool', ReadMcpResource: 'ReadMcpResourceTool',
    ReadMcpResourceDir: 'ReadMcpResourceDirTool',
  };
  const present = [];
  const absent = [];
  for (const name of ALL) {
    const dir = DIR_OVERRIDE[name] || name + 'Tool';
    (fs.existsSync(path.join(TOOLS, dir)) ? present : absent).push(name);
  }

  assert.equal(present.length, 34, 'the implemented-tool count changed: re-derive R417 coverage');
  assert.equal(absent.length, 10, 'the absent-tool count changed');
  assert.deepEqual(absent.sort(), [
    'ClaudeDesign', 'OfferChromeSetup', 'Projects', 'ProposeSkills', 'ReadMcpResourceDir',
    'ReadNotifications', 'ReportFindings', 'ScheduleWakeup', 'ShowOnboardingRolePicker', 'Workflow',
  ], 'the absent-tool list changed: update R417 and this test together');
});

test('the contract has NO availability or permission dimension', () => {
  // The correction to R442's suggestion. If this ever becomes false, a real third comparison
  // dimension appears and this test is where that change should surface.
  const dts = fs.readFileSync(DTS, 'utf8');
  for (const name of ['isEnabled', 'checkPermissions', 'check_permissions', 'isAvailable',
    'isReadOnly', 'isDestructive']) {
    assert.ok(!dts.includes(name),
      name + ' appeared in the contract: it IS a comparable dimension now, re-derive R443');
  }

  // And confirm where those names actually live — CCB's internal Tool interface, not the contract.
  const toolTs = fs.readFileSync(TOOL_TS, 'utf8');
  for (const name of ['isEnabled', 'isReadOnly', 'isDestructive']) {
    assert.ok(toolTs.includes(name),
      name + ' is gone from CCB Tool.ts: re-derive what the internal interface still declares');
  }
});

test('every contract interface is an Input or Output — nothing else is published', () => {
  // This is what makes the union lists the complete tool enumeration rather than a partial view.
  const dts = fs.readFileSync(DTS, 'utf8');
  const ifaces = [...dts.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]);
  assert.ok(ifaces.length >= 80, 'the interface count dropped: ' + ifaces.length);
  const stray = ifaces.filter((n) => !n.endsWith('Input') && !n.endsWith('Output'));
  assert.deepEqual(stray, [],
    'non-Input/Output interfaces appeared: the contract may now publish a tool descriptor, which '
    + 'would add a comparison dimension');

  const types = [...dts.matchAll(/^export type (\w+)/gm)].map((m) => m[1]);
  // Two unions plus seven tools whose Output is a `type` alias rather than an `interface`. The
  // alias form is easy to miss: an interface-only scan under-counts the contract by those tools.
  const unions = types.filter((n) => n.startsWith('Tool'));
  assert.deepEqual(unions.sort(), ['ToolInputSchemas', 'ToolOutputSchemas'],
    'the union types changed: re-derive the tool enumeration');
  const aliases = types.filter((n) => n.endsWith('Output'));
  assert.deepEqual(aliases.sort(), [
    'AgentOutput', 'ArtifactOutput', 'FileReadOutput', 'ListMcpResourcesOutput', 'McpOutput',
    'ProjectsOutput', 'RefreshMcpToolsOutput',
  ], 'the set of Output type aliases changed: an interface-only scan would under-count by these');
});

test('a bare [^;]+ regex would have merged the two unions — why extraction is line-based', () => {
  // The first two extraction attempts produced 45 and 46 "input" members because \\s matches
  // newlines and the union terminator is optional in a lazy match. Recording the trap so the next
  // reader does not retry it.
  const text = fs.readFileSync(DTS, 'utf8');
  const lazy = /export type ToolInputSchemas\s*=([^;]+);/.exec(text);
  assert.ok(lazy, 'the union is gone');
  const leaked = lazy[1].includes('ToolOutputSchemas');
  assert.equal(leaked, true,
    'the lazy-match trap no longer reproduces: the line-based extractor may no longer be necessary, '
    + 'but the contract text changed, so re-verify the counts above');
});
