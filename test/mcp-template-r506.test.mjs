// R506: `Mcp` is not "needs an MCP server" — it is a template's name, and no configuration can register it.
//
// WHAT R504 SAID, AND WHY IT WAS TOO TIDY
//   R504 proved the two resource tools appear once a server advertising `resources` connects, and filed the
//   third — the contract's `Mcp` — under the same heading with a note that MCPTool declares `name: 'mcp'` and
//   is "installed per server". That was a reading, and it blurred two different verdicts into one row of the
//   table.
//
// WHAT THE MEASUREMENT SHOWS
//   tools/mcp-template.cjs reads the shipped bundle and the source tree:
//       template name property:   "mcp"
//       spread "…MCPTool," found: yes
//       name override in spread:  skipPrefix ? tool.name : fullyQualifiedName
//       modules importing MCPTool (excluding its own file and tests): 0
//
//   So the shape is:
//       var MCPTool = buildTool({ isMcp: true, name: "mcp", ... });      // a prototype
//       return { ...MCPTool, name: skipPrefix ? tool.name : fqName };    // every server tool derives from it
//   and nothing imports MCPTool as a tool in its own right.
//
//   Therefore `mcp` is a name that exists only as a prototype's field. Connecting a hundred servers still
//   registers no tool called `mcp`; each is registered under its derived name. The contract's `Mcp` input —
//   a bare `[k: string]: unknown` — describes something never instantiated under that name.
//
// THE TWO VERDICTS ARE NOW SEPARATED
//   requires-mcp-server   the tool exists and appears once a prerequisite is met (ListMcpResources,
//                         ReadMcpResource — proven in R504 by going 39 → 41 tools with a fixture server)
//   template-only-name    no configuration can produce it, because the name belongs to a template (Mcp)
//
//   Collapsing those into one reason would have implied that starting an MCP server would surface all three,
//   which is false for one of them.
//
// WHAT IS NOT CLAIMED
//   Not that the contract is wrong to declare `Mcp` — an SDK-facing schema may legitimately describe a template.
//   Only that this build never registers a tool by that name, and that this is a fact about naming rather than
//   about missing functionality. Nor is it claimed that MCPTool is dead code: the spread uses it constantly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'tools', 'mcp-template.cjs');
const ABSENCE = path.join(ROOT, 'tools', 'tool-absence.cjs');
const SRC = path.join(ROOT, '..', '.tmp', 'ccb-src');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist'))
  && fs.existsSync(path.join(SRC, 'packages'));

test('MCPTool is a template with no importers', { skip: !haveAll }, () => {
  const r = spawnSync(process.execPath, [TEMPLATE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.equal(r.status, 0, 'the template analysis failed:\n' + (r.stderr || '').slice(0, 700));
  const d = JSON.parse(r.stdout);

  assert.equal(d.templateName, 'mcp', 'the template name property changed');
  assert.equal(d.spreadFound, true, 'the spread that derives per-server tools is gone');
  assert.equal(d.importers.length, 0,
    `MCPTool is now imported as a tool: ${JSON.stringify(d.importers)} — the template verdict needs re-deriving`);
  // The override must be a computed name, not a literal, or the template could be registered unchanged.
  assert.match(d.nameOverride, /skipPrefix|tool\.name|fullyQualifiedName/,
    'the name override no longer computes a per-server name: ' + d.nameOverride);
});

test('the template name appears in source only as a definition and a spread', { skip: !haveAll }, () => {
  const p = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'MCPTool', 'MCPTool.ts');
  assert.ok(fs.existsSync(p), 'MCPTool.ts moved');
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /export const MCPTool = buildTool\(/, 'the template definition changed');
  assert.match(text, /name:\s*'mcp'/, "the template's own name is no longer 'mcp'");
});

test('Mcp and the resource pair now carry different reasons', { skip: !haveAll }, () => {
  const r = spawnSync(process.execPath, [ABSENCE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  assert.equal(r.status, 0, 'tool-absence failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  const byName = new Map(d.rows.map((x) => [x.contractName, x]));

  assert.equal(byName.get('Mcp').reason, 'template-only-name',
    'Mcp is no longer classified as template-only: it would be implied to appear with a server');
  assert.equal(byName.get('ListMcpResources').reason, 'requires-mcp-server');
  assert.equal(byName.get('ReadMcpResource').reason, 'requires-mcp-server');

  // And the counts must reflect the split, not the old lump.
  const counts = d.rows.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {});
  assert.equal(counts['requires-mcp-server'], 2, 'the requires-mcp-server count did not drop to 2');
  assert.equal(counts['template-only-name'], 1, 'the template-only-name count is not 1');
  assert.equal(counts['listed-not-registered'] || 0, 0, 'an absence is unexplained again');
});

test('the distinction is stated in the tool, not left to the reader', () => {
  const source = fs.readFileSync(ABSENCE, 'utf8');
  assert.match(source, /TEMPLATE_ONLY/, 'the template-only set is gone');
  assert.match(source, /prototype's name|prototype name/,
    'the tool no longer explains that mcp is a prototype name');
  assert.match(source, /cannot\s+appear at all|never appears under that name/,
    'the tool no longer says this tool cannot be registered by any configuration');
  assert.match(source, /different\s+verdict|different reason/,
    'the tool no longer distinguishes the two verdicts');
});

test('the template tool does not claim MCPTool is unused', () => {
  const source = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(source, /Nor is it claimed that MCPTool is dead code/i,
    'the tool no longer disclaims the dead-code reading');
  assert.match(source, /spread uses it constantly/i,
    'the tool no longer records that the spread depends on the template');
});
