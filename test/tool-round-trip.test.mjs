// The full tool round trip: model asks -> approval gate -> real tool -> result back to model.
//
// Round 347 proved a text reply travels end to end with a stub runner. That stub cannot reach
// the tool path, because the executor is a closure inside createAgentRunner and never leaves it
// (turnOptions carries requestApproval but NOT execute). So this file drives the SAME loop
// one level lower, where both halves are injectable:
//
//   runAgent({ tools: definitionsFor(defineTools(...)), execute: createApprovalExecutor(...),
//              fetchImpl })
//
// The fetch is scripted; the tools, the approval executor, the write and the message history are
// all the real ones.
//
// MEASURED:
//   turns        2
//   stopReason   end_turn
//   text         'wrote it'
//   events       ['turn','tool_request','tool_result','turn','text','done']
//   file         chain.md existed with content 'CHAIN-OK'
//   tool_result  'Wrote <path>/chain.md (+1 -0)'
//
// That last line is the point: the model does not receive 'ok', it receives the tool's own
// reported diff, which is what lets it judge whether the edit landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function apiMessage(body) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

function harness({ mode = 'acceptEdits', ask = async () => 'allow' } = {}) {
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const { defineTools, definitionsFor } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
  const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chain-'));
  const tools = defineTools({ workspaceRoot: ws, allowedRoots: [ws], execRoots: [ws] });
  const execute = createApprovalExecutor({ mode, tools, ask, onEvent: () => {} });
  return {
    ws, execute, definitions: definitionsFor(tools), runAgent,
    run: (script, extra = {}) => {
      let call = 0;
      const fetchImpl = async () => script[Math.min(call++, script.length - 1)];
      return runAgent({
        baseUrl: 'http://stub.invalid', apiKey: 'stub-key', model: 'stub-model',
        messages: [{ role: 'user', content: 'go' }],
        tools: definitionsFor(tools), execute, fetchImpl, onEvent: () => {},
        ...extra,
      });
    },
    cleanup: () => fs.rmSync(ws, { recursive: true, force: true }),
  };
}

test('a tool_use turn runs the real tool and feeds its result back to the model', async () => {
  const h = harness();
  try {
    const result = await h.run([
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { path: 'chain.md', content: 'CHAIN-OK' } },
      ] }),
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'wrote it' }] }),
    ]);
    assert.equal(result.turns, 2, 'the loop did not take a second turn');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'wrote it');
    const file = path.join(h.ws, 'chain.md');
    assert.ok(fs.existsSync(file), 'the tool did not actually write the file');
    assert.equal(fs.readFileSync(file, 'utf8'), 'CHAIN-OK');
  } finally { h.cleanup(); }
});

test('the model receives the tool result, not a bare acknowledgement', async () => {
  const h = harness();
  try {
    const result = await h.run([
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { path: 'chain.md', content: 'CHAIN-OK' } },
      ] }),
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'wrote it' }] }),
    ]);
    const turn = result.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    assert.ok(turn, 'no tool_result turn was appended to the history');
    const block = turn.content.find((b) => b.type === 'tool_result');
    assert.equal(block.tool_use_id, 'tu1', 'the result is not tied to the request id');
    assert.match(String(block.content), /chain\.md/, 'the result does not name the file: ' + block.content);
    assert.match(String(block.content), /\+1/, 'the result does not carry the diff, so the model cannot verify the write');
  } finally { h.cleanup(); }
});

test('the event stream reports the request and the result around the execution', async () => {
  const h = harness();
  try {
    const seen = [];
    let call = 0;
    const script = [
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { path: 'x.md', content: 'X' } },
      ] }),
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
    ];
    await h.runAgent({
      baseUrl: 'http://stub.invalid', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      tools: h.definitions, execute: h.execute,
      fetchImpl: async () => script[Math.min(call++, 1)],
      onEvent: (e) => seen.push(e.type),
    });
    assert.deepEqual(seen, ['turn', 'tool_request', 'tool_result', 'turn', 'text', 'done']);
  } finally { h.cleanup(); }
});

test('a denied tool does not run, and the refusal reaches the model', async () => {
  // The approval gate is the security boundary; a denial must stop the write, not merely be
  // logged. 'ask' mode asks on every mutation, so this is the default posture.
  const h = harness({ mode: 'ask', ask: async () => 'deny' });
  try {
    const result = await h.run([
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { path: 'denied.md', content: 'NOPE' } },
      ] }),
      apiMessage({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'could not write' }] }),
    ]);
    assert.equal(fs.existsSync(path.join(h.ws, 'denied.md')), false, 'a denied Write still created the file');
    const turn = result.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    assert.ok(turn, 'the denial was not reported back to the model');
    const block = turn.content.find((b) => b.type === 'tool_result');
    // MEASURED text: 'The user declined to run Write.' — it names the tool, so the model can
    // tell WHICH request failed when it asked for several in one turn.
    assert.match(String(block.content), /declined/i, 'the refusal text is uninformative: ' + block.content);
    assert.match(String(block.content), /Write/, 'the refusal does not name the tool: ' + block.content);
  } finally { h.cleanup(); }
});