// Where the real agent notices a cancellation — measured, not assumed.
//
// MEASURED by calling the real runAgent with an ALREADY-aborted signal:
//
//   error.code    'aborted'
//   error.message 'the run was cancelled'
//   events        []            <- not even the 'turn' event fired
//
// That last line is the useful part: the first abort check sits at the TOP of the turn loop,
// before any work or notification. So an already-cancelled run costs nothing.
//
// A NOTE ON STUBS. The previous round measured cancellation with a stub agent whose run()
// ignored its signal, saw the work complete anyway, and briefly read that as 'cancel does not
// work'. It was the stub, not the kernel. This file therefore exercises the REAL agent for the
// abort behaviour and keeps stubs only for the kernel-side bookkeeping (which the kernel owns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

test('an already-aborted run throws aborted before doing any work', async () => {
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const controller = new AbortController();
  controller.abort();
  const events = [];
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
      onEvent: (e) => events.push(e.type),
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'an aborted run did not throw');
  assert.equal(caught.code, 'aborted');
  assert.match(String(caught.message), /cancel/i);
  assert.deepEqual(events, [], 'the run emitted events before noticing the abort: ' + events.join(', '));
});

test('the abort check precedes the first turn event in the loop', () => {
  // The measured empty event list is only meaningful if the check really is first.
  const agent = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  const loop = agent.indexOf('while (turns < maxTurns) {');
  assert.ok(loop > 0, 'the turn loop is gone');
  const head = agent.slice(loop, loop + 400);
  const abortAt = head.indexOf('signal?.aborted');
  const turnAt = head.indexOf("onEvent({ type: 'turn'");
  assert.ok(abortAt > 0, 'the loop no longer checks the signal');
  assert.ok(turnAt > 0, 'the turn event is gone');
  assert.ok(abortAt < turnAt, 'the abort check now runs after the turn event');
});

test('a cancelled run never reaches the network', async () => {
  // baseUrl points at a closed port; if the abort did not fire first this would be a network
  // error instead of an abort.
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const controller = new AbortController();
  controller.abort();
  let code = null;
  try {
    await runAgent({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [], execute: async () => ({ content: 'x' }), maxTokens: 16,
      signal: controller.signal, onEvent: () => {},
    });
  } catch (e) { code = e.code; }
  assert.equal(code, 'aborted', 'expected an abort, got ' + code);
});

test('a run cancelled between two tool calls stops before the second', async () => {
  // Covers the SECOND abort check (inside the tool loop). The tests above only exercise the
  // first one — measured: removing the tool-loop check left them all green.
  //
  // The agent is driven through a fetch stub that returns one assistant message with two
  // tool_use blocks; the first tool aborts the controller, so the second must never run.
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const controller = new AbortController();
  const executed = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'First', input: {} },
          { type: 'tool_use', id: 't2', name: 'Second', input: {} },
        ],
        stop_reason: 'tool_use',
      });
    },
  });
  let code = null;
  try {
    await runAgent({
      baseUrl: 'http://stub/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [{ name: 'First' }, { name: 'Second' }],
      execute: async (request) => {
        executed.push(request.name);
        if (request.name === 'First') controller.abort();
        return { content: 'ok' };
      },
      maxTokens: 64,
      signal: controller.signal,
      onEvent: () => {},
      fetchImpl,
    });
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, 'aborted', 'the run did not abort after the first tool cancelled it, got ' + code);
  assert.deepEqual(executed, ['First'], 'the second tool ran after cancellation: ' + executed.join(', '));
});
