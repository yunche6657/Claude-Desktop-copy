import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { McpHost } = createRequire(import.meta.url)('../desktop/mcp-host.cjs');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('stopAll waits for disconnected initialization and its late session DELETE', async () => {
  const initialize = deferred();
  const deleteStarted = deferred();
  const deletion = deferred();
  const deletes = [];
  const host = new McpHost({ fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') {
      deletes.push(options.headers['mcp-session-id']);
      deleteStarted.resolve();
      return deletion.promise;
    }
    return initialize.promise;
  } });
  host.load({ mcpServers: { fixture: { type: 'http', url: 'http://fixture.invalid' } } });
  const oldResult = Promise.allSettled([host.connect('fixture')]);
  assert.equal((await host.disconnect('fixture')).status, 'disconnected');
  assert.equal((await host.disconnect('fixture')).status, 'disconnected');
  let finished = false;
  const shutdown = host.stopAll().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  initialize.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'late-session' },
  }));
  await deleteStarted.promise;
  assert.deepEqual(deletes, ['late-session']);
  assert.equal(finished, false);
  deletion.resolve(new Response(null, { status: 204 }));
  await shutdown;
  assert.equal(finished, true);
  assert.equal((await oldResult)[0].status, 'rejected');
});

test('disconnect reports stop errors while shutdown drains their retirement records', async () => {
  const host = new McpHost();
  host.load({ mcpServers: { sync: { command: 'node' }, async: { command: 'node' } } });
  host.servers.get('sync').connection = { stop() { throw new Error('sync stop'); } };
  host.servers.get('async').connection = { stop() { return Promise.reject(new Error('async stop')); } };
  await assert.rejects(host.disconnect('sync'), /sync stop/);
  await assert.rejects(host.disconnect('async'), /async stop/);
  await host.stopAll();
  assert.equal(host.pendingTeardowns.size, 0);
});
