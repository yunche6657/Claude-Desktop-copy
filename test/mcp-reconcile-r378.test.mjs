import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const { McpHost } = createRequire(import.meta.url)('../desktop/mcp-host.cjs');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const reply = (id, result, session) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
  headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
});

test('equal normalized config preserves a connected server; changes and removal retire it', async () => {
  const deletes = [];
  const host = new McpHost({ fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') { deletes.push(options.headers['mcp-session-id']); return new Response(null, { status: 204 }); }
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') return reply(request.id, { capabilities: {} }, 'first');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return reply(request.id, { tools: [{ name: 'one' }] });
  } });
  const config = headers => ({ mcpServers: { one: { type: 'http', url: 'http://fixture.invalid', headers } } });
  host.load(config({ a: '1', b: '2' }));
  await host.connect('one');
  const connection = host.servers.get('one').connection;
  host.load(config({ b: '2', a: '1' }));
  assert.equal(host.servers.get('one').connection, connection);
  assert.equal(host.list()[0].toolCount, 1);
  assert.deepEqual(deletes, []);
  host.load(config({ a: 'changed' }));
  assert.equal(host.list()[0].status, 'disconnected');
  assert.deepEqual(deletes, ['first']);
  host.load({ mcpServers: {} });
  assert.deepEqual(host.list(), []);
  await host.stopAll();
});

test('removing a connected stdio server terminates its child', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
  const host = new McpHost();
  host.load({ mcpServers: { one: { command: process.execPath, args: [fixture, '--mode', 'ok'] } } });
  await host.connect('one');
  const child = host.servers.get('one').connection.child;
  const exited = once(child, 'close');
  host.load({ mcpServers: {} });
  await exited;
  assert.deepEqual(host.list(), []);
  await host.stopAll();
});

test('reload invalidates an initializing server and stopAll waits for its late session cleanup', async () => {
  const pending = deferred();
  const deleting = deferred();
  const deleteStarted = deferred();
  const host = new McpHost({ fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') { deleteStarted.resolve(options.headers['mcp-session-id']); return deleting.promise; }
    return pending.promise;
  } });
  const config = { mcpServers: { one: { type: 'http', url: 'http://old.invalid' } } };
  host.load(config);
  const old = host.connect('one');
  const oldResult = Promise.allSettled([old]);
  host.load(config);
  assert.equal(host.list()[0].status, 'connecting');
  host.load({ mcpServers: { one: { type: 'http', url: 'http://new.invalid' } } });
  assert.equal(host.list()[0].status, 'disconnected');
  let finished = false;
  const shutdown = host.stopAll().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  pending.resolve(reply(1, { capabilities: {} }, 'late'));
  assert.equal(await deleteStarted.promise, 'late');
  assert.equal(finished, false);
  deleting.resolve(new Response(null, { status: 204 }));
  await shutdown;
  assert.equal((await oldResult)[0].status, 'rejected');
  assert.equal(finished, true);
});

test('late old initialization cannot disturb the replacement connection', async () => {
  const pending = deferred();
  const host = new McpHost({ fetchImpl: async (url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (url.includes('old.invalid')) return pending.promise;
    if (request.method === 'initialize') return reply(request.id, { capabilities: {} }, 'new');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return reply(request.id, { tools: [{ name: 'replacement' }] });
  } });
  host.load({ mcpServers: { one: { type: 'http', url: 'http://old.invalid' } } });
  const oldResult = Promise.allSettled([host.connect('one')]);
  host.load({ mcpServers: { one: { type: 'http', url: 'http://new.invalid' } } });
  await host.connect('one');
  const replacement = host.servers.get('one').connection;
  pending.resolve(reply(1, { capabilities: {} }, 'old'));
  assert.equal((await oldResult)[0].status, 'rejected');
  assert.equal(host.servers.get('one').connection, replacement);
  assert.equal(host.list()[0].toolCount, 1);
  assert.equal(host.list()[0].status, 'connected');
  await host.stopAll();
});

test('invalid snapshots preserve state and retirement handles synchronous or asynchronous stop errors', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { one: { command: 'node' }, two: { command: 'node' } } });
  host.servers.get('one').connection = { stop() { throw new Error('sync'); } };
  host.servers.get('two').connection = { stop() { return Promise.reject(new Error('async')); } };
  assert.throws(() => host.load({ mcpServers: [] }), /mcpServers must be an object/);
  assert.equal(host.list().length, 2);
  const result = host.load({ mcpServers: { one: { type: 'sse', url: 'http://fixture.invalid' }, two: null } });
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(host.list().map(x => x.status), ['disconnected', 'invalid']);
  await host.stopAll();
});
