// A failed tool must hand the model something it can act on, and the shape must be consistent
// across every path that can produce a failure.
//
// Measured this round by driving the real loop with a fake model:
//   turn 1  Read missing.txt        -> fails
//   turn 2  model sees  "Tool failed [not-found]: file does not exist: <path>; List its
//                        directory to check the name, or Glob for the pattern"
//   turn 3  model calls List        -> sees present.txt, recovers
//
// That message is the point of rounds 214-215: a code, a reason, and a next step.
//
// The defect found here: agent.cjs had its own fallback that formatted
// "Tool failed: <msg>" WITHOUT the [code], while tool-approval.cjs included it. A model that
// learned to read the code from one path would find it missing on the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
const { defineTools, definitionsFor } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

function executorWith(handler) {
  return createApprovalExecutor({
    mode: 'bypassPermissions',
    ask: async () => 'allow',
    onEvent: () => {},
    tools: [{ name: 'Boom', action: 'read', handler }],
  });
}

test('a coded tool error names the code', () => {
  // The code is the machine-readable half; without it the model must re-parse prose.
  const execute = executorWith(() => {
    const error = new Error('it broke');
    error.code = 'boom';
    throw error;
  });
  return execute({ name: 'Boom', input: {} }).then((outcome) => {
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /Tool failed \[boom\]/);
    assert.match(String(outcome.content), /it broke/);
  });
});

test('an uncoded error does not print empty brackets', () => {
  const execute = executorWith(() => { throw new Error('plain failure'); });
  return execute({ name: 'Boom', input: {} }).then((outcome) => {
    assert.equal(String(outcome.content).includes('[]'), false, 'empty brackets were printed');
    assert.match(String(outcome.content), /Tool failed: plain failure/);
  });
});

test('an unknown tool is reported as unknown, not as a failure', () => {
  // Different situation, different wording: nothing ran, so nothing failed.
  const execute = executorWith(() => 'never called');
  return execute({ name: 'NoSuchTool', input: {} }).then((outcome) => {
    assert.match(String(outcome.content), /Unknown tool/);
    assert.equal(outcome.isError, true);
  });
});

test('the model sees the failure reason and a next step, then recovers', async () => {
  // The end-to-end claim: after a failed Read the model is told how to look instead, and a
  // List on the next turn succeeds.
  const bodies = [];
  const realFetch = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init && init.body ? init.body : '{}')));
    turn += 1;
    const content = turn === 1
      ? [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'missing.txt' } }]
      : turn === 2
        ? [{ type: 'tool_use', id: 't2', name: 'List', input: {} }]
        : [{ type: 'text', text: 'done' }];
    const body = JSON.stringify({ type: 'message', content, stop_reason: turn < 3 ? 'tool_use' : 'end_turn' });
    return { ok: true, status: 200, async text() { return body; } };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-'));
  try {
    fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
    const tools = defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] });
    const execute = createApprovalExecutor({ mode: 'bypassPermissions', ask: async () => 'allow', tools, onEvent: () => {} });
    await runAgent({
      baseUrl: 'http://unused', apiKey: 'k', model: 'm', system: 's',
      messages: [{ role: 'user', content: 'read missing.txt' }],
      tools: definitionsFor(tools), execute, onEvent: () => {},
    });

    const secondTurn = JSON.stringify(bodies[1] || {});
    assert.match(secondTurn, /does not exist/, 'the failure never reached the model');
    assert.match(secondTurn, /not-found/, 'the error code was dropped');
    assert.match(secondTurn, /List|Glob/, 'no alternative was suggested');

    const thirdTurn = JSON.stringify(bodies[2] || {});
    assert.match(thirdTurn, /present\.txt/, 'the recovery turn returned nothing useful');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent fallback formats errors the same way as the executor', () => {
  // agent.cjs has its own catch for tools that throw before the executor sees them. It used
  // to omit the code; a model reading [code] on one path must find it on the other.
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  assert.match(source, /Tool failed \[\$\{code\}\]/, 'the fallback no longer includes the code');
  assert.match(source, /error\.code === 'string'/, 'the fallback no longer checks for a code');
});
