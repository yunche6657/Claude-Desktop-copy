import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { McpHost } = require('../desktop/mcp-host.cjs');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const response = (id, result, session) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
  headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
});
const setup = fetchImpl => {
  const host = new McpHost({ fetchImpl });
  host.load({ mcpServers: { fixture: { type: 'http', url: 'http://fixture.invalid/mcp' } } });
  return host;
};

test('disconnect invalidates delayed initialization and deletes a late HTTP session', async t => {
  const pending = deferred();
  const calls = [];
  const host = setup(async (_url, options) => {
    calls.push(options);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return pending.promise;
  });
  t.after(() => host.stopAll());
  const first = host.connect('fixture');
  const second = host.connect('fixture');
  const rejected = Promise.allSettled([first, second]);
  assert.equal(calls.length, 1);
  await host.disconnect('fixture');
  pending.resolve(response(1, { capabilities: {} }, 'late-session'));
  const results = await rejected;
  assert.deepEqual(results.map(x => x.status), ['rejected', 'rejected']);
  assert.equal(host.list()[0].status, 'disconnected');
  assert.equal(calls.filter(x => x.method === 'DELETE').length, 1);
  assert.equal(calls.find(x => x.method === 'DELETE').headers['mcp-session-id'], 'late-session');
});

test('a stale tools failure cannot overwrite a replacement connection', async t => {
  const pending = deferred();
  const started = deferred();
  let initializations = 0;
  const host = setup(async (_url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') {
      initializations++;
      return response(request.id, { capabilities: {} }, `session-${initializations}`);
    }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (options.headers['mcp-session-id'] === 'session-1') {
      started.resolve();
      return pending.promise;
    }
    return response(request.id, { tools: [{ name: 'new-tool' }] });
  });
  t.after(() => host.stopAll());
  const old = host.connect('fixture');
  const oldResult = Promise.allSettled([old]);
  await started.promise;
  await host.disconnect('fixture');
  await host.connect('fixture');
  const replacement = host.servers.get('fixture').connection;
  pending.reject(new Error('old failure'));
  assert.equal((await oldResult)[0].status, 'rejected');
  assert.equal(host.servers.get('fixture').connection, replacement);
  assert.equal(host.list()[0].status, 'connected');
  assert.equal(host.list()[0].toolCount, 1);
  assert.equal(host.list()[0].error, null);
});
