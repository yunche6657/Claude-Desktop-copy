// R430: WebSearch reports searchCount — the count UI.tsx already computed.
//
// THE FINDING
//   `WebSearchTool/UI.tsx` already had, unexported:
//
//       function getSearchSummary(results) {
//         let searchCount = 0
//         for (const result of results) {
//           if (result != null && typeof result !== 'string') { searchCount++; ... }
//         }
//         return { searchCount, totalResultCount }
//       }
//
//   and rendered "Did N search(es) in Xs" from it. That IS the official `searchCount`
//   ("Number of web searches performed"). The value existed, ran on every render, and never reached
//   the tool's output. Third round in a row with this shape (R427 Glob.totalMatches, R428
//   Grep.totalFiles, now this).
//
// WHY ReadMcpResource.error WAS NOT DONE HERE
//   It is different in kind. CCB's ReadMcpResource THROWS on every failure path — server missing,
//   not connected, no resource capability, and the `resources/read` request itself. The official
//   `error?` field means "report the failure as data instead of failing". Turning throws into data
//   changes behaviour for existing callers, so it needs its own decision rather than being folded
//   into a field addition. The last test in this file pins that distinction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOL = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'WebSearchTool',
  'WebSearchTool.ts');
const UI = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'WebSearchTool', 'UI.tsx');
const MCP = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'ReadMcpResourceTool',
  'ReadMcpResourceTool.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const tool = () => fs.readFileSync(TOOL, 'utf8');
const ui = () => fs.readFileSync(UI, 'utf8');

test('the contract declares searchCount as an optional number of searches', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('Text content of the resource');
  assert.ok(at > 0, 'the MCP contract text moved');
  const wAt = dts.indexOf('export interface WebSearchOutput');
  assert.ok(wAt > 0, 'WebSearchOutput is gone');
  const seg = dts.slice(wAt, wAt + 1400);
  assert.match(seg, /searchCount\?: number/,
    'searchCount is no longer an optional number in the contract');
  // The doc comment matters: it is "searches performed", not "results returned".
  assert.ok(/Number of web searches performed/.test(seg),
    'the contract comment changed: re-derive whether this counts searches or results');
});

test('the counting helper now lives with the data, not only in the renderer', () => {
  const t = tool();
  assert.match(t, /export function getSearchSummary\(results:/,
    'getSearchSummary is not exported from the tool module');
  // It must count non-string entries — one per search block.
  assert.match(t, /if \(result != null && typeof result !== 'string'\) \{\s*searchCount\+\+/,
    'the counting rule changed: it should count one per non-string result block');
});

test('searchCount is populated on every call, including a no-results search', () => {
  const t = tool();
  assert.match(t, /searchCount: getSearchSummary\(results\)\.searchCount/,
    'the output object does not report searchCount');

  // The field must sit in the same object literal as the other three.
  const at = t.indexOf('const data: Output = {');
  assert.ok(at > 0, 'the data object moved');
  const seg = t.slice(at, at + 400);
  for (const k of ['query,', 'results,', 'durationSeconds,', 'searchCount:']) {
    assert.ok(seg.includes(k), 'the data object is missing ' + k);
  }
});

test('the schema declares searchCount as optional', () => {
  const t = tool();
  const at = t.indexOf('const outputSchema');
  assert.ok(at > 0, 'WebSearchTool lost its outputSchema');
  const end = t.indexOf('type OutputSchema', at);
  const seg = t.slice(at, end > 0 ? end : at + 2000);
  assert.match(seg, /searchCount: z[\s\S]{0,80}?\.optional\(\)/,
    'searchCount is not declared optional in the schema');
});

test('UI.tsx no longer keeps a second copy of the counting rule', () => {
  // Two implementations would let the number shown to the user and the number reported in the
  // output diverge.
  const u = ui();
  const defs = (u.match(/function getSearchSummary/g) || []).length;
  assert.equal(defs, 0,
    'UI.tsx defines getSearchSummary again: the display and the reported field can now disagree');
  assert.match(u, /import \{[^}]*getSearchSummary[^}]*\} from '\.\/WebSearchTool\.js'/,
    'UI.tsx does not import the shared helper');
  // It must still use it for the display.
  assert.match(u, /getSearchSummary\(output\.results/,
    'UI.tsx stopped using the helper to render the search summary');
});

test('the bundle carries the field and only one copy of the helper', () => {
  const { text } = findChunk('Number of web searches performed');
  assert.ok(text.includes('searchCount'), 'searchCount is missing from the built chunk');
  // A single implementation is the point of moving it; two would be a silent divergence risk.
  const helperDefs = (text.match(/function getSearchSummary/g) || []).length;
  assert.equal(helperDefs, 1,
    'the bundled chunk defines getSearchSummary more than once');
});

test('ReadMcpResource.error stays unimplemented, and the reason is still true', () => {
  // ReadMcpResource reports every failure by throwing, so an `error` output field would require
  // converting throws into data — a behaviour change, not a field addition.
  const m = fs.readFileSync(MCP, 'utf8');
  const throws = (m.match(/throw new Error\(/g) || []).length;
  assert.ok(throws >= 3,
    'the throw-based failure paths changed; re-derive whether `error` is now straightforward');
  assert.ok(!/error: z/.test(m),
    'an `error` output field appeared; if failures now return data, update this test and the '
    + 'evidence note that says it was deliberately deferred');
});
