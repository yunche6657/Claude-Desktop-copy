// Importing CLI sessions: the two channels the sidebar banner needs.
//
// Neither existed. `probeImportableCliSessions` was answered only by the generic fallback
// ({sessions,archived,pinned}) and `importAllCliSessions` had no handler at all, so it
// answered null. The consumer (cc43287c9-Me-M2ucD.js, fn `Kle`) reads `m?.count` off the
// probe answer to decide whether to show the banner, so with no `count` the banner could
// never appear -- even though 55 real CLI transcript files existed under ~/.claude/projects.
//
// The fallback being *safe* is exactly why this went unnoticed: nothing crashed, the feature
// just did not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge({ projects = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-import-home-'));
  if (projects) {
    for (const [dirName, files] of Object.entries(projects)) {
      const dir = path.join(home, '.claude', 'projects', dirName);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body, 'utf8');
      }
    }
  }
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const handlers = new Map();
  const storePath = path.join(home, 'kernel-sessions.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
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
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
  };
  return { call, kernel, restore, home };
}

const TRANSCRIPT = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello from the CLI' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
].join(String.fromCharCode(10));

test('the probe reports a count, which is what the banner reads', async () => {
  const { call, restore } = makeBridge({
    projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT, 'bbb.jsonl': TRANSCRIPT } },
  });
  try {
    const probe = await call('LocalSessions', 'probeImportableCliSessions');
    assert.equal(typeof probe.count, 'number', 'the banner reads count off this answer');
    assert.equal(probe.count, 2, 'both transcripts must be counted');
    assert.ok(Array.isArray(probe.sessions));
    assert.ok(Array.isArray(probe.archived));
    assert.ok(Array.isArray(probe.pinned));
  } finally { restore(); }
});

test('with no CLI projects the count is 0, not undefined', async () => {
  const { call, restore } = makeBridge({});
  try {
    const probe = await call('LocalSessions', 'probeImportableCliSessions');
    assert.equal(probe.count, 0);
  } finally { restore(); }
});

test('importing creates sessions that the CLI list then reports', async () => {
  const { call, restore } = makeBridge({ projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT } } });
  try {
    const result = await call('LocalSessions', 'importAllCliSessions');
    assert.equal(result.imported, 1);
    const listed = await call('LocalSessions', 'listCliSessions');
    assert.equal(listed.length, 1);
    assert.equal(typeof listed[0].lastActivityAt, 'number');
    assert.equal(listed[0].handle, 'aaa');
  } finally { restore(); }
});

test('the imported transcript keeps the CLI rows', async () => {
  const { call, restore } = makeBridge({ projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT } } });
  try {
    await call('LocalSessions', 'importAllCliSessions');
    const listed = await call('LocalSessions', 'listCliSessions');
    const rows = await call('LocalSessions', 'getTranscript', listed[0].bridgeSessionId);
    assert.equal(rows.length, 2, 'only user/assistant rows are kept');
    assert.equal(rows[0].type, 'user');
    assert.equal(rows[1].type, 'assistant');
    // Scoped to the user row: the import could put the text in the assistant row and a blob
    // search would not notice.
    assert.ok(JSON.stringify(rows[0].message.content).includes('hello from the CLI'));
  } finally { restore(); }
});

test('importing twice does not duplicate the sidebar', async () => {
  const { call, restore } = makeBridge({ projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT } } });
  try {
    await call('LocalSessions', 'importAllCliSessions');
    const second = await call('LocalSessions', 'importAllCliSessions');
    assert.equal(second.imported, 0, 'already-imported handles must be skipped');
    assert.equal((await call('LocalSessions', 'listCliSessions')).length, 1);
  } finally { restore(); }
});

test('a transcript with no messages is not imported', async () => {
  const { call, restore } = makeBridge({
    projects: { 'C--proj': { 'empty.jsonl': JSON.stringify({ type: 'queue-operation' }) } },
  });
  try {
    const result = await call('LocalSessions', 'importAllCliSessions');
    assert.equal(result.imported, 0);
    assert.equal((await call('LocalSessions', 'listCliSessions')).length, 0);
  } finally { restore(); }
});
test('the probe counts only what is NOT yet imported', async () => {
  // The first version counted every CLI transcript on disk, so after an import the banner
  // kept offering sessions that were already in the sidebar. Measured: 55 imported, count 55.
  const { call, restore } = makeBridge({
    projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT, 'bbb.jsonl': TRANSCRIPT } },
  });
  try {
    const before = await call('LocalSessions', 'probeImportableCliSessions');
    assert.equal(before.count, 2, 'nothing imported yet, both are importable');

    await call('LocalSessions', 'importAllCliSessions');

    const after = await call('LocalSessions', 'probeImportableCliSessions');
    assert.equal(after.count, 0, 'everything is imported, so nothing is left to offer');
  } finally { restore(); }
});

test('a newly added CLI transcript becomes importable again', async () => {
  // The banner must still work for sessions created after the first import.
  const { call, restore, home } = makeBridge({ projects: { 'C--proj': { 'aaa.jsonl': TRANSCRIPT } } });
  try {
    await call('LocalSessions', 'importAllCliSessions');
    assert.equal((await call('LocalSessions', 'probeImportableCliSessions')).count, 0);

    fs.writeFileSync(path.join(home, '.claude', 'projects', 'C--proj', 'ccc.jsonl'), TRANSCRIPT, 'utf8');
    const after = await call('LocalSessions', 'probeImportableCliSessions');
    assert.equal(after.count, 1, 'the new transcript must be offered');
    assert.equal(after.sessions[0].handle, 'ccc');
  } finally { restore(); }
});
