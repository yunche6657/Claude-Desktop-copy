import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture() {
  let actor = 'a', version = 1, listener, fail = false, pendingRead, pendingStatus;
  const listeners = new Set(), events = [], reads = [];
  const coverage = Object.fromEntries(['coordinator','config','reserved','identities','session','tenantHistory','plugins'].map(key => [key, true]));
  const servers = [{ name: 'app', source: 'local', tools: [{ name: 'v', _meta: { 'ui/resourceUri': 'ui://x' } }] }];
  const backend = { id: 'ccb', start() {}, async sendMessage() {}, cancel() {}, dispose() {}, removeSession() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }, getInfo() { return { actorToken: actor }; },
    mcpServerStatus(_id, token) { return pendingStatus ? pendingStatus.promise : Promise.resolve({ actorToken: token, servers }); },
    readMcpResource(_id, token, name, uri) { reads.push({ token, name, uri }); return pendingRead ? pendingRead.promise : Promise.resolve({ actorToken: token, contents: [{ uri, text: 'ok', _meta: { ui: { resourceUri: uri, hidden: 1 }, other: 1 } }] }); } };
  const provider = { subscribe(fn) { listener = fn; return () => {}; },
    async getSnapshot() { if (fail) throw new Error('source failed'); return { version, complete: true, coverage, featureEnabled: true,
      sessionAllowed: true, tenancy: { accountId: 'account', orgId: 'org' }, cliRunsAsThisUser: false, conflicts: () => false }; },
    isCurrent(s) { return s.version === version; } };
  const kernel = createSessionKernel({ backend, emit: e => events.push(e), cliMcpDiscovery: provider });
  kernel.start({ sessionId: 's' });
  return { kernel, events, reads, setActor: a => { actor = a; }, change: () => { version++; listener(); },
    fail: value => { fail = value; }, setRead: value => { pendingRead = value; }, setStatus: value => { pendingStatus = value; },
    fire: (type, token) => { for (const fn of listeners) fn({ type, sessionId: 's', actorToken: token }); } };
}
const lastList = events => events.filter(e => e.type === 'session_cli_mcp_servers').at(-1)?.sessionCliMcpServers;

test('actor close, pause, replacement and removal revoke published app state', async () => {
  for (const mode of ['query_closed', 'actor_paused', 'replace', 'remove']) {
    const f = fixture();
    await f.kernel.refreshCliMcpStatus('s');
    assert.equal(f.kernel.getCliMcpApps('s').length, 1);
    if (mode === 'replace') { f.setActor('b'); f.setStatus(deferred()); f.fire('query_installed', 'b'); }
    else if (mode === 'remove') f.kernel.remove('s');
    else { f.setActor(null); f.fire(mode, null); }
    assert.deepEqual(lastList(f.events), []);
    assert.equal(f.kernel.getCliMcpApps('s'), null);
    f.kernel.dispose();
  }
});

test('same actor repoll and transient source failure retain valid state; invalidation revokes', async () => {
  const f = fixture();
  await f.kernel.refreshCliMcpStatus('s');
  const status = deferred(); f.setStatus(status);
  const poll = f.kernel.refreshCliMcpStatus('s');
  assert.equal(lastList(f.events).length, 1);
  assert.equal(f.kernel.getCliMcpApps('s').length, 1);
  status.resolve({ actorToken: 'a', servers: [{ name: 'app', source: 'local', tools: [{ name: 'v', _meta: { 'ui/resourceUri': 'ui://x' } }] }] });
  assert.equal(await poll, true);
  assert.equal(f.kernel.getCliMcpApps('s').length, 1);
  f.fail(true);
  assert.equal(await f.kernel.refreshCliMcpApps('s'), false);
  assert.equal(lastList(f.events).length, 1);
  f.fail(false);
  await f.kernel.refreshCliMcpApps('s');
  f.fail(true); f.change();
  assert.deepEqual(lastList(f.events), []);
  assert.equal(f.kernel.getCliMcpApps('s'), null);
  f.kernel.dispose();
});

test('resource read requires exact published server and URI and discards stale replies', async () => {
  const f = fixture();
  await f.kernel.refreshCliMcpStatus('s');
  assert.deepEqual(await f.kernel.readCliMcpAppResource('s', 'other', 'ui://x'), { contents: [], unavailable: 'not_connected' });
  assert.deepEqual(await f.kernel.readCliMcpAppResource('s', 'app', 'ui://other'), { contents: [], unavailable: 'read_failed' });
  assert.equal(f.reads.length, 0);
  assert.deepEqual(await f.kernel.readCliMcpAppResource('s', 'app', 'ui://x'), { contents: [{ uri: 'ui://x', text: 'ok', _meta: { ui: { resourceUri: 'ui://x' } } }] });
  const pending = deferred(); f.setRead(pending);
  const reading = f.kernel.readCliMcpAppResource('s', 'app', 'ui://x');
  f.fail(true); f.change();
  pending.resolve({ actorToken: 'a', contents: [{ uri: 'ui://x', text: 'late' }] });
  assert.deepEqual(await reading, { contents: [], unavailable: 'not_connected' });
  assert.equal(f.reads.length, 2);
  f.kernel.dispose();
});
