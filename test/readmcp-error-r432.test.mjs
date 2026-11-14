// R432: ReadMcpResource reports `error` — for exactly one failure path.
//
// THE BOUNDARY IS THE WHOLE POINT
//   The official field says "Human-readable error when the server could not read the resource".
//   That is one failure: the request reached a connected, capable server and still failed.
//
//   The three checks above it are the caller's fault:
//       server not found / not connected / no resource capability
//
//   Wrapping the entire call in a try/catch would turn those into `error` strings, and a caller
//   could no longer tell "I called it wrong" from "the server is broken". A permanently-absent
//   field withholds information; a misleading error sends the caller down the wrong path.
//
//   So the load-bearing assertions here are the ones that check the three throws are STILL throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOL = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'ReadMcpResourceTool',
  'ReadMcpResourceTool.ts');
const LIST = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'ListMcpResourcesTool',
  'ListMcpResourcesTool.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const src = () => fs.readFileSync(TOOL, 'utf8');

function code() {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the contract keeps error optional and scoped to server-side read failure', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface ReadMcpResourceOutput');
  assert.ok(at > 0, 'ReadMcpResourceOutput is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = dts.slice(open + 1, end);
  assert.match(body, /error\?: string/, 'error is no longer optional');
  assert.ok(/the server could not read the resource/.test(body),
    'the contract wording changed: re-derive which failure this field describes');
  // contents stays REQUIRED — that is why an empty array is the honest failure value.
  assert.match(body, /contents: \{/, 'contents is no longer required');
});

test('all three caller-error checks still THROW', () => {
  // If any of these becomes a returned value, callers lose the ability to distinguish their own
  // mistake from a broken server.
  const c = code();
  for (const [label, pattern] of [
    ['server not found', /if \(!client\) \{\s*throw new Error\(/],
    ['server not connected', /if \(client\.type !== 'connected'\) \{\s*throw new Error\(/],
    ['no resource capability', /if \(!client\.capabilities\?\.resources\) \{\s*throw new Error\(/],
  ]) {
    assert.match(c, pattern, label + ' no longer throws: the error field now swallows a caller error');
  }
  // And exactly three throws — a fourth would mean another path was converted.
  assert.equal((c.match(/throw new Error\(/g) || []).length, 3,
    'the number of throwing paths changed: re-derive the boundary');
});

test('ensureConnectedClient stays OUTSIDE the try', () => {
  // Failing to connect is an availability problem of the chosen server — the same class as the
  // three checks — not "the server could not read the resource".
  const c = code();
  const connectAt = c.indexOf('const connectedClient = await ensureConnectedClient(client)');
  const tryAt = c.indexOf('try {', connectAt);
  assert.ok(connectAt > 0, 'the connect call moved');
  assert.ok(tryAt > 0, 'the try block is gone');
  assert.ok(connectAt < tryAt,
    'ensureConnectedClient is inside the try: a connection failure would be reported as a read error');
});

test('only the resources/read request is converted to data', () => {
  const c = code();
  assert.match(c, /let result: ReadResourceResult/,
    'the request result is no longer declared outside the try, so the success path cannot use it');
  assert.match(c, /method: 'resources\/read'/,
    'the request method changed');

  // The catch must return the contract shape: required contents plus optional error.
  const catchAt = c.indexOf('} catch (error) {');
  assert.ok(catchAt > 0, 'the catch block is gone');
  const seg = c.slice(catchAt, catchAt + 400);
  assert.match(seg, /contents: \[\]/,
    'the failure path does not return an empty contents array');
  assert.match(seg, /error: errorMessage\(error\)/,
    'the failure path does not report the error message');
});

test('the schema declares error as optional', () => {
  const c = code();
  const at = c.indexOf('export const outputSchema');
  assert.ok(at > 0, 'ReadMcpResource lost its outputSchema');
  const end = c.indexOf('type OutputSchema', at);
  const seg = c.slice(at, end > 0 ? end : at + 1600);
  assert.match(seg, /error: z[\s\S]{0,120}?\.optional\(\)/,
    'error is not declared optional in the schema');
});

test('the precedent this decision leaned on is still in the codebase', () => {
  // ListMcpResources converts a per-server failure to data rather than failing the whole call.
  const list = fs.readFileSync(LIST, 'utf8');
  assert.match(list, /catch \(error\) \{[\s\S]{0,200}?logMCPError\(client\.name, errorMessage\(error\)\)/,
    'the ListMcpResources precedent changed: re-derive whether turning failures into data is still '
    + 'the house style');
  assert.match(list, /shouldn't sink the whole result/,
    'the comment stating the rationale is gone');
});

test('the adopted bundle carries the field', () => {
  const { text } = findChunk('Human-readable error when the server could not read the resource');
  assert.ok(text.includes('error'), 'the error field is missing from the built chunk');
});
