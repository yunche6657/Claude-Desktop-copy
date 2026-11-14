import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

test('discovery requires a current complete trusted snapshot and revokes it on source change', async () => {
  let version = 1, listener;
  const events = [];
  const actor = 'actor';
  const status = [{ name: 'cli-app', source: 'project', status: 'connected', tools: [{ name: 'view', _meta: { ui: { resourceUri: 'ui://page', csp: { domains: ['x'] }, extra: 'hidden' }, hidden: true } }] },
    { name: 'reserved', source: 'project', tools: [{ name: 'view', _meta: { 'ui/resourceUri': 'ui://reserved' } }] }];
  const backend = { id: 'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {}, onEvent() { return () => {}; },
    getInfo() { return { actorToken: actor }; }, async mcpServerStatus() { return { actorToken: actor, servers: status }; } };
  const coverage = { coordinator: true, config: true, reserved: true, identities: true, session: true, tenantHistory: true, plugins: true };
  let complete = false;
  const provider = { subscribe(fn) { listener = fn; return () => {}; },
    async getSnapshot() { return { version, complete, coverage, featureEnabled: true, sessionAllowed: true,
      tenancy: { accountId: 'fixture', orgId: 'org' }, cliRunsAsThisUser: false, conflicts: name => name === 'reserved' }; },
    isCurrent(snapshot) { return snapshot.version === version; } };
  const kernel = createSessionKernel({ backend, emit: e => events.push(e), cliMcpDiscovery: provider });
  kernel.start({ sessionId: 's' });
  assert.equal(await kernel.refreshCliMcpStatus('s'), true);
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.equal(events.some(e => e.type === 'session_cli_mcp_servers'), false);
  complete = true;
  assert.equal(await kernel.refreshCliMcpApps('s'), true);
  const apps = kernel.getCliMcpApps('s');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'cli-app');
  assert.deepEqual(apps[0].tools[0]._meta, { ui: { resourceUri: 'ui://page' } });
  assert.deepEqual(kernel.getSession('s').cliMcpAppServerNames, ['cli-app']);
  complete = false;
  version++;
  listener();
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.deepEqual(events.filter(e => e.type === 'session_cli_mcp_servers').at(-1).sessionCliMcpServers, []);
  await Promise.resolve();
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.deepEqual(kernel.getSession('s').cliMcpAppServerNames, ['cli-app']);
  kernel.dispose();
});

test('stale source snapshot cannot publish after a newer refresh', async () => {
  let resolveOld, calls = 0;
  const waiting = new Promise(resolve => { resolveOld = resolve; });
  const coverage = { coordinator: true, config: true, reserved: true, identities: true, session: true, tenantHistory: true, plugins: true };
  const snapshot = { version: 1, complete: true, coverage, featureEnabled: true, sessionAllowed: true,
    tenancy: { accountId: null, orgId: null }, cliRunsAsThisUser: false, conflicts: () => false };
  const backend = { id: 'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {}, onEvent() { return () => {}; },
    getInfo() { return { actorToken: 'a' }; }, async mcpServerStatus() { return { actorToken: 'a', servers: [{ name: 'app', source: 'local', tools: [{ name: 'v', _meta: { 'ui/resourceUri': 'ui://x' } }] }] }; } };
  const provider = { subscribe() { return () => {}; }, getSnapshot() { calls++; return calls === 1 ? waiting : Promise.resolve(snapshot); }, isCurrent() { return true; } };
  const kernel = createSessionKernel({ backend, emit() {}, cliMcpDiscovery: provider });
  kernel.start({ sessionId: 's' });
  const first = kernel.refreshCliMcpStatus('s');
  await Promise.resolve();
  assert.equal(await kernel.refreshCliMcpApps('s'), true);
  resolveOld(snapshot);
  await first;
  assert.equal(kernel.getCliMcpApps('s').length, 1);
  kernel.dispose();
});
