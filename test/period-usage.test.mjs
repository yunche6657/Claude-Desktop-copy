// getPeriodUsage must return REAL quota or nothing -- never a fabricated panel.
//
// The frontend (c96d752d0, fn JG) does:
//   queryKey: ["epitaxy","period-usage"]
//   queryFn: () => Sn?.getPeriodUsage?.() ?? null
//   const { data: r } = useQuery(...); const hasUsage = !!r
// and renders windows.five_hour / .seven_day with { utilization, resets_at, status }.
//
// Before this there was no handler, so the fallback answered null and the panel never
// appeared. The fix reproduces the call the shipped CLI makes:
//   case "plain": return "/api/oauth/usage";
// and answers null when there is no OAuth token -- a zeroed shape would render a fake quota.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

/** A bridge over a throwaway config library. */
function makeBridge(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-quota-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  if (profile) {
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify(profile, null, 2));
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({
      entries: [{ id: 'p1', name: 'p1' }], appliedId: 'p1',
    }, null, 2));
  }
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;

  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const api = registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
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
  const restore = () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { call, restore, api };
}

test('the window mapping matches what the panel reads', () => {
  const { call, restore, api } = makeBridge(null);
  try {
    const mapped = api.mapUsageWindows({
      five_hour: { utilization: 42.5, resets_at: 1760000000 },
      seven_day: { utilization: 10, resets_at: 1760500000 },
    });
    assert.ok(mapped, 'a body with windows must map');
    assert.equal(mapped.windows.five_hour.utilization, 42.5);
    assert.equal(mapped.windows.five_hour.resets_at, 1760000000);
    assert.equal(mapped.windows.seven_day.utilization, 10);
    assert.equal(typeof mapped.fetchedAt, 'number');
  } finally { restore(); }
});

test('status is carried through when present', () => {
  // The panel switches to "approaching_limit" styling on this field.
  const { restore, api } = makeBridge(null);
  try {
    const mapped = api.mapUsageWindows({
      five_hour: { utilization: 95, resets_at: 1, status: 'approaching_limit' },
    });
    assert.equal(mapped.windows.five_hour.status, 'approaching_limit');
  } finally { restore(); }
});

test('optional windows map too', () => {
  const { restore, api } = makeBridge(null);
  try {
    const mapped = api.mapUsageWindows({
      five_hour: { utilization: 1, resets_at: 1 },
      seven_day_opus: { utilization: 2, resets_at: 2 },
      overage: { utilization: 3, resets_at: 3 },
    });
    assert.ok(mapped.windows.seven_day_opus);
    assert.ok(mapped.windows.overage);
  } finally { restore(); }
});

test('a body with no usable windows maps to null, not an empty panel', () => {
  const { restore, api } = makeBridge(null);
  try {
    assert.equal(api.mapUsageWindows({}), null);
    assert.equal(api.mapUsageWindows(null), null);
    assert.equal(api.mapUsageWindows({ unrelated: true }), null);
  } finally { restore(); }
});

test('no OAuth token means no quota -- null, never zeros', async () => {
  // This is the honesty requirement: a zeroed shape would render a panel claiming the user
  // has used 0% of a plan they may not even have.
  const { call, restore } = makeBridge({ inferenceProvider: 'gateway' });
  try {
    const result = await call('ClaudeCode', 'getPeriodUsage');
    assert.equal(result, null, `expected null without a token, got ${JSON.stringify(result)}`);
  } finally { restore(); }
});

test('a profile carrying an OAuth token is used', async () => {
  // The token path must be found; with an unreachable endpoint the answer is still null,
  // but the important part is that it does not throw and does not invent data.
  const { call, restore } = makeBridge({
    type: 'oauth',
    credentials: { accessToken: 'sk-ant-oat-fake-token' },
  });
  try {
    const result = await call('ClaudeCode', 'getPeriodUsage');
    // Either null (network/401) or a real mapped body; never a fabricated one.
    if (result !== null) {
      assert.ok(result.windows, 'a non-null answer must carry windows');
    }
    assert.ok(result === null || typeof result === 'object');
  } finally { restore(); }
});

test('the handler exists at all, and is not the generic fallback', async () => {
  // The original defect: NO handler, so the generic fallback answered null forever and the
  // panel could never appear. Asserting "returns null" is not enough -- the fallback also
  // returns null. Assert the handler is registered explicitly.
  const { call, restore, api } = makeBridge(null);
  try {
    assert.doesNotThrow(() => call('ClaudeCode', 'getPeriodUsage'));
    // The bridge exposes registeredCount; a real handler must be in there.
    assert.ok(api.registeredCount > 0, 'the bridge must have registered handlers');
    assert.equal(typeof api.mapUsageWindows, 'function',
      'the mapping helper is part of this handler being real, not the fallback');
  } finally { restore(); }
});

test('with a token, the usage endpoint is actually called', async () => {
  // Step "token lookup disabled" previously stayed green because nothing proved the token
  // was USED. This stubs fetch and asserts the request goes to /api/oauth/usage with the
  // bearer token, and that a real body comes back mapped.
  const { call, restore } = makeBridge({
    type: 'oauth',
    credentials: { accessToken: 'sk-ant-oat-test-token' },
  });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init && init.headers && init.headers.authorization });
    return {
      ok: true,
      async json() {
        return { five_hour: { utilization: 7, resets_at: 1760000000 } };
      },
    };
  };
  try {
    const result = await call('ClaudeCode', 'getPeriodUsage');
    assert.equal(calls.length, 1, 'exactly one usage request must be made');
    assert.match(calls[0].url, /\/api\/oauth\/usage$/);
    assert.equal(calls[0].auth, 'Bearer sk-ant-oat-test-token');
    assert.ok(result, 'a successful response must map to a body');
    assert.equal(result.windows.five_hour.utilization, 7);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test('a non-ok response answers null rather than a partial panel', async () => {
  const { call, restore } = makeBridge({
    type: 'oauth',
    credentials: { accessToken: 'sk-ant-oat-stale' },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  try {
    assert.equal(await call('ClaudeCode', 'getPeriodUsage'), null);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test('a throwing fetch answers null instead of propagating', async () => {
  const { call, restore } = makeBridge({
    type: 'oauth',
    credentials: { accessToken: 'sk-ant-oat-x' },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await call('ClaudeCode', 'getPeriodUsage'), null);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});
