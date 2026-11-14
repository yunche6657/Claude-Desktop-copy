// The landing page is the first screen a user sees; its numbers must come from real data.
//
// MEASURED on a live window with the real store:
//
//   getCodeStats() -> { totalSessions: 206, totalMessages: 1645, activeDays: 6,
//                       firstSessionDate: '2026-10-20T13:42:44.010Z', peakActivityHour: 21,
//                       streaks: { currentStreak: 5, ... } }
//
// The store on disk held 205 sessions / 1645 rows at that moment, and the live window showed
// 「会话 205」「Token 总数 3.9M」「最常用的模型 Sonnet 5.5」. The numbers agree, which is the
// point: this panel is the most visible place a hand-drawn shell would invent plausible
// figures, and an inflated "3.9M tokens" would be indistinguishable from a real one by eye.
//
// Also pinned here: pressing 「新建」 navigates back to the landing route and does NOT create a
// row. That surprised the first probe — it looked like a dead button. It is upstream behaviour:
// the session is created when the first message is sent, not when New is pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function makeBridge() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-stats-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => {
      const seg = c.split('_$_');
      return seg[seg.length - 2] === service && seg[seg.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, kernel, cleanup: () => { try { fs.unlinkSync(storePath); } catch { /* gone */ } } };
}

test('getCodeStats answers every field the panel schema requires', async () => {
  // The renderer validates with a schema and throws 'unexpected payload shape' on a miss, which
  // turned into a QueryClient error on every mount when a field was absent.
  const b = await makeBridge();
  try {
    b.kernel.start({ cwd: os.tmpdir() });
    const stats = await b.call('LocalSessions', 'getCodeStats');
    // MEASURED keys: totalSessions, totalMessages, activeDays, firstSessionDate,
    // lastSessionDate, peakActivityHour, streaks, dailyActivity, dailyModelTokens, modelUsage.
    // The first three are numbers and the two day series are arrays; the panel sums them.
    for (const key of ['totalSessions', 'totalMessages', 'activeDays']) {
      assert.equal(typeof stats[key], 'number', key + ' is ' + JSON.stringify(stats[key]));
    }
    assert.ok(Array.isArray(stats.dailyActivity), 'dailyActivity is not an array');
    assert.ok(Array.isArray(stats.dailyModelTokens), 'dailyModelTokens is not an array');
    assert.equal(typeof stats.streaks, 'object');
    assert.equal(typeof stats.modelUsage, 'object');
  } finally { b.cleanup(); }
});

test('the stats track the real store instead of inventing numbers', async () => {
  const b = await makeBridge();
  try {
    for (let i = 0; i < 4; i += 1) b.kernel.start({ cwd: os.tmpdir() });
    const sessions = b.kernel.getAll();
    const stats = await b.call('LocalSessions', 'getCodeStats');
    assert.equal(stats.totalSessions, sessions.length,
      'the panel reports ' + stats.totalSessions + ' sessions but the store holds ' + sessions.length);
    const rows = sessions.reduce((n, s) => n + (b.kernel.getTranscript(s.sessionId) || []).length, 0);
    assert.equal(stats.totalMessages, rows,
      'the panel reports ' + stats.totalMessages + ' messages but the store holds ' + rows);
  } finally { b.cleanup(); }
});

test('creating a session raises the reported count by exactly one', async () => {
  const b = await makeBridge();
  try {
    b.kernel.start({ cwd: os.tmpdir() });
    const before = await b.call('LocalSessions', 'getCodeStats');
    b.kernel.start({ cwd: os.tmpdir() });
    const after = await b.call('LocalSessions', 'getCodeStats');
    assert.equal(after.totalSessions, before.totalSessions + 1);
  } finally { b.cleanup(); }
});

test('starting a session makes it appear in the list the sidebar reads', async () => {
  // MEASURED live: getAll() went 205 -> 206 and the new id was present; the sidebar's
  // .dframe-nav-scroll also carried it. This is the 'New' button's real contract.
  const b = await makeBridge();
  try {
    const before = await b.call('LocalSessions', 'getAll');
    const created = b.kernel.start({ cwd: os.tmpdir() });
    const after = await b.call('LocalSessions', 'getAll');
    assert.equal(after.length, before.length + 1);
    assert.ok(after.some((s) => s.sessionId === created.sessionId), 'the new session is missing from getAll');
    // getSessionList is a WRAPPER, not an array: { sessions, loadGeneration, archivedPending }.
    // Asserting Array.isArray here was my mistake, not a defect — the sidebar reads .sessions.
    const list = await b.call('LocalSessions', 'getSessionList');
    assert.ok(Array.isArray(list.sessions), 'getSessionList.sessions is not an array');
    assert.ok(list.sessions.some((s) => s.sessionId === created.sessionId),
      'the sidebar list omits the new session');
  } finally { b.cleanup(); }
});