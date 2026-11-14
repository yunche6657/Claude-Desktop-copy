// R490: the 19 shared tools are 16 identical / 3 differing, and every difference is the CLI having MORE.
//
// WHY THIS WAS THE RIGHT NEXT QUESTION
//   R489 showed the CLI contract (claude-code 2.1.318, 44 tools) and the SDK contract (claude-agent-sdk
//   0.2.114, 21 tools) are not in a subset relation: Config and TaskOutput exist only in the SDK file.
//   That was a conclusion about tool NAMES. If the 19 shared tools had identical input contracts, the
//   divergence would be one-directional — the SDK simply lags — and comparing CCB against either would
//   agree on those 19. If their fields differed in both directions, the two files came from genuinely
//   separate lineages and no cross-contract comparison could assume a shared schema.
//
// THE MEASUREMENT
//       19 shared tools
//       16 with byte-identical input field sets (names, types, optionality)
//        3 with differences, ALL of them the CLI having more:
//          Agent     CLI adds `effort`; `isolation` adds "remote"; `model` adds "fable"
//          FileRead  CLI adds `allow_large`
//          WebFetch  CLI adds `offset`
//
//   Every one of the three is additive on the CLI side. Nothing exists in the SDK that is absent from the
//   CLI among these 19. So the shared portion is consistent with a version skew (the SDK tracks an older
//   CLI), not with two independently branched schemas.
//
// WHERE THE FIRST PARSER WAS WRONG — AND WHY IT LOOKED LIKE A DATA FINDING
//   The first run reported "tools with no parsed interface at all: Mcp". That reads like the CLI contract
//   is missing an interface its own union names. It was a parser gap: McpInput is declared as
//       export interface McpInput {
//         [k: string]: unknown;
//       }
//   — an index signature, not a named field. The field regex required `name: type`, so it produced zero
//   fields, and zero fields was reported as "no interface".
//
//   The fix was to parse index signatures as fields, and the self-check now asserts McpInput yields exactly
//   one index-signature field. Without that assertion the parser could regress silently and the report
//   would again claim a missing interface.
//
// THE SELF-CHECK IS THE POINT
//   The tool refuses to print a comparison when its own parser fails hand-verified facts (FileReadInput's
//   five fields, file_path required, offset optional, AgentInput's two required fields, McpInput's index
//   signature). That is deliberate: this project has repeatedly trusted a detector that did not describe
//   the file, and a confident wrong comparison is worse than no comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'contract-fields.cjs');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const SDK = path.join(ROOT, '..', '.tmp', 'ccb-src', 'node_modules', '.cache',
  '@anthropic-ai', 'claude-agent-sdk@0.2.114@@@1', 'sdk-tools.d.ts');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

const haveBoth = fs.existsSync(CLI) && fs.existsSync(SDK);

test('the shared tools are 16 identical and 3 differing', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the field comparison failed:\n' + (result.stderr || '').slice(0, 900));
  const r = JSON.parse(result.stdout);

  assert.equal(r.sharedCount, 19, 'the shared tool set changed: re-derive the comparison');
  assert.equal(r.identicalCount, 16, 'the identical count changed');
  assert.equal(r.differingCount, 3, 'the differing count changed');
  assert.deepEqual(r.rows.filter((x) => !x.identical).map((x) => x.tool).sort(),
    ['Agent', 'FileRead', 'WebFetch'],
    'the set of differing tools changed');
});

test('every difference is the CLI having more, never the SDK', { skip: !haveBoth }, () => {
  // This is what makes the shared portion consistent with version skew rather than forked schemas.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);

  for (const row of r.rows.filter((x) => !x.identical)) {
    assert.equal(row.onlySdk.length, 0,
      `${row.tool} has fields only in the SDK: ${JSON.stringify(row.onlySdk)}`
      + ' — the divergence would no longer be one-directional');
    assert.ok(row.onlyCli.length > 0 || row.typeDiffs.length > 0 || row.optionalityDiffs.length > 0,
      `${row.tool} is marked differing but shows no difference`);
  }

  // And the specific additions, pinned so a future contract swap is visible.
  const agent = r.rows.find((x) => x.tool === 'Agent');
  assert.deepEqual(agent.onlyCli, ['effort'], 'Agent no longer adds effort on the CLI side');
  const isolation = agent.typeDiffs.find((d) => d.field === 'isolation');
  assert.ok(isolation && isolation.cli.includes('remote') && !isolation.sdk.includes('remote'),
    'the isolation type difference changed');
  const model = agent.typeDiffs.find((d) => d.field === 'model');
  assert.ok(model && model.cli.includes('fable') && !model.sdk.includes('fable'),
    'the model enum difference changed');

  assert.deepEqual(r.rows.find((x) => x.tool === 'FileRead').onlyCli, ['allow_large']);
  assert.deepEqual(r.rows.find((x) => x.tool === 'WebFetch').onlyCli, ['offset']);
});

test('an index signature is parsed as a field, not as a missing interface', { skip: !haveBoth }, () => {
  // The first parser produced zero fields for McpInput and the report said "no parsed interface at all",
  // which looks like a contract defect rather than a parser defect.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  const mcp = r.rows.find((x) => x.tool === 'Mcp');
  assert.ok(mcp, 'the Mcp tool disappeared from the shared set');
  assert.ok(mcp.identical,
    'Mcp is reported as differing: ' + JSON.stringify({ onlyCli: mcp.onlyCli, onlySdk: mcp.onlySdk }));

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /indexSignature/, 'index signatures are no longer marked');
  assert.match(source, /\[\\?\(\?<name>|\[\$\{idx/, 'the index-signature pattern is gone');
});

test('the parser refuses to report when its own self-check fails', () => {
  // A confident wrong comparison is worse than no comparison. The tool must gate on hand-verified facts.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /PARSER SELF-CHECK FAILED/,
    'the self-check no longer aborts the report');
  assert.match(source, /process\.exit\(3\)/, 'the abort no longer exits non-zero');
  // The specific facts it verifies must still be in the check.
  for (const fact of ['FileReadInput', 'allow_large', 'AgentInput', 'McpInput']) {
    assert.ok(source.includes(fact), `the self-check no longer mentions ${fact}`);
  }
  // FileReadInput's required/optional split is a real assertion, not a count.
  assert.match(source, /file_path.*should be required/,
    'the required/optional check on file_path is gone');
});

test('the comparison covers input contracts only, and says so', () => {
  // R440-R442 covered output fields for a different question. This tool must not appear to close that.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /input contract/i, 'the tool no longer states it compares input contracts');
  assert.ok(source.includes('ToolOutputSchemas'),
    'the tool no longer reads the output union at all, so it cannot compute the shared set');
  // It must not claim to have compared outputs.
  assert.ok(!/output contracts are identical/i.test(source),
    'the tool now claims a conclusion about output contracts it does not compute');
});
