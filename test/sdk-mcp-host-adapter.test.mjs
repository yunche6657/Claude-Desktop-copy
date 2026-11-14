import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSdkMcpHostAdapter } = require('../desktop/sdk-mcp-host-adapter.cjs');
const { createCliMcpDiscoveryProvider, SOURCE_KEYS } = require('../desktop/cli-mcp-discovery-provider.cjs');

test('binding, metadata, declarations and invalidation are enforced across endpoints', async () => {
  let invalidate, notify, allow = true, release;
  const sources = Object.fromEntries(SOURCE_KEYS.map(key => {
    const value = { complete: true, names: [], isReserved: () => false, featureEnabled: true, sessionAllowed: true,
      cliRunsAsThisUser: false, tenancy: { accountId: null, orgId: null } };
    return [key, { read: () => value, isCurrent: x => x === value, subscribe: f => { if (key === 'gate') invalidate = f; return () => {}; } }];
  }));
  const host = createSdkMcpHostAdapter({ session: 's', actor: 'a', discovery: createCliMcpDiscoveryProvider(sources),
    isCurrent: () => true, authorize: async () => allow, createEndpoint: options => {
      notify = options.notifyClient;
      return { ccb: async m => ({ id: m.id, result: { tools: [{ name: 'view', _meta: { ui: { resourceUri: 'ui://alpha/page', csp: { resourceDomains: ['example.test'] } } } }] } }),
        read: async uri => { if (release) await new Promise(r => { release.resolve = r; }); return { result: { contents: [{ uri, text: 'ok' }] } }; }, close() {} };
    } });
  try {
    host.attach('alpha', 'local');
    await host.refresh();
    await host.ccb('alpha', { id: 1, method: 'tools/list' });
    assert.equal(host.apps()[0].tools[0]._meta.ui.csp, undefined);
    assert.equal((await host.read({ session: 's', actor: 'a' }, 'alpha', 'ui://alpha/page')).contents[0].text, 'ok');
    await assert.rejects(host.read({ session: 's', actor: 'wrong' }, 'alpha', 'ui://alpha/page'), /binding mismatch/);
    await assert.rejects(host.read({ session: 's', actor: 'a' }, 'alpha', 'ui://other/page'), /not declared/);
    allow = false;
    await assert.rejects(host.read({ session: 's', actor: 'a' }, 'alpha', 'ui://alpha/page'), /denied/);
    allow = true; release = {};
    const pending = host.read({ session: 's', actor: 'a' }, 'alpha', 'ui://alpha/page');
    while (!release.resolve) await new Promise(r => setImmediate(r));
    notify({ method: 'notifications/tools/list_changed' });
    release.resolve();
    await assert.rejects(pending, /declaration changed/);
    assert.deepEqual(host.apps(), []);
    await host.ccb('alpha', { id: 2, method: 'tools/list' });
    invalidate();
    assert.throws(() => host.apps(), /stale/);
    await host.refresh();
    assert.deepEqual(host.apps(), []);
  } finally { host.close(); }
});
