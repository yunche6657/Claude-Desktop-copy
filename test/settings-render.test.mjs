// Settings must render.
//
// Three independent defects made every Settings page unusable:
//
//  1. /api/account_profile answered `conversation_preferences: {}`. The pane puts it
//     in a textarea and computes text direction with `for (const ch of value)`, so an
//     object threw `TypeError: e is not iterable` and the error boundary took the
//     whole route.
//  2. Custom3pUsage.getSummary was unhandled, so Settings > Usage rendered
//     "Couldn't load usage".
//  3. LocalAgentModeSessions.getSupportedCommands answered a status object, and the
//     caller runs `.filter` on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApiInterceptors } = require('../desktop/api-interceptors.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

const bootstrapFixture = {
  account: {
    uuid: 'e9b02a25-14e9-408e-a04f-cbd274ae2f26',
    email_address: 'cowork-3p@localhost',
    memberships: [],
    settings: { paprika_mode: 'auto' },
  },
};

const profile = () => createApiInterceptors({ bootstrap: () => bootstrapFixture })(
  new Request('app://localhost/api/account_profile'), '/api/account_profile');

test('conversation_preferences is a string, never an object', async () => {
  // An object here throws while the textarea renders and kills the whole route.
  const body = await (await profile()).json();
  assert.equal(typeof body.conversation_preferences, 'string');
  assert.doesNotThrow(() => { for (const _ch of body.conversation_preferences) break; });
});

test('conversation_preferences is empty when the account has none', async () => {
  const body = await (await profile()).json();
  assert.equal(body.conversation_preferences, '');
});

test('a string conversation_preferences is passed through', async () => {
  const intercept = createApiInterceptors({
    bootstrap: () => ({
      account: { ...bootstrapFixture.account, settings: { conversation_preferences: 'be terse' } },
    }),
  });
  const body = await (await intercept(
    new Request('app://localhost/api/account_profile'), '/api/account_profile')).json();
  assert.equal(body.conversation_preferences, 'be terse');
});

test('the size cap is null when unbounded', async () => {
  const body = await (await profile()).json();
  assert.ok('conversation_preferences_cloud_max_chars' in body);
  assert.equal(body.conversation_preferences_cloud_max_chars, null);
});

test('notification preferences answer a well-formed record, not 503', async () => {
  // Without this the Notifications pane reported a query error on every mount.
  const intercept = createApiInterceptors({ bootstrap: () => bootstrapFixture });
  const res = intercept(
    new Request('app://localhost/api/organizations/00000000-0000-4000-8000-000000000001/notification/preferences'),
    '/api/organizations/00000000-0000-4000-8000-000000000001/notification/preferences');
  assert.ok(res, 'must be intercepted rather than forwarded');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(typeof body.effective_preferences, 'object');
  assert.equal(typeof body.push_reachability, 'object');
  assert.equal(body.push_reachability.has_active_channel, false, 'this build sends no push');
  assert.ok(Array.isArray(body.push_reachability.platforms));
  assert.equal(typeof body.admin_spend_alerts_available, 'boolean');
});

test('any organization id matches, not just one', async () => {
  const intercept = createApiInterceptors({ bootstrap: () => bootstrapFixture });
  for (const id of ['00000000-0000-4000-8000-000000000001', 'abcdef01-2345-4678-89ab-cdef01234567']) {
    const path = `/api/organizations/${id}/notification/preferences`;
    assert.ok(intercept(new Request(`app://localhost${path}`), path), id);
  }
});

test('other organization paths are still forwarded', async () => {
  const intercept = createApiInterceptors({ bootstrap: () => bootstrapFixture });
  const path = '/api/organizations/x/usage';
  assert.equal(intercept(new Request(`app://localhost${path}`), path), null);
});

// ---- bridge-side settings surfaces -----------------------------------------

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

test('getSupportedCommands answers an array in both namespaces', async () => {
  // The caller runs `.filter` on it; a status object throws.
  const { call } = makeBridge();
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const answer = await call(service, 'getSupportedCommands', {});
    assert.ok(Array.isArray(answer), `${service}.getSupportedCommands must be an array`);
    assert.doesNotThrow(() => answer.filter(() => true));
  }
});

test('Custom3pUsage.getSummary answers the shape the page reads', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.getTranscript(s.sessionId).push(
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] }, uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'u2' },
  );

  const summary = await call('Custom3pUsage', 'getSummary', 30);
  assert.ok(summary, 'a null answer makes the page say "Couldn\'t load usage"');
  assert.equal(typeof summary.windowHours, 'number');
  assert.equal(summary.windowHours, 720, '30 days in hours');

  for (const surface of ['chat', 'cowork', 'code']) {
    const totals = summary.surfaces[surface];
    assert.ok(totals, `missing surfaces.${surface}`);
    assert.equal(typeof totals.inputTokens, 'number');
    assert.equal(typeof totals.outputTokens, 'number');
    assert.equal(typeof totals.webSearchRequests, 'number');
  }
  assert.ok(Array.isArray(summary.bars));
});

test('getSummary counts this build\'s real tokens under Code', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.getTranscript(s.sessionId).push(
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'abcdefgh' }] }, uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'abcd' }] }, uuid: 'u2' },
  );

  const { surfaces } = await call('Custom3pUsage', 'getSummary', 30);
  assert.ok(surfaces.code.inputTokens > 0, 'the user turn counts as input');
  assert.ok(surfaces.code.outputTokens > 0, 'the assistant turn counts as output');
  // Chat and Cowork are not implemented surfaces; they must not claim activity.
  assert.equal(surfaces.chat.inputTokens, 0);
  assert.equal(surfaces.cowork.inputTokens, 0);
});

test('getSummary with no sessions still answers a valid, empty summary', async () => {
  const { call } = makeBridge();
  const summary = await call('Custom3pUsage', 'getSummary', 7);
  assert.equal(summary.windowHours, 168);
  assert.deepEqual(summary.bars, []);
  assert.equal(summary.surfaces.code.inputTokens, 0);
});

test('getSummary bar rows carry start and all three surfaces', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.getTranscript(s.sessionId).push(
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }] }, uuid: 'u1' },
  );

  const { bars } = await call('Custom3pUsage', 'getSummary', 30);
  assert.ok(bars.length >= 1);
  const row = bars[0];
  assert.match(row.start, /^\d{4}-\d{2}-\d{2}$/, 'start is a date the chart parses');
  for (const surface of ['chat', 'cowork', 'code']) assert.ok(row[surface], `missing ${surface}`);
});
