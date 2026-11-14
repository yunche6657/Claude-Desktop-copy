import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { McpHost } = require('../desktop/mcp-host.cjs');
const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

test('a closed stdio server is disconnected and an old close cannot clear its replacement', async t => {
  const host = new McpHost();
  t.after(() => host.stopAll());
  host.load({ mcpServers: { fixture: { command: process.execPath, args: [fixture, '--mode', 'ok'] } } });
  await host.connect('fixture');
  const first = host.servers.get('fixture').connection;
  const exited = once(first.child, 'close');
  first.child.kill();
  await exited;
  assert.equal(host.list()[0].status, 'disconnected');
  assert.equal(host.list()[0].toolCount, 0);
  await assert.rejects(host.callTool('fixture', 'echo', {}), /is disconnected/);
  await host.connect('fixture');
  const replacement = host.servers.get('fixture').connection;
  first.child.emit('close', 0);
  assert.equal(host.servers.get('fixture').connection, replacement);
  assert.equal(host.list()[0].status, 'connected');
  assert.equal((await host.callTool('fixture', 'echo', { text: 'alive' })).content[0].text, 'alive');
});
