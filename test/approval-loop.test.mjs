// After an approval is granted, does the tool ACTUALLY run, and does its result reach
// the transcript?
//
// Rounds 22-23 verified the approval request/response plumbing and the visible card. The
// step after that was never checked: an allowed tool must execute, and the outcome must
// land in the transcript so a reopened session shows what happened. A gate that collects
// consent and then does nothing would pass every earlier test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { createApprovalExecutor } = require('../desktop/tool-approval.cjs');

/** An executor wired to approve-or-deny however the test says. */
function makeExecutor({ decision, handler, mode = 'ask' }) {
  const events = [];
  const asked = [];
  const execute = createApprovalExecutor({
    mode,
    tools: [{ name: 'Write', handler }],
    ask: async (request) => { asked.push(request); return decision; },
    onEvent: (e) => events.push(e),
  });
  return { execute, events, asked };
}

test('an allowed tool really runs and its content is returned to the model', async () => {
  let ran = 0;
  const { execute } = makeExecutor({
    decision: 'allow',
    handler: async (input) => { ran += 1; return { content: `wrote ${input.path}` }; },
  });

  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(ran, 1, 'the handler must be invoked exactly once');
  assert.equal(result.content, 'wrote a.txt', 'the tool output must reach the caller');
  assert.notEqual(result.isError, true);
});

test('a denied tool does not run at all', async () => {
  let ran = 0;
  const { execute } = makeExecutor({
    decision: 'deny',
    handler: async () => { ran += 1; return { content: 'x' }; },
  });

  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(ran, 0, 'a denial must not execute the handler');
  assert.equal(result.isError, true);
  assert.match(result.content, /declined/i);
});

test('the denial message is shown to the model, not silently swallowed', async () => {
  // Otherwise the model believes it wrote the file and continues on a false premise.
  const { execute } = makeExecutor({
    decision: 'deny',
    handler: async () => ({ content: '' }),
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(typeof result.content, 'string');
  assert.ok(result.content.length > 0, 'the model needs to be told it was refused');
});

test('a timeout is reported as a timeout, not as a user refusal', async () => {
  const { execute } = makeExecutor({
    decision: 'timeout',
    handler: async () => ({ content: 'x' }),
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(result.isError, true);
  assert.match(result.content, /did not respond in time/i);
});

test('a throwing handler is reported as a tool failure, not a crash', async () => {
  const { execute } = makeExecutor({
    decision: 'allow',
    handler: async () => { throw new Error('disk full'); },
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(result.isError, true);
  assert.match(result.content, /disk full/);
});

test('an unknown tool is refused without asking the user', async () => {
  // No point prompting for something that cannot run.
  const { asked, execute } = makeExecutor({
    decision: 'allow',
    handler: async () => ({ content: 'x' }),
  });
  // `execute` only knows Write.
  const result = await createApprovalExecutor({
    mode: 'ask',
    tools: [{ name: 'Write', handler: async () => ({ content: 'x' }) }],
    ask: async (r) => { asked.push(r); return 'allow'; },
    onEvent: () => {},
  })({ name: 'NotATool', input: {} });

  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool/i);
  assert.equal(asked.length, 0, 'an unknown tool must not reach the approval prompt');
});

test('a mode that does not prompt runs the tool without asking', async () => {
  // acceptEdits is the default; a prompt here would make every edit unusable.
  let ran = 0;
  const { execute, asked } = makeExecutor({
    decision: 'deny', // would deny if asked
    mode: 'acceptEdits',
    handler: async () => { ran += 1; return { content: 'ok' }; },
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(asked.length, 0, 'acceptEdits must not prompt for edits');
  assert.equal(ran, 1);
  assert.notEqual(result.isError, true);
});

// ---- the outcome reaches the transcript ------------------------------------

test('an allowed tool leaves a tool_use/tool_result pair in the transcript', async () => {
  // The kernel records what ran; without this a reopened session shows the assistant
  // answering without ever looking at a file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-loop-'));
  const kernel = createSessionKernel({
    emit: () => {},
    storePath: path.join(dir, 'kernel-sessions.json'),
    // The agent runs one gated tool, approved by the kernel's own approval hook.
    createAgent: ({ requestApproval }) => ({
      model: 'stub',
      tools: [],
      async run({ onEvent }) {
        const decision = await requestApproval({ toolName: 'Write', command: 'Write a.txt' });
        onEvent({ type: 'tool_request', id: 'tu_1', name: 'Write', input: { path: 'a.txt' } });
        onEvent({
          type: decision === 'allow' ? 'tool_result' : 'tool_error',
          id: 'tu_1',
          content: decision === 'allow' ? 'wrote a.txt' : 'the user declined',
        });
        return { text: `decision=${decision}`, stopReason: 'end_turn' };
      },
    }),
  });

  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'write the file');

  // Approve when the request appears.
  let waited = 0;
  let requestId = null;
  while (waited < 5000) {
    const open = kernel.getSession(s.sessionId).pendingToolPermissions;
    if (open.length > 0) { requestId = open[0].requestId; break; }
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }
  assert.ok(requestId, 'the tool must have raised an approval request');
  kernel.respondToApproval(requestId, 'allow');
  await turn;

  const entries = kernel.getTranscript(s.sessionId);
  const blocks = entries.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const uses = blocks.filter((b) => b.type === 'tool_use');
  const results = blocks.filter((b) => b.type === 'tool_result');

  assert.equal(uses.length, 1, 'the tool call must be recorded');
  assert.equal(uses[0].name, 'Write');
  assert.equal(results.length, 1, 'its outcome must be recorded too');
  assert.match(String(results[0].content ?? ''), /wrote a\.txt/);
});

test('a denied tool records the refusal instead of a success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-loop-'));
  const kernel = createSessionKernel({
    emit: () => {},
    storePath: path.join(dir, 'kernel-sessions.json'),
    createAgent: ({ requestApproval }) => ({
      model: 'stub',
      tools: [],
      async run({ onEvent }) {
        const decision = await requestApproval({ toolName: 'Write', command: 'Write a.txt' });
        onEvent({ type: 'tool_request', id: 'tu_1', name: 'Write', input: { path: 'a.txt' } });
        onEvent({
          type: decision === 'allow' ? 'tool_result' : 'tool_error',
          id: 'tu_1',
          content: decision === 'allow' ? 'wrote a.txt' : 'the user declined',
        });
        return { text: 'done', stopReason: 'end_turn' };
      },
    }),
  });

  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'write the file');

  let waited = 0;
  let requestId = null;
  while (waited < 5000) {
    const open = kernel.getSession(s.sessionId).pendingToolPermissions;
    if (open.length > 0) { requestId = open[0].requestId; break; }
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }
  assert.ok(requestId);
  kernel.respondToApproval(requestId, 'deny');
  await turn;

  const entries = kernel.getTranscript(s.sessionId);
  const blocks = entries.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const results = blocks.filter((b) => b.type === 'tool_result' || b.is_error === true);
  assert.ok(results.length >= 1, 'a refusal must be recorded');
  const text = JSON.stringify(results);
  assert.match(text, /declined/, 'the record must say it was declined, not that it succeeded');
  assert.doesNotMatch(text, /wrote a\.txt/, 'a denied tool must not claim success');
});

test('the turn finishes after an approval so the session is reusable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-loop-'));
  const kernel = createSessionKernel({
    emit: () => {},
    storePath: path.join(dir, 'kernel-sessions.json'),
    createAgent: ({ requestApproval }) => ({
      model: 'stub',
      tools: [],
      async run() {
        await requestApproval({ toolName: 'Write', command: 'Write a.txt' });
        return { text: 'ok', stopReason: 'end_turn' };
      },
    }),
  });

  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'go');
  const open = kernel.getSession(s.sessionId).pendingToolPermissions;
  kernel.respondToApproval(open[0].requestId, 'allow');
  await turn;

  assert.equal(kernel.getSession(s.sessionId).isRunning, false);
  assert.deepEqual(kernel.getSession(s.sessionId).pendingToolPermissions, []);
});
