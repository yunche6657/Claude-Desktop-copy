// A gateway failure is reported — verified by RUNNING the kernel against a dead endpoint.
//
// WHY THIS FILE WAS REWRITTEN. It asserted on source text ('the kernel returns ok:false',
// 'it emits an error event'). Those pass whenever the strings exist, and stay green when the
// behaviour breaks. This version starts a real kernel whose agent points at a closed port.
//
// MEASURED:
//   sendMessage -> { ok: false, error: 'request failed: fetch failed', code: 'network' }
//   transcript  -> 1 row, type 'user'      (the typed prompt survives)
//   isRunning   -> false                   (the session is usable again)
//   events      -> includes 'error'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A kernel whose agent cannot reach its gateway (nothing listens on port 1). */
async function failingKernel() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-gw-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  const events = [];
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: (opts) => runAgent({
        ...opts,
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-test',
        model: 'm',
        tools: [],
        execute: async () => ({ content: 'x' }),
        maxTokens: 16,
      }),
    }),
    emit: (e) => events.push(e),
    storePath,
  });
  return { kernel, events, storePath };
}

test('a failed turn returns ok:false with a reason and a code', async () => {
  const { kernel, storePath } = await failingKernel();
  try {
    const s = kernel.start({ cwd: ROOT });
    const res = await kernel.sendMessage(s.sessionId, 'say hello');
    assert.equal(res.ok, false, 'a dead gateway produced ok:true');
    assert.equal(typeof res.error, 'string', 'the failure carries no message');
    assert.ok(res.error.length > 0, 'the failure message is empty');
    assert.equal(res.code, 'network', 'the failure is not classified as a network error, got ' + JSON.stringify(res.code));
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a failed turn keeps the user message and clears isRunning', async () => {
  const { kernel, storePath } = await failingKernel();
  try {
    const s = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(s.sessionId, 'keep this prompt');
    const rows = kernel.getTranscript(s.sessionId) || [];
    assert.equal(rows.length, 1, 'expected exactly the user row, got ' + rows.length);
    assert.equal(rows[0].type, 'user', 'the surviving row is not the user message');
    assert.equal(kernel.getSession(s.sessionId).isRunning, false, 'the session is stuck running');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a failed turn emits an error event the renderer can see', async () => {
  const { kernel, events, storePath } = await failingKernel();
  try {
    const s = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(s.sessionId, 'say hello');
    const errEvent = events.find((e) => e && e.type === 'error');
    assert.ok(errEvent, 'no error event was emitted');
    assert.equal(typeof errEvent.message, 'string', 'the error event carries no message');
    assert.equal(errEvent.code, 'network', 'the error event lost its classification');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('the session is usable again after a failure', async () => {
  // The real consequence of a stuck isRunning flag: the next message is refused.
  const { kernel, storePath } = await failingKernel();
  try {
    const s = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(s.sessionId, 'first');
    const second = await kernel.sendMessage(s.sessionId, 'second');
    assert.equal(second.ok, false, 'the second turn should also fail on the dead gateway');
    assert.doesNotMatch(String(second.error), /already running/, 'the session refused the retry as busy');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a cancelled run is classified aborted, not as a network failure', async () => {
  // FOUND BY A MUTATION SWEEP. Renaming the abort classification from 'aborted' to 'other'
  // left every test green, because none of them exercised cancellation through the agent.
  // Measured: an already-aborted signal produces { code: 'aborted', message: 'the run was cancelled' }.
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const controller = new AbortController();
  controller.abort();
  let caught = null;
  try {
    await runAgent({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      execute: async () => ({ content: 'x' }),
      maxTokens: 16,
      signal: controller.signal,
      onEvent: () => {},
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'an aborted run did not throw');
  assert.equal(caught.code, 'aborted', 'cancellation is not classified as aborted, got ' + JSON.stringify(caught.code));
  assert.match(String(caught.message), /cancel/i, 'the message does not mention cancellation');
});