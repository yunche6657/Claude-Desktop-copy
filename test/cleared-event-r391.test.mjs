// R391: `/clear` must tell the renderer, not just return {ok:true}.
//
// `clearSession` already emptied the transcript and set `hasPreClearSession`, so a caller that
// only reads the return value looks perfectly healthy. The conversation reset is driven by an
// event, though:
//
//   transport: case"cleared": t({kind:"cleared", hasPreClearSession:r.hasPreClearSession,
//                                 unwoundRefusalFallback:r.unwoundRefusalFallback}); break;
//   also:      case"cleared": return {sessionId:t.sessionId, kind:"cleared", session:t.session}
//   store:     case"cleared": return i=!0, nD(e), yO(e), n.unwoundRefusalFallback&&jT(e),
//                { ...rD(t), refusalFallback: ..., restoredRefusalFallback: ...,
//                  hasPreClearSession: n.hasPreClearSession ?? null, spawnedFresh: t.spawnedFresh }
//              nD(e) = U.dropSession(e), K.reset(e), W.clear(e), IC(e), bn(e),
//                      clearSession(e), resend(e), aC(e), tC(e), ...
//
// So without the event the store keeps per-session sub-state (streaming buffers, refusal
// fallback, connection bookkeeping) after the rows are already gone, and the resume affordance
// reads a field the store never received.
//
// Payload shape is taken from the pinned original's emission (offset 984048):
//   {type:"cleared", sessionId, session, hasPreClearSession, unwoundRefusalFallback}
import test from 'node:test';
import assert from 'node:assert/strict';
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
  const sent = [];
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const channels = [...handlers.keys()];
  const invoke = async (method, ...args) => {
    const channel = channels.find((c) => c.includes('LocalSessions_$_') && c.endsWith('_$_' + method));
    if (!channel) throw new Error('no channel for ' + method);
    return await handlers.get(channel)({}, ...args);
  };
  const events = () => sent.map(([, payload]) => payload).filter((p) => p && p.type);
  return { kernel, invoke, events };
}

/** One clear announcement per uuid-distinct payload; emitSessionEvent fans out on several channels. */
function clearedEvents(events) {
  const seen = new Map();
  for (const e of events) {
    if (e.type !== 'cleared') continue;
    seen.set(e.sessionId, e);
  }
  return [...seen.values()];
}

function seed(bridge, rows) {
  const { sessionId } = bridge.kernel.start({ cwd: ROOT });
  bridge.kernel.setTranscript(sessionId, rows.map((i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `row-${i}`,
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `line ${i}` }] },
  })));
  return sessionId;
}

test('clearing a conversation announces it', async () => {
  const bridge = makeBridge();
  const sessionId = seed(bridge, [0, 1, 2, 3]);

  const answer = await bridge.invoke('clearSession', sessionId);
  assert.equal(answer.ok, true);

  const fired = clearedEvents(bridge.events());
  assert.equal(fired.length, 1, 'the clear was never announced, so the store keeps its sub-state');
  assert.equal(fired[0].sessionId, sessionId);
  // The store spreads the session snapshot; without it the reset starts from a stale record.
  assert.ok(fired[0].session, 'the event carries no session snapshot');
  assert.equal(fired[0].hasPreClearSession, true,
    'hasPreClearSession is not true, so the resume affordance will not appear');
  // The transport short-circuits on this: `n.unwoundRefusalFallback && jT(e)`. It must be a
  // real false, not undefined-by-omission.
  assert.equal(fired[0].unwoundRefusalFallback, false);
});

test('the announcement is built after the rows are gone', async () => {
  // The reducer resets state for a conversation that no longer exists. If the event were built
  // before the removal, `session` would describe the old record.
  //
  // Checking the transcript AFTER `clearSession` returns cannot tell the two orders apart — it
  // is empty either way once the call finishes. Measured: moving the emit above the removal
  // left the suite green twice, including when the test sampled getSession/getTranscript through
  // wrappers on the kernel (the bridge layer holds its own reference and bypasses them).
  //
  // What IS observable from outside is the rendering sink: events leave through webContents.send.
  // Recording, per delivered event, whether the transcript was already empty gives the order
  // without touching bridge internals.
  const bridge = makeBridge();
  const sessionId = seed(bridge, [0, 1, 2]);

  // Re-register with a sink that samples the kernel at delivery time.
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const handlers = new Map();
  const samples = [];
  registerBridgeServices({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (_channel, payload) => {
          if (payload?.type === 'cleared' && payload.sessionId === sessionId) {
            samples.push(bridge.kernel.getTranscript(sessionId).length);
          }
        },
      },
    }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => bridge.kernel },
    frontend: { root: ROOT },
  });
  const channel = [...handlers.keys()].find((c) => c.includes('LocalSessions_$_') && c.endsWith('_$_clearSession'));
  await handlers.get(channel)({}, sessionId);

  assert.equal(samples.length >= 1, true, 'the clear was never delivered to the renderer sink');
  assert.equal(samples[0], 0,
    'at delivery the transcript still held rows, so the renderer resets against stale content');
  assert.deepEqual(bridge.kernel.getTranscript(sessionId), [], 'the transcript was not emptied');
  assert.equal(bridge.kernel.getSession(sessionId)?.hasPreClearSession, true,
    'the record no longer offers a resume, so the announced flag describes nothing');
});

test('clearing an already-empty conversation still announces, with hasPreClearSession false', async () => {
  // A no-op clear is still a clear from the renderer's point of view: it asked, the transcript
  // is empty, and there is nothing to resume. Announcing with `true` here would offer a resume
  // for content that does not exist.
  const bridge = makeBridge();
  const sessionId = seed(bridge, []);

  const answer = await bridge.invoke('clearSession', sessionId);
  assert.equal(answer.ok, true);

  const fired = clearedEvents(bridge.events());
  assert.equal(fired.length, 1, 'an empty clear was not announced');
  assert.equal(fired[0].hasPreClearSession, false);
});

test('an unknown session is refused and announces nothing', async () => {
  const bridge = makeBridge();
  const answer = await bridge.invoke('clearSession', 'local_not_a_session');
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'unknown_session');
  assert.equal(clearedEvents(bridge.events()).length, 0,
    'a refused clear still announced one');
});

test('restoring the cleared conversation does not pretend to clear again', async () => {
  // `resumePreClearSession` puts rows back; only one `cleared` should ever have been announced
  // for that conversation, with hasPreClearSession true (it can be undone).
  const bridge = makeBridge();
  const sessionId = seed(bridge, [0, 1]);
  await bridge.invoke('clearSession', sessionId);
  assert.equal(clearedEvents(bridge.events()).length, 1);

  const restored = await bridge.invoke('resumePreClearSession', sessionId);
  assert.equal(restored.ok, true);
  assert.equal(bridge.kernel.getTranscript(sessionId).length, 2, 'the rows did not come back');
  assert.equal(clearedEvents(bridge.events()).length, 1,
    'resuming announced a second clear');
});
