// The fallback report makes "which visible feature is silently unimplemented" answerable.
//
// The generic registration loop answers a guessed shape for any channel without a real
// handler: {} for getState, false for is/can, emptyFor(frag) for get/list/read, and null for
// everything else. 255 action-like methods (set/save/install/delete/... ) have no handler.
//
// That number on its own is alarming and misleading. What matters is whether a user can reach
// them. Measured with CLAUDE_TRACE=all while walking the chat surface and four settings
// panels (general, usage, privacy, claude-code):
//
//   [fallback] lines: 0
//
// So none of the 255 are on a path a user walks today. This file keeps that measurable —
// previously the only way to answer it was to read source and guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

test('the bridge exposes a fallback report', () => {
  assert.match(BRIDGE, /fallbackReport\(\)/, 'the report is not exposed on the bridge');
  assert.match(BRIDGE, /fallbackCalls\.entries\(\)/, 'the report does not read the counter');
});

test('the report is sorted so the worst channel comes first', () => {
  // A caller asking "what is broken" should not have to sort it themselves.
  assert.match(BRIDGE, /\.sort\(\(a, b\) => b\.count - a\.count\)/);
});

test('main forwards the report on a diagnostic channel', () => {
  // Assert the registration itself. Matching /\$diag\$_fallback_report/ anywhere stayed green
  // when the channel name was renamed, because other $diag channels matched the same pattern.
  const at = MAIN.indexOf("ipcMain.handle('$diag$_fallback_report'");
  assert.ok(at > 0, 'the diagnostic channel is not registered');
  const block = MAIN.slice(at, at + 200);
  assert.match(block, /bridge\.fallbackReport/, 'the channel does not return the report');
});
test('the counter still records every fallback answer', () => {
  // Without the increment the report would always be empty and look like a clean bill.
  assert.match(BRIDGE, /fallbackCalls\.set\(frag, \(fallbackCalls\.get\(frag\) \|\| 0\) \+ 1\)/);
});

test('the fallback still prefers a real handler', () => {
  // Order is the whole reason a 255-method gap is survivable.
  const handlerAt = BRIDGE.indexOf('if (exact) return await exact(_event, ...args);');
  const counterAt = BRIDGE.indexOf('fallbackCalls.set(frag,');
  assert.ok(handlerAt > 0 && counterAt > handlerAt, 'the fallback runs before the real handler');
});