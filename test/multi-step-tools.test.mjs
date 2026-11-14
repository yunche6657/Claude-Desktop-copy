// Multi-step tool use, and the two different truncation limits.
//
// MEASURED LIVE (replica :10310). Prompt: "List the files in the workspace root, then read
// package.json and report the name field. Use tools, do not guess."
// The transcript gained 6 rows:
//
//   user       List the files in the workspace root, then read package.json ...
//   assistant  tool_use List   { path: '.' }
//   user       tool_result   "dir desktop\ndir downloads\ndir evidence\n..."   (real listing)
//   assistant  tool_use Read   { path: 'package.json' }
//   user       tool_result   "1\t{\r\n2\t  \"name\": \"code-desktop-reconstruction\" ..."
//   assistant  final text quoting the real name
//
// Two tools ran in sequence, each returned real data, and the answer was built from it.
//
// THE TWO LIMITS, which must not be confused:
//   MAX_TOOL_OUTPUT = 30_000 in tools.cjs   — caps what a TOOL hands back, and says so:
//                                             '… [truncated N characters]'
//   preview: slice(0, 400)  in agent.cjs    — caps only the UI EVENT payload
// The model's copy is NOT truncated. Truncating the model's copy would make it answer from
// a prefix while the transcript showed the full result — a silent wrong answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a tool result above the cap is truncated WITH a notice', () => {
  // A silent slice would make the model reason over a prefix it believes is complete.
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /const MAX_TOOL_OUTPUT = 30_000;/);
  assert.match(tools, /\[truncated \$\{text\.length - MAX_TOOL_OUTPUT\} characters\]/, 'the truncation notice is gone');
});

test('the UI preview is capped at 400 characters', () => {
  // This is a display limit only; the transcript pane does not need the whole payload.
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /preview: String\(outcome\?\.content \?\? ''\)\.slice\(0, 400\)/);
});

test('the copy the MODEL receives is not truncated', () => {
  // The push that feeds the next request must carry the full content.
  const agent = read('desktop/agent.cjs');
  const at = agent.indexOf('results.push({');
  assert.ok(at > 0, 'the model-facing push is missing');
  const block = agent.slice(at, at + 320);
  assert.match(block, /content: typeof outcome\?\.content === 'string' \? outcome\.content/, 'the model copy is transformed');
  assert.doesNotMatch(block, /slice\(/, 'the model copy is truncated');
});

test('consecutive tool calls each get their own result row', () => {
  // Measured: List and Read produced two separate tool_use / tool_result pairs, matched by id.
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /tool_use_id: request\.id/, 'results are not tied back to their call');
});

test('the turn budget stops an unbounded tool loop', () => {
  // A model that keeps calling tools must not run forever.
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /turn-budget/, 'the turn budget error is gone');
});
