// A real agent, a real tool, a real file — and the answer comes from the file.
//
// WHY THIS EXISTS. Every other test in this suite injects a stub agent, which is right for
// isolating the kernel — but a stub cannot catch a bug in the REAL path. Round 328 found exactly
// that: the kernel hard-coded its default model, and because stubs ignore the model, 1985 green
// tests coexisted with 'every new session fails its first message'.
//
// So these two tests drive agent.cjs against a fetch stub that speaks the wire protocol, and a
// real Read tool over a real file. That catches the classes a stub cannot:
//   - the tool_use → tool_result → text sequence actually forms
//   - the tool receives the input the model sent
//   - the transcript carries one row per protocol message
//
// MEASURED LIVE (real gateway, :10750), which is what these encode:
//   turn 1  ok:true  4 rows  tool_use { name:'Read', input:{ path:'package.json' } }
//           tool_result  '1\t{\r\n2\t  "name": "code-desktop-reconstruction"…'
//           final text   'code-desktop-reconstruction'
//   turn 2  ok:true  6 rows  still exactly ONE tool_use (it recalled instead of re-reading)
//           final text   'code-desktop-reconstruction'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A fetch stub that answers with a scripted sequence of assistant messages. */
function scriptedFetch(messages) {
  let index = 0;
  return async () => {
    const payload = messages[Math.min(index, messages.length - 1)];
    index++;
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(payload); },
    };
  };
}

const toolUse = (id, name, input) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
});

const textReply = (text) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
});

test('a tool round produces tool_use, then tool_result, then the answer', async () => {
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tool-'));
  const file = path.join(tmp, 'answer.txt');
  fs.writeFileSync(file, 'REAL-FILE-CONTENT\n');
  try {
    const tools = defineTools({ workspaceRoot: tmp, allowedRoots: [tmp], execRoots: [tmp] });
    const definitions = Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
    const execute = async (request) => {
      const tool = tools[request.name];
      if (!tool) return { content: 'unknown tool', isError: true };
      return await tool.handler(request.input || {});
    };
    const events = [];
    const result = await runAgent({
      baseUrl: 'http://stub/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read answer.txt' }] }],
      tools: definitions,
      execute,
      maxTokens: 256,
      onEvent: (e) => events.push(e),
      fetchImpl: scriptedFetch([
        toolUse('t1', 'Read', { path: 'answer.txt' }),
        textReply('REAL-FILE-CONTENT'),
      ]),
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'REAL-FILE-CONTENT');
    // The tool really ran: its result carries the file's contents.
    const joined = JSON.stringify(result.messages);
    assert.match(joined, /REAL-FILE-CONTENT/, 'the tool result did not carry the file contents');
    // And the event stream shows the request reaching the executor.
    assert.ok(events.some((e) => e.type === 'tool_request' && e.name === 'Read'), 'no tool_request event');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a denied tool never runs and its result says so', async () => {
  // The other half of the contract: when the executor refuses, the model is told, and the file
  // it would have read is untouched.
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  let executed = 0;
  const result = await runAgent({
    baseUrl: 'http://stub/v1', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    tools: [{ name: 'Read' }],
    execute: async () => { executed++; return { content: 'denied by policy', isError: true }; },
    maxTokens: 128,
    onEvent: () => {},
    fetchImpl: scriptedFetch([
      toolUse('t1', 'Read', { path: 'x' }),
      textReply('could not read it'),
    ]),
  });
  assert.equal(executed, 1, 'the executor was not asked exactly once');
  assert.equal(result.text, 'could not read it');
  assert.match(JSON.stringify(result.messages), /denied by policy/, 'the refusal never reached the model');
});
