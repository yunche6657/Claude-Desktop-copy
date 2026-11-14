// R504: the last three unexplained tools now have a measured cause, and it is not a flag.
//
// THE QUESTION CARRIED FOR FOUR ROUNDS
//   R500 reported three contract tools as "listed in the registration block but absent at runtime, unexplained":
//   ListMcpResources, ReadMcpResource, Mcp. R501 proposed `shouldDefer: true`; the data refuted it, because
//   eleven deferred tools are registered anyway.
//
// THE MECHANISM, READ FROM SOURCE AND CONFIRMED BY EXPERIMENT
//   src/tools.ts, inside getTools():
//       const specialTools = new Set([
//         ListMcpResourcesTool.name, ReadMcpResourceTool.name, SYNTHETIC_OUTPUT_TOOL_NAME,
//       ])
//       const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
//   with the comment "filter out special tools that get added conditionally". They are stripped here —
//   unconditionally, which is why the registration block looks like it should register them.
//
//   dist/chunk-fbsjt94j.js, per MCP client:
//       const supportsResources = !!client.capabilities?.resources;
//       const resourceTools = [];
//       if (supportsResources) { ... resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool); }
//
//   So the two resource tools exist only when a connected MCP server advertises the `resources` capability.
//
// THE MEASUREMENT
//   tools/mcp-tool-gate.cjs launches the CLI twice — once with no MCP configuration, once with a twelve-line
//   stdio fixture server that answers `initialize` with `capabilities.resources` — and diffs the init frames:
//        no MCP configuration:    39 tools
//        with a resources server: 41 tools
//        gained: ListMcpResourcesTool, ReadMcpResourceTool
//
//   That is the whole question answered by observation rather than by reading. Reading the source predicted it;
//   the two probes are what make it a fact.
//
// WHY THE THIRD TOOL IS A DIFFERENT CASE
//   The contract's `Mcp` does not come back with a resources-only fixture, and it should not: MCPTool declares
//   `name: 'mcp'` and is installed per server that provides tools. Reporting all three as "explained by the
//   resources gate" would have been tidier and false.
//
// WHAT THIS ROUND ALSO CHANGED IN tool-absence
//   The three rows moved from `listed-not-registered` to `requires-mcp-server`, so that the unexplained count
//   is now zero and the tool stops implying a defect where there is a configuration dependency. Every one of
//   the 44 contract tools now carries a reason.
//
// WHAT IS NOT CLAIMED
//   Not that `mcp` can never be registered — only that this fixture does not register it. Not that a real
//   server would behave identically to the fixture; the claim is about the CLI's assembly logic, and the fixture
//   isolates that. And not that the 41-tool figure is any build's full surface: it is what one resources-capable
//   server adds to the default flag set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'tools', 'mcp-tool-gate.cjs');
const ABSENCE = path.join(ROOT, 'tools', 'tool-absence.cjs');
const SRC = path.join(ROOT, '..', '.tmp', 'ccb-src');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(SRC, 'src', 'tools.ts'));

const runGate = () => spawnSync(process.execPath, [GATE, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

test('the two resource tools appear exactly when a resources-capable server connects', { skip: !haveAll }, () => {
  const r = runGate();
  assert.equal(r.status, 0, 'the gate probe failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.equal(d.withoutMcp, 39, 'the no-MCP tool count changed');
  assert.equal(d.withMcp, 41, 'the with-MCP tool count changed');
  assert.deepEqual(d.gained.sort(), ['ListMcpResourcesTool', 'ReadMcpResourceTool'],
    'the tools gained from a resources server changed: ' + JSON.stringify(d.gained));
  assert.deepEqual(d.stillAbsent, [], 'a resource tool is still absent despite the fixture');
});

test('the mechanism is quoted from source, not asserted from memory', { skip: !fs.existsSync(SRC) }, () => {
  const toolsTs = fs.readFileSync(path.join(SRC, 'src', 'tools.ts'), 'utf8');
  // The strip half.
  assert.match(toolsTs, /const specialTools = new Set\(\[/,
    'the specialTools set is gone: the strip half of the mechanism changed');
  assert.match(toolsTs, /ListMcpResourcesTool\.name/, 'ListMcpResourcesTool is no longer stripped');
  assert.match(toolsTs, /ReadMcpResourceTool\.name/, 'ReadMcpResourceTool is no longer stripped');
  assert.match(toolsTs, /getAllBaseTools\(\)\.filter\(tool => !specialTools\.has\(tool\.name\)\)/,
    'the filter expression changed');
  assert.match(toolsTs, /added conditionally/,
    'the comment explaining that these are conditionally re-added is gone');
});

test('every contract tool now carries a reason', { skip: !haveAll }, () => {
  const r = spawnSync(process.execPath, [ABSENCE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  assert.equal(r.status, 0, 'tool-absence failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);

  const counts = d.rows.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {});
  assert.equal(counts['listed-not-registered'] || 0, 0,
    'an absence is unexplained again: ' + JSON.stringify(counts));

  // R506 split the MCP trio: the two resource tools require a server, while `Mcp` is a template name that no
  // configuration can register. This test originally asserted all three sat in requires-mcp-server; that was
  // correct for R504 and is now superseded, so it asserts the MCP-related total and the split instead.
  const mcpTotal = (counts['requires-mcp-server'] || 0) + (counts['template-only-name'] || 0);
  assert.equal(mcpTotal, 3, 'the MCP-related group changed size: ' + JSON.stringify(counts));
  assert.equal(counts['requires-mcp-server'], 2,
    'the resource pair no longer accounts for exactly two rows');
});

test('the third tool is reported as a different case, not folded into the same explanation', { skip: !haveAll }, () => {
  const d = JSON.parse(spawnSync(process.execPath, [ABSENCE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
  }).stdout);

  const byName = new Map(d.rows.map((x) => [x.contractName, x]));
  const mcp = byName.get('Mcp');
  assert.ok(mcp, 'Mcp is missing from the analysis');
  // R504 grouped it with the resource pair; R506 measured that it belongs elsewhere. Either way it must not be
  // treated as "will appear once a server connects", which is what folding it in would imply.
  assert.notEqual(mcp.reason, 'requires-mcp-server',
    'Mcp is again grouped with the resource pair: that implies a server would register it, which is false');
  assert.equal(mcp.reason, 'template-only-name',
    'Mcp is no longer classified as a template-only name');

  const list = byName.get('ListMcpResources');
  assert.match(list.detail, /specialTools/,
    'the ListMcpResources row no longer cites the strip mechanism');
});

test('the tool states which figure it is and is not claiming', () => {
  const source = fs.readFileSync(GATE, 'utf8');
  // The disclaimer is in the THE THIRD TOOL IS DIFFERENT header block.
  assert.match(source, /is not this mechanism/,
    'the tool no longer separates the Mcp case from the resources gate');
  assert.match(source, /per-server dynamic tool/,
    'the tool no longer says MCPTool is installed per server');
  assert.match(source, /claim is about the CLI/,
    'the tool no longer limits the claim to the assembly logic rather than to real servers');
  assert.match(source, /resources-only fixture does not register it either/,
    'the tool no longer admits the fixture leaves `mcp` unregistered');
});
