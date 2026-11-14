// Cancellation is checked at the tool-loop boundary, not inside a tool.
//
// METHOD: the previous round's three-way split (broken / no-source / deliberate) applied to the
// tool-execution chain.
//
//   execute(request) receives { id, name, input } — no signal.
//   tools.cjs has ZERO occurrences of signal / abort / cancel.
//   tool-approval.cjs calls `tool.handler(request.input || {})` — input only.
//
// So no tool can observe cancellation, and forwarding a signal would be dead weight. That is the
// 'no source' case, not a break.
//
// What the agent DOES do, measured in desktop/agent.cjs:
//
//   for (const request of requests) {
//     if (signal?.aborted) throw new AgentError('aborted', 'the run was cancelled');
//     onEvent({ type: 'tool_request', ... });
//     outcome = await execute(request);
//   }
//
// i.e. the abort check sits at the LOOP BOUNDARY: a cancel stops the remaining tool calls and
// the next request, but does not interrupt one already running. For this tool set that is the
// only achievable contract, because the handlers are synchronous-ish and take no signal.
//
// MEASURED with a stub agent whose turn ignores its signal: cancelling returned { ok: true } and
// the in-flight work still completed. That is a property of the STUB, not of the kernel — the
// real agent throws at the next boundary, which test/cancel-and-resend.test.mjs already pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the agent checks for cancellation before each tool call', () => {
  const agent = read('desktop/agent.cjs');
  const loop = agent.indexOf('for (const request of requests) {');
  assert.ok(loop > 0, 'the tool loop is gone');
  const body = agent.slice(loop, loop + 400);
  assert.match(body, /if \(signal\?\.aborted\) throw new AgentError\('aborted'/, 'the per-call abort check is gone');
  // And it must come BEFORE the call.
  assert.ok(body.indexOf('signal?.aborted') < body.indexOf('await execute(request)'),
    'the abort check runs after the tool was already invoked');
});

test('no tool handler takes a cancellation signal', () => {
  // Pinned so that adding signal support becomes a deliberate, visible change.
  const tools = read('desktop/tools.cjs');
  for (const name of ['signal', 'abort', 'cancel']) {
    assert.equal(tools.split(name).length - 1, 0, 'tools.cjs started referencing ' + name);
  }
});

test('the approval executor passes only the tool input to the handler', () => {
  const approval = read('desktop/tool-approval.cjs');
  assert.match(approval, /return await tool\.handler\(request\.input \|\| \{\}\);/, 'the handler call shape changed');
});

test('the executor request carries id, name and input', () => {
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /\.map\(block => \(\{ id: block\.id, name: block\.name, input: block\.input \|\| \{\} \}\)\)/,
    'the request shape changed');
});
