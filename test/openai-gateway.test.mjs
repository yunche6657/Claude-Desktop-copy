import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const { startOpenAIGateway } = createRequire(import.meta.url)('../desktop/openai-gateway.cjs');

test('real CCB full system and tool schema pass through prepareCcbRuntime without being rewritten', {skip:process.env.OPENAI_CCB_REAL_PROOF!=='1',timeout:45000}, async t => {
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const require=createRequire(import.meta.url),{prepareCcbRuntime}=require('../desktop/ccb-runtime-config.cjs'),{createCcbKernel}=require('../desktop/ccb-kernel.cjs');
 const root=process.env.CCB_REAL_CORE||'D:/CodexArtifacts/claude-code-desktop/MODEL-DISCOVERY-VERIFIED/resources/agent-core';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'openai-real-ccb-'));let shape;
 const server=http.createServer(async(req,res)=>{const input=await body(req);shape={tools:input.tools.length,systemBytes:Buffer.byteLength(input.messages[0].content),maxTokens:input.max_tokens,effort:input.reasoning_effort};res.writeHead(200,{'content-type':'text/event-stream'});event(res,{choices:[{index:0,delta:{content:'FULL_CCB_OPENAI_OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:8}});res.end('data: [DONE]\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={...process.env};for(const key of ['NODE_TEST_CONTEXT','NODE_OPTIONS','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CLAUDE_AGENT_MODEL','ANTHROPIC_MODEL','CLAUDE_CCB_GATEWAY_ADAPTER','ANTHROPIC_API_TYPE'])delete env[key];
 const runtime=await prepareCcbRuntime({env,startOpenAIGateway:options=>startOpenAIGateway(options),gateway:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture-only',apiType:'openai-chat',model:'fixture-model',raw:{inferenceModelCapabilities:{'fixture-model':{supportedEfforts:['high']}}}}});
 const {spawn}=await import('node:child_process');
  const kernel=createCcbKernel({spawnImpl:spawn,bunPath:path.join(root,'bun/bun.exe'),entryPath:path.join(root,'claude-code/dist/cli-bun.js'),kernelRoot:path.join(root,'claude-code'),cwd:dir,homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),env:runtime.env,model:'fixture-model',permissionMode:'default',startupTimeoutMs:30000,turnTimeoutMs:30000,extraArgs:['--strict-mcp-config'],log:(...args)=>console.error('[CCB proof]',...args)});
 t.after(async()=>{await kernel.dispose();await runtime.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 kernel.onEvent(e=>{if(e.type==='error') console.error('[proof event]',e);});
  const result=await kernel.sendMessage('11111111-2222-4333-8444-555555555555','Reply exactly FULL_CCB_OPENAI_OK without tools.',{effortLevel:'high'});
 assert.equal(result.text,'FULL_CCB_OPENAI_OK');assert.ok(shape.tools>10);assert.ok(shape.systemBytes>10000);assert.ok(shape.maxTokens>1000);assert.equal(shape.effort,'high');
  const actor=kernel.getInfo('11111111-2222-4333-8444-555555555555').actorToken;
  await kernel.setModel('11111111-2222-4333-8444-555555555555','unknown-model');
  const second=await kernel.sendMessage('11111111-2222-4333-8444-555555555555','Reply exactly FULL_CCB_OPENAI_OK again without tools.');
  assert.equal(second.text,'FULL_CCB_OPENAI_OK');assert.equal(shape.effort,undefined);
  assert.equal(kernel.getInfo('11111111-2222-4333-8444-555555555555').actorToken,actor);
});

async function fixture(t, handler, options = {}) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gateway = await startOpenAIGateway({ upstreamBaseUrl: base + (options.path || '/v1'), apiKey: 'fixture-secret', protocol: options.protocol || 'openai-chat', capabilityProfile: options.capabilityProfile, timeoutMs: options.timeoutMs || 2000 });
  t.after(async () => { await gateway.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return gateway;
}
async function body(req) { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks)); }
function event(res, value) { res.write(`data: ${JSON.stringify(value)}\r\n\r\n`); }
function post(gateway, value, extra = {}) { return fetch(gateway.baseUrl + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'fixture-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }], ...value }), ...extra }); }
function decode(raw) { return raw.trim().split('\n\n').map(s => JSON.parse(s.split('\n').find(l => l.startsWith('data:')).slice(5))); }

for (const protocol of ['openai-chat', 'openai-responses']) test(`${protocol} preserves selected model and explicit effort`, async t => {
  let captured;
  const gateway = await fixture(t, async (req, res) => {
    captured = await body(req);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'first message is not system prompt' } }));
  }, { protocol, capabilityProfile: { inferenceModelCapabilities: { 'gpt-selected': { supportedEfforts: ['high'] } } } });
  const response = await post(gateway, { model: 'gpt-selected', output_config: { effort: 'high' } });
  assert.equal(captured.model, 'gpt-selected');
  assert.equal(protocol === 'openai-chat' ? captured.reasoning_effort : captured.reasoning.effort, 'high');
  assert.equal(response.status, 400);
  const raw = await response.text();
  assert.match(raw, /first message is not system prompt/);
  assert.ok(!raw.includes('fixture-secret'));
});

test('SSE provider error retains redacted provider reason rather than generic HTTP 200', async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { error: { code: 'PERMISSION_DENIED', status: 403, message: 'account restricted' } }); res.end();
  });
  const response = await post(gateway, {});
  assert.equal(response.status, 403);
  const raw = await response.text(); assert.match(raw, /account restricted/); assert.ok(!raw.includes('fixture-secret'));
});

test('invalid effort is rejected before upstream invocation', async t => {
  let called = false;
  const gateway = await fixture(t, async (req, res) => { called = true; res.end(); });
  assert.equal((await post(gateway, { output_config: { effort: 'bogus' } })).status, 400);
  assert.equal(called, false);
});

test('New API repeated tool metadata remains a single name and call ID', async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req);res.writeHead(200, {'content-type':'text/event-stream'});
    for (const args of ['{', '"value":', '"ok"', '}']) event(res,{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',function:{name:'probe_echo',arguments:args}}]}}]});
    event(res,{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});res.end('data: [DONE]\n\n');
  });
  const output = await (await post(gateway,{})).json();assert.equal(output.content[0].name,'probe_echo');assert.equal(output.content[0].id,'call_1');assert.deepEqual(output.content[0].input,{value:'ok'});
});

test('chat streams real text before upstream completes and includes usage', async t => {
  let release; const gate = new Promise(r => { release = r; }); t.after(() => release());
  const gateway = await fixture(t, async (req, res) => {
    const input = await body(req); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-secret'); assert.equal(input.stream, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { choices: [{ index: 0, delta: { content: 'first' } }] });
    await gate;
    event(res, { choices: [{ index: 0, delta: { content: ' second' }, finish_reason: 'stop' }] });
    event(res, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }); res.end('data: [DONE]\n\n');
  });
  const response = await post(gateway, { stream: true }); const reader = response.body.getReader(); const decoder = new TextDecoder(); let raw = '';
  while (!raw.includes('first')) raw += decoder.decode((await reader.read()).value);
  assert.ok(!raw.includes('message_stop')); release();
  for (;;) { const next = await reader.read(); if (next.done) break; raw += decoder.decode(next.value); }
  const events = decode(raw); assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop');
  assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 8, output_tokens: 3 });
});

test('chat tools preserve indexes, fragmented metadata, arguments and tool_result history', async t => {
  const gateway = await fixture(t, async (req, res) => {
    const input = await body(req); assert.equal(req.url, '/v1/chat/completions');
    assert.equal(input.messages[0].content, 'system');
    assert.equal(input.messages[1].content[1].image_url.url, 'data:image/png;base64,YQ==');
    assert.equal(input.messages[2].tool_calls[0].function.arguments, '{"x":1}');
    assert.deepEqual(input.messages[3], { role: 'tool', tool_call_id: 'previous', content: 'result' });
    assert.equal(input.messages[4].content[0].text, 'continue');
    assert.deepEqual(input.tool_choice, { type: 'function', function: { name: 'search' } });
    assert.deepEqual(input.tools[0].function.parameters, { type: 'object' }); assert.deepEqual(input.stop, ['END']);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 3, id: 'call_', function: { name: 'sea' } }, { index: 7, id: 'other', function: { name: 'other', arguments: '{"b":' } }] } }] });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 3, id: 'one', function: { name: 'rch', arguments: '{"q":' } }, { index: 7, function: { arguments: '2}' } }] } }] });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 3, function: { arguments: '"hello"}' } }] }, finish_reason: 'tool_calls' }] }); res.end('data: [DONE]\n\n');
  }, { path: '/v1/chat/completions' });
  const response = await post(gateway, { system: [{ type: 'text', text: 'system' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'previous', name: 'search', input: { x: 1 } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'previous', content: [{ type: 'text', text: 'result' }] }, { type: 'text', text: 'continue' }] }], tools: [{ name: 'search', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'search' }, stop_sequences: ['END'], temperature: 0.4 });
  assert.equal(response.status, 200); const output = await response.json();
  assert.equal(output.stop_reason, 'tool_use');
  assert.deepEqual(output.content.find(b => b.id === 'call_one'), { type: 'tool_use', id: 'call_one', name: 'search', input: { q: 'hello' } });
  assert.deepEqual(output.content.find(b => b.id === 'other').input, { b: 2 });
});

for (const stream of [true, false]) test(`responses converts text/function call and history (stream=${stream})`, async t => {
  const gateway = await fixture(t, async (req, res) => {
    const input = await body(req); assert.equal(req.url, '/v1/responses'); assert.equal(input.max_output_tokens, 100);
    assert.equal(input.input[1].content[0].image_url, 'https://example.test/image');
    assert.equal(input.input[2].type, 'function_call'); assert.equal(input.input[3].type, 'function_call_output');
    assert.equal(input.tools[0].name, 'search'); assert.equal(input.tool_choice, 'required');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'working' });
    event(res, { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search' } });
    event(res, { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"q":' });
    event(res, { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '"term"}' });
    event(res, { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search', arguments: '{"q":"term"}' } });
    event(res, { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 9 } } }); res.end();
  }, { protocol: 'openai-responses', path: '/v1/responses' });
  const response = await post(gateway, { stream, system: 'system', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image' } }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'search', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'ok' }] }], tools: [{ name: 'search', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } });
  if (stream) {
    const events = decode(await response.text()); assert.equal(events.filter(e => e.type === 'content_block_start').length, 2);
    assert.deepEqual(events.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json), ['{"q":', '"term"}']); assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  } else {
    const output = await response.json(); assert.equal(output.content[0].text, 'working'); assert.deepEqual(output.content[1].input, { q: 'term' }); assert.deepEqual(output.usage, { input_tokens: 12, output_tokens: 9 });
  }
});

test('errors are sanitized, unsupported input returns 400 and truncation is detected', async t => {
  let mode = 'http';
  const gateway = await fixture(t, async (req, res) => {
    await body(req);
    if (mode === 'http') { res.writeHead(401).end('fixture-secret'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'error') event(res, { error: { message: 'fixture-secret' } });
    else event(res, { choices: [{ index: 0, delta: { content: 'partial' } }] });
    res.end();
  });
  let response = await post(gateway); assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('fixture-secret'));
  mode = 'error'; response = await post(gateway, { stream: true }); const raw = await response.text(); assert.equal(response.status,502);assert.ok(raw.includes('api_error')); assert.ok(!raw.includes('fixture-secret'));
  mode = 'truncated'; response = await post(gateway); assert.equal(response.status, 502);
  response = await post(gateway, { messages: [] , tool_choice: { type: 'invalid' } }); assert.equal(response.status, 400);
});

test('HTTP 200 SSE INVALID_REQUEST remains non-retryable business 400 without leaking body', async t => {
 const gateway=await fixture(t,async(req,res)=>{await body(req);res.writeHead(200,{'content-type':'text/event-stream'});event(res,{choices:[],error:{status:400,code:'INVALID_REQUEST',type:'server_error',message:'fixture-secret private prompt'}});res.end();});
 for(const stream of [true,false]){const response=await post(gateway,{stream});assert.equal(response.status,400);const result=await response.json();assert.equal(result.error.type,'invalid_request_error');assert.match(result.error.message,/invalid_request/);assert.ok(!JSON.stringify(result).includes('fixture-secret'));assert.ok(!JSON.stringify(result).includes('private prompt'));}
});

test('timeouts cancel upstream and return 504', async t => {
  let closed = false;
  const gateway = await fixture(t, async (req, res) => { await body(req); res.on('close', () => { closed = true; }); }, { timeoutMs: 60 });
  const response = await post(gateway); assert.equal(response.status, 504); await response.text();
  for (let i = 0; i < 20 && !closed; i++) await delay(10);
  assert.equal(closed, true);
});

test('downstream disconnect aborts active upstream stream', async t => {
  let closed = false;
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.on('close', () => { closed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); event(res, { choices: [{ index: 0, delta: { content: 'hello' } }] });
  });
  const controller = new AbortController(); const response = await post(gateway, { stream: true }, { signal: controller.signal });
  await response.body.getReader().read(); controller.abort();
  for (let i = 0; i < 30 && !closed; i++) await delay(10);
  assert.equal(closed, true);
});

test('validates loopback and protocol', async () => {
  await assert.rejects(startOpenAIGateway({ host: '0.0.0.0' }), /loopback/);
  await assert.rejects(startOpenAIGateway({ protocol: 'invalid' }), /protocol/);
});

test('chat streamed tool blocks contain complete metadata and JSON fragments', async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call_', function: { name: 'look' } }] } }] });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'id', function: { name: 'up', arguments: '{"x":' } }] } }] });
    event(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }); res.end('data: [DONE]\n\n');
  }, { path: '' });
  const events = decode(await (await post(gateway, { stream: true })).text());
  const start = events.find(e => e.type === 'content_block_start');
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 'call_id', name: 'lookup', input: {} });
  assert.equal(events.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''), '{"x":1}');
  assert.equal(events.filter(e => e.type === 'content_block_stop').length, 1);
});

test('request size is bounded before sending upstream', async t => {
  let called = false;
  const gateway = await fixture(t, (req, res) => { called = true; res.end(); });
  const response = await post(gateway, { messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] });
  assert.equal(response.status, 413); assert.equal(called, false); await response.text();
});

function assertSequentialBlocks(events) {
  let current = null, next = 0;
  for (const event of events) {
    if (event.type === 'content_block_start') { assert.equal(current, null); assert.equal(event.index, next++); current = event.index; }
    if (event.type === 'content_block_delta') assert.equal(event.index, current);
    if (event.type === 'content_block_stop') { assert.equal(event.index, current); current = null; }
  }
  assert.equal(current, null);
  assert.ok(!JSON.stringify(events).includes('signature'));
}

for (const protocol of ['openai-chat', 'openai-responses']) for (const stream of [false, true]) test(`${protocol} explicit reasoning preserves thinking/text/tool order (stream=${stream})`, async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (protocol === 'openai-chat') {
      for (const delta of [
        { reasoning_content: 'consider ' }, { reasoning_content: 'input', content: 'answer' },
        { tool_calls: [{ index: 0, id: 'call_probe', function: { name: 'probe', arguments: '{"x":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
        { reasoning_content: 'after tool' }, { content: 'tail' }
      ]) event(res, { choices: [{ index: 0, delta }] });
      event(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const value of [
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'consider ' },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'input' },
        { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'consider input' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'consider input' }] } },
        { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'answer' },
        { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_probe', name: 'probe' } },
        { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"x":' },
        { type: 'response.function_call_arguments.delta', output_index: 2, delta: '1}' },
        { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', arguments: '{"x":1}' } },
        { type: 'response.reasoning_text.delta', output_index: 3, content_index: 0, delta: 'after tool' },
        { type: 'response.output_text.delta', output_index: 4, content_index: 0, delta: 'tail' },
        { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 8 } } }
      ]) event(res, value);
    }
    res.end('data: [DONE]\n\n');
  }, { protocol });
  const response = await post(gateway, { stream });
  assert.equal(response.status, 200);
  const expected = ['thinking', 'text', 'tool_use', 'thinking', 'text'];
  if (stream) {
    const events = decode(await response.text());
    assertSequentialBlocks(events);
    assert.deepEqual(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type), expected);
    assert.equal(events.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join(''), 'consider inputafter tool');
    assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'answertail');
    assert.equal(events.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''), '{"x":1}');
    assert.equal(events.at(-1).type, 'message_stop');
  } else {
    const output = await response.json();
    assert.deepEqual(output.content.map(b => b.type), expected);
    assert.equal(output.content[0].thinking, 'consider input');
    assert.deepEqual(output.content[2], { type: 'tool_use', id: 'call_probe', name: 'probe', input: { x: 1 } });
    assert.equal(output.content[3].thinking, 'after tool');
    assert.ok(!JSON.stringify(output).includes('signature'));
  }
});

for (const type of ['response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done']) test(`Responses retains done-only summary via ${type}`, async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, type === 'response.output_item.done' ? { type, output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'explicit summary' }] } } : type === 'response.reasoning_summary_part.done' ? { type, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: 'explicit summary' } } : { type, output_index: 0, summary_index: 0, text: 'explicit summary' });
    event(res, { type: 'response.completed', response: {} }); res.end();
  }, { protocol: 'openai-responses' });
  assert.deepEqual((await (await post(gateway, {})).json()).content, [{ type: 'thinking', thinking: 'explicit summary' }]);
});

test('Chat explicit thinking streams before completion while tagged ordinary text stays text', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { choices: [{ index: 0, delta: { reasoning_content: 'upstream thought' } }] });
    await gate;
    event(res, { choices: [{ index: 0, delta: { content: '<think>ordinary text</think>' }, finish_reason: 'stop' }] }); res.end();
  });
  const reader = (await post(gateway, { stream: true })).body.getReader();
  const decoder = new TextDecoder(); let raw = '';
  try {
    while (!raw.includes('upstream thought')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); raw += decoder.decode(chunk.value);
    }
    assert.ok(!raw.includes('message_stop'));
  } finally { release(); }
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value); }
  const events = decode(raw); assertSequentialBlocks(events);
  assert.deepEqual(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type), ['thinking', 'text']);
  assert.equal(events.find(e => e.delta?.type === 'text_delta').delta.text, '<think>ordinary text</think>');
});

test('parallel tool fragments interleaved with reasoning remain complete and sequential', async t => {
  const gateway = await fixture(t, async (req, res) => {
    await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [
      { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{"x":' } }] },
      { reasoning_content: 'explicit interlude' },
      { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{"y":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] },
      { content: 'done' }
    ]) event(res, { choices: [{ index: 0, delta }] });
    event(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }); res.end();
  });
  const events = decode(await (await post(gateway, { stream: true })).text());
  assertSequentialBlocks(events);
  assert.deepEqual(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type), ['tool_use', 'thinking', 'tool_use', 'text']);
  for (const [index, expected] of [[0, { x: 1 }], [2, { y: 2 }]]) {
    assert.deepEqual(JSON.parse(events.filter(e => e.index === index && e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join('')), expected);
  }
});

test('thinking history replays explicit Chat reasoning without inventing Responses IDs or signatures', () => {
  const { convertAnthropicRequest } = createRequire(import.meta.url)('../desktop/openai-gateway.cjs');
  const request = { model: 'fixture', messages: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'original reasoning', signature: 'anthropic-only' },
    { type: 'redacted_thinking', data: 'opaque-secret' },
    { type: 'text', text: 'answer' }, { type: 'tool_use', id: 'call_1', name: 'probe', input: {} }
  ] }] };
  const chat = convertAnthropicRequest(request, 'openai-chat').messages[0];
  assert.equal(chat.reasoning_content, 'original reasoning');
  assert.equal(chat.tool_calls[0].id, 'call_1');
  assert.equal(chat.content[0].text, 'answer');
  const responses = convertAnthropicRequest(request, 'openai-responses');
  assert.deepEqual(responses.input.map(item => item.type || item.role), ['assistant', 'function_call']);
  assert.ok(!JSON.stringify(responses).includes('original reasoning'));
  assert.ok(!JSON.stringify([chat, responses]).includes('opaque-secret'));
  assert.ok(!JSON.stringify([chat, responses]).includes('anthropic-only'));
});

test('responses rejects unsupported stop sequences explicitly', async t => {
  const gateway = await fixture(t, (req, res) => res.end(), { protocol: 'openai-responses' });
  const response = await post(gateway, { stop_sequences: ['STOP'] }); assert.equal(response.status, 400); await response.text();
});
