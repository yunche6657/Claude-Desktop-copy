// An API failure must be classified by status, and the classification must reach the caller.
//
// FOUND BROKEN, THEN FIXED. Driving the agent against a local server that answers with a chosen
// status showed every code collapsing to one label, and the kernel dropping even that:
//
//   before:  401 -> code 'api-error'   result { ok:false, error }        event { message }
//            429 -> code 'api-error'   (no code on the result)           (no code on the event)
//            500 -> code 'api-error'
//
// so 401, 429 and 500 were distinguishable only by pattern-matching the message text.
// After the fix:
//
//   after:   401 -> result.code 'auth'        event.code 'auth'
//            429 -> result.code 'rate-limit'  event.code 'rate-limit'
//            500 -> result.code 'server'      event.code 'server'
//
// Two edits: agent.cjs classifies by status instead of a constant, and session-kernel.cjs
// forwards `code` on both the streamed error event and the failed-turn result.
//
// NOTE ON FIDELITY: the shipped frontend has no 429 handling either (searching all asset
// bundles for 429/rate-limit finds only two hash constants). This change does not invent a
// retry policy; it only stops discarding information the agent already computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a 401 is classified as auth, not as a generic api-error', () => {
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /response\.status === 401 \|\| response\.status === 403 \? 'auth'/,
    'auth failures are no longer distinguished');
});

test('a 429 is classified as rate-limit', () => {
  // The one status where the user's next action differs most: wait, do not retype.
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /response\.status === 429 \? 'rate-limit'/, 'rate limiting is not classified');
});

test('a 5xx is classified as server', () => {
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /response\.status >= 500 \? 'server'/, 'server failures are not classified');
});

test('the streamed error event carries the code', () => {
  // Measured before: the event had only `message`.
  const kernel = read('desktop/session-kernel.cjs');
  const at = kernel.indexOf("if (event.type === 'error') {");
  assert.ok(at > 0, 'the error event branch is gone');
  // 800, not 500: the explanatory comment above the emit pushes the spread 680 chars down.
  const block = kernel.slice(at, at + 800);
  assert.match(block, /\.\.\.\(event\.code \? \{ code: event\.code \} : \{\}\)/,
    'the error event drops the code again');
});

test('the failed-turn result carries the code', () => {
  // Measured after: result.code was 'auth' / 'rate-limit' / 'server'.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const failureCode = typeof error\?\.code === 'string' \? error\.code : null;/,
    'the failure code is not captured');
  assert.match(kernel, /\.\.\.\(failureCode \? \{ code: failureCode \} : \{\}\)/,
    'the failure result drops the code again');
});