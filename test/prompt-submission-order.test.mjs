import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

test('completed prompts retain submission time instead of moving below their reply', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const kernel = createSessionKernel({ emit: () => {}, createAgent: () => ({
    model: 'fixture', tools: [],
    async run() { await waiting; return { text: 'answer', stopReason: 'end_turn' }; },
  }) });
  const { sessionId } = kernel.start({ cwd: process.cwd() });
  const sent = kernel.sendMessage(sessionId, 'question');
  await new Promise(resolve => setTimeout(resolve, 40));
  const beforeCompletion = Date.now();
  release();
  await sent;
  const prompt = kernel.getTranscript(sessionId).find(row => row.type === 'user');
  assert.ok(Date.parse(prompt.timestamp) < beforeCompletion,
    'prompt time must precede completion, so reloading cannot move it after the answer');
});
