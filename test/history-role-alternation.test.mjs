// A long conversation must still be sendable: the Messages API requires alternating roles.
//
// FOUND BROKEN. The transcript stores one row per BLOCK, so mapping rows straight to messages
// produces runs of the same role. Sending to the largest stored session failed outright:
//
//   API 400: tool calls and tool results do not match,
//            please start a new conversation and retry
//
// The transcript itself was FINE — 144 tool_use blocks, 144 tool_result blocks, zero orphans,
// zero unclosed. The defect was purely in how the rows were flattened into request messages.
//
// MEASURED across the real store: 42 of 149 sessions had consecutive same-role runs; the worst
// had 182 runs across 479 rows. 107 sessions had none, which is why this survived so long —
// a short conversation never accumulates a run.
//
// THE FIX merges adjacent same-role messages, keeping every block and dropping only the role
// boundary. On the worst session:
//
//   raw     479 messages, 182 consecutive pairs, 480 blocks
//   merged  297 messages,   0 consecutive pairs, 480 blocks
//
// and the same session then answered { ok: true, text: 'OK' } instead of 400.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the turn history is merged, not mapped row-for-row', () => {
  // The bug: `prior.map(...)` straight into the request.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const history = mergeAdjacentRoles\(\[/, 'the history is no longer merged');
});

test('mergeAdjacentRoles exists and joins same-role content', () => {
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /function mergeAdjacentRoles\(messages\) \{/, 'the merge helper is gone');
  assert.match(kernel, /if \(!last \|\| last\.role !== m\.role\) \{/, 'the role comparison is gone');
  assert.match(kernel, /last\.content = \[\.\.\.toBlocks\(last\.content\), \.\.\.toBlocks\(m\.content\)\]/,
    'adjacent content is no longer concatenated');
});

test('a string content is normalised to blocks before merging', () => {
  // A plain string cannot be concatenated with a block array.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const toBlocks = \(c\) => \(Array\.isArray\(c\) \? c : \[\{ type: 'text', text: String\(c \?\? ''\) \}\]\);/,
    'string content is not normalised');
});

test('the merge preserves every block', () => {
  // Measured: 480 blocks in, 480 out. Dropping a block would silently lose a tool_result and
  // re-create the very mismatch the merge fixes.
  const kernel = read('desktop/session-kernel.cjs');
  const at = kernel.indexOf('function mergeAdjacentRoles');
  const block = kernel.slice(at, at + 1200);
  assert.match(block, /\.\.\.toBlocks\(last\.content\)/, 'existing blocks are dropped');
  assert.match(block, /\.\.\.toBlocks\(m\.content\)/, 'new blocks are dropped');
});
