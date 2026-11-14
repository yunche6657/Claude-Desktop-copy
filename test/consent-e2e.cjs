// Consent + local execution end-to-end test.
//
// Drives the real consent window: it opens the dialog, clicks the primary
// button, and asserts that an allow runs the command and a cancel does not.
// Both paths are verified against actual child-process output, not mocks.
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

// Clicks the visible consent window's primary button. The window is found by
// title-less modal ownership: it is the only BrowserWindow besides the main one.
async function clickConsent(decision) {
  const target = BrowserWindow.getAllWindows().find(win => win !== mainWindow && !win.isDestroyed());
  if (!target) throw new Error('consent window never opened');
  // The dialog disables its buttons for 500ms after focus to stop a click that
  // opened the window from confirming it, so wait for the button to enable.
  for (let i = 0; i < 40; i++) {
    const state = await target.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('${decision}');
      if (!button) return 'missing';
      if (button.disabled) return 'disabled';
      button.click();
      return 'clicked';
    })()`);
    if (state === 'clicked') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('consent button never became clickable');
}

async function askAndRun(request) {
  const policy = { allowedRoots: null };
  const decision = await consent.ask(request);
  if (decision !== 'allow') return { denied: true, decision };
  const { runCommand } = require('../desktop/local-exec.cjs');
  return await runCommand(request, policy);
}

let mainWindow;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { ConsentManager } = require('../desktop/consent-manager.cjs');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-e2e-'));
  server = createApp({ dataDir, mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  mainWindow = new BrowserWindow({ show: false, width: 900, height: 600 });
  await mainWindow.loadURL(`http://127.0.0.1:${server.address().port}`);

  bus = new EipcBus();
  consent = new ConsentManager({ parentWindow: mainWindow, ipcMain });
  consent.register();

  // 1. Allow runs the command.
  const allowed = askAndRun({ kind: 'run-command', command: 'node --version', toolName: 'Bash' });
  await new Promise(resolve => setTimeout(resolve, 600));
  await clickConsent('allow');
  const allowedResult = await allowed;
  assert.equal(allowedResult.denied, undefined, 'an allow must not be reported as denied');
  assert.equal(allowedResult.exitCode, 0);
  assert.match(allowedResult.stdout, /^v\d+\./);

  // 2. Cancel must not run anything.
  const denied = askAndRun({ kind: 'run-command', command: 'node --version', toolName: 'Bash' });
  await new Promise(resolve => setTimeout(resolve, 600));
  await clickConsent('cancel');
  const deniedResult = await denied;
  assert.equal(deniedResult.denied, true);
  assert.equal(deniedResult.decision, 'cancel');
  assert.equal(deniedResult.stdout, undefined, 'a cancelled run must not produce output');

  // 3. An unsupported kind is refused instead of prompting.
  let refused = false;
  try { await consent.ask({ kind: 'connect', connectorName: 'x' }); }
  catch (error) { refused = /MCP host/.test(error.message); }
  assert.equal(refused, true, 'MCP consent kinds must be refused, not faked');

  // 4. A prompt that nobody answers resolves on its deadline.
  const timedOut = await consent.ask({ kind: 'run-command', command: 'node --version' }, { timeoutMs: 300 });
  assert.equal(timedOut, 'timeout');

  console.log(JSON.stringify({
    ok: true,
    allow: { exitCode: allowedResult.exitCode, stdout: allowedResult.stdout.trim() },
    cancel: { denied: deniedResult.denied, decision: deniedResult.decision },
    mcpRefused: refused,
    timeout: timedOut,
  }));

  consent.dispose();
  bus.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  try { consent?.dispose(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
