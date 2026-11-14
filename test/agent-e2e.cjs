// Live end-to-end agent test through the real desktop wiring.
//
// Boots the same stack main.cjs uses (server in agent mode + EipcBus + consent
// manager), then drives one prompt from the renderer. The model must call a
// tool, the consent window must appear, and approving it must actually change
// the workspace.
//
// Needs credentials:
//   ANTHROPIC_AUTH_TOKEN, CLAUDE_AGENT_MODEL (or ANTHROPIC_MODEL)
// Skips (exit 0 with skipped:true) when they are absent, so CI stays green.
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
let workspace;

async function answerConsent(decision) {
  for (let i = 0; i < 240; i++) {
    const target = BrowserWindow.getAllWindows().find(win => win !== mainWindow && !win.isDestroyed());
    if (target) {
      const state = await target.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('${decision}');
        if (!button) return 'missing';
        if (button.disabled) return 'disabled';
        button.click();
        return 'clicked';
      })()`).catch(() => 'gone');
      if (state === 'clicked') return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_AGENT_MODEL || process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no credentials' }));
    app.exit(0);
    return;
  }

  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');
  const { ConsentManager } = require('../desktop/consent-manager.cjs');
  const { createAgentRunner } = require('../desktop/agent-config.cjs');
  const { MODES } = require('../desktop/permissions.cjs');

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'original content\n');
  const dataDir = path.join(workspace, '..', `agent-e2e-data-${process.pid}`);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload-main-view.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  const consentManager = new ConsentManager({ parentWindow: win, ipcMain });
  consentManager.register();
  consent = consentManager;

  const runner = createAgentRunner({
    workspaceRoot: workspace,
    approve: request => consentManager.ask(request),
    env: { ...process.env, CLAUDE_PERMISSION_MODE: MODES.ASK },
  });

  server = createApp({
    dataDir,
    mode: 'agent',
    agent: { run: options => runner.run(options), model: runner.model },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  bus = new EipcBus();
  detach = registerDesktopServices({
    bus, mainWindow: win, sessions: server.sessions, mode: 'agent', consent: consentManager,
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  const js = code => win.webContents.executeJavaScript(code);

  const session = await js(`window.claudeAppBindings.createSession({ title: 'agent e2e', projectPath: ${JSON.stringify(workspace)} })`);

  const promptPromise = js(
    `window.claudeAppBindings.sendPrompt(${JSON.stringify(session.id)}, ` +
    `'Use the Write tool to set target.txt to the exact text: AGENT_WROTE_THIS\\n')`,
  );

  // Approve any tool the model asks for. Bounded so a hang fails the test.
  let approvals = 0;
  for (let i = 0; i < 40; i++) {
    const offered = BrowserWindow.getAllWindows().some(w => w !== win && !w.isDestroyed());
    if (offered) {
      if (await answerConsent('allow')) approvals++;
      await new Promise(resolve => setTimeout(resolve, 300));
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  await promptPromise;

  // Wait for the run to finish.
  let stored = null;
  for (let i = 0; i < 120; i++) {
    stored = await js(`window.claudeAppBindings.getSession(${JSON.stringify(session.id)})`);
    const last = stored.messages[stored.messages.length - 1];
    if (last && last.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const last = stored.messages[stored.messages.length - 1];
  const finalBytes = fs.readFileSync(path.join(workspace, 'target.txt'), 'utf8');
  const toolsUsed = (last.tools || []).map(tool => `${tool.name}:${tool.status}`);

  console.log(JSON.stringify({
    ok: last.status === 'completed' && finalBytes.includes('AGENT_WROTE_THIS'),
    status: last.status,
    approvals,
    toolsUsed,
    assistantText: String(last.text || '').slice(0, 200),
    fileAfter: finalBytes.trim(),
  }, null, 1));

  assert.equal(last.status, 'completed', `run failed: ${last.error || 'unknown'}`);
  assert.ok(toolsUsed.length > 0, 'the model never called a tool');
  assert.ok(finalBytes.includes('AGENT_WROTE_THIS'), `file not written; got ${JSON.stringify(finalBytes)}`);

  detach?.();
  consentManager.dispose();
  bus.dispose();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  server.closeAllConnections();
  server.close(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
    app.exit(0);
  });
}

app.whenReady().then(main).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { consent?.dispose(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});

