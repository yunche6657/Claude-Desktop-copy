// The approval gate, driven by the session kernel the way the renderer drives it.
//
// Every previous approval test used a stub backend. This one uses the REAL session-kernel
// approval plumbing (requestApproval -> tool_permission_request -> respondToApproval) with a
// stub agent whose executor records whether it ran. That keeps the test offline while still
// exercising the production path: mint the id, emit the card, wait, honour the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** An agent whose run() asks for approval and records the decision it received. */
function gatedAgent({ toolName = 'Write', onDecision } = {}) {
  return {
    model: 'stub',
    tools: [toolName],
    async run({ requestApproval, onEvent }) {
      onEvent({ type: 'tool_request', id: 'tu_1', name: toolName, input: { path: 'a.txt' } });
      const decision = await requestApproval({ toolName, input: { path: 'a.txt' }, toolUseId: 'tu_1' });
      if (onDecision) onDecision(decision);
      const allowed = decision === 'allow';
      onEvent({
        type: 'tool_result',
        id: 'tu_1',
        name: toolName,
        isError: !allowed,
        preview: allowed ? 'wrote a.txt' : 'declined',
      });
      onEvent({ type: 'text', text: allowed ? 'done' : 'declined' });
      return { text: allowed ? 'done' : 'declined', stopReason: 'end_turn' };
    },
  };
}

async function runWithDecision(decision, seen) {
  const events = [];
  const kernel = createSessionKernel({
    emit: (event) => events.push(event),
    createAgent: () => gatedAgent({ onDecision: (value) => { if (seen) seen.push(value); } }),
  });
  const started = kernel.start({ cwd: 'C:\\work' });
  const turn = kernel.sendMessage(started.sessionId, 'write a.txt');
  const card = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no approval card was emitted')), 5000);
    const poll = setInterval(() => {
      const found = events.find((event) => event.type === 'tool_permission_request' && event.request);
      if (found) { clearInterval(poll); clearTimeout(timer); resolve(found.request); }
    }, 20);
  });
  kernel.respondToApproval(card.requestId, decision);
  const result = await turn;
  return { card, result, events, kernel, started };
}

test('a gated tool emits a card naming the tool and carrying the input', async () => {
  const { card } = await runWithDecision('allow');
  assert.equal(card.toolName, 'Write');
  assert.deepEqual(card.input, { path: 'a.txt' });
  assert.match(card.requestId, /^perm_\d+$/, 'the id must be one the kernel minted');
});

test('allowing the card lets the tool run', async () => {
  const seen = [];
  const { result, events } = await runWithDecision('allow', seen);
  assert.deepEqual(seen, ['allow'], 'the executor must receive the allow decision');
  assert.equal(result.text, 'done');
  assert.ok(events.some((event) => event.type === 'tool_permission_resolved'));
});

test('denying the card stops the tool and the turn still finishes', async () => {
  const seen = [];
  const { result, events } = await runWithDecision('deny', seen);
  assert.deepEqual(seen, ['deny'], 'the executor must receive the deny decision');
  assert.equal(result.text, 'declined');
  // A denial is data, not a failed turn.
  assert.equal(result.ok, true);
  const resolved = events.filter((event) => event.type === 'tool_permission_resolved');
  assert.equal(resolved.length, 1, 'exactly one resolution event');
});

test('the card records what the renderer will show', async () => {
  const { card } = await runWithDecision('allow');
  // The renderer reads toolName + input to draw the card body.
  assert.equal(typeof card.toolName, 'string');
  assert.equal(typeof card.input, 'object');
});

test('a turn that is never answered does not hang forever', async () => {
  // The approval timeout is the guard that prevents the round-21 lockup.
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => gatedAgent({}),
  });
  const started = kernel.start({ cwd: 'C:\\work' });
  const pending = kernel.requestApproval(started.sessionId, { toolName: 'Write', input: {} }, { timeoutMs: 300 });
  const decision = await pending;
  assert.equal(decision, 'timeout', 'an unanswered prompt must settle as timeout, not hang');
});
