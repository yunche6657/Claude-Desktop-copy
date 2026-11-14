// File tools and diff view through the real desktop shell.
//
// Verifies the paths a user actually takes: load a file, edit it, preview the
// diff, apply it; and that the permission mode changes whether a write prompts.
// The project path is set to a temporary workspace so the approved-root
// confinement is exercised rather than bypassed.
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

async function clickConsent(decision) {
  for (let i = 0; i < 200; i++) {
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
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`consent window never offered #${decision}`);
}

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');
  const { ConsentManager } = require('../desktop/consent-manager.cjs');

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'files-ws-'));
  const target = path.join(workspace, 'sample.js');
  fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-data-'));
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

  const js = code => mainWindow.webContents.executeJavaScript(code);

  // The workspace root has to be approved before any file call is legal.
  await js(`window.claudeAppSettings.updateSettings({ projectPath: ${JSON.stringify(workspace)} })`);

  // 1. Reads work in ask mode and return real bytes.
  const read = await js(`window.claudeAppBindings.readFile(${JSON.stringify(target)})`);
  assert.equal(read.lines, 3);
  assert.match(read.content, /const b = 2;/);

  // 2. A path outside the root is refused by the policy, not merely by consent.
  const outside = path.join(os.tmpdir(), 'not-in-workspace.txt');
  const outsideResult = await js(`window.claudeAppBindings.readFile(${JSON.stringify(outside)})`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(outsideResult.thrown || '', /outside the approved roots/,
    `outside-root read was not refused: ${JSON.stringify(outsideResult)}`);

  // 3. acceptEdits writes without a prompt.
  await js(`window.claudeAppBindings.setPermissionMode('acceptEdits')`);
  assert.equal(await js(`window.claudeAppBindings.getPermissionMode()`), 'acceptEdits');

  const edited = 'const a = 1;\nconst b = 42;\nconst c = 3;\n';
  const preview = await js(`window.claudeAppBindings.previewWrite(${JSON.stringify(target)}, ${JSON.stringify(edited)})`);
  assert.equal(preview.diff.added, 1);
  assert.equal(preview.diff.removed, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'preview must not write');

  const writeResult = await js(`window.claudeAppBindings.writeFile(${JSON.stringify(target)}, ${JSON.stringify(edited)})`);
  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.written, true);
  assert.equal(fs.readFileSync(target, 'utf8'), edited, 'acceptEdits must apply without prompting');

  // 4. ask mode prompts, and a cancel leaves the file untouched.
  await js(`window.claudeAppBindings.setPermissionMode('ask')`);
  const pendingDenied = js(
    `window.claudeAppBindings.writeFile(${JSON.stringify(target)}, ${JSON.stringify('REPLACED\n')})`,
  );
  await new Promise(resolve => setTimeout(resolve, 500));
  await clickConsent('cancel');
  const denied = await pendingDenied;
  assert.equal(denied.denied, true);
  assert.equal(denied.decision, 'cancel');
  assert.equal(fs.readFileSync(target, 'utf8'), edited, 'a cancelled write must not touch the file');

  // 5. ask mode with an allow does write.
  const pendingAllowed = js(
    `window.claudeAppBindings.writeFile(${JSON.stringify(target)}, ${JSON.stringify('REPLACED\n')})`,
  );
  await new Promise(resolve => setTimeout(resolve, 500));
  await clickConsent('allow');
  const allowed = await pendingAllowed;
  assert.equal(allowed.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'REPLACED\n');

  // 6. An unknown permission mode is refused.
  const badMode = await js(`window.claudeAppBindings.setPermissionMode('yolo')`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(badMode.thrown || '', /Unknown permission mode/);

  // 7. The diff view renders the real hunks in the DOM. The file is reset to a
  // known baseline first so the assertion does not depend on earlier steps.
  await js(`window.claudeAppBindings.setPermissionMode('acceptEdits')`);
  const baseline = 'const a = 1;\nconst b = 42;\nconst c = 3;\n';
  fs.writeFileSync(target, baseline);

  const rendered = await js(`(async () => {
    document.getElementById('edit-path').value = ${JSON.stringify(target)};
    document.getElementById('edit-form').requestSubmit();
    const area = document.getElementById('edit-content');
    // Wait for the load to actually populate the textarea, not merely for the
    // element to become visible: the submit is async.
    for (let i = 0; i < 80 && area.value === ''; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const loaded = area.value;
    area.value = 'const a = 1;\\nconst b = 99;\\nconst c = 3;\\n';
    document.getElementById('edit-preview').click();
    for (let i = 0; i < 80 && document.getElementById('diff-panel').hidden; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const added = [...document.querySelectorAll('#diff-body .diff-line.add .text')].map(n => n.textContent);
    const removed = [...document.querySelectorAll('#diff-body .diff-line.del .text')].map(n => n.textContent);
    const heads = [...document.querySelectorAll('#diff-body .diff-hunk-head')].map(n => n.textContent);
    return { added, removed, heads, loaded, panelHidden: document.getElementById('diff-panel').hidden };
  })()`);
  assert.equal(rendered.panelHidden, false, 'diff panel did not open');
  assert.equal(rendered.loaded, baseline, 'the editor must load the current bytes');
  assert.deepEqual(rendered.removed, ['const b = 42;']);
  assert.deepEqual(rendered.added, ['const b = 99;']);
  assert.equal(rendered.heads.length, 1);
  assert.match(rendered.heads[0], /^@@ -\d+,\d+ \+\d+,\d+ @@$/);

  // 8. Applying from the diff view writes the file.
  const applied = await js(`(async () => {
    document.getElementById('diff-apply').click();
    for (let i = 0; i < 60 && document.getElementById('diff-note').textContent !== '已写入。'; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return document.getElementById('diff-note').textContent;
  })()`);
  assert.equal(applied, '已写入。');
  assert.match(fs.readFileSync(target, 'utf8'), /const b = 99;/);

  console.log(JSON.stringify({
    ok: true,
    readLines: read.lines,
    outsideRefused: true,
    previewHunks: preview.diff.hunks.length,
    askDenied: denied.decision,
    askAllowed: allowed.ok,
    diff: { removed: rendered.removed, added: rendered.added },
    applied,
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

