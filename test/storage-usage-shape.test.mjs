import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorageUsage } = require('../desktop/storage-usage.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { home: root, workspace: root, dataDir: path.join(root, 'data'), userDataDir: path.join(root, 'data'), coworkRoot: path.join(root, 'cowork'), storePath: path.join(root, 'data', 'sessions', 'kernel-sessions.json'), runtimeRoots: [path.join(root, 'data', 'runtime')] };
  const put = (file, bytes) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.alloc(bytes, 1)); return target; };
  return { root, options, put };
}

test('known-size actual directories retain the frontend contract without overlapping bytes', t => {
  const f = fixture(t);
  f.put('.claude/projects/p/11111111-1111-1111-1111-111111111111.jsonl', 11);
  f.put('.claude/projects/p/subagents/agent-a.jsonl', 13);
  f.put('.claude/projects/p/manifest.json', 7);
  f.put('.claude/file-history/entry', 17);
  f.put('.claude/shell-snapshots/snapshot', 19);
  f.put('.claude/backups/backup', 23);
  f.put('.claude/plans/plan', 29);
  f.put('data/sessions/kernel-sessions.json', 31);
  f.put('data/attachments/a.png', 37);
  f.put('data/Cache/Cache_Data/data_1', 41);
  f.put('data/Code Cache/js/a', 43);
  f.put('data/Partitions/browser/Cache/a', 47);
  f.put('data/Partitions/browser/Local Storage/db', 53);
  f.put('data/logs/app.log', 59);
  f.put('data/runtime/cli.js', 61);
  f.put('data/runtime/Cache/required', 67);
  f.put('cowork/.cowork/store.json', 71);
  f.put('cowork/attachments/a', 73);
  const storage = createStorageUsage(f.options);
  const { device, cowork, measured } = storage.snapshot();
  assert.equal(device.totalBytes + cowork.totalBytes, 702);
  assert.equal(measured.files.length, 18);
  assert.equal(device.code.transcriptsBytes, 24);
  assert.equal(device.code.recordsBytes, 31);
  assert.equal(device.code.sessionCount, 1, 'subagent and index files are not sessions');
  assert.equal(device.runtime.claudeCodeBytes, 128);
  assert.equal(device.app.webCacheBytes, 131);
  assert.equal(device.app.browserPanesBytes, 53);
  assert.equal(device.unknownBytes, 96);
  assert.equal(cowork.totalBytes, 144);
  assert.equal(cowork.workspace.sessionDiskBytes, 0);
  assert.equal(cowork.coverage.sharedSessionStoreOwner, 'device');
  for (const usage of [device, cowork]) {
    for (const group of ['code', 'runtime', 'app', 'workspace', 'conversations']) assert.ok(usage[group]);
    assert.ok(Array.isArray(usage.conversations.stale));
    assert.ok(Number.isFinite(usage.totalBytes));
  }
  const cleared = storage.clearCache();
  assert.equal(cleared.freedBytes, 131);
  assert.equal(cleared.deletedCount, 3);
  for (const file of ['data/runtime/Cache/required', 'data/Partitions/browser/Local Storage/db', '.claude/plans/plan', '.claude/backups/backup', 'data/attachments/a.png', 'data/sessions/kernel-sessions.json']) assert.ok(fs.existsSync(path.join(f.root, file)), file);
});

test('missing runtime is explicitly unknown and overlapping roots/hardlinks count once', t => {
  const f = fixture(t); const file = f.put('data/cache-entry', 27);
  fs.linkSync(file, path.join(f.root, 'data', 'hardlink'));
  const storage = createStorageUsage({ ...f.options, runtimeRoots: [], coworkRoot: f.options.dataDir });
  const snap = storage.snapshot();
  assert.equal(snap.device.totalBytes + snap.cowork.totalBytes, 27);
  assert.equal(snap.device.coverage.runtimeKnown, false);
  assert.equal(snap.measured.files.length, 1);
});

test('cache junctions are skipped and reported instead of traversing external files', t => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), Buffer.alloc(99));
  fs.mkdirSync(f.options.userDataDir, { recursive: true });
  fs.symlinkSync(outside, path.join(f.options.userDataDir, 'Cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const storage = createStorageUsage(f.options);
  assert.equal(storage.getUsage().coverage.complete, false);
  assert.equal(storage.clearCache().deletedCount, 0);
  assert.equal(fs.statSync(path.join(outside, 'keep')).size, 99);
});

test('relocated Chromium sessionData caches are separated from browser persistent state', t => {
  const f = fixture(t);
  f.put('data/sessionData/Cache/a', 101);
  f.put('data/sessionData/Partitions/browser/Code Cache/a', 103);
  f.put('data/sessionData/Partitions/browser/Local Storage/state', 107);
  f.put('data/cache/http', 109);
  const storage = createStorageUsage(f.options);
  assert.equal(storage.getUsage().app.webCacheBytes, 313);
  assert.equal(storage.getUsage().app.browserPanesBytes, 107);
  assert.equal(storage.clearCache().freedBytes, 313);
  assert.ok(fs.existsSync(path.join(f.root, 'data/sessionData/Partitions/browser/Local Storage/state')));
});

test('explicit session attachments are measured once without walking the session working directory', t => {
  const f = fixture(t); const attachment = f.put('project/a.png', 83);
  f.put('project/unrelated', 1000);
  const storage = createStorageUsage({ ...f.options, getSessions: () => [{ sessionId: 'code', cwd: path.join(f.root, 'project'), attachments: [{ filePath: attachment }] }, { sessionId: 'cowork', cwd: f.root }], getCoworkSessionIds: () => ['cowork'], getTranscript: id => id === 'cowork' ? [{ type: 'image', path: f.put('cowork/attachments/c.png', 89) }] : [] });
  const snapshot = storage.snapshot();
  assert.equal(snapshot.device.totalBytes, 83);
  assert.equal(snapshot.cowork.totalBytes, 89);
  assert.equal(snapshot.measured.files.length, 2);
});

test('cleanup tokens enforce explicit type, expiry, changed and active session protection', async t => {
  const f = fixture(t); let clock = Date.now();
  const sessions = ['old', 'became-active', 'changed', 'cowork', 'already-active'].map(id => ({ sessionId: id, updatedAt: clock - 40 * 86400000, isRunning: id === 'already-active' }));
  const removed = [];
  const storage = createStorageUsage({ ...f.options, now: () => clock, getSessions: () => sessions, getCoworkSessionIds: () => ['cowork'], removeSession: id => { removed.push(id); return true; } });
  const noDelete = storage.previewCleanup('device', 30).preview;
  assert.equal(noDelete.sessionCount, 3); assert.equal(noDelete.count, 0);
  assert.equal((await storage.runCleanup('device', noDelete.token)).deletedCount, 0);
  const preview = storage.previewCleanup('device', 30).preview;
  sessions.find(s => s.sessionId === 'became-active').isRunning = true;
  sessions.find(s => s.sessionId === 'changed').updatedAt = clock;
  const result = await storage.runCleanup('device', preview.token, { deleteSessions: true });
  assert.equal(result.deletedCount, 1); assert.equal(result.skippedCount, 2);
  assert.deepEqual(removed, ['old']);
  assert.equal((await storage.runCleanup('device', preview.token, { deleteSessions: true })).errorCode, 'expired');
  const cowork = storage.previewCleanup('cowork', 30).preview;
  assert.equal(cowork.chatCount, 1);
  assert.equal((await storage.runCleanup('device', cowork.token, { deleteSessions: true })).errorCode, 'expired');
  const expired = storage.previewCleanup('cowork', 30).preview; clock += 300001;
  assert.equal((await storage.runCleanup('cowork', expired.token)).errorCode, 'expired');
  assert.equal(storage.previewCleanup('device', 'all').errorCode, 'bad-selection');
});

test('cleanup cancellation stops between sessions and emits frontend progress arguments', async t => {
  const f = fixture(t); const progress = []; const removed = [];
  let storage;
  storage = createStorageUsage({ ...f.options, now: () => 10000000000, getSessions: () => ['a', 'b'].map(sessionId => ({ sessionId, updatedAt: 1 })), removeSession: id => { removed.push(id); }, onProgress: (...args) => { progress.push(args); storage.cancelCleanup('device'); } });
  const preview = storage.previewCleanup('device', 30).preview;
  const result = await storage.runCleanup('device', preview.token, { deleteSessions: true });
  assert.equal(result.cancelled, true); assert.deepEqual(removed, ['a']); assert.deepEqual(progress, [['device', 1, 2]]);
});

test('bridge handlers use the real kernel store and keep Device/Cowork separate', async t => {
  const f = fixture(t);
  const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');
  const { createSessionKernel } = require('../desktop/session-kernel.cjs');
  const kernel = createSessionKernel({ emit() {}, storePath: f.options.storePath, createAgent: () => ({ tools: [], async run() { return { text: '' }; } }) });
  const handlers = new Map(); let relaunched = false;
  const bridge = registerBridgeServices({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    bridgeMap: { 'claude.web': { DeviceStorage: ['getUsage', 'previewCodeCleanup', 'runCodeCleanup', 'clearCacheAndRestart'], CoworkStorage: ['getUsage', 'getCounts', 'previewCleanup', 'runCleanup'] } },
    getMainWindow: () => null, storageUserDataDir: f.options.userDataDir,
    settings: { dataDir: f.options.dataDir, coworkUserFilesPath: f.options.coworkRoot, kernelFactory: () => kernel }, frontend: { root: f.root },
    relaunchApp: () => { relaunched = true; },
  });
  t.after(() => bridge.dispose());
  const call = (service, method, ...args) => handlers.get(messageChannel('claude.web', service, method))({}, ...args);
  const row = kernel.start({ cwd: f.root });
  kernel.update(row.sessionId, { updatedAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  kernel.flush();
  const device = await call('DeviceStorage', 'getUsage');
  assert.equal(device.code.recordsBytes, fs.statSync(f.options.storePath).size);
  const cowork = await call('CoworkStorage', 'getUsage');
  assert.equal(cowork.code.recordsBytes, 0);
  assert.equal((await call('CoworkStorage', 'getCounts')).conversations, 0);
  f.put('data/Cache/entry', 97);
  const cleared = await call('DeviceStorage', 'clearCacheAndRestart');
  assert.equal(cleared.freedBytes, 97); assert.equal(relaunched, true);
  assert.ok(kernel.getAll().some(s => s.sessionId === row.sessionId));
});
