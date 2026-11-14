// R403: RefreshMcpTools added to CCB.
//
// WHY THIS ONE WAS POSSIBLE
//   Two prior rounds recorded blockers where the official semantics needed a mechanism CCB lacks
//   (§3.2 review-card UI, §2 MCP directory semantics). This tool is the opposite case, the same
//   shape as R400's ProposeGoal: the mechanism already exists, only the model-facing entry point
//   was missing.
//
//     clearServerCache(name, config)   src/services/mcp/client.ts
//       -> clears connectToServer + the four fetch caches (tools/resources/commands)
//     options.refreshTools()           src/Tool.ts:169, already called from src/query.ts:1989
//     ConnectedMCPServer.config        is exactly the `serverRef` clearServerCache wants
//
//   So the tool is a thin, honest adapter — it does not invent protocol behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const SRC_TOOL = path.join(
  SRC, 'packages', 'builtin-tools', 'src', 'tools', 'RefreshMcpToolsTool', 'RefreshMcpToolsTool.ts',
);

function toolTableBody() {
  const { text } = findChunk('function getAllBaseTools()');
  const at = text.indexOf('function getAllBaseTools()');
  return text.slice(at, at + text.slice(at).indexOf('\n}'));
}

test('the bundle declares RefreshMcpTools with the official input field', () => {
  const { text } = findChunk('RefreshMcpToolsTool = buildTool(');
  assert.ok(text.includes('"RefreshMcpTools"'),
    'the literal tool name is missing, so the model would not see it');
  // The description is copied verbatim from sdk-tools.d.ts, making it the most stable evidence
  // that the declared field matches the official one.
  assert.ok(text.includes('Optional server name: refresh only this server'),
    'the official `server` field description is absent');
});

test('the tool is registered in the table, so the model can reach it', () => {
  assert.ok(toolTableBody().includes('RefreshMcpToolsTool'),
    'RefreshMcpToolsTool is not registered in the tool table');
});

test('it reuses the existing cache invalidation rather than reimplementing it', () => {
  // The load-bearing decision. If this tool performed its own MCP round-trip it would diverge
  // from how the rest of the app refreshes servers (and would miss the resource/command caches).
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /clearServerCache\(client\.name, client\.config\)/,
    'the tool no longer calls clearServerCache with the server config');
  assert.ok(!/resources\/list|tools\/list/.test(src),
    'the tool speaks the MCP protocol directly: it should go through clearServerCache');

  // And the helper it calls must still clear all four caches.
  const client = fs.readFileSync(path.join(SRC, 'src', 'services', 'mcp', 'client.ts'), 'utf8');
  const at = client.indexOf('export async function clearServerCache');
  assert.ok(at > 0, 'clearServerCache is gone');
  const body = client.slice(at, at + 1200);
  for (const cache of ['fetchToolsForClient', 'fetchResourcesForClient', 'fetchCommandsForClient']) {
    assert.ok(body.includes(cache + '.cache.delete'),
      'clearServerCache stopped clearing ' + cache + ', so a refresh would be partial');
  }
});

test('it asks the host to recompute tools, so the change is visible in this turn', () => {
  // Without this the caches are cold but the model's tool list still shows the old set until the
  // next query starts.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /context\.options\.refreshTools\?\.\(\)/,
    'the tool does not call the refreshTools callback');
});

test('omitting `server` refreshes all connected servers; naming one refreshes only it', () => {
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  // Assert the semantics, not the exact line wrapping. A regex keyed to indentation broke as
  // soon as the ternary was formatted differently, which says nothing about behaviour.
  assert.match(src, /const targets = input\.server/, 'the target-selection ternary is gone');
  assert.ok(/connected\.filter\(\s*\(?c\)?\s*=>\s*c\.name === input\.server\)/.test(src),
    'there is no branch that narrows to one server by name');
  assert.ok(/:\s*connected\b/.test(src),
    'there is no branch that keeps all connected servers');

  // An unknown name is an error, not a silent no-op — otherwise a typo looks like success.
  assert.match(src, /not found\. Available servers:/,
    'an unknown server name is no longer rejected');
});

test('it reports per-server failure instead of throwing the whole call away', () => {
  // One broken server must not make the other refreshes look unsuccessful.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /failed\.push\(\{ server: client\.name, error: errorMessage\(e\) \}\)/,
    'a per-server failure no longer lands in the failed list');
  assert.match(src, /const refreshed: string\[\] = \[\]/,
    'the refreshed list is gone');
  // Concurrency safety: refreshing mutates shared caches.
  assert.match(src, /isConcurrencySafe\(\)\s*\{\s*return false\s*\}/,
    'the tool claims concurrency safety while mutating shared MCP caches');
});

test('it is exported from the barrel and adopted into the bundle', () => {
  const barrel = fs.readFileSync(
    path.join(SRC, 'packages', 'builtin-tools', 'src', 'index.ts'), 'utf8',
  );
  assert.match(barrel, /export \{ RefreshMcpToolsTool \} from '\.\/tools\/RefreshMcpToolsTool\/RefreshMcpToolsTool\.js'/,
    'RefreshMcpToolsTool is not exported from the package barrel');

  const defining = fs.readdirSync(DIST)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(DIST, n)).size < 20_000_000)
    .filter((n) => fs.readFileSync(path.join(DIST, n), 'utf8').includes('RefreshMcpToolsTool = buildTool('));
  assert.equal(defining.length, 1,
    'expected exactly one chunk to define RefreshMcpToolsTool, got ' + defining.length);
});
