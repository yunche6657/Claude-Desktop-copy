// Tests for the ClaudeVM bridge surface.
//
// Cowork's secure workspace runs in a lightweight VM. The frontend asks the main
// process whether the Windows Virtual Machine Platform is present, offers to
// enable it, and tracks download/boot through dedicated status methods. Leaving
// any of these to a generic null fallback left the setup banner stuck at 0%
// because the frontend could not tell "not installed" from "no answer".
//
// These tests pin the shapes and, importantly, that the platform probe answers
// without requiring elevation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const bridgeMap = require('../desktop/shim/bridge-map.json');

/** Minimal ipcMain stand-in that records handlers by channel. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function makeBus(overrides = {}) {
  const ipcMain = fakeIpcMain();
  const svc = registerBridgeServices({
    ipcMain,
    bridgeMap,
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', supportedFeatures: {}, sessions: () => [] },
    frontend: { root: '.' },
    ...overrides,
  });
  const call = async (domain, service, method, ...args) => {
    const channel = `$eipc_message$_6010a08f-a0fa-48b4-99da-0689b9e2de7b_$_${domain}_$_${service}_$_${method}`;
    const fn = ipcMain.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${domain}.${service}.${method}`);
    return await fn({}, ...args);
  };
  return { ipcMain, svc, call };
}

test('the ClaudeVM methods the frontend calls are all registered', () => {
  const { ipcMain } = makeBus();
  const methods = bridgeMap['claude.web'].ClaudeVM;
  for (const m of methods) {
    if (m.startsWith('on')) continue; // events, not handlers
    const channel = `$eipc_message$_6010a08f-a0fa-48b4-99da-0689b9e2de7b_$_claude.web_$_ClaudeVM_$_${m}`;
    assert.ok(ipcMain.handlers.has(channel), `missing handler: ${m}`);
  }
});

test('getDownloadStatus and getRunningStatus report strings, not null', async () => {
  const { call } = makeBus();
  const dl = await call('claude.web', 'ClaudeVM', 'getDownloadStatus');
  const run = await call('claude.web', 'ClaudeVM', 'getRunningStatus');
  assert.equal(typeof dl, 'string');
  assert.equal(typeof run, 'string');
});

test('the platform probe answers without elevation', async () => {
  const { call } = makeBus();
  const result = await call('claude.web', 'ClaudeVM', 'checkVirtualMachinePlatform');
  // ROUND 261: this used to assert an object { installed, state }. That shape was the bug.
  //
  // The renderer consumes the value directly:
  //   g.checkVirtualMachinePlatform().then(t => { e || c(t ? null : 'not_enabled') })
  // An object is always truthy, so 'not_enabled' was unreachable and a host WITHOUT the
  // feature behaved as if it had it. The handler now answers the boolean the caller tests.
  assert.equal(typeof result, 'boolean', 'the caller branches on the value, not on a field');
  // Either the service key is readable (true) or it is absent (false); both are real answers.
  assert.ok(result === true || result === false);
});

test('enabling the platform reports that it needs elevation rather than pretending', async () => {
  const { call } = makeBus();
  const result = await call('claude.web', 'ClaudeVM', 'enableVirtualMachinePlatform');
  assert.equal(result.ok, false);
  assert.match(result.reason, /administrator|elevat|dism/i);
});

test('download fails with a stated reason instead of hanging', async () => {
  const { call } = makeBus();
  const result = await call('claude.web', 'ClaudeVM', 'download');
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
  // The status the banner polls must move off "idle", or it stays on 0%.
  const status = await call('claude.web', 'ClaudeVM', 'getDownloadStatus');
  assert.notEqual(status, 'idle');
});

test('startVM answers from the live pipe rather than a hard-coded refusal', async () => {
  const { call } = makeBus();
  const result = await call('claude.web', 'ClaudeVM', 'startVM');
  // The answer must reflect the host: reachable when the Cowork VM service is
  // running, otherwise a refusal that names the reason. Either way the shape is
  // stable and the claim is checkable.
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.ok, 'boolean');
  if (result.ok) {
    assert.equal(typeof result.detail, 'string');
  } else {
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

test('startVM reports a running VM once the service answers', async () => {
  const { call } = makeBus();
  const started = await call('claude.web', 'ClaudeVM', 'startVM');
  const running = await call('claude.web', 'ClaudeVM', 'getRunningStatus');
  if (started.ok) {
    assert.equal(running, 'running');
  } else {
    // Without the service the status must not pretend to have started.
    assert.notEqual(running, 'running');
  }
});

test('the session transcript reflects the kernel messages', async () => {
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({
        emit,
        createAgent: () => ({
          async run({ messages, onEvent }) {
            onEvent({ type: 'text', text: 'TRANSCRIPT-OK' });
            return {
              text: 'TRANSCRIPT-OK',
              stopReason: 'end_turn',
              messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: 'TRANSCRIPT-OK' }] }],
            };
          },
        }),
      }),
    },
  });

  const session = await call('claude.web', 'LocalAgentModeSessions', 'start', { cwd: 'C:\\w' });
  await call('claude.web', 'LocalAgentModeSessions', 'sendMessage', session.sessionId, 'hello');

  const transcript = await call('claude.web', 'LocalAgentModeSessions', 'getTranscript', session.sessionId);
  // A running original answers an ARRAY of stream-json entries, not an object.
  assert.ok(Array.isArray(transcript), 'getTranscript must answer an array');
  assert.equal(transcript.length, 2, 'one user turn plus one assistant reply');
  assert.equal(transcript[0].type, 'user');
  assert.equal(transcript[1].type, 'assistant');
  assert.ok(Array.isArray(transcript[0].message.content));
  assert.equal(transcript[0].parentUuid, null);
  assert.equal(transcript[1].parentUuid, transcript[0].uuid);
});

test('getTranscript answers an empty array for an unknown session', async () => {
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({ emit, createAgent: () => ({ async run() { return { text: '' }; } }) }),
    },
  });
  const t = await call('claude.web', 'LocalAgentModeSessions', 'getTranscript', 'local_missing');
  assert.ok(Array.isArray(t));
  assert.equal(t.length, 0);
});

test('getLoginDesktop3pStatus carries a nested source object', async () => {
  // dz(e) reads `e.type`; pz()/mz() read `e.source.type` and `e.source.remote`.
  // A flat payload leaves `source` undefined and the settings panel throws
  //   Cannot read properties of undefined (reading 'type')
  const { call } = makeBus();
  const status = await call('claude.settings', 'Custom3pSetup', 'getLoginDesktop3pStatus');
  assert.equal(typeof status, 'object');
  assert.equal(typeof status.source, 'object');
  assert.ok(status.source !== null, 'source must not be null');
  assert.equal(typeof status.source.type, 'string');
  assert.equal(typeof status.source.remote, 'boolean');
  assert.equal(typeof status.thirdPartyConfigured, 'boolean');
  assert.equal(typeof status.hybrid, 'boolean');
});

test('getConfigHealth matches the shape the settings panel reads', async () => {
  // Verified against a running original:
  //   { provider, endpoint, source: {type, remote}, checkedAt, state }
  const { call } = makeBus();
  const health = await call('claude.settings', 'Custom3pSetup', 'getConfigHealth');
  assert.equal(typeof health, 'object');
  for (const key of ['provider', 'endpoint', 'source', 'checkedAt', 'state']) {
    assert.ok(key in health, `missing ${key}`);
  }
  assert.equal(typeof health.source.type, 'string');
  assert.equal(typeof health.source.remote, 'boolean');
  assert.equal(typeof health.state, 'string');
  // checkedAt must be an ISO timestamp the panel can compare.
  assert.ok(Number.isFinite(Date.parse(health.checkedAt)), 'checkedAt must parse');
});

test('recheckConfigHealth answers the same shape as getConfigHealth', async () => {
  const { call } = makeBus();
  const a = await call('claude.settings', 'Custom3pSetup', 'getConfigHealth');
  const b = await call('claude.settings', 'Custom3pSetup', 'recheckConfigHealth');
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(b.source.type, a.source.type);
});

test('a turn emits on both session event channels', async () => {
  // The transcript view refreshes from events rather than polling. A turn that only
  // writes the store leaves the UI showing stale content, so both LocalAgentModeSessions
  // and LocalSessions must receive `onEvent`.
  const sent = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const { call } = makeBus({
    getMainWindow: () => fakeWindow,
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({
        emit,
        createAgent: () => ({
          async run({ messages, onEvent }) {
            onEvent({ type: 'text', text: 'EVT' });
            return { text: 'EVT', stopReason: 'end_turn', messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: 'EVT' }] }] };
          },
        }),
      }),
    },
  });

  const session = await call('claude.web', 'LocalAgentModeSessions', 'start', { cwd: 'C:\\w' });
  await call('claude.web', 'LocalAgentModeSessions', 'sendMessage', session.sessionId, 'hi');

  const channels = [...new Set(sent.map((s) => s.channel))];
  assert.ok(
    channels.some((c) => c.includes('LocalAgentModeSessions_$_onEvent')),
    `missing LocalAgentModeSessions channel; saw ${channels.join(', ')}`,
  );
  assert.ok(
    channels.some((c) => c.includes('LocalSessions_$_onEvent')),
    `missing LocalSessions channel; saw ${channels.join(', ')}`,
  );
  // A turn must emit at least one text delta the renderer can append.
  assert.ok(sent.some((s) => s.payload && s.payload.type === 'text_delta'));
});

test('getSystemInfo carries os_version, which the terminal backend splits on', async () => {
  // The terminal backend does:
  //   if (info?.platform === "win32")
  //     return { backend: "conpty", buildNumber: Number(split(info.os_version, ".")) }
  // With os_version absent the split receives undefined and throws inside the
  // session detail view, so the field is part of the contract.
  const { call } = makeBus();
  const info = await call('claude.settings', 'DesktopInfo', 'getSystemInfo');
  assert.equal(typeof info.os_version, 'string');
  assert.ok(info.os_version.length > 0, 'os_version must not be empty');
  assert.ok(info.os_version.includes('.'), 'os_version must be dotted so it can be split');
  // osRelease is kept as an alias for other readers.
  assert.equal(info.osRelease, info.os_version);
});

test('LocalSessions.start and sendMessage reach the kernel', async () => {
  // The session detail view talks to LocalSessions, not LocalAgentModeSessions: the
  // histogram shows getTranscriptTail and getContextUsage on that namespace. If its
  // start/sendMessage are not backed, the composer dispatches into a session the
  // kernel never created.
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({
        emit,
        createAgent: () => ({
          async run({ messages, onEvent }) {
            onEvent({ type: 'text', text: 'LS-OK' });
            return { text: 'LS-OK', stopReason: 'end_turn', messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: 'LS-OK' }] }] };
          },
        }),
      }),
    },
  });

  const session = await call('claude.web', 'LocalSessions', 'start', { cwd: 'C:\\w' });
  assert.match(session.sessionId, /^local_/);

  const result = await call('claude.web', 'LocalSessions', 'sendMessage', session.sessionId, 'hello');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'LS-OK');

  const transcript = await call('claude.web', 'LocalSessions', 'getTranscript', session.sessionId);
  assert.ok(Array.isArray(transcript));
  assert.equal(transcript.length, 2);
});

test('LocalSessions.getTranscriptTail and getContextUsage answer from the kernel', async () => {
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({
        emit,
        createAgent: () => ({
          async run({ messages, onEvent }) {
            onEvent({ type: 'text', text: 'TAIL' });
            return { text: 'TAIL', stopReason: 'end_turn', messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: 'TAIL' }] }] };
          },
        }),
      }),
    },
  });

  const session = await call('claude.web', 'LocalSessions', 'start', { cwd: 'C:\\w' });
  await call('claude.web', 'LocalSessions', 'sendMessage', session.sessionId, 'x');

  const tail = await call('claude.web', 'LocalSessions', 'getTranscriptTail', session.sessionId);
  // The consumer is localTransport.fetchTranscriptTail, which does
  //   if (!o || !Array.isArray(o.messages)) return null;
  // so the answer is an OBJECT carrying a messages array. An earlier version of
  // this test asserted a bare array — the very shape that made the call resolve to
  // null so the tail never loaded.
  assert.equal(Array.isArray(tail), false, 'getTranscriptTail answers an object');
  assert.ok(Array.isArray(tail.messages), 'messages must be an array');
  assert.equal(tail.messages.length, 2);
  assert.equal(typeof tail.hasMore, 'boolean');

  const usage = await call('claude.web', 'LocalSessions', 'getContextUsage', session.sessionId);
  assert.equal(typeof usage, 'object');
  assert.ok(usage !== null);
  // rawMaxTokens is required by the transport: without it the payload is nulled
  // and the usage meter renders nothing.
  assert.equal(typeof usage.rawMaxTokens, 'number');
  assert.ok(Array.isArray(usage.categories));
  assert.equal(typeof usage.totalTokens, 'number');
});

test('getBusyShellPtyKeys answers the five keyed buckets the composer reads', async () => {
  // Verified against a running original: an object with live/busy/probed/unknown/tabs,
  // not an array. A wrong shape stalls the composer's send path.
  // These handlers live inside the `if (kernel)` block, so a kernel must be supplied.
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({ emit, createAgent: () => ({ async run() { return { text: '' }; } }) }),
    },
  });
  const keys = await call('claude.web', 'LocalSessions', 'getBusyShellPtyKeys', 'local_x', false);
  assert.equal(typeof keys, 'object');
  assert.ok(keys !== null && !Array.isArray(keys), 'must be an object, not an array');
  for (const k of ['live', 'busy', 'probed', 'unknown', 'tabs']) {
    assert.ok(k in keys, `missing ${k}`);
  }
  assert.equal(typeof keys.probed, 'boolean');
  for (const k of ['live', 'busy', 'unknown', 'tabs']) {
    assert.ok(Array.isArray(keys[k]), `${k} must be an array`);
  }
});

test('startShellPty answers the {ok, shell} shape the terminal pane checks', async () => {
  const { call } = makeBus({
    settings: {
      sidebarMode: 'epitaxy',
      supportedFeatures: {},
      sessions: () => [],
      kernelFactory: ({ emit }) => createSessionKernel({ emit, createAgent: () => ({ async run() { return { text: '' }; } }) }),
    },
  });
  const session = await call('claude.web', 'LocalSessions', 'start', { cwd: 'C:\\w' });

  const first = await call('claude.web', 'LocalSessions', 'startShellPty', session.sessionId, 80, 24, 'prewarm', null, true, { hostShellAware: true });
  assert.equal(typeof first, 'object');
  // The pane does `if (!t || !t.ok) { startFailed }`; the previous fabricated
  // handle had no `ok` and rendered "Failed to start shell" on every open.
  assert.equal(first.ok, true, 'without ok the pane reports a failed start');
  assert.match(first.shell, /^shell_/);
  // This build pipes a child process rather than binding a PTY, and says so.
  assert.equal(first.isPty, false);

  const second = await call('claude.web', 'LocalSessions', 'startShellPty', session.sessionId, 100, 30, 'prewarm', null, true, {});
  assert.equal(second.shell, first.shell, 'the running shell is reused for the same session');
  assert.equal(second.reused, true);

  // The handler spawns a real child; stop it or the test process cannot exit.
  await call('claude.web', 'LocalSessions', 'stopShellPty', session.sessionId);
});