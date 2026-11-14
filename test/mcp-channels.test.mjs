// The MCP channels were answering through the generic fallback; they now reach a real client.
//
// FOUND by ranking the 643 action-shaped fallbacks and then keeping only the ones the shipped
// frontend actually CALLS. The whole MCP family was in that set:
//
//   getLocalMcpServers / mcpListResources / mcpReadResource / mcpCallTool / mcpAuthenticate
//
// This was a real gap, not a deliberate omission: desktop/mcp-host.cjs already implements a
// complete MCP client (load / list / connect / callTool / disconnect / restart / stopAll) and the
// upstream main process implements all of these channels. The client had only ever been wired
// into main-services.cjs (the hand-drawn shell), so the shipped frontend could not see it.
//
// The user's own ~/.claude.json carries a real mcpServers block, so these tests run against the
// real config path rather than a fixture (CLAUDE_MCP_CONFIG overrides it when needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A bridge over a real kernel, with the MCP config pointed at a temp file. */
async function makeBridge(mcpConfig, seedConnected) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-mcp-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const configPath = path.join(os.tmpdir(), 'dsh-mcpcfg-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const seedEntry = { command: 'fixture-command', args: [] };
  const fixtureConfig = seedConnected
    ? { ...mcpConfig, mcpServers: { ...mcpConfig?.mcpServers, [seedConnected.name]: seedEntry } }
    : mcpConfig;
  if (fixtureConfig !== undefined) fs.writeFileSync(configPath, JSON.stringify(fixtureConfig));
  const saved = process.env.CLAUDE_MCP_CONFIG;
  process.env.CLAUDE_MCP_CONFIG = configPath;
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  kernel.start({ sessionId: 's' });
  // A fake CONNECTED server, so the handlers' deeper branches (the ones that actually call the
  // connection) are reachable without a real MCP process. Without this the tests only ever
  // exercised the early `not connected` returns, and mutating the real branch stayed green
  // (measured).
  const seededHost = seedConnected ? (() => {
    const { McpHost, normaliseServer } = require(path.join(ROOT, 'desktop', 'mcp-host.cjs'));
    const host = new McpHost();
    host.servers.set(seedConnected.name, {
      status: 'connected',
      server: normaliseServer(seedConnected.name, seedEntry),
      tools: [],
      connection: seedConnected.connection,
    });
    return host;
  })() : undefined;
  const handlers = new Map();
  registerBridgeServices(Object.assign({
    ...(seededHost ? { mcpHost: seededHost } : {}),
  }, {
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  }));
  // Match on the SERVICE too: several namespaces declare the same method name, and matching only
  // the suffix picked the wrong one (measured: mcpCallTool appeared to answer null).
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => {
      const parts = c.split('_$_');
      return parts[parts.length - 2] === service && parts[parts.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return {
    call,
    host: seededHost,
    kernel,
    cleanup: () => {
      try { fs.unlinkSync(storePath); } catch { /* gone */ }
      try { fs.unlinkSync(configPath); } catch { /* gone */ }
      if (saved === undefined) delete process.env.CLAUDE_MCP_CONFIG; else process.env.CLAUDE_MCP_CONFIG = saved;
    },
  };
}

test('getLocalMcpServers answers an array, never null', async () => {
  const b = await makeBridge({ mcpServers: {} });
  try {
    const servers = await b.call('LocalSessions', 'getLocalMcpServers');
    assert.ok(Array.isArray(servers), 'getLocalMcpServers answered ' + JSON.stringify(servers) + '; the panel maps over it');
  } finally { b.cleanup(); }
});

test('resource IPC refuses missing and host-launcher sessions before contacting the server', async () => {
  const calls = [];
  const b = await makeBridge({ mcpServers: {} }, {
    name: 'live-server',
    connection: {
      async listResources() { calls.push('list'); return [{ uri: 'test:1' }]; },
      async readResource() { calls.push('read'); return [{ uri: 'test:1' }]; },
    },
  });
  try {
    assert.deepEqual(await b.call('LocalSessions', 'mcpListResources', 'missing', 'live-server'), []);
    assert.deepEqual(await b.call('LocalSessions', 'mcpReadResource', 'missing', 'live-server', 'test:1'), { contents: [] });
    assert.deepEqual(await b.call('LocalSessions', 'mcpCallTool', 'missing', 'live-server', 'tool', {}), { content: [{ type: 'text', text: 'Session not found' }], isError: true });
    const originalGetSession = b.kernel.getSession;
    for (const flag of ['_startedThroughHostCliLauncher', '_everStartedThroughHostCliLauncher', 'launcherMarked']) {
      b.kernel.getSession = id => id === 's' ? { ...originalGetSession(id), [flag]: true } : originalGetSession(id);
      assert.deepEqual(await b.call('LocalSessions', 'mcpListResources', 's', 'live-server'), []);
      assert.deepEqual(await b.call('LocalSessions', 'mcpReadResource', 's', 'live-server', 'test:1'), { contents: [] });
      assert.deepEqual(await b.call('LocalSessions', 'mcpCallTool', 's', 'live-server', 'tool', {}), { content: [{ type: 'text', text: 'Not available for this session: this app makes no connector calls for it.' }], isError: true });
    }
    assert.deepEqual(calls, []);
    b.kernel.getSession = id => id === 's' ? { ...originalGetSession(id), backend: { remoteTarget: {} }, launcherMarked: true } : originalGetSession(id);
    assert.deepEqual(await b.call('LocalSessions', 'mcpListResources', 's', 'live-server'), [{ uri: 'test:1' }]);
    assert.deepEqual(calls, ['list']);
  } finally { b.cleanup(); }
});

test('getLocalMcpServers reports the servers from the config', async () => {
  const b = await makeBridge({ mcpServers: { 'alpha-server': { command: 'node', args: ['-e', ''] } } });
  try {
    const servers = await b.call('LocalAgentModeSessions', 'getLocalMcpServers');
    assert.equal(servers.length, 1, 'the configured server was not listed: ' + JSON.stringify(servers));
    assert.equal(servers[0].name, 'alpha-server');
    // The renderer reads status; a server that was never connected is not 'connected'.
    assert.notEqual(servers[0].status, 'connected');
  } finally { b.cleanup(); }
});

test('mcpListResources answers an array for a server that is not connected', async () => {
  // The panel renders 'no resources' for an empty array; an error would take the route down.
  const b = await makeBridge({ mcpServers: { 'alpha-server': { command: 'node', args: ['-e', ''] } } });
  try {
    const resources = await b.call('LocalSessions', 'mcpListResources', 'session-x', 'alpha-server');
    assert.ok(Array.isArray(resources), 'mcpListResources answered ' + JSON.stringify(resources));
    assert.deepEqual(resources, []);
  } finally { b.cleanup(); }
});

test('mcpReadResource answers the { contents } container', async () => {
  // The consumer reads `.contents`; answering a bare array renders an empty preview silently.
  const b = await makeBridge({ mcpServers: {} });
  try {
    const answer = await b.call('LocalSessions', 'mcpReadResource', 'session-x', 'alpha-server', 'file:///x');
    assert.ok(answer && typeof answer === 'object', 'mcpReadResource answered ' + JSON.stringify(answer));
    assert.ok(Array.isArray(answer.contents), 'the contents container is missing');
  } finally { b.cleanup(); }
});

test('mcpCallTool reports an unknown server as a tool error, not a rejection', async () => {
  const b = await makeBridge({ mcpServers: {} });
  try {
    const answer = await b.call('LocalSessions', 'mcpCallTool', 's', 'no-such-server', 'someTool', {});
    assert.ok(answer && typeof answer === 'object', 'mcpCallTool answered ' + JSON.stringify(answer));
    assert.equal(answer.isError, true, 'a failed tool call must be marked isError');
    assert.ok(Array.isArray(answer.content) && answer.content.length > 0, 'the failure carried no content');
    assert.match(String(answer.content[0].text), /no server named/i);
  } finally { b.cleanup(); }
});

test('mcpAuthenticate refuses explicitly instead of answering null', async () => {
  // OAuth needs a browser round trip and a loopback callback server; this build has neither.
  // A null answer left the UI spinning, which is worse than a stated refusal.
  const b = await makeBridge({ mcpServers: {} });
  try {
    const answer = await b.call('LocalSessions', 'mcpAuthenticate', 'session-x', 'alpha-server');
    assert.ok(answer && typeof answer === 'object', 'mcpAuthenticate answered ' + JSON.stringify(answer));
    assert.equal(answer.error, 'Session not running');
  } finally { b.cleanup(); }
});

test('MCP session verbs forward session and arguments without restarting the shared host', async () => {
  const b = await makeBridge({ mcpServers: {} });
  try {
    assert.deepEqual(await b.call('LocalSessions', 'mcpReconnect', 'session-x', 'server'), { error: 'Session not running' });
    const calls = [];
    for (const method of ['mcpReconnect', 'mcpRetryConnection', 'mcpEnableServer']) {
      b.kernel[method] = (...args) => { calls.push([method, ...args]); return { queued: true, error: 'Turn in progress' }; };
      assert.deepEqual(await b.call('LocalSessions', method, 's', 'server', 'dialog'), { queued: true, error: 'Turn in progress' });
    }
    assert.deepEqual(calls, ['mcpReconnect', 'mcpRetryConnection', 'mcpEnableServer'].map(method => [method, 's', 'server', 'dialog']));
  } finally { b.cleanup(); }
});

test('a CONNECTED server is asked for its resources, and the answer is unwrapped', async () => {
  // This is the branch the earlier version never reached: with no connected server the handler
  // returns early, so mutating the real `contents` wrapping stayed green.
  const calls = [];
  const b = await makeBridge({ mcpServers: {} }, {
    name: 'live-server',
    connection: {
      async listResources() { calls.push('list'); return [{ uri: 'file:///a', name: 'a' }]; },
      async readResource(uri) { calls.push('read:' + uri); return [{ uri, text: 'BODY' }]; },
    },
  });
  try {
    const resources = await b.call('LocalSessions', 'mcpListResources', 's', 'live-server');
    assert.deepEqual(calls, ['list'], 'the connection was not asked for resources');
    assert.deepEqual(resources, [{ uri: 'file:///a', name: 'a' }]);

    const read = await b.call('LocalSessions', 'mcpReadResource', 's', 'live-server', 'file:///a');
    assert.ok(calls.includes('read:file:///a'), 'the connection was not asked to read');
    assert.ok(Array.isArray(read.contents), 'the { contents } wrapper is missing for a connected server');
    assert.equal(read.contents[0].text, 'BODY');
  } finally { b.cleanup(); }
});

test('a CONNECTED server whose call throws is reported as a tool error', async () => {
  const b = await makeBridge({ mcpServers: {} }, {
    name: 'broken-server',
    connection: {
      async listResources() { throw new Error('boom'); },
      async readResource() { throw new Error('boom'); },
    },
  });
  try {
    // The list degrades to empty rather than throwing into the renderer.
    assert.deepEqual(await b.call('LocalSessions', 'mcpListResources', 's', 'broken-server'), []);
    const read = await b.call('LocalSessions', 'mcpReadResource', 's', 'broken-server', 'file:///x');
    assert.deepEqual(read, { contents: [] });
  } finally { b.cleanup(); }
});

test('a DISCONNECTED server is not asked, and still answers an array', async () => {
  // WHY THIS EXISTS: mutating the status check away left every test green, because with no
  // connection the handler threw and the catch returned the same empty array. MEASURED with a
  // server that has a connection object but status 'disconnected': the correct answer is [],
  // while the mutant returned null (it called into the connection and the real client refused).
  // An array is what the panel maps over, so null is a visible break, not an equivalent.
  const calls = [];
  const b = await makeBridge({ mcpServers: {} }, {
    name: 'idle-server',
    connection: { async listResources() { calls.push('list'); return [{ uri: 'x' }]; } },
  });
  try {
    const host = b.host;
    // Force the seeded server back to 'disconnected' while keeping its connection object.
    host.servers.get('idle-server').status = 'disconnected';
    const resources = await b.call('LocalSessions', 'mcpListResources', 's', 'idle-server');
    assert.deepEqual(resources, [], 'a disconnected server must answer an empty array');
    assert.deepEqual(calls, [], 'a disconnected server was asked for resources');
  } finally { b.cleanup(); }
});

test('the MCP channels are registered with real handlers', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  for (const method of ['getLocalMcpServers', 'mcpListResources', 'mcpReadResource', 'mcpCallTool']) {
    assert.ok(bridge.includes('_$_' + method + "'"), method + ' has no handler');
  }
});
