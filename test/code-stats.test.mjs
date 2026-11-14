// getCodeStats must satisfy the zod schema the caller validates against.
//
// The call site throws on a null answer and again on a shape mismatch:
//
//   let e = await t();
//   if (!e) throw Error("getCodeStats returned null");
//   let n = codeStatsSchema.safeParse(e);
//   if (!n.success) throw Error("getCodeStats returned an unexpected payload shape");
//
// so any missing field surfaces as a QueryClient error on every mount. The schema
// is `qo` in c06cf64bb-C0tIfxkK.js; these assertions mirror its required keys and
// their types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
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

test('getCodeStats answers every field the schema requires', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });

  const stats = await call('LocalSessions', 'getCodeStats');
  assert.equal(typeof stats, 'object');
  assert.ok(stats !== null, 'a null answer is thrown on');

  for (const key of [
    'totalSessions', 'totalMessages', 'activeDays',
    'firstSessionDate', 'lastSessionDate', 'peakActivityHour',
    'streaks', 'dailyActivity', 'dailyModelTokens', 'modelUsage',
  ]) {
    assert.ok(key in stats, `missing ${key}`);
  }
});

test('getCodeStats numeric fields are numbers, not strings', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  const stats = await call('LocalSessions', 'getCodeStats');
  for (const key of ['totalSessions', 'totalMessages', 'activeDays']) {
    assert.equal(typeof stats[key], 'number', key);
  }
});

test('getCodeStats nullable fields are null or an ISO string', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  const stats = await call('LocalSessions', 'getCodeStats');

  for (const key of ['firstSessionDate', 'lastSessionDate']) {
    const v = stats[key];
    assert.ok(v === null || typeof v === 'string', `${key} must be string|null`);
    if (typeof v === 'string') assert.ok(!Number.isNaN(Date.parse(v)), `${key} must parse`);
  }
  assert.ok(stats.peakActivityHour === null || typeof stats.peakActivityHour === 'number');
});

test('getCodeStats streaks carries both counters', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  const { streaks } = await call('LocalSessions', 'getCodeStats');
  assert.equal(typeof streaks.currentStreak, 'number');
  assert.equal(typeof streaks.longestStreak, 'number');
});

test('getCodeStats dailyActivity rows carry the four schema fields', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  const { dailyActivity } = await call('LocalSessions', 'getCodeStats');
  assert.ok(Array.isArray(dailyActivity));
  for (const row of dailyActivity) {
    assert.equal(typeof row.date, 'string');
    assert.equal(typeof row.messageCount, 'number');
    assert.equal(typeof row.sessionCount, 'number');
    assert.equal(typeof row.toolCallCount, 'number');
  }
});

test('getCodeStats modelUsage rows carry all four token counters', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.getTranscript(s.sessionId).push(
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] }, uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'u2' },
  );

  const { modelUsage } = await call('LocalSessions', 'getCodeStats');
  const rows = Object.values(modelUsage);
  assert.ok(rows.length > 0, 'a session must contribute a model row');
  for (const row of rows) {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
      assert.equal(typeof row[key], 'number', key);
    }
  }
});

test('getCodeStats counts the sessions that actually exist', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  kernel.start({ cwd: 'C:\\work' });
  const stats = await call('LocalSessions', 'getCodeStats');
  assert.equal(stats.totalSessions, 2);
});

test('getCodeStats is valid with no sessions at all', async () => {
  // A fresh profile must not produce a shape the schema rejects.
  const { call } = makeBridge();
  const stats = await call('LocalSessions', 'getCodeStats');
  assert.equal(stats.totalSessions, 0);
  assert.equal(stats.totalMessages, 0);
  assert.ok(Array.isArray(stats.dailyActivity));
  assert.equal(stats.firstSessionDate, null);
  assert.equal(stats.peakActivityHour, null);
});
