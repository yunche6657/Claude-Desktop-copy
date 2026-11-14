// Cancelling a turn must clear isRunning, even when the agent never settles.
//
// isRunning is set at the top of sendMessage and cleared either by the success branch
// or by the catch. If the agent does not react to abort — a hung HTTP request, a tool
// waiting on an approval that never arrives — neither path runs, and the session is
// stuck at isRunning:true forever. Its stop button then reports cancelled:true while
// the UI still shows a spinner, and every later sendMessage is refused with
// "a turn is already running for this session".
//
// Observed live: a session that hit an unanswered tool approval could not be recovered
// at all until the process was restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** An agent that ignores the abort signal entirely — the worst case. */
function deafAgent() {
  return {
    model: 'deaf',
    tools: [],
    // Never settles, and never looks at signal.
    run() { return new Promise(() => {}); },
  };
}

/** An agent that settles when aborted, like a well-behaved one. */
function cooperativeAgent() {
  return {
    model: 'good',
    tools: [],
    run({ signal }) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ text: 'done', stopReason: 'end_turn' }), 30000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ text: '', stopReason: 'aborted' });
        }, { once: true });
      });
    },
  };
}

function makeKernel(agentFactory) {
  return createSessionKernel({ emit: () => {}, createAgent: agentFactory });
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('cancel clears isRunning when the agent ignores the abort', async () => {
  // The gap: with a deaf agent nothing else ever clears the flag.
  const kernel = makeKernel(deafAgent);
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'go').catch(() => {});
  await settle();
  assert.equal(kernel.getSession(s.sessionId).isRunning, true);

  const result = kernel.cancel(s.sessionId);
  assert.equal(result.ok, true);
  assert.equal(kernel.getSession(s.sessionId).isRunning, false,
    'isRunning must be cleared by cancel itself, not only by the turn returning');
});

test('cancel clears isRunning for a cooperative agent too', async () => {
  const kernel = makeKernel(cooperativeAgent);
  const s = kernel.start({ cwd: 'C:\\w' });
  const turn = kernel.sendMessage(s.sessionId, 'go');
  await settle();
  kernel.cancel(s.sessionId);
  await turn;
  await settle();
  assert.equal(kernel.getSession(s.sessionId).isRunning, false);
});

test('a stuck session can be used again after cancel', async () => {
  // Before the fix this threw "a turn is already running for this session" forever.
  const kernel = makeKernel(cooperativeAgent);
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'first').catch(() => {});
  await settle();
  kernel.cancel(s.sessionId);
  await settle();

  const second = kernel.sendMessage(s.sessionId, 'second');
  await settle();
  kernel.cancel(s.sessionId);
  await second;
  assert.equal(kernel.getSession(s.sessionId).isRunning, false);
});

test('cancel removes the controller so a second cancel reports no running turn', async () => {
  const kernel = makeKernel(deafAgent);
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'go').catch(() => {});
  await settle();

  assert.equal(kernel.cancel(s.sessionId).ok, true);
  const again = kernel.cancel(s.sessionId);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no running turn');
});

test('cancel on an idle session reports no running turn', async () => {
  const kernel = makeKernel(deafAgent);
  const s = kernel.start({ cwd: 'C:\\w' });
  const result = kernel.cancel(s.sessionId);
  assert.equal(result.ok, false);
});

test('cancel emits close so the renderer stops showing a spinner', async () => {
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: deafAgent,
  });
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'go').catch(() => {});
  await settle();
  events.length = 0;

  kernel.cancel(s.sessionId);
  const close = events.find((e) => e.type === 'close' && e.sessionId === s.sessionId);
  assert.ok(close, 'the UI relies on close to clear the streaming state');
});

test('cancel does not touch other sessions', async () => {
  const kernel = makeKernel(deafAgent);
  const a = kernel.start({ cwd: 'C:\\a' });
  const b = kernel.start({ cwd: 'C:\\b' });
  kernel.sendMessage(a.sessionId, 'go').catch(() => {});
  kernel.sendMessage(b.sessionId, 'go').catch(() => {});
  await settle();

  kernel.cancel(a.sessionId);
  assert.equal(kernel.getSession(a.sessionId).isRunning, false);
  assert.equal(kernel.getSession(b.sessionId).isRunning, true, 'b must be untouched');
});
