import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const actualMcp = require('../desktop/mcp-host.cjs');

test('main service config status preserves a real connected MCP server and shutdown closes it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-main-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
  fs.writeFileSync(path.join(directory, 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [fixture, '--mode', 'ok'] } },
  }));
  let host;
  class ObservedHost extends actualMcp.McpHost {
    constructor(...args) { super(...args); host = this; }
  }
  const originalLoad = Module._load;
  let registerDesktopServices;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return { app: { getPath: () => directory }, dialog: {} };
      if (request === './mcp-host.cjs' && parent?.filename.endsWith('main-services.cjs')) return { ...actualMcp, McpHost: ObservedHost };
      return originalLoad.apply(this, arguments);
    };
    ({ registerDesktopServices } = require('../desktop/main-services.cjs'));
  } finally {
    Module._load = originalLoad;
  }
  const services = new Map();
  const bus = { registerView() {}, registerService(_namespace, name, methods) { services.set(name, methods); }, emit() {} };
  const window = new EventEmitter();
  window.webContents = {};
  const detach = registerDesktopServices({ bus, mainWindow: window, sessions: {}, mode: 'demo', consent: null });
  t.after(() => detach());
  const mcp = services.get('McpHost');
  assert.equal(mcp.getConfigStatus().loaded, true);
  assert.equal((await mcp.connectServer(null, 'fixture')).status, 'connected');
  const connection = host.servers.get('fixture').connection;
  const before = await mcp.callTool(null, 'fixture', 'echo', { text: 'before' });
  assert.equal(before.content[0].text, 'before');
  for (let i = 0; i < 2; i++) {
    const status = mcp.getConfigStatus();
    assert.equal(status.servers[0].status, 'connected');
    assert.equal(status.servers[0].toolCount, 2);
    assert.equal(host.servers.get('fixture').connection, connection);
  }
  const after = await mcp.callTool(null, 'fixture', 'echo', { text: 'after' });
  assert.equal(after.content[0].text, 'after');
  const exited = once(connection.child, 'close');
  detach();
  await exited;
  assert.deepEqual(host.list(), []);
});
