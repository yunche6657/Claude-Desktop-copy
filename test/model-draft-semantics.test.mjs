// The composer's model picker is a DRAFT setting: it decides the model a NEW session uses,
// not the model of a session that already exists.
//
// Round 160 got this wrong. It measured the model field of the current session after a pick,
// saw it unchanged, observed zero bridge calls, and concluded 「选了模型但没生效」 — a defect.
// Round 161 disproved it with one different experiment:
//
//   pick kimi-k3  ->  picker shows kimi-k3
//   send a message (creates a new session)
//   new session record -> model: "kimi-k3"
//   transcript          -> 2 rows, assistant replied "OK"
//   prewarmLocal trace  -> model: kimi-k3
//
// So the chain picker -> draft -> new session -> backend is intact. What round 160 measured
// was the wrong object: an existing session, which the picker deliberately does not touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const makeKernel = () => createSessionKernel({
  emit: () => {},
  log: () => {},
  createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
});

test('a session records the model it was started with', () => {
  // This is what the picker feeds: start({ model }). The measured value was kimi-k3 after
  // picking kimi-k3 in the composer, so the draft does reach the record.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd(), model: 'kimi-k3' });
  assert.equal(s.model, 'kimi-k3', 'the started session did not keep the requested model');
});

test('two sessions started with different models keep their own', () => {
  // The pick must apply to the NEXT session and must not retroactively rewrite an older one;
  // round 160 read the older one and called the feature broken.
  const kernel = makeKernel();
  const first = kernel.start({ cwd: process.cwd(), model: 'deepseek-v4.1-flash' });
  const second = kernel.start({ cwd: process.cwd(), model: 'kimi-k3' });
  assert.equal(kernel.getSession(first.sessionId).model, 'deepseek-v4.1-flash',
    'starting a second session rewrote the first');
  assert.equal(kernel.getSession(second.sessionId).model, 'kimi-k3');
});

test('a later updateSession can still change an existing session model', () => {
  // The picker chooses not to do this, but the channel exists for callers that do.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd(), model: 'old-model' });
  const updated = kernel.update(s.sessionId, { model: 'new-model' });
  assert.equal(updated.model, 'new-model');
});
