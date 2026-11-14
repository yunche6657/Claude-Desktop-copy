// MCP hosting through the real desktop shell.
//
// Writes a real mcp.json, lets the main process load it, then drives connect /
// list / callTool from the renderer over the EIPC bridge. The fixture server is
// a real child process, so this covers config parsing, spawn, handshake and
// tool invocation as one path.
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let detach;
let mainWindow;
let dir;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shell-'));
  const configPath = path.join(dir, 'mcp.json');
  const fixture = path.join(__dirname, 'fixtures', 'mcp-server.mjs');
  // Electron's process.execPath is electron.exe, not node. Running the fixture
  // through it requires ELECTRON_RUN_AS_NODE, which the spawn env carries.
  // A real Streamable-HTTP MCP server on loopback, so the http transport is
  // exercised over actual HTTP rather than a stub.
  const httpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let message;
      try { message = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const send = result => {
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(req.headers['mcp-session-id'] ? {} : { 'mcp-session-id': 'sess-shell' }),
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') { send({ protocolVersion: '2025-06-18', capabilities: {} }); return; }
      if (message.method === 'tools/list') { send({ tools: [{ name: 'ping' }] }); return; }
      if (message.method === 'tools/call') {
        send({ content: [{ type: 'text', text: `pong:${message.params?.arguments?.text ?? ''}` }] });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }));
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = httpServer.address().port;

  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      fixture: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture, '--mode', 'ok'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      broken: { type: 'stdio' },
      remote: { type: 'http', url: `http://127.0.0.1:${httpPort}/mcp` },
      legacy: { type: 'sse', url: 'https://example.invalid/sse' },
    },
  }, null, 2));

  const dataDir = path.join(dir, 'data');
  server = createApp({ dataDir, mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload-main-view.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bus = new EipcBus();
  detach = registerDesktopServices({ bus, mainWindow, sessions: server.sessions, mode: 'demo', consent: null });
  await mainWindow.loadURL(origin);

  const js = code => mainWindow.webContents.executeJavaScript(code);

  // Point the host at the config written above, then read the load result. The
  // service loads once at registration, so a status call after setting the path
  // is what surfaces the entries.
  const status = await js(`(async () => {
    await window.claudeAppSettings.updateSettings({ mcpConfigPath: ${JSON.stringify(configPath)} });
    return await window.claudeAppBindings.getMcpConfigStatus();
  })()`);

  assert.equal(status.loaded, true, `config did not load: ${JSON.stringify(status)}`);
  assert.deepEqual(status.accepted.sort(), ['fixture', 'remote']);
  // stdio and http are connectable; the malformed entry and the unimplemented sse
  // transport are both rejected, with distinct reasons.
  assert.deepEqual(status.rejected.map(r => r.name).sort(), ['broken', 'legacy']);
  assert.match(status.rejected.find(r => r.name === 'broken').error, /requires a command/);
  assert.match(status.rejected.find(r => r.name === 'legacy').error, /not implemented/);

  const listed = await js(`window.claudeAppBindings.listMcpServers()`);
  assert.equal(listed.length, 4);
  assert.equal(listed.find(s => s.name === 'fixture').status, 'disconnected');
  assert.equal(listed.find(s => s.name === 'broken').status, 'invalid');
  assert.equal(listed.find(s => s.name === 'remote').status, 'disconnected');
  assert.equal(listed.find(s => s.name === 'legacy').status, 'unsupported');

  // Connect the real server.
  const connected = await js(`window.claudeAppBindings.connectMcpServer('fixture')`);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.toolCount, 2);

  // Call a tool through the bridge.
  const called = await js(`window.claudeAppBindings.callMcpTool('fixture', 'add', { a: 7, b: 35 })`);
  assert.equal(called.content[0].text, '42');

  const echoed = await js(`window.claudeAppBindings.callMcpTool('fixture', 'echo', { text: '桥接' })`);
  assert.equal(echoed.content[0].text, '桥接');

  // The real HTTP server connects and answers a tool call.
  const remoteState = await js(`window.claudeAppBindings.connectMcpServer('remote')`);
  assert.equal(remoteState.status, 'connected');
  assert.equal(remoteState.toolCount, 1);
  const pong = await js(`window.claudeAppBindings.callMcpTool('remote', 'ping', { text: 'hi' })`);
  assert.equal(pong.content[0].text, 'pong:hi');
  await js(`window.claudeAppBindings.disconnectMcpServer('remote')`);

  // An unsupported transport still refuses, with an explicit reason.
  const legacyError = await js(`window.claudeAppBindings.connectMcpServer('legacy')`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(legacyError.thrown || '', /not implemented/);

  // Disconnect leaves the server listed but idle.
  const off = await js(`window.claudeAppBindings.disconnectMcpServer('fixture')`);
  assert.equal(off.status, 'disconnected');
  const afterOff = await js(`window.claudeAppBindings.listMcpServers()`);
  assert.equal(afterOff.find(s => s.name === 'fixture').toolCount, 0);

  // Calling while disconnected is refused rather than hanging.
  const idleError = await js(`window.claudeAppBindings.callMcpTool('fixture', 'echo', { text: 'x' })`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(idleError.thrown || '', /is disconnected/);

  console.log(JSON.stringify({
    ok: true,
    loaded: status.loaded,
    accepted: status.accepted.sort(),
    rejected: status.rejected.map(entry => entry.name),
    connected: { status: connected.status, tools: connected.toolCount },
    add: called.content[0].text,
    echo: echoed.content[0].text,
    httpTransport: remoteState.status,
    httpToolResult: pong.content[0].text,
    sseRefused: true,
    disconnectedStatus: off.status,
    idleCallRefused: true,
  }));

  detach?.();
  bus.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  try { httpServer.close(); } catch {}
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});


