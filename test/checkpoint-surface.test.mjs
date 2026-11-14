// The rewind surface: which methods the shipped UI really calls, and what a real
// implementation has to answer.
//
// Round-224 lesson applied literally: "checkpoint" appears in 23 shipped files and
// "rewind" in 53, which looks like a large unimplemented feature. It mostly is not.
// A word-boundary scan of all 3,838 shipped js/html files (130.6 MB) finds:
//
//   .rewindV2(          1 occurrence  (cb1e253a0-DgeDleLc.js, the local transport)
//   .rewind(            1 occurrence  (same function, the pre-v2 fallback)
//   .rewindFiles(       0
//   .undoRewind(        0
//   .switchRewindMark(  0
//   .rewindToRefusedPrompt( 0
//   restoreCheckpoint   0     undoMessage 0     revertMessage 0     checkpointRestore 0
//
// The other ~50 "rewind" hits are unrelated identifiers: mermaid's animation rewind(),
// a code editor's rewinddir, i18n keys such as hintNoRewind, and the "rewindMarker"
// prop of the transcript renderer. None of them is a bridge call. So the three names
// the task card listed as candidates must NOT be invented: restoreCheckpoint /
// undoMessage / revertMessage do not exist, exactly like readAgent / saveAgent in
// agent-bridge-surface.test.mjs.
//
// What IS real: two declared bridge methods, LocalSessions.rewindV2 and .rewind. Their
// single shipped consumer destructures the answer:
//
//   async function rh(e,t,n){ if(e?.rewindV2){ let {prefill:r, refusal:i} =
//     await e.rewindV2(t,n); ... } if(e?.rewind) return {prefill: await e.rewind(t,n)}; }
//
// Measured against a running replica (port 9391) the generic fallback answered null and
// the real consumer threw:
//
//   THREW: Cannot destructure property 'prefill' of '(intermediate value)' as it is null
//
// A declared method whose only consumer crashes on its answer is a handler gap, not a
// feature that is merely absent. That is what the handlers in bridge-services.cjs close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'resources', 'ion-dist');

/**
 * Build the bridge the same way bridge-handler-presence.test.mjs does, and return a
 * caller that resolves a method fragment to the registered channel function.
 */
function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  let turns = 0;
  const kernel = require('../desktop/session-kernel.cjs').createSessionKernel({
    emit: () => {},
    createAgent: () => ({
      model: 'm',
      tools: [],
      async run() {
        turns += 1;
        return { text: 'reply ' + turns, stopReason: 'end_turn' };
      },
    }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const invoke = (frag, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes(frag));
    if (!channel) throw new Error('no channel for ' + frag);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, handlers, invoke };
}

/** Seed one session with a multi-turn conversation. Returns its id and row uuids. */
async function seed(bridge, turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-'));
  const session = bridge.kernel.start({ cwd: dir });
  for (let i = 0; i < turns; i += 1) {
    await bridge.kernel.sendMessage(session.sessionId, 'question ' + i);
  }
  const rows = bridge.kernel.getTranscript(session.sessionId);
  return { sessionId: session.sessionId, rows };
}

/** Every shipped js/html file, as one string. Cached: 130 MB is expensive to re-read. */
let bundleCache = null;
function shippedBundle() {
  if (bundleCache !== null) return bundleCache;
  const parts = [];
  if (fs.existsSync(BUNDLE)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|html)$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(BUNDLE);
  }
  bundleCache = parts.join('\n');
  return bundleCache;
}

// ---------------------------------------------------------------------------
// The negative half: names that must never be implemented.
// ---------------------------------------------------------------------------

test('the shipped bundle contains no restoreCheckpoint / undoMessage / revertMessage', () => {
  // The task card named these three as candidates. A word-boundary search finds ZERO, and
  // so does a plain substring search. Implementing any of them would add bridge surface the
  // original does not have -- the readAgent/saveAgent failure mode.
  const text = shippedBundle();
  assert.ok(text.length > 100000, 'the shipped bundle is missing or empty: ' + BUNDLE);
  for (const name of ['restoreCheckpoint', 'undoMessage', 'revertMessage', 'checkpointRestore']) {
    assert.equal(new RegExp('\\b' + name + '\\b').test(text), false,
      name + ' actually exists in the bundle; this test is out of date, not the code');
  }
});

test('rewindFiles / undoRewind / switchRewindMark / rewindToRefusedPrompt are declared but never called', () => {
  // They ARE in bridge-map.json (captured from a live original), but no shipped file calls
  // them: zero member-call occurrences, with or without optional chaining. Declaring them is
  // correct; implementing them is not required by any caller. This pins the distinction so a
  // future round does not "fix" four channels nothing reaches.
  const text = shippedBundle();
  for (const name of ['rewindFiles', 'undoRewind', 'switchRewindMark', 'rewindToRefusedPrompt']) {
    assert.equal(new RegExp('\\?\\.' + name + '\\s*\\(').test(text), false,
      name + ' is called with optional chaining now; it needs a real handler');
    assert.equal(new RegExp('\\.' + name + '\\s*\\(').test(text), false,
      name + ' is called as a method now; it needs a real handler');
  }
});

test('only rewindV2 and rewind are actually called, and both are declared', () => {
  // The positive half of the same scan: exactly these two, reached from one function.
  const text = shippedBundle();
  assert.ok(text.length > 100000, 'the shipped bundle is missing or empty: ' + BUNDLE);
  assert.equal((text.match(/\.rewindV2\s*\(/g) || []).length, 1, 'rewindV2 call count changed');
  assert.equal((text.match(/\.rewind\s*\(/g) || []).length, 1, 'rewind call count changed');
  const map = require('../desktop/shim/bridge-map.json');
  const declared = new Set(map['claude.web'].LocalSessions);
  for (const name of ['rewind', 'rewindV2']) {
    assert.ok(declared.has(name), name + ' is no longer declared in bridge-map.json');
  }
});

// ---------------------------------------------------------------------------
// The positive half: rewindV2 must answer the shape its consumer destructures.
// ---------------------------------------------------------------------------

test('rewindV2 answers an object, because its consumer destructures prefill and refusal', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 3);
  const answer = await bridge.invoke('LocalSessions_$_rewindV2', sessionId, rows[rows.length - 1].uuid);
  // The shipped consumer is: let {prefill:r, refusal:i} = await e.rewindV2(t,n).
  // Destructuring null is a TypeError, so anything but an object is a crash.
  assert.equal(typeof answer, 'object');
  assert.notEqual(answer, null, 'rewindV2 answered null, which the consumer cannot destructure');
  assert.ok('prefill' in answer, 'the answer has no prefill key to destructure');
});

test('rewindV2 truncates the transcript so the target message is the last row', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 3);
  assert.ok(rows.length >= 5, 'the seed did not produce a multi-turn transcript: ' + rows.length);
  // Rewind to the first user message: everything after it must be gone.
  const target = rows[0].uuid;
  await bridge.invoke('LocalSessions_$_rewindV2', sessionId, target);
  const after = bridge.kernel.getTranscript(sessionId);
  assert.equal(after.length, 1, 'the transcript was not truncated at the target row');
  assert.equal(after[0].uuid, target, 'the surviving row is not the rewind target');
});

test('rewindV2 returns the truncated prompt text as prefill, so the composer refills', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  const target = rows[0].uuid;
  const textBlock = rows[0].message.content.find((block) => block.type === 'text');
  const answer = await bridge.invoke('LocalSessions_$_rewindV2', sessionId, target);
  assert.equal(answer.prefill, textBlock.text, 'prefill is not the rewound prompt text');
});

test('rewind is the pre-v2 fallback and answers the same prefill contract', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  const answer = await bridge.invoke('LocalSessions_$_rewind', sessionId, rows[0].uuid);
  assert.equal(typeof answer.prefill, 'string', 'rewind did not answer a prefill string');
  assert.equal(bridge.kernel.getTranscript(sessionId).length, 1);
});

test('an unknown rewind target is refused instead of silently truncating everything', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  const answer = await bridge.invoke('LocalSessions_$_rewindV2', sessionId, 'no-such-uuid');
  // A refusal is a prefill-less object, never null: the consumer destructures it either way.
  assert.equal(typeof answer, 'object');
  assert.notEqual(answer, null);
  assert.equal(answer.prefill, undefined, 'a refused rewind must not offer a prefill');
  assert.equal(bridge.kernel.getTranscript(sessionId).length, rows.length,
    'a refused rewind changed the transcript anyway');
});

test('rewindV2 on an unknown session answers the same safe shape', async () => {
  const bridge = makeBridge();
  const answer = await bridge.invoke('LocalSessions_$_rewindV2', 'local_nope', 'whatever');
  assert.equal(typeof answer, 'object');
  assert.notEqual(answer, null);
  assert.equal(answer.prefill, undefined);
});

test('rewinding leaves the session record intact and not running', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  await bridge.invoke('LocalSessions_$_rewindV2', sessionId, rows[0].uuid);
  const record = bridge.kernel.getSession(sessionId);
  assert.ok(record, 'the session record disappeared during a rewind');
  assert.equal(record.isRunning, false, 'a rewind left the session marked running');
  assert.equal(record.sessionId, sessionId);
});

test('after a rewind the next turn appends to the truncated transcript, not the old one', async () => {
  // The rewind must be a real cut, not a display filter: the continued conversation has to
  // chain from the surviving row.
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  const target = rows[0].uuid;
  await bridge.invoke('LocalSessions_$_rewindV2', sessionId, target);
  await bridge.kernel.sendMessage(sessionId, 'continued');
  const after = bridge.kernel.getTranscript(sessionId);
  assert.ok(after.length > 1, 'the continued turn did not append a row');
  assert.equal(after[0].uuid, target, 'the original anchor row was lost');
  assert.equal(after[1].parentUuid, target, 'the new turn did not chain from the rewind target');
});

// ---------------------------------------------------------------------------
// Both namespaces must answer alike, or a surface talking to one sees a dead method.
// ---------------------------------------------------------------------------

test('LocalAgentModeSessions.rewindV2 answers the same shape as LocalSessions.rewindV2', async () => {
  const bridge = makeBridge();
  const { sessionId, rows } = await seed(bridge, 2);
  const answer = await bridge.invoke('LocalAgentModeSessions_$_rewindV2', sessionId, rows[0].uuid);
  assert.equal(typeof answer, 'object');
  assert.notEqual(answer, null, 'the other namespace still falls back to null');
  assert.ok('prefill' in answer);
});
