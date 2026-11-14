// The bridge could read a transcript but not write one.
//
// `getTranscript` existed while a writer did not, even though the kernel has always
// supported `setTranscript`. That asymmetry blocks any programmatic construction of session
// content -- tests, imports and replays all need to place known rows into a session.
//
// It surfaced while trying to exercise the usage card: the frontend turns an assistant row
// whose text is exactly "<plan-usage/>" into a {kind:"usage"} card (c06cf64bb @159560),
// which mounts the component that calls getPeriodUsage. Without a writer there was no
// honest way to produce that row.
//
// The writer is deliberately NOT an IPC channel and NOT in bridge-map: the shipped frontend
// never calls `setTranscript`, so exposing it on the renderer surface would add a method the
// original does not have. It is exported on the module instead.
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
  const channels = () => [...handlers.keys()];
  // The raw handler map, before the registration loop filters it by bridge-map.
  const handlerNames = () => [...handlers.keys()];
  const call = (service, method, ...args) => {
    const channel = channels().find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { call, kernel, api, channels, handlerNames, handlers };
}

const MARKER_ROW = {
  type: 'assistant',
  uuid: 'marker-1',
  message: { role: 'assistant', content: [{ type: 'text', text: '<plan-usage/>' }] },
};

test('a transcript can be written and read back', async () => {
  const { call, kernel, api } = makeBridge();
  const started = await call('LocalSessions', 'start', { cwd: process.cwd() });
  const sid = started.sessionId;

  const written = api.setTranscript(sid, [MARKER_ROW]);
  assert.equal(written.ok, true, `write must succeed: ${JSON.stringify(written)}`);
  assert.equal(written.rows, 1, 'the answer must report the stored row count');

  const back = kernel.getTranscript(sid);
  assert.ok(Array.isArray(back));
  assert.equal(back.length, 1);
  assert.equal(back[0].message.content[0].text, '<plan-usage/>');
});

test('the usage marker row survives the round trip', async () => {
  const { call, kernel, api } = makeBridge();
  const started = await call('LocalSessions', 'start', { cwd: process.cwd() });
  const sid = started.sessionId;
  api.setTranscript(sid, [MARKER_ROW]);
  const texts = kernel.getTranscript(sid)
    .flatMap((r) => (r.message?.content || []).map((c) => c.text)).filter(Boolean);
  assert.ok(texts.includes('<plan-usage/>'), 'the marker must be present after a round trip');
});

test('an unknown session is refused, not silently accepted', async () => {
  const { api } = makeBridge();
  const result = api.setTranscript('no-such-session', [MARKER_ROW]);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('a non-array body is refused by the handler, not only by the kernel', async () => {
  // Deleting the handler's own guard left this green once, because kernel.setTranscript
  // happens to reject non-arrays too. Assert the handler's OWN error text so the guard is
  // load-bearing rather than incidentally redundant.
  const { call, api } = makeBridge();
  const started = await call('LocalSessions', 'start', { cwd: process.cwd() });
  for (const bad of [null, undefined, 'text', 42, {}]) {
    const result = api.setTranscript(started.sessionId, bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.error, 'rows must be an array',
      'the handler must reject it itself, with its own message');
  }
});

test('an empty session id is refused', async () => {
  const { api } = makeBridge();
  for (const bad of ['', null, undefined, 42]) {
    const result = api.setTranscript(bad, [MARKER_ROW]);
    assert.equal(result.ok, false);
  }
});

test('writing replaces the transcript rather than appending', async () => {
  const { call, kernel, api } = makeBridge();
  const started = await call('LocalSessions', 'start', { cwd: process.cwd() });
  const sid = started.sessionId;

  api.setTranscript(sid, [MARKER_ROW]);
  const second = api.setTranscript(sid, []);
  assert.equal(second.ok, true);
  assert.equal(second.rows, 0, 'an empty array must clear the transcript');
  assert.equal(kernel.getTranscript(sid).length, 0);
});

test('the writer is NOT exposed as an IPC channel', async () => {
  // The renderer surface must match the original, which has no setTranscript.
  //
  // Two distinct leaks are possible and they need different assertions:
  //   a) a `define()` with an unlisted name -> a RAW FRAGMENT key in the handler map.
  //      It is never registered as a channel (the loop only walks bridge-map), so checking
  //      channel names alone stays green -- that is exactly how this went unnoticed once.
  //   b) adding the name to bridge-map -> a real channel.
  const { handlers, api } = makeBridge();
  const keys = [...handlers.keys()];

  const rawFragments = keys.filter((k) => k.includes('setTranscript') && !k.startsWith('$eipc_'));
  assert.deepEqual(rawFragments, [],
    'a define() with an unlisted name leaves a raw fragment; that is still a leak of intent');

  const channels = keys.filter((k) => k.startsWith('$eipc_') && k.includes('setTranscript'));
  assert.deepEqual(channels, [], 'setTranscript must not become a bridge channel');

  assert.equal(typeof api.setTranscript, 'function', 'it must still be reachable on the module');
});

test('the writer is NOT added to bridge-map', async () => {
  const map = require('../desktop/shim/bridge-map.json');
  for (const services of Object.values(map)) {
    if (!services || typeof services !== 'object') continue;
    for (const methods of Object.values(services)) {
      if (!Array.isArray(methods)) continue;
      assert.equal(methods.includes('setTranscript'), false,
        'bridge-map describes the shipped contract and must not gain this method');
    }
  }
});
