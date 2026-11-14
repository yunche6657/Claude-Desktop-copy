import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createCliMcpDiscoveryProvider, SOURCE_KEYS } = createRequire(import.meta.url)('../desktop/cli-mcp-discovery-provider.cjs');
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

function sourceFixture() {
  const listeners = new Map();
  const versions = Object.fromEntries(SOURCE_KEYS.map(key => [key, 1]));
  const sources = Object.fromEntries(SOURCE_KEYS.map(key => [key, {
    async read() { return { complete: true, version: versions[key], names: key === 'plugins' ? ['plugin:Taken-App'] : [],
      ...(key === 'reserved' ? { isReserved: name => name.startsWith('internal-') } : {}),
      ...(key === 'gate' ? { featureEnabled: true } : {}),
      ...(key === 'scope' ? { tenancy: { accountId: 'a', orgId: 'o' }, sessionAllowed: true, cliRunsAsThisUser: false } : {}) }; },
    isCurrent(value) { return value.version === versions[key]; },
    subscribe(fn) { listeners.set(key, fn); return () => listeners.delete(key); },
  }]));
  return { sources, change(key) { versions[key]++; listeners.get(key)?.(); }, listeners };
}

test('missing source or subscription never fabricates complete discovery', async () => {
  const provider = createCliMcpDiscoveryProvider();
  assert.equal((await provider.getSnapshot({ sessionId: 's' })).complete, false);
  const stop = provider.subscribe(() => {});
  assert.equal((await provider.getSnapshot({ sessionId: 's' })).complete, false);
  stop();
});

test('complete subscribed sources produce checked conflicts and invalidate on change', async () => {
  const fixture = sourceFixture(), provider = createCliMcpDiscoveryProvider(fixture.sources);
  let changed = 0;
  const stop = provider.subscribe(() => { changed++; });
  const snapshot = await provider.getSnapshot({ sessionId: 's', actorToken: 'a' });
  assert.equal(snapshot.complete, true);
  assert.equal(provider.isCurrent(snapshot), true);
  assert.equal(snapshot.conflicts('taken_app'), true);
  assert.equal(snapshot.conflicts('internal-tool'), true);
  assert.equal(snapshot.conflicts('free'), false);
  fixture.change('plugins');
  assert.equal(changed, 1);
  assert.equal(provider.isCurrent(snapshot), false);
  assert.throws(() => snapshot.conflicts('free'), /stale/);
  stop();
  assert.equal(fixture.listeners.size, 0);
});

test('each discovery source invalidates its own provider and leaves an independent provider current', async () => {
  const a = sourceFixture(), b = sourceFixture();
  const first = createCliMcpDiscoveryProvider(a.sources), second = createCliMcpDiscoveryProvider(b.sources);
  let notices = 0;
  const stopFirst = first.subscribe(() => { notices++; });
  const stopSecond = second.subscribe(() => {});
  for (const key of SOURCE_KEYS) {
    const old = await first.getSnapshot({ sessionId: 'one', actorToken: 'actor-one' });
    const other = await second.getSnapshot({ sessionId: 'two', actorToken: 'actor-two' });
    assert.equal(old.complete, true, key);
    a.change(key);
    assert.equal(first.isCurrent(old), false, key);
    assert.throws(() => old.conflicts('free'), /stale/, key);
    assert.equal(second.isCurrent(other), true, key);
    assert.equal(other.conflicts('free'), false, key);
    assert.equal((await first.getSnapshot({ sessionId: 'one', actorToken: 'actor-one' })).complete, true, key);
  }
  assert.equal(notices, SOURCE_KEYS.length);
  stopFirst(); stopSecond();
});

test('changed or malformed source during acquisition fails closed', async () => {
  const fixture = sourceFixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const original = fixture.sources.plugins.read;
  fixture.sources.plugins.read = async (...args) => { const value = await original(...args); await pending; return value; };
  const provider = createCliMcpDiscoveryProvider(fixture.sources);
  const stop = provider.subscribe(() => {});
  const inflight = provider.getSnapshot({ sessionId: 's' });
  fixture.change('plugins');
  release();
  assert.equal((await inflight).complete, false);
  fixture.sources.scope.read = async () => ({ complete: true, version: 1, tenancy: { accountId: null } });
  assert.equal((await provider.getSnapshot({ sessionId: 's' })).complete, false);
  stop();
});

test('provider and session kernel publish only while all trusted fixture sources are current', async () => {
  const fixture = sourceFixture(), provider = createCliMcpDiscoveryProvider(fixture.sources), events = [];
  const backend = { id: 'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {}, onEvent() { return () => {}; },
    getInfo() { return { actorToken: 'actor' }; }, async mcpServerStatus() { return { actorToken: 'actor', servers: [
      { name: 'free', source: 'local', tools: [{ name: 'show', _meta: { 'ui/resourceUri': 'ui://free' } }] },
      { name: 'taken_app', source: 'local', tools: [{ name: 'show', _meta: { 'ui/resourceUri': 'ui://taken' } }] },
    ] }; } };
  const kernel = createSessionKernel({ backend, cliMcpDiscovery: provider, emit: event => events.push(event) });
  kernel.start({ sessionId: 's' });
  assert.equal(await kernel.refreshCliMcpStatus('s'), true);
  assert.deepEqual(kernel.getCliMcpApps('s').map(app => app.name), ['free']);
  fixture.change('gate');
  assert.equal(kernel.getCliMcpApps('s'), null);
  assert.deepEqual(events.filter(event => event.type === 'session_cli_mcp_servers').at(-1).sessionCliMcpServers, []);
  kernel.dispose();
});
