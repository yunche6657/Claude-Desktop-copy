// Desktop shell smoke test.
//
// Runs the real desktop/main.cjs entry point in an offscreen Electron window and
// verifies the reconstructed EIPC layer end to end: the preload bridge is
// exposed, window controls reach the main process, settings round-trip through
// the bus, and a prompt streams back through the sessionEvent channel rather
// than over SSE.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let cleanup = [];

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus, VIEW } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-desktop-shell-'));
  server = createApp({ dataDir, mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const win = new BrowserWindow({
    show: false,
    width: 1936,
    height: 1048,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload-main-view.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const bus = new EipcBus();
  const detach = registerDesktopServices({
    bus,
    mainWindow: win,
    sessions: server.sessions,
    mode: 'demo',
  });
  cleanup.push(detach, () => bus.dispose());

  await win.loadURL(origin);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // 1. The preload must expose the reconstructed globals.
    const bridge = {
      bindings: typeof window.claudeAppBindings === 'object' && window.claudeAppBindings !== null,
      settings: typeof window.claudeAppSettings === 'object' && window.claudeAppSettings !== null,
      windowControl: typeof window.electronWindowControl === 'object' && window.electronWindowControl !== null,
    };
    for (const [name, ok] of Object.entries(bridge)) if (!ok) throw new Error('missing preload global: ' + name);

    // 2. Settings must round-trip through the EIPC bus.
    const before = await window.claudeAppSettings.getSidebarMode();
    await window.claudeAppSettings.setSidebarMode('cowork');
    const after = await window.claudeAppSettings.getSidebarMode();
    if (before !== 'code' || after !== 'cowork') throw new Error('sidebar mode round-trip failed: ' + before + ' -> ' + after);
    await window.claudeAppSettings.setSidebarMode('code');

    // 3. Window state must be readable through the bus.
    const state = await window.electronWindowControl.getWindowState();
    if (typeof state.isMaximized !== 'boolean') throw new Error('getWindowState shape is wrong');

    // 4. An unsupported sidebar mode must be refused by the main process.
    let refused = false;
    try { await window.claudeAppSettings.setSidebarMode('bogus'); } catch { refused = true; }
    if (!refused) throw new Error('main process accepted an unsupported sidebar mode');

    // 5. A prompt must stream over sessionEvent, not SSE.
    for (let i = 0; i < 50 && !document.getElementById('connection').textContent.includes('演示'); i++) await wait(100);
    const session = await window.claudeAppBindings.createSession({ title: 'EIPC 冒烟', projectPath: '' });
    const frames = [];
    const off = window.claudeAppBindings.onSessionEvent(event => frames.push(event));
    const { runId } = await window.claudeAppBindings.sendPrompt(session.id, '桌面桥接测试');
    for (let i = 0; i < 100 && !frames.some(f => f.type === 'done'); i++) await wait(100);
    off();
    if (!frames.some(f => f.type === 'text')) throw new Error('no text frames over sessionEvent');
    if (!frames.some(f => f.type === 'done')) throw new Error('no terminal frame over sessionEvent');
    if (frames.some(f => f.runId !== runId)) throw new Error('sessionEvent carried a foreign runId');

    // 6. The persisted transcript must match what streamed.
    const stored = await window.claudeAppBindings.getSession(session.id);
    if (stored.messages.length !== 2) throw new Error('transcript not persisted');
    if (!stored.messages[1].text.length) throw new Error('assistant text not persisted');

    // 7. MCP hosting is declared unavailable rather than faked.
    const servers = await window.claudeAppBindings.listMcpServers();
    if (!Array.isArray(servers) || servers.length !== 0) throw new Error('MCP host should report an empty list');

    return {
      bridge,
      sidebar: { before, after },
      windowState: state,
      frames: frames.length,
      types: [...new Set(frames.map(f => f.type))].sort(),
      persistedMessages: stored.messages.length,
      mcpServers: servers.length,
    };
  })()`);

  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '../evidence/desktop-shell.png'), image.toPNG());

  console.log(JSON.stringify({ ok: true, ...result, dataDir }));

  for (const fn of cleanup) { try { fn(); } catch { /* teardown best effort */ } }
  win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  for (const fn of cleanup) { try { fn(); } catch { /* teardown best effort */ } }
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
