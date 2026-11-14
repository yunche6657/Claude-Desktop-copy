import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

test('only registered CLI app names are announced and identical polls do not emit again', async () => {
  let actor = 'a', version = 1, failPoll = false;
  const events = [];
  const coverage = Object.fromEntries(['coordinator','config','reserved','identities','session','tenantHistory','plugins'].map(key => [key, true]));
  const server = name => ({ name, source: 'local', tools: [{ name: 'v', _meta: { 'ui/resourceUri': 'ui://x' } }] });
  const rows = [server('existing-0'), server('admitted'), server('rejected')];
  const backend = { id:'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {}, onEvent() { return () => {}; },
    getInfo() { return { actorToken: actor }; }, async mcpServerStatus(_id, token) { if (failPoll) throw new Error('poll failure'); return { actorToken: token, servers: rows }; } };
  const provider = { subscribe() { return () => {}; }, isCurrent(s) { return s.version === version; },
    async getSnapshot() { return { version, complete:true, coverage, featureEnabled:true, sessionAllowed:true,
      tenancy:{accountId:null,orgId:null}, cliRunsAsThisUser:false, conflicts:() => false }; } };
  const kernel = createSessionKernel({ backend, emit: e => events.push(e), cliMcpDiscovery:provider });
  kernel.start({ sessionId:'s' });
  kernel.update('s', { cliMcpAppServerNames: [...Array.from({length:63}, (_, i) => `existing-${i}`), 'x'.repeat(257)] });
  await kernel.refreshCliMcpStatus('s');
  assert.deepEqual(kernel.getCliMcpApps('s').map(app => app.name), ['existing-0', 'admitted']);
  assert.equal(kernel.getSession('s').cliMcpAppServerNames.length, 64);
  assert.equal(kernel.getSession('s').cliMcpAppServerNames.includes('rejected'), false);
  assert.equal(events.filter(e => e.type === 'session_cli_mcp_servers').length, 1);
  await kernel.refreshCliMcpStatus('s');
  assert.equal(events.filter(e => e.type === 'session_cli_mcp_servers').length, 1);
  failPoll = true;
  assert.equal(await kernel.refreshCliMcpStatus('s'), false);
  assert.equal(kernel.getCliMcpApps('s').length, 2);
  assert.equal(events.filter(e => e.type === 'session_cli_mcp_servers').length, 1);
  version++;
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.deepEqual(events.filter(e => e.type === 'session_cli_mcp_servers').at(-1).sessionCliMcpServers, []);
  failPoll = false;
  await kernel.refreshCliMcpStatus('s');
  actor = 'b';
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.deepEqual(events.filter(e => e.type === 'session_cli_mcp_servers').at(-1).sessionCliMcpServers, []);
  await kernel.refreshCliMcpStatus('s');
  kernel.dispose();
  assert.deepEqual(events.filter(e => e.type === 'session_cli_mcp_servers').at(-1).sessionCliMcpServers, []);
});
