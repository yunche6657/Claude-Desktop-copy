// R489: the two sdk-tools.d.ts contracts on disk are NOT a package and its trimmed copy.
//
// WHY THIS MATTERED ENOUGH TO SPEND A ROUND ON
//   R488 found that the 44-name coverage list reproduces fully against
//   `.tmp/cc-contract/package/sdk-tools.d.ts`, and that two much smaller copies of sdk-tools.d.ts live
//   inside `.tmp/ccb-src/node_modules`. Before that discovery, the small copies had been mistaken for the
//   authoritative contract, producing a false report of "25 phantom tools".
//
//   A natural guess is that the small file is the same contract minus optional tools. If that were true, the
//   44-tool denominator would be a subset question and the coverage figure would be robust to which file you
//   read. It is not true, and the way it fails is informative.
//
// THE MEASUREMENT
//       CLI   @anthropic-ai/claude-code      2.1.318   173,038 bytes   44 in / 44 out   44 tools
//       SDK   @anthropic-ai/claude-agent-sdk 0.2.114   117,768 bytes   21 in / 20 out   21 tools
//
//       shared 19   CLI-only 25   SDK-only 2
//
//   The SDK set is not a subset. Two tools exist in the SDK contract and appear NOWHERE in the CLI
//   contract — not as an unused interface, not as a comment:
//       Config      ConfigInput / ConfigOutput        absent from the CLI file entirely
//       TaskOutput  TaskOutputInput / TaskOutputOutput absent; the CLI file lists TaskCreate, TaskGet,
//                                                       TaskList, TaskStop, TaskUpdate but not TaskOutput
//
//   So these are two independently evolved contracts. Consequences:
//     - "44 official tools" is a statement about claude-code 2.1.318 specifically. A different client
//       version yields a different denominator, so the 75% is version-scoped, not universal.
//     - A round comparing CCB against the SDK contract instead would find 21 tools, 2 of which the CLI
//       contract does not have, and would produce a different percentage.
//
// A COUNTING TRAP HIT TWICE
//   The last member line of `ToolInputSchemas` is the literal token `ToolOutputSchemas`: the union body has
//   no terminator before the next declaration, so a line-based extractor harvests the next type's NAME as a
//   member. R443 recorded this ("v2: 45 members, including ToolOutputSchemas") and R489 hit it again,
//   briefly reporting 45 inputs and a phantom tool named ToolOutputSchemas.
//   Both extractors now break when the member is a known union name. Because CCB tool names are also
//   PascalCase, nothing about the shape distinguishes them — only the union-name list does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'contract-compare.cjs');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const SDK = path.join(ROOT, '..', '.tmp', 'ccb-src', 'node_modules', '.cache',
  '@anthropic-ai', 'claude-agent-sdk@0.2.114@@@1', 'sdk-tools.d.ts');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

// The contracts live outside the repository; skip cleanly rather than fail on an environment difference.
const haveBoth = fs.existsSync(CLI) && fs.existsSync(SDK);

test('the two contracts describe different tool counts', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the comparison tool failed:\n' + (result.stderr || '').slice(0, 800));
  const r = JSON.parse(result.stdout);

  assert.equal(r.cli.tools.length, 44, 'the CLI contract tool count changed: re-derive the coverage denominator');
  assert.equal(r.sdk.tools.length, 21, 'the SDK contract tool count changed');
  assert.equal(r.cli.version, '2.1.318', 'the CLI package version changed');
  assert.equal(r.sdk.version, '0.2.114', 'the SDK package version changed');
  assert.equal(r.deltaTools, 23, 'the difference between the contracts changed');
});

test('the SDK contract is NOT a subset of the CLI contract', { skip: !haveBoth }, () => {
  // This is the substantive finding: if it were a subset, the denominator debate would be moot.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);

  assert.equal(r.sdkIsSubset, false,
    'the SDK contract became a subset. If that is genuine, the analysis in this round needs revisiting.');
  assert.deepEqual(r.sdkOnly, ['Config', 'TaskOutput'],
    'the SDK-only set changed: ' + JSON.stringify(r.sdkOnly));
  assert.equal(r.shared.length, 19, 'the shared set changed');
  assert.equal(r.cliOnly.length, 25, 'the CLI-only set changed');
});

test('the SDK-only tools are absent from the CLI contract text entirely', { skip: !haveBoth }, () => {
  // Not merely missing from a union — the strings do not occur at all.
  const text = fs.readFileSync(CLI, 'utf8');
  for (const name of ['Config', 'TaskOutput']) {
    assert.ok(!text.includes(name),
      `${name} now appears in the CLI contract: the two contracts may have converged`);
  }
  // And the CLI does list its own Task* family, so the absence is specific, not a parsing gap.
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate']) {
    assert.ok(text.includes(name), `${name} is missing from the CLI contract: the comparison premise broke`);
  }
});

test('a union name is never harvested as a tool', { skip: !haveBoth }, () => {
  // The trap R443 and R489 both hit: ToolOutputSchemas is the next declaration, not a member.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  for (const side of ['cli', 'sdk']) {
    assert.ok(!r[side].tools.includes('ToolInputSchemas'),
      `${side}: ToolInputSchemas was collected as a tool`);
    assert.ok(!r[side].tools.includes('ToolOutputSchemas'),
      `${side}: ToolOutputSchemas was collected as a tool`);
  }
  // The counts must be equal for the CLI contract, where every tool has both sides.
  assert.equal(r.cli.inputs, r.cli.outputs,
    'the CLI contract no longer has equal input and output counts: extraction may have drifted');
  // The SDK contract is documented as 21 in / 20 out, the difference being TaskOutput having no input
  // schema of its own.
  assert.equal(r.sdk.inputs - r.sdk.outputs, 1,
    'the SDK input/output skew changed: re-derive which tool lacks a side');
});

test('the tool names the CLI contract as the denominator', () => {
  // The report must state which contract the coverage figure rests on, because reading the wrong file
  // produced a false "25 phantom tools" verdict one round earlier.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /which contract is the denominator/i,
    'the report no longer explains that the denominator is contract-dependent');
  assert.match(source, /claude-code 2\.1\.318|CLI package/,
    'the report no longer names the CLI package as the source');
  assert.match(source, /UNION_NAMES/,
    'the union-name guard is gone: the next reader will harvest ToolOutputSchemas again');
});
