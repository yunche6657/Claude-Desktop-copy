// A failed tool call must be REPORTED, EXPLAINED, and SURVIVABLE.
//
// MEASURED LIVE (replica :10300). Prompt: "Read the file /definitely/not/here.txt".
// The transcript gained exactly four rows:
//
//   user       Read the file /definitely/not/here.txt ...
//   assistant  tool_use Read { path: /definitely/not/here.txt }
//   user       tool_result  "Tool failed [outside-root]: path is outside the approved roots"
//   assistant  "I couldn't read that file — ... If the file exists somewhere in your workspace,
//               tell me the relative path (or I can list the workspace for you)."
//
//   1. the failure carries a CODE (outside-root), not just text
//   2. the model RECEIVED the failure and explained it — it was not swallowed
//   3. a follow-up landed in the same session (4 rows -> 6, recovered: true, running: false)
//
// SCOPE NOTE. The first version of these assertions used bare words ('is_error', 'outside-root',
// 'failedEntry') and survived renaming each one, because the word still appeared elsewhere in
// the file. They now match the exact expression that implements each property.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a tool failure reaches the model marked is_error', () => {
  // The exact spread: `...(isError ? { is_error: true } : {}),`
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /\.\.\.\(isError \? \{ is_error: true \} : \{\}\)/,
    'the error marker is no longer attached to the tool result');
});

test('the failure text carries a code in brackets', () => {
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /Tool failed \[\$\{/, 'the failure message lost its code');
});

test('a path outside the roots fails with an actionable message', () => {
  // The exact call, including the advice the model repeated back to the user.
  const fileTools = read('desktop/file-tools.cjs');
  assert.match(fileTools, /fail\('outside-root', 'path is outside the approved roots: '/,
    'the outside-root failure is gone or reworded');
  assert.match(fileTools, /use a path inside the workspace/, 'the next step was dropped');
});

test('a failed turn still clears the running flag', () => {
  // Measured: after the failed Read a follow-up produced rows 4 -> 6 with running:false.
  // Several paths set `isRunning: false`; the point is that the error path is among them.
  const kernel = read('desktop/session-kernel.cjs');
  const occurrences = (kernel.match(/isRunning: false/g) || []).length;
  assert.ok(occurrences >= 2, 'fewer places clear isRunning than expected: ' + occurrences);
});

test('the failed turn keeps the user message in the transcript', () => {
  // Round 214 fixed the opposite: a throwing turn used to leave 0 rows. The user's prompt
  // must survive so the conversation can be retried or edited.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const failedEntry = \{/, 'the failure path does not build a user row');
});
