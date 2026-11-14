import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { McpHost, StdioConnection } = require('../desktop/mcp-host.cjs');

test('HTTP MCP resources paginate and read through the connected session', async t => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, session: req.headers['mcp-session-id'], message });
    if (req.method === 'DELETE' || message?.id === undefined) { res.writeHead(202).end(); return; }
    const results = {
      initialize: { protocolVersion: '2025-06-18', capabilities: { resources: {} } },
      'tools/list': { tools: [] },
      'resources/list': message.params?.cursor ? { resources: [{ uri: 'test:two' }] } : { resources: [{ uri: 'test:one' }], nextCursor: 'page-2' },
      'resources/read': { contents: [{ uri: message.params?.uri, text: 'fixture' }] },
    };
    res.writeHead(200, { 'content-type': 'application/json', ...(message.method === 'initialize' ? { 'mcp-session-id': 'fixture-session' } : {}) });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = new McpHost();
  host.load({ mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` } } });
  await host.connect('fixture');
  const connection = host.servers.get('fixture').connection;
  assert.deepEqual(await connection.listResources(), [{ uri: 'test:one' }, { uri: 'test:two' }]);
  assert.deepEqual(await connection.readResource('test:two'), [{ uri: 'test:two', text: 'fixture' }]);
  await host.disconnect('fixture');
  assert.deepEqual(calls.filter(x => x.message?.method === 'resources/list').map(x => x.message.params), [{}, { cursor: 'page-2' }]);
  assert.ok(calls.filter(x => x.message?.method?.startsWith('resources/')).every(x => x.session === 'fixture-session'));
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).session, 'fixture-session');
});

// Execute the shipped _listAllPages method itself with fixture transport/cache.
function nativePager() {
  const source = readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'), 'utf8');
  const start = source.indexOf('async _listAllPages(');
  const end = source.indexOf('_freshness(', start);
  // The first _freshness reference occurs inside the method; use the method boundary.
  const boundary = source.indexOf('}_freshness(', start);
  assert.ok(start >= 0 && end > start && boundary > end);
  const method = source.slice(start, boundary + 1);
  class NativeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  return vm.runInNewContext(`(class { ${method} })`, { _p: NativeError, gp: { ListPaginationExceeded: 'pagination-exceeded' } });
}

test('resource pagination matches native repeated cursors and 64-page boundary', async () => {
  const Native = nativePager();
  async function compare(makePage) {
    const calls = { native: [], replica: [] };
    const page = (kind, params) => {
      const number = calls[kind].length + 1;
      calls[kind].push(params?.cursor);
      return makePage(number);
    };
    const native = new Native();
    native._listMaxPages = 64;
    native._cache = { captureGeneration: () => 0, write: async () => {} };
    native._freshness = () => ({});
    native.request = async request => page('native', request.params);
    const replica = Object.create(StdioConnection.prototype);
    replica.serverCapabilities = { resources: {} };
    replica.request = async (_method, params) => page('replica', params);
    const nativeResult = await native._listAllPages('resources/list', undefined, undefined, (a, b) => a.resources.push(...b.resources))
      .then(r => ({ resources: Array.from(r.resources) }), e => ({ error: e.code }));
    const replicaResult = await replica.listResources()
      .then(resources => ({ resources }), e => ({ error: e.code }));
    assert.deepEqual(replicaResult, nativeResult);
    assert.deepEqual(calls.replica, calls.native);
    return { result: replicaResult, calls: calls.replica.length };
  }
  const repeated = await compare(n => ({ resources: [n], nextCursor: n === 1 ? '' : '' }));
  assert.deepEqual(repeated, { result: { resources: [1, 2] }, calls: 2 });
  const exact = await compare(n => ({ resources: [n], ...(n < 64 && { nextCursor: String(n) }) }));
  assert.equal(exact.calls, 64); assert.equal(exact.result.resources.length, 64);
  const exceeded = await compare(n => ({ resources: [n], nextCursor: String(n) }));
  assert.deepEqual(exceeded, { result: { error: 'pagination-exceeded' }, calls: 64 });
});
