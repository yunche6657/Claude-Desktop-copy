// Agent loop, tool registry and approval gate tests.
//
// No network: `fetchImpl` is injected, so these assert the protocol shape and
// the control flow. The live behaviour against a real model is covered by
// build/probe-agent.cjs, which is a probe rather than a test because it needs
// credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  AgentError, API_VERSION, normaliseBaseUrl, messagesEndpoint,
  callMessages, toolRequests, assistantText, runAgent,
} = require('../desktop/agent.cjs');
const { defineTools, definitionsFor, globToRegExp } = require('../desktop/tools.cjs');
const { actionFor, describeRequest, createApprovalExecutor, TOOL_ACTIONS } = require('../desktop/tool-approval.cjs');
const { MODES, ACTIONS } = require('../desktop/permissions.cjs');

/** Builds a fetch stub that returns queued message bodies in order. */
function stubFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = responses.shift();
    if (!next) throw new Error('stub ran out of responses');
    if (next instanceof Error) throw next;
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status || 200,
      text: async () => JSON.stringify(next.body ?? next),
    };
  };
  impl.calls = calls;
  return impl;
}

const assistant = content => ({ type: 'message', role: 'assistant', content, stop_reason: 'end_turn' });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const textBlock = text => ({ type: 'text', text });

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

// ── URL and envelope ──────────────────────────────────────────────────────

test('the base URL is normalised and /v1 is not doubled', () => {
  assert.equal(normaliseBaseUrl('https://api.example.com'), 'https://api.example.com');
  assert.equal(normaliseBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normaliseBaseUrl('https://api.example.com/v1'), 'https://api.example.com');
  assert.equal(normaliseBaseUrl('https://api.example.com/v1/'), 'https://api.example.com');
  assert.equal(messagesEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/messages');
  assert.throws(() => normaliseBaseUrl(''), /base URL is required/);
});

test('a request carries the Anthropic headers and the tools', async () => {
  const fetchImpl = stubFetch([assistant([textBlock('ok')])]);
  await callMessages({
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
    fetchImpl,
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.example.com/v1/messages');
  assert.equal(call.options.headers['x-api-key'], 'k');
  assert.equal(call.options.headers['anthropic-version'], API_VERSION);
  assert.equal(call.body.model, 'm');
  assert.equal(call.body.tools.length, 1);
});

test('a missing key or model is refused before any request', async () => {
  const fetchImpl = stubFetch([]);
  await assert.rejects(() => callMessages({ baseUrl: 'https://x', model: 'm', messages: [], fetchImpl }), /API key is required/);
  await assert.rejects(() => callMessages({ baseUrl: 'https://x', apiKey: 'k', messages: [], fetchImpl }), /model id is required/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('an API error surfaces its message', async () => {
  const fetchImpl = stubFetch([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
  await assert.rejects(
    () => callMessages({ baseUrl: 'https://x', apiKey: 'k', model: 'm', messages: [], fetchImpl }),
    /API 401: invalid x-api-key/,
  );
});

test('a non-message body is rejected instead of being trusted', async () => {
  const fetchImpl = stubFetch([{ ok: true, body: { hello: 'world' } }]);
  await assert.rejects(
    () => callMessages({ baseUrl: 'https://x', apiKey: 'k', model: 'm', messages: [], fetchImpl }),
    /unexpected body/,
  );
});

// ── Block helpers ─────────────────────────────────────────────────────────

test('tool_use blocks are extracted and text is concatenated', () => {
  const message = assistant([
    textBlock('before '),
    toolUse('t1', 'Read', { path: 'a' }),
    textBlock('after'),
    toolUse('t2', 'Bash', { command: 'ls' }),
  ]);
  assert.deepEqual(toolRequests(message).map(r => r.name), ['Read', 'Bash']);
  assert.equal(assistantText(message), 'before after');
  assert.deepEqual(toolRequests({ content: [] }), []);
  assert.equal(assistantText(null), '');
});

// ── The loop ──────────────────────────────────────────────────────────────

test('a text-only reply finishes in one turn without executing anything', async () => {
  const fetchImpl = stubFetch([assistant([textBlock('done')])]);
  const executed = [];
  const result = await runAgent({
    baseUrl: 'https://x', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    execute: async request => { executed.push(request); return { content: '' }; },
    fetchImpl,
  });
  assert.equal(result.text, 'done');
  assert.equal(result.turns, 1);
  assert.equal(executed.length, 0);
});

test('a tool call is executed and its result is sent back', async () => {
  const fetchImpl = stubFetch([
    assistant([toolUse('t1', 'Read', { path: 'a.txt' })]),
    assistant([textBlock('the file says hi')]),
  ]);
  const result = await runAgent({
    baseUrl: 'https://x', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'read a.txt' }],
    execute: async () => ({ content: 'hi' }),
    fetchImpl,
  });

  assert.equal(result.turns, 2);
  assert.equal(result.text, 'the file says hi');

  // The second request must carry the assistant turn and a matching tool_result.
  const second = fetchImpl.calls[1].body.messages;
  const assistantTurn = second.find(m => m.role === 'assistant');
  assert.ok(assistantTurn.content.some(b => b.type === 'tool_use' && b.id === 't1'));

  const resultTurn = second.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.deepEqual(resultTurn.content, [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }]);
});

test('several tool calls in one turn all get results', async () => {
  const fetchImpl = stubFetch([
    assistant([toolUse('a', 'Read', {}), toolUse('b', 'Read', {})]),
    assistant([textBlock('both done')]),
  ]);
  let count = 0;
  await runAgent({
    baseUrl: 'https://x', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    execute: async () => { count++; return { content: `r${count}` }; },
    fetchImpl,
  });
  const results = fetchImpl.calls[1].body.messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(r => r.tool_use_id), ['a', 'b']);
  assert.deepEqual(results.map(r => r.content), ['r1', 'r2']);
});

test('a throwing tool becomes an is_error tool_result, not a crash', async () => {
  const fetchImpl = stubFetch([
    assistant([toolUse('t1', 'Edit', {})]),
    assistant([textBlock('ok')]),
  ]);
  const events = [];
  await runAgent({
    baseUrl: 'https://x', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    execute: async () => { throw new Error('ambiguous-match'); },
    onEvent: event => events.push(event),
    fetchImpl,
  });
  const result = fetchImpl.calls[1].body.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /ambiguous-match/);
  assert.ok(events.some(e => e.type === 'tool_error'));
});

test('an isError outcome is forwarded as is_error', async () => {
  const fetchImpl = stubFetch([
    assistant([toolUse('t1', 'Bash', {})]),
    assistant([textBlock('ok')]),
  ]);
  await runAgent({
    baseUrl: 'https://x', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    execute: async () => ({ content: 'exit 1', isError: true }),
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[1].body.messages.at(-1).content[0].is_error, true);
});

test('the turn budget stops a model that never finishes', async () => {
  // Always ask for another tool: the loop must refuse to spin forever.
  const loop = () => assistant([toolUse('t', 'Read', {})]);
  const fetchImpl = stubFetch(Array.from({ length: 5 }, loop));
  await assert.rejects(
    () => runAgent({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      execute: async () => ({ content: 'x' }),
      maxTurns: 3,
      fetchImpl,
    }),
    error => error instanceof AgentError && error.code === 'turn-budget',
  );
});

test('cancellation aborts before the next turn', async () => {
  const controller = new AbortController();
  const fetchImpl = stubFetch([
    assistant([toolUse('t1', 'Read', {})]),
    assistant([textBlock('never reached')]),
  ]);
  await assert.rejects(
    () => runAgent({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      execute: async () => { controller.abort(); return { content: 'x' }; },
      signal: controller.signal,
      fetchImpl,
    }),
    error => error.code === 'aborted',
  );
});

// ── Tools ─────────────────────────────────────────────────────────────────

test('tool definitions omit the local handler and action', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const defs = definitionsFor(tools);
  assert.ok(defs.length >= 6);
  for (const def of defs) {
    assert.equal(typeof def.name, 'string');
    assert.equal(typeof def.description, 'string');
    assert.equal(def.input_schema.type, 'object');
    assert.equal(def.handler, undefined, 'handlers must not leak into the API payload');
    assert.equal(def.action, undefined);
  }
}));

test('Read returns numbered lines and honours offset/limit', () => withRoot(async root => {
  writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const read = tools.find(t => t.name === 'Read');

  const all = await read.handler({ path: 'a.txt' });
  assert.match(all.content, /^1\tone/m);
  assert.match(all.content, /^4\tfour/m);

  const partial = await read.handler({ path: 'a.txt', offset: 2, limit: 1 });
  assert.match(partial.content, /^3\tthree/m);
  assert.ok(!partial.content.includes('one'));
  assert.match(partial.content, /more lines/);
}));

test('Read refuses a path outside the workspace', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const read = tools.find(t => t.name === 'Read');
  await assert.rejects(() => read.handler({ path: 'C:/Windows/win.ini' }), /outside the approved roots/);
}));

test('Write and Edit really change the file', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const write = tools.find(t => t.name === 'Write');
  const edit = tools.find(t => t.name === 'Edit');

  const wrote = await write.handler({ path: 'a.txt', content: 'hello\n' });
  assert.match(wrote.content, /Wrote/);
  assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello\n');

  const edited = await edit.handler({ path: 'a.txt', old_string: 'hello', new_string: 'goodbye' });
  assert.match(edited.content, /Edited/);
  assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'goodbye\n');
}));

test('Edit refuses an ambiguous match', () => withRoot(async root => {
  writeFileSync(path.join(root, 'a.txt'), 'x\nx\n');
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const edit = tools.find(t => t.name === 'Edit');
  await assert.rejects(() => edit.handler({ path: 'a.txt', old_string: 'x', new_string: 'y' }), /occurs 2 times/);
}));

test('List and Glob report workspace contents', () => withRoot(async root => {
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  writeFileSync(path.join(root, 'src', 'b.txt'), 'b');
  writeFileSync(path.join(root, 'top.md'), 'm');
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });

  const listed = await tools.find(t => t.name === 'List').handler({ path: '.' });
  assert.match(listed.content, /dir src/);
  assert.match(listed.content, /file top\.md/);

  const globbed = await tools.find(t => t.name === 'Glob').handler({ pattern: 'src/*.js' });
  assert.match(globbed.content, /src\/a\.js/);
  assert.ok(!globbed.content.includes('b.txt'));
}));

test('Bash runs an allowlisted command and reports a non-zero exit as an error', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const bash = tools.find(t => t.name === 'Bash');

  const ok = await bash.handler({ command: 'node --version' });
  assert.match(ok.content, /^v\d+\./m);
  assert.notEqual(ok.isError, true);

  const bad = await bash.handler({ command: 'git --definitely-not-a-flag' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /\[exit \d+\]/);
}));

test('Bash refuses a command outside the allowlist', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const bash = tools.find(t => t.name === 'Bash');
  await assert.rejects(() => bash.handler({ command: 'curl http://example.com' }), /not in the allowlist/);
}));

test('globToRegExp handles the supported subset', () => {
  assert.ok(globToRegExp('*.js').test('a.js'));
  assert.ok(!globToRegExp('*.js').test('src/a.js'), 'a basename pattern does not cross directories');
  assert.ok(globToRegExp('**/*.js').test('src/deep/a.js'));
  assert.ok(globToRegExp('src/**').test('src/a/b'));
  assert.ok(globToRegExp('a?c').test('abc'));
});

// ── Approval gate ─────────────────────────────────────────────────────────

test('tool names map to permission actions', () => {
  assert.equal(actionFor('Read'), ACTIONS.READ);
  assert.equal(actionFor('List'), ACTIONS.READ);
  assert.equal(actionFor('Glob'), ACTIONS.READ);
  assert.equal(actionFor('Write'), ACTIONS.EDIT);
  assert.equal(actionFor('Edit'), ACTIONS.EDIT);
  assert.equal(actionFor('Bash'), ACTIONS.EXEC);
  // An unknown tool must prompt, so it maps to an action that prompts in every
  // permissive mode.
  assert.equal(actionFor('MysteryTool'), ACTIONS.EDIT);
  assert.ok(Object.keys(TOOL_ACTIONS).length >= 6);
});

test('describeRequest produces a one-line summary per tool', () => {
  assert.equal(describeRequest({ name: 'Read', input: { path: 'a.js' } }), 'Read a.js');
  assert.equal(describeRequest({ name: 'Bash', input: { command: 'ls -la' } }), 'Run: ls -la');
  assert.equal(describeRequest({ name: 'Glob', input: { pattern: '**/*.js' } }), 'Find files matching **/*.js');
  assert.equal(describeRequest({ name: 'Other', input: {} }).startsWith('Other '), true);
});

test('acceptEdits runs edits without asking but asks for commands', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const asked = [];
  const execute = createApprovalExecutor({
    mode: MODES.ACCEPT_EDITS,
    tools,
    ask: async request => { asked.push(request.command); return 'allow'; },
  });

  await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.equal(asked.length, 0, 'an edit must not prompt in acceptEdits');

  await execute({ name: 'Bash', input: { command: 'node --version' } });
  assert.equal(asked.length, 1, 'a command must prompt in acceptEdits');
  assert.match(asked[0], /node --version/);
}));

test('ask mode prompts before an edit and honours a denial', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  let asked = 0;
  const execute = createApprovalExecutor({
    mode: MODES.ASK,
    tools,
    ask: async () => { asked++; return 'cancel'; },
  });

  const outcome = await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.equal(asked, 1);
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /declined/);
  // A denied write must not have created the file.
  assert.throws(() => readFileSync(path.join(root, 'a.txt'), 'utf8'));
}));

test('a timeout is reported as such, not as a generic denial', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const execute = createApprovalExecutor({ mode: MODES.ASK, tools, ask: async () => 'timeout' });
  const outcome = await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /did not respond in time/);
}));

test('an approval error is treated as a denial, never as consent', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const execute = createApprovalExecutor({
    mode: MODES.ASK,
    tools,
    ask: async () => { throw new Error('consent window crashed'); },
  });
  const outcome = await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.equal(outcome.isError, true);
  assert.throws(() => readFileSync(path.join(root, 'a.txt'), 'utf8'));
}));

test('bypassPermissions runs everything without asking', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  let asked = 0;
  const execute = createApprovalExecutor({
    mode: MODES.BYPASS,
    tools,
    ask: async () => { asked++; return 'cancel'; },
  });
  const outcome = await execute({ name: 'Write', input: { path: 'a.txt', content: 'hi' } });
  assert.equal(asked, 0);
  assert.notEqual(outcome.isError, true);
  assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hi');
}));

test('plan mode refuses edits but allows reads', () => withRoot(async root => {
  writeFileSync(path.join(root, 'a.txt'), 'content');
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const decisions = ['cancel', 'allow'];
  const execute = createApprovalExecutor({
    mode: MODES.PLAN,
    tools,
    ask: async () => decisions.shift(),
  });

  const read = await execute({ name: 'Read', input: { path: 'a.txt' } });
  assert.notEqual(read.isError, true, 'plan mode may read');
  assert.match(read.content, /content/);

  const write = await execute({ name: 'Write', input: { path: 'a.txt', content: 'changed' } });
  assert.equal(write.isError, true, 'plan mode must never mutate');
  assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'content');
}));

test('an unknown tool is refused at execution time', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const execute = createApprovalExecutor({ mode: MODES.BYPASS, tools, ask: async () => 'allow' });
  const outcome = await execute({ name: 'NotATool', input: {} });
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /Unknown tool/);
}));

test('the gate emits an event for each decision', () => withRoot(async root => {
  const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
  const events = [];
  const execute = createApprovalExecutor({
    mode: MODES.ASK,
    tools,
    ask: async () => 'allow',
    onEvent: event => events.push(event.type),
  });
  await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.ok(events.includes('tool_approval_needed'));
  assert.ok(events.includes('tool_allowed'));
}));
