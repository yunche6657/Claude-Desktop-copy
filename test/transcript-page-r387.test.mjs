// R387: `getTranscriptPage` was declared, read by the local transport, and unanswered.
//
// The transport decides whether paging exists by testing the channel for truthiness:
//
//   readsTranscriptInPages(){ return u?.getTranscriptPage !== void 0 }
//   async fetchEarlierTranscript(e,t){ let n=O.get(e), r=u?.getTranscriptPage; if(!n||!r) return []; ... }
//   let s = await K.read({...mode:f.Page...}) ?? await r(e,a,200);
//   if (s?.found === true && Array.isArray(s.messages)) { ... Me.set(e, s.hasMore === true) ... }
//   else je.set(e,"cursor_lost"), O.delete(e), []
//
// The generic fallback answers null, so scrolling back was never attempted at all: the request
// returned [] and the earlier-page cursor was kept forever.
//
// The contract below is not invented — it is read off the original's own getTranscriptPage
// (pinned main bundle, offset 1190026) as this consumer uses it:
//   found      whether the cursor names a real row (false => the renderer reports cursor_lost)
//   messages   the rows ABOVE the cursor, newest-last, at most `limit` of them
//   hasMore    whether anything remains above that page
//   source     the read path the renderer reports ("window" is the only value it special-cases)
//   totalRows  optional; the transport uses it to refuse an implausibly long read
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

function makeBridge() {
  const handlers = new Map();
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: 'ok', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const channels = [...handlers.keys()];
  const invoke = async (method, ...args) => {
    const channel = channels.find((c) => c.includes('LocalSessions_$_') && c.endsWith('_$_' + method));
    if (!channel) throw new Error('no channel for ' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return { kernel, invoke, channels };
}

/** A kernel whose transcript is `rows` long, with predictable uuids. */
function withRows(count) {
  const bridge = makeBridge();
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  const rows = Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `row-${String(i).padStart(3, '0')}`,
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `line ${i}` }] },
  }));
  bridge.kernel.setTranscript(sessionId, rows);
  return { ...bridge, sessionId, rows };
}

test('the channel answers the page shape instead of the fallback null', async () => {
  const { invoke, sessionId } = withRows(10);
  const page = await invoke('getTranscriptPage', sessionId, '', 200);
  assert.notEqual(page, null, 'the generic fallback answered: the handler is not registered');
  assert.equal(typeof page, 'object');
  // The transport's own gate. A null here is what made paging look unsupported.
  assert.notEqual(page, undefined);
  assert.ok('found' in page, 'the page has no `found`, so the transport reports cursor_lost');
  assert.ok(Array.isArray(page.messages), 'the page has no messages array');
});

test('an empty cursor pages from the newest rows and reports whether anything is above', async () => {
  const { invoke, sessionId, rows } = withRows(500);
  const page = await invoke('getTranscriptPage', sessionId, '', 200);
  assert.equal(page.found, true);
  assert.equal(page.messages.length, 200, 'the limit was ignored');
  assert.deepEqual(page.messages.map((r) => r.uuid), rows.slice(300).map((r) => r.uuid),
    'the first page is not the newest rows');
  assert.equal(page.hasMore, true, 'more rows remain above but hasMore says otherwise');
  assert.equal(page.totalRows, 500);
  assert.equal(page.source, 'full');
});

test('the cursor is exclusive: the named row is not repeated', async () => {
  // The renderer splices the page above the cursor row it already holds. Repeating that row
  // would duplicate one message in the middle of the conversation.
  const { invoke, sessionId, rows } = withRows(10);
  const cursor = rows[7].uuid;
  const page = await invoke('getTranscriptPage', sessionId, cursor, 3);
  assert.equal(page.found, true);
  assert.deepEqual(page.messages.map((r) => r.uuid), ['row-004', 'row-005', 'row-006'],
    'the page is not the rows immediately above the cursor');
  assert.ok(!page.messages.some((r) => r.uuid === cursor), 'the cursor row was repeated');
  assert.equal(page.hasMore, true);
});

test('the oldest page reports hasMore false so paging stops', async () => {
  const { invoke, sessionId, rows } = withRows(5);
  const page = await invoke('getTranscriptPage', sessionId, rows[2].uuid, 200);
  assert.equal(page.found, true);
  assert.deepEqual(page.messages.map((r) => r.uuid), ['row-000', 'row-001']);
  assert.equal(page.hasMore, false, 'the oldest page still claims more rows exist');
});

test('an unknown cursor is reported as not found, never as an empty page', async () => {
  // found:false is what makes the transport say cursor_lost and drop its cursor. Returning an
  // empty page with found:true would look like "nothing above" and silently truncate history.
  const { invoke, sessionId } = withRows(10);
  const page = await invoke('getTranscriptPage', sessionId, 'row-does-not-exist', 200);
  assert.equal(page.found, false);
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
});

test('an unknown session does not throw and does not fabricate rows', async () => {
  const { invoke } = makeBridge();
  const page = await invoke('getTranscriptPage', 'local_nope', '', 200);
  assert.equal(page.found, false);
  assert.deepEqual(page.messages, []);
});
