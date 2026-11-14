// MCP host tests.
//
// These spawn a real child process speaking newline-delimited JSON-RPC, so the
// handshake, tool listing and tool calls are exercised over the actual wire
// format rather than against a stubbed connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { McpHost, normaliseServer, McpError } = await import('../desktop/mcp-host.cjs');

const FIXTURE = path.join(here, 'fixtures', 'mcp-server.mjs');

function serverEntry(mode) {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [FIXTURE, '--mode', mode],
  };
}

test('a stdio entry is accepted and http/sse are recognised', () => {
  const stdio = normaliseServer('a', { command: 'node', args: ['x'] });
  assert.equal(stdio.type, 'stdio');
  assert.deepEqual(stdio.args, ['x']);
  // A missing `type` means stdio, which is what the original assumes.
  assert.equal(normaliseServer('b', { command: 'node' }).type, 'stdio');
  assert.equal(normaliseServer('c', { type: 'http', url: 'https://x' }).type, 'http');
  assert.equal(normaliseServer('d', { type: 'sse', url: 'https://x' }).type, 'sse');
});

test('invalid entries are refused with a reason', () => {
  assert.throws(() => normaliseServer('a', { type: 'stdio' }), /requires a command string/);
  assert.throws(() => normaliseServer('a', { command: 'node', args: 'not-an-array' }), /args must be a string array/);
  assert.throws(() => normaliseServer('a', { command: 'node', args: [1] }), /args must be a string array/);
  assert.throws(() => normaliseServer('a', { command: 'node', env: [] }), /env must be an object/);
  assert.throws(() => normaliseServer('a', { type: 'carrier-pigeon' }), /unknown type/);
  assert.throws(() => normaliseServer('a', null), /is not an object/);
});

test('load reports invalid servers instead of dropping them silently', () => {
  const host = new McpHost();
  const result = host.load({
    mcpServers: {
      good: { command: process.execPath, args: [FIXTURE] },
      bad: { type: 'stdio' },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    },
  });
  assert.deepEqual(result.accepted.sort(), ['good', 'remote']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].name, 'bad');

  const listed = host.list();
  assert.equal(listed.find(s => s.name === 'good').status, 'disconnected');
  assert.equal(listed.find(s => s.name === 'bad').status, 'invalid');
  // http is now a real transport, so the entry starts disconnected, not unsupported.
  assert.equal(listed.find(s => s.name === 'remote').status, 'disconnected');
  host.stopAll();
});

test('a malformed mcpServers value is refused', () => {
  const host = new McpHost();
  assert.throws(() => host.load({ mcpServers: [] }), /mcpServers must be an object/);
});

test('connect performs the handshake and lists tools', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: serverEntry('ok') } });
  try {
    const state = await host.connect('fixture');
    assert.equal(state.status, 'connected');
    assert.equal(state.toolCount, 2);

    const entry = host.list().find(s => s.name === 'fixture');
    assert.equal(entry.status, 'connected');
    assert.equal(entry.type, 'stdio');
  } finally {
    host.stopAll();
  }
});

test('tools can be called and return their content', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: serverEntry('ok') } });
  try {
    await host.connect('fixture');
    const echo = await host.callTool('fixture', 'echo', { text: 'hello' });
    assert.equal(echo.content[0].text, 'hello');

    const sum = await host.callTool('fixture', 'add', { a: 2, b: 40 });
    assert.equal(sum.content[0].text, '42');
  } finally {
    host.stopAll();
  }
});

test('an unknown tool surfaces the server error', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: serverEntry('ok') } });
  try {
    await host.connect('fixture');
    await assert.rejects(() => host.callTool('fixture', 'nope', {}), /unknown tool nope/);
  } finally {
    host.stopAll();
  }
});

test('calling an unconnected server is refused', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: serverEntry('ok') } });
  try {
    await assert.rejects(() => host.callTool('fixture', 'echo', {}), /is disconnected/);
    await assert.rejects(() => host.callTool('missing', 'echo', {}), /no server named/);
    await assert.rejects(() => host.connect('missing'), /no server named/);
  } finally { host.stopAll(); }
});

test('a server that emits non-JSON fails the connect', async () => {
  const host = new McpHost({ timeoutMs: 2000 });
  host.load({ mcpServers: { bad: serverEntry('garbage') } });
  try {
    await assert.rejects(() => host.connect('bad'), /non-JSON line/);
    assert.equal(host.list().find(s => s.name === 'bad').status, 'failed');
  } finally { host.stopAll(); }
});

test('a silent server hits the request timeout', async () => {
  const host = new McpHost({ timeoutMs: 300 });
  host.load({ mcpServers: { quiet: serverEntry('silent') } });
  try {
    await assert.rejects(() => host.connect('quiet'), /did not answer initialize/);
    assert.equal(host.list().find(s => s.name === 'quiet').status, 'failed');
  } finally { host.stopAll(); }
});

test('a crashing server is reported, not swallowed', async () => {
  const host = new McpHost({ timeoutMs: 3000 });
  host.load({ mcpServers: { crash: serverEntry('crash') } });
  try {
    await assert.rejects(() => host.connect('crash'), /exited with code|did not answer/);
    assert.equal(host.list().find(s => s.name === 'crash').status, 'failed');
  } finally { host.stopAll(); }
});

test('disconnect and restart round-trip a server', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { fixture: serverEntry('ok') } });
  try {
    await host.connect('fixture');
    const off = await host.disconnect('fixture');
    assert.equal(off.status, 'disconnected');
    assert.equal(host.list().find(s => s.name === 'fixture').toolCount, 0);

    const again = await host.restart('fixture');
    assert.equal(again.status, 'connected');
    assert.equal(again.toolCount, 2);
  } finally { host.stopAll(); }
});

test('an unsupported transport cannot be connected', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { legacy: { type: 'sdk' } } });
  try {
    await assert.rejects(() => host.connect('legacy'), /not implemented/);
  } finally { host.stopAll(); }
});

test('McpError carries a stable code', async () => {
  const host = new McpHost();
  host.load({ mcpServers: {} });
  try {
    await host.connect('nope').catch(error => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, 'not-found');
    });
  } finally { host.stopAll(); }
});

// ── HTTP transport ────────────────────────────────────────────────────────
// These drive HttpConnection through an injected fetch, so the wire format is
// asserted without a network: request shape, Mcp-Session-Id handling, JSON vs SSE
// bodies, and DELETE on stop.

function httpServer(url = 'https://mcp.example/rpc', extra = {}) {
  return { name: 'remote', type: 'http', url, ...extra };
}

/** Builds a fetch stub returning queued {status, contentType, body, sessionId}.
 *
 * A JSON-RPC notification (an object with no `id`) expects no answered message,
 * so it is answered 202 with an empty body and does NOT consume a queued
 * response. Treating it as a request shifted every later assertion by one. */
function stubHttp(responses) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body });
    if (body && body.id === undefined) {
      return {
        ok: true, status: 202,
        headers: { get: () => null },
        text: async () => '',
      };
    }
    const next = responses.shift();
    if (!next) throw new Error('stub ran out of responses');
    const headers = new Map();
    if (next.contentType) headers.set('content-type', next.contentType);
    if (next.sessionId) headers.set('mcp-session-id', next.sessionId);
    return {
      ok: (next.status || 200) < 400,
      status: next.status || 200,
      headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    };
  };
  impl.calls = calls;
  return impl;
}

const jsonMessage = (id, result) => ({ jsonrpc: '2.0', id, result });

test('an http entry requires a url and accepts headers', () => {
  assert.throws(() => normaliseServer('a', { type: 'http' }), /requires a url string/);
  assert.throws(() => normaliseServer('a', { type: 'http', url: '   ' }), /requires a url string/);
  assert.throws(() => normaliseServer('a', { type: 'http', url: 'https://x', headers: [] }), /headers must be an object/);
  const entry = normaliseServer('a', { type: 'http', url: 'https://x', headers: { authorization: 'Bearer t' } });
  assert.equal(entry.url, 'https://x');
  assert.deepEqual(entry.headers, { authorization: 'Bearer t' });
});

test('http, stdio and sse are loadable; sdk remains unsupported', () => {
  const host = new McpHost();
  const result = host.load({
    mcpServers: {
      local: { command: 'node' },
      remote: { type: 'http', url: 'https://mcp.example/rpc' },
      legacy: { type: 'sse', url: 'https://mcp.example/sse' },
      sdk: { type: 'sdk' },
    },
  });
  assert.deepEqual(result.accepted.sort(), ['legacy', 'local', 'remote']);
  const listed = host.list();
  assert.equal(listed.find(s => s.name === 'remote').status, 'disconnected');
  assert.equal(listed.find(s => s.name === 'legacy').status, 'disconnected');
  assert.equal(listed.find(s => s.name === 'sdk').status, 'unsupported');
});

test('connect performs the handshake and records the session id', async () => {
  const fetchImpl = stubHttp([
    { contentType: 'application/json', sessionId: 'sess-1', body: jsonMessage(1, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'remote' } }) },
    { contentType: 'application/json', body: jsonMessage(2, { tools: [{ name: 'ping' }] }) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example/rpc' } } });

  const state = await host.connect('remote');
  assert.equal(state.status, 'connected');
  assert.equal(state.toolCount, 1);

  // The initialize POST carries the protocol headers and no session yet.
  const init = fetchImpl.calls.find(x => x.body && x.body.method === 'initialize');
  assert.ok(init, 'an initialize POST must have been sent');
  assert.equal(init.method, 'POST');
  assert.equal(init.body.method, 'initialize');
  assert.match(init.headers.accept, /text\/event-stream/);
  assert.equal(init.headers['mcp-session-id'], undefined);

  // Every later request must repeat the session id.
  const list = fetchImpl.calls.find(x => x.body && x.body.method === 'tools/list');
  assert.ok(list, 'a tools/list POST must have been sent');
  assert.equal(list.headers['mcp-session-id'], 'sess-1');
  host.stopAll();
});

test('an SSE response body is parsed into messages', async () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n';
  const fetchImpl = stubHttp([
    { contentType: 'text/event-stream', sessionId: 's1', body: sse },
    { contentType: 'application/json', body: jsonMessage(2, { tools: [] }) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  const state = await host.connect('remote');
  assert.equal(state.status, 'connected');
  host.stopAll();
});

test('a tools/call round-trips through the transport', async () => {
  const fetchImpl = stubHttp([
    { contentType: 'application/json', sessionId: 's1', body: jsonMessage(1, {}) },
    { contentType: 'application/json', body: jsonMessage(2, { tools: [{ name: 'echo' }] }) },
    { contentType: 'application/json', body: jsonMessage(3, { content: [{ type: 'text', text: 'pong' }] }) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await host.connect('remote');

  const result = await host.callTool('remote', 'echo', { text: 'ping' });
  assert.equal(result.content[0].text, 'pong');

  // Locate by method: the initialized notification also sits in the call log.
  const call = fetchImpl.calls.find(x => x.body && x.body.method === 'tools/call');
  assert.ok(call, 'a tools/call POST must have been sent');
  assert.deepEqual(call.body.params, { name: 'echo', arguments: { text: 'ping' } });
  host.stopAll();
});

test('an HTTP error status is surfaced with the body', async () => {
  const fetchImpl = stubHttp([{ status: 401, contentType: 'application/json', body: { error: 'bad token' } }]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await assert.rejects(() => host.connect('remote'), /responded 401/);
  assert.equal(host.list().find(s => s.name === 'remote').status, 'failed');
});

test('a response with no matching id is a protocol error', async () => {
  const fetchImpl = stubHttp([
    { contentType: 'application/json', body: jsonMessage(99, {}) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await assert.rejects(() => host.connect('remote'), /did not answer initialize/);
});

test('a non-JSON body is rejected rather than trusted', async () => {
  const fetchImpl = stubHttp([{ contentType: 'application/json', body: '<html>not json</html>' }]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await assert.rejects(() => host.connect('remote'), /not valid JSON/);
});

test('a malformed SSE frame is reported, not skipped', async () => {
  const fetchImpl = stubHttp([{ contentType: 'text/event-stream', body: 'data: {broken\n\n' }]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await assert.rejects(() => host.connect('remote'), /SSE frame was not valid JSON/);
});

test('a request timeout aborts and reports it', async () => {
  const never = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const host = new McpHost({ fetchImpl: never, timeoutMs: 60 });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await assert.rejects(() => host.connect('remote'), /did not answer within|aborted/);
});

test('stopping an http session issues DELETE when a session id exists', async () => {
  const fetchImpl = stubHttp([
    { contentType: 'application/json', sessionId: 's9', body: jsonMessage(1, {}) },
    { contentType: 'application/json', body: jsonMessage(2, { tools: [] }) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { remote: { type: 'http', url: 'https://x/rpc' } } });
  await host.connect('remote');
  await host.disconnect('remote');
  const del = fetchImpl.calls.find(c => c.method === 'DELETE');
  assert.ok(del, 'a DELETE must be sent to end the session');
  assert.equal(del.headers['mcp-session-id'], 's9');
});

test('extra headers reach the server', async () => {
  const fetchImpl = stubHttp([
    { contentType: 'application/json', body: jsonMessage(1, {}) },
    { contentType: 'application/json', body: jsonMessage(2, { tools: [] }) },
  ]);
  const host = new McpHost({ fetchImpl });
  host.load({
    mcpServers: {
      remote: { type: 'http', url: 'https://x/rpc', headers: { authorization: 'Bearer abc' } },
    },
  });
  await host.connect('remote');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer abc');
  host.stopAll();
});



