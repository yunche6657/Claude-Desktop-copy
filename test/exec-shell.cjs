// Local execution through the real desktop shell.
//
// Unlike consent-e2e.cjs, which drives ConsentManager directly, this test boots
// the same wiring main.cjs uses (EipcBus + registerDesktopServices + the
// LocalExecution service + ConsentManager) and then drives it from the renderer
// through the preload bridge. That covers the path a user actually takes:
// type a command in the panel, approve it in the separate window, read output.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let consent;
let detach;
let mainWindow;

async function clickConsent(decision) {
  for (let i = 0; i < 60; i++) {
    const target = BrowserWindow.getAllWindows().find(win => win !== mainWindow && !win.isDestroyed());
    if (target) {
      const state = await target.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('${decision}');
        if (!button) return 'missing';
        if (button.disabled) return 'disabled';
        button.click();
        return 'clicked';
      })()`).catch(() => 'gone');
      if (state === 'clicked') return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`consent window never offered #${decision}`);
}

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');
  const { ConsentManager } = require('../desktop/consent-manager.cjs');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-shell-'));
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
  consent = new ConsentManager({ parentWindow: mainWindow, ipcMain });
  consent.register();
  detach = registerDesktopServices({ bus, mainWindow, sessions: server.sessions, mode: 'demo', consent });

  await mainWindow.loadURL(origin);

  // The renderer calls runCommand through the preload bridge; the main process
  // must show the consent window. Kick the call off without awaiting, approve
  // it from the test, then read the result.
  const pending = mainWindow.webContents.executeJavaScript(
    `window.claudeAppBindings.runCommand({ command: 'node --version', toolName: 'Bash' })`,
  ).catch(error => ({ thrown: String(error && error.message) }));

  await new Promise(resolve => setTimeout(resolve, 500));
  await clickConsent('allow');
  const allowed = await pending;
  assert.equal(allowed.thrown, undefined, `renderer call threw: ${allowed.thrown}`);
  assert.equal(allowed.denied, undefined, 'an allow must not come back denied');
  assert.equal(allowed.exitCode, 0);
  assert.match(allowed.stdout, /^v\d+\./);

  // Denial from the renderer's perspective.
  const pendingDenied = mainWindow.webContents.executeJavaScript(
    `window.claudeAppBindings.runCommand({ command: 'node --version', toolName: 'Bash' })`,
  );
  await new Promise(resolve => setTimeout(resolve, 500));
  await clickConsent('cancel');
  const denied = await pendingDenied;
  assert.equal(denied.denied, true);
  assert.equal(denied.decision, 'cancel');

  // A non-allowlisted command must be refused by the exec policy, not merely by
  // the consent dialog. Because consent runs first, the refusal surfaces after
  // approval — the point is that approving does not make it runnable.
  const pendingBanned = mainWindow.webContents.executeJavaScript(
    `window.claudeAppBindings.runCommand({ command: 'curl http://example.com' })`,
  ).then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  await new Promise(resolve => setTimeout(resolve, 500));
  await clickConsent('allow');
  const banned = await pendingBanned;
  const refusedAfterApproval = Boolean(banned.thrown && /allowlist/.test(banned.thrown));
  assert.equal(refusedAfterApproval, true, `approved non-allowlisted command was not refused: ${JSON.stringify(banned)}`);

  console.log(JSON.stringify({
    ok: true,
    allow: { exitCode: allowed.exitCode, stdout: allowed.stdout.trim() },
    deny: { denied: denied.denied, decision: denied.decision },
    bannedRefusedAfterApproval: refusedAfterApproval,
  }));

  detach?.();
  consent.dispose();
  bus.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { consent?.dispose(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
