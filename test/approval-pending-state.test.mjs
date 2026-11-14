// The pending approval must be visible in the session record the renderer polls.
//
// The renderer draws the approval card from `session.pendingToolPermissions`, not from the
// event stream alone. If that field is missing or never cleared, the card either never appears
// or appears forever. Both were observed while verifying the real-model approval path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function gatedAgent() {
  return {
    model: 'stub',
    tools: ['Write'],
    async run({ requestApproval, onEvent }) {
      onEvent({ type: 'tool_request', id: 'tu_1', name: 'Write', input: { path: 'a.txt' } });
      const decision = await requestApproval({ toolName: 'Write', input: { path: 'a.txt' }, toolUseId: 'tu_1' });
      onEvent({ type: 'tool_result', id: 'tu_1', name: 'Write', isError: decision !== 'allow', preview: decision });
      onEvent({ type: 'text', text: decision });
      return { text: decision, stopReason: 'end_turn' };
    },
  };
}

async function startGated() {
  const events = [];
  const kernel = createSessionKernel({ emit: (event) => events.push(event), createAgent: () => gatedAgent() });
  const started = kernel.start({ cwd: 'C:\\work', permissionMode: 'ask' });
  const turn = kernel.sendMessage(started.sessionId, 'write a.txt');
  const card = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no card')), 5000);
    const poll = setInterval(() => {
      const found = events.find((event) => event.type === 'tool_permission_request' && event.request);
      if (found) { clearInterval(poll); clearTimeout(timer); resolve(found.request); }
    }, 20);
  });
  return { kernel, started, turn, card, events };
}

test('a pending approval is listed in the session record', async () => {
  const { kernel, started, turn, card } = await startGated();
  const session = kernel.getSession(started.sessionId);
  assert.ok(Array.isArray(session.pendingToolPermissions), 'the field must exist');
  assert.equal(session.pendingToolPermissions.length, 1, 'the waiting request must be listed');
  assert.equal(session.pendingToolPermissions[0].requestId, card.requestId);
  assert.equal(session.pendingToolPermissions[0].toolName, 'Write');
  kernel.respondToApproval(card.requestId, 'deny');
  await turn;
});

test('resolving the approval clears it from the session record', async () => {
  const { kernel, started, turn, card } = await startGated();
  assert.equal(kernel.getSession(started.sessionId).pendingToolPermissions.length, 1);
  kernel.respondToApproval(card.requestId, 'deny');
  await turn;
  assert.equal(
    kernel.getSession(started.sessionId).pendingToolPermissions.length,
    0,
    'a resolved card must not linger -- otherwise the UI shows a dead prompt forever',
  );
});

test('the session is no longer running once the turn settles', async () => {
  const { kernel, started, turn, card } = await startGated();
  assert.equal(kernel.getSession(started.sessionId).isRunning, true);
  kernel.respondToApproval(card.requestId, 'deny');
  await turn;
  assert.equal(kernel.getSession(started.sessionId).isRunning, false);
});
