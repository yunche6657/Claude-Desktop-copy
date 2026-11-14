import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { McpHost } = require('../desktop/mcp-host.cjs');

async function fixture(endpoint = '/messages?session=fixture') {
  let stream; const calls = []; let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/sse') {
      stream = res;
      req.on('close', disconnected);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`: ready\r\nevent: endpoint\r\ndata: ${endpoint}\r`);
      setTimeout(() => res.write('\n\r\n'), 5);
      return;
    }
    if (req.url !== '/messages?session=fixture') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body); calls.push({ msg, authorization: req.headers.authorization });
    res.writeHead(202).end();
    if (!msg.id || msg.method === 'tools/call' && msg.params.name === 'hang') return;
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { resources: {} } };
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'ping' }] };
    else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: msg.params.arguments.value }] };
    else if (msg.method === 'resources/list') result = { resources: [{ uri: 'fixture:x' }] };
    else if (msg.method === 'resources/read') result = { contents: [{ uri: msg.params.uri, text: 'ok' }] };
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    stream.write(`event: message\ndata: ${payload}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/sse`, calls, closed, end: () => stream?.end(), dispose: async () => { stream?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('legacy SSE host handshake, tools, resources and stop use a real loopback server', async () => {
  const f = await fixture(); const host = new McpHost({ timeoutMs: 1000 });
  try {
    assert.deepEqual(host.load({ mcpServers: { s: { type: 'sse', url: f.url, headers: { authorization: 'Bearer fixture' } } } }).accepted, ['s']);
    assert.equal((await host.connect('s')).toolCount, 1);
    assert.equal((await host.callTool('s', 'ping', { value: 'pong' })).content[0].text, 'pong');
    const conn = host.servers.get('s').connection;
    assert.deepEqual(await conn.listResources(), [{ uri: 'fixture:x' }]);
    assert.equal((await conn.readResource('fixture:x'))[0].text, 'ok');
    assert.ok(f.calls.every(c => c.authorization === 'Bearer fixture'));
    const pending = host.callTool('s', 'hang', {});
    await new Promise(resolve => setTimeout(resolve, 20));
    await host.disconnect('s');
    await assert.rejects(pending, /stopped|disconnected/);
    await f.closed;
    assert.equal(host.list()[0].status, 'disconnected');
  } finally { await host.stopAll(); await f.dispose(); }
});

test('stream end rejects pending request and updates host state', async () => {
  const f = await fixture(); const host = new McpHost({ timeoutMs: 1000 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: f.url } } }); await host.connect('s');
    const pending = host.callTool('s', 'hang', {}); await new Promise(resolve => setTimeout(resolve, 20)); f.end();
    await assert.rejects(pending, /stream ended/);
    assert.equal(host.list()[0].status, 'disconnected');
  } finally { await host.stopAll(); await f.dispose(); }
});

test('cross-origin advertised endpoint is rejected before any POST', async () => {
  const f = await fixture('http://127.0.0.1:1/steal'); const host = new McpHost({ timeoutMs: 1000 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: f.url, headers: { authorization: 'Bearer fixture' } } } });
    await assert.rejects(host.connect('s'), /same-origin/);
    assert.equal(f.calls.length, 0);
  } finally { await host.stopAll(); await f.dispose(); }
});

test('stopping during endpoint discovery aborts GET and rejects connect', async () => {
  let closed;
  const closeEvent = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    req.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': waiting\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = new McpHost({ timeoutMs: 1000 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse` } } });
    const pending = host.connect('s');
    await new Promise(resolve => setTimeout(resolve, 30));
    await host.disconnect('s');
    await assert.rejects(pending, /stopped|disconnected/);
    await closeEvent;
    assert.equal(host.list()[0].status, 'disconnected');
  } finally { await host.stopAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('POST redirects are rejected and credentials do not reach another origin', async () => {
  let leaked = 0;
  const target = http.createServer((req, res) => { leaked++; res.writeHead(200).end(); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  let stream;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n');
    } else { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` }).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = new McpHost({ timeoutMs: 1000 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse`, headers: { authorization: 'Bearer fixture' } } } });
    await assert.rejects(host.connect('s'), { code: 'network' });
    assert.equal(leaked, 0);
  } finally {
    await host.stopAll(); stream?.destroy(); server.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});


test('early SSE response does not hide a failing POST', async () => {
  let stream;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })}\n\n`);
    setTimeout(() => res.writeHead(500).end(), 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = new McpHost({ timeoutMs: 500 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse` } } });
    await assert.rejects(host.connect('s'), { code: 'http-error' });
  } finally { await host.stopAll(); stream?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('request timeout aborts a hanging POST even after an early SSE response', async () => {
  let stream; let postClosed;
  const closed = new Promise(resolve => { postClosed = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    res.on('close', postClosed);
    const msg = JSON.parse(body);
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = new McpHost({ timeoutMs: 100 });
  try {
    host.load({ mcpServers: { s: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse` } } });
    await assert.rejects(host.connect('s'), { code: 'timeout' });
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('POST was not aborted')), 1000))]);
  } finally { await host.stopAll(); stream?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
