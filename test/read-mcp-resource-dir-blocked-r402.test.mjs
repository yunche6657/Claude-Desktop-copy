// R402: ReadMcpResourceDir cannot be implemented against the MCP protocol as specified.
//
// THE FINDING
//   The tool takes a DIRECTORY resource URI and returns its direct children, marking
//   subdirectories with mimeType "inode/directory". Measured against the SDK that CCB actually
//   depends on:
//
//     ListResourcesRequest.params  -> only `_meta` and `cursor`; no `uri`, no parent filter
//     "inode/directory"            -> zero occurrences in the whole SDK
//
//   So `resources/list` is a FLAT enumeration with paging, and directory semantics do not exist
//   at the protocol level. Building the tool on top of it means prefix-filtering a flat list and
//   guessing which entries are directories — fields aligned, meaning invented.
//
// A REAL DEFECT FOUND ON THE WAY
//   fetchResourcesForClient sends `{ method: 'resources/list' }` with no cursor and discards
//   `result.nextCursor`. The protocol supports both. So ListMcpResources silently returns only
//   the first page, and the result is LRU-cached. That affects an EXISTING tool and is recorded
//   here rather than fixed, because fixing it changes every MCP tool's behaviour and paging
//   correctness has no real server to verify against in this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const SDKS = path.join(SRC, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');

function sdkTypes() {
  const p = path.join(SDKS, 'types.d.ts');
  assert.ok(fs.existsSync(p),
    'the MCP SDK type definitions are missing at ' + p
    + '; the source tree needs `bun install --ignore-scripts` (see R397)');
  return fs.readFileSync(p, 'utf8');
}

/** Direct keys of the `params` object inside a named request schema. */
function requestParams(text, schemaName) {
  const i = text.indexOf('export declare const ' + schemaName);
  assert.ok(i > 0, 'schema not found: ' + schemaName);
  const seg = text.slice(i, i + 4000);
  const start = seg.indexOf('params:');
  assert.ok(start > 0, schemaName + ' has no params');
  const open = seg.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let k = open; k < seg.length; k += 1) {
    if (seg[k] === '{') depth += 1;
    else if (seg[k] === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > 0, 'unbalanced params in ' + schemaName);
  const block = seg.slice(open, end + 1);
  const keys = [];
  let d = 0;
  for (const line of block.split('\n')) {
    if (d === 1) {
      const m = /^\s*([\w."/-]+)\??:/.exec(line);
      if (m) keys.push(m[1]);
    }
    d += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return keys;
}

test('resources/list accepts only _meta and cursor — there is no directory filter', () => {
  const params = requestParams(sdkTypes(), 'ListResourcesRequestSchema');
  assert.deepEqual(params.sort(), ['_meta', 'cursor'],
    'the protocol gained params, which may make a directory tool implementable: re-derive §2');
  assert.ok(!params.includes('uri'),
    'resources/list now takes a uri: ReadMcpResourceDir may be implementable, revisit the blocker');
});

test('the SDK has no inode/directory convention', () => {
  // The official tool marks subdirectories with this mimeType. If the convention is not in the
  // protocol, a CCB implementation would have to invent it per-server.
  const text = sdkTypes();
  assert.ok(!text.includes('inode/directory'),
    'the SDK now mentions inode/directory: the directory convention became protocol-level, so '
    + 'revisit the §2 analysis');
});

test('ListResourcesResult carries nextCursor, so paging exists', () => {
  const text = sdkTypes();
  assert.match(text, /ListResourcesResultSchema[\s\S]{0,2500}nextCursor/,
    'nextCursor vanished from the result schema; the paging defect below would not apply');
});

test('fetchResourcesForClient still drops nextCursor — a live defect in an existing tool', () => {
  const client = fs.readFileSync(path.join(SRC, 'src', 'services', 'mcp', 'client.ts'), 'utf8');
  const at = client.indexOf('export const fetchResourcesForClient');
  assert.ok(at > 0, 'fetchResourcesForClient is gone; re-derive the paging finding');
  const body = client.slice(at, at + 1400);

  assert.match(body, /method: 'resources\/list'/,
    'the call site changed; re-derive whether it pages');
  assert.ok(!/cursor/.test(body),
    'fetchResourcesForClient now passes or reads a cursor: the paging defect is fixed, so the '
    + 'evidence in read-mcp-resource-dir-r402.md §3 must be updated');
});

test('the tool is still absent from the bundle', () => {
  const dist = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
  const tableFile = fs.readdirSync(dist)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(dist, n)).size < 20_000_000)
    .find((n) => fs.readFileSync(path.join(dist, n), 'utf8').includes('function getAllBaseTools()'));
  assert.ok(tableFile, 'the tool table is missing');
  const table = fs.readFileSync(path.join(dist, tableFile), 'utf8');
  assert.ok(!table.includes('ReadMcpResourceDirTool'),
    'ReadMcpResourceDirTool is registered: §2 was implemented, update the worklist and this file');
  // Contrast: the sibling tool this was compared against IS present.
  assert.ok(table.includes('ReadMcpResourceTool'),
    'ReadMcpResourceTool vanished, which contradicts the §4 list of already-matching tools');
});
