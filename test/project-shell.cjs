// Project browsing through the real desktop shell.
//
// Builds a workspace containing the things that matter for the tree: nested
// files, an ignored file, an always-skipped directory, and a symlink. Then it
// drives the renderer: pick a workspace, read the tree, and click a file to load
// it into the editor.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let detach;
let mainWindow;
let workspace;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-ws-'));
  const write = (rel, content) => {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('src/index.js', 'console.log(1);\n');
  write('src/deep/util.js', 'export const x = 1;\n');
  write('README.md', '# demo\n');
  write('secret.txt', 'hidden\n');
  write('.ignore', 'secret.txt\n');
  write('node_modules/pkg/i.js', 'x\n');

  const dataDir = path.join(workspace, '..', `proj-data-${process.pid}`);
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

  // The tree must refuse to run before a workspace exists, rather than walking
  // the process cwd.
  const beforePick = await js(`window.claudeAppBindings.listWorkspaceTree()`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(beforePick.thrown || '', /no workspace selected/);

  // Approve the workspace the same way the picker does.
  await js(`window.claudeAppSettings.updateSettings({ projectPath: ${JSON.stringify(workspace)} })`);

  const tree = await js(`window.claudeAppBindings.listWorkspaceTree({ maxEntries: 500 })`);
  assert.equal(tree.truncated, false);
  const paths = tree.entries.map(entry => entry.path);

  assert.ok(paths.includes('src'), 'src must be listed');
  assert.ok(paths.includes('src/index.js'), 'nested file must be listed');
  assert.ok(paths.includes('src/deep/util.js'), 'deeply nested file must be listed');
  assert.ok(paths.includes('README.md'));
  assert.ok(!paths.includes('secret.txt'), '.ignore must be applied');
  assert.ok(!paths.some(p => p.startsWith('node_modules')), 'node_modules must be skipped');

  // Directories claim their type correctly.
  const src = tree.entries.find(entry => entry.path === 'src');
  assert.equal(src.type, 'directory');
  assert.equal(tree.entries.find(entry => entry.path === 'README.md').type, 'file');

  // One-level listing agrees with the full tree.
  const top = await js(`window.claudeAppBindings.listWorkspaceDirectory('')`);
  assert.ok(top.some(entry => entry.name === 'src' && entry.type === 'directory'));
  assert.ok(!top.some(entry => entry.name === 'secret.txt'));

  // Escaping the workspace is refused.
  const escape = await js(`window.claudeAppBindings.listWorkspaceDirectory('..')`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(escape.thrown || '', /escapes the workspace/);

  // Now drive the UI: open the project panel, refresh the tree, click a file.
  const ui = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('project-panel').hidden = false;
    document.getElementById('project-refresh').click();
    for (let i = 0; i < 100 && document.querySelectorAll('#project-tree .project-row').length === 0; i++) {
      await wait(50);
    }
    const rows = [...document.querySelectorAll('#project-tree .project-row')];
    const labels = rows.map(r => r.querySelector('.label').textContent);
    const target = rows.find(r => r.dataset.path === 'src/index.js');
    if (!target) return { rows: labels, clicked: false };
    target.click();
    for (let i = 0; i < 100 && document.getElementById('edit-content').value === ''; i++) {
      await wait(50);
    }
    return {
      rows: labels,
      clicked: true,
      panelHidden: document.getElementById('edit-panel').hidden,
      loadedPath: document.getElementById('edit-path').value,
      loadedContent: document.getElementById('edit-content').value,
    };
  })()`);

  assert.equal(ui.clicked, true, `file row not rendered: ${JSON.stringify(ui.rows)}`);
  assert.ok(ui.rows.includes('src/index.js'), 'the tree must render the nested file');
  assert.ok(!ui.rows.includes('secret.txt'), 'the rendered tree must not show ignored files');
  assert.equal(ui.panelHidden, false, 'clicking a file must open the editor');
  assert.equal(ui.loadedPath, 'src/index.js');
  assert.match(ui.loadedContent, /console\.log\(1\)/);

  console.log(JSON.stringify({
    ok: true,
    treeEntries: tree.entries.length,
    hasNested: paths.includes('src/deep/util.js'),
    ignoredHidden: !paths.includes('secret.txt'),
    skippedNodeModules: !paths.some(p => p.startsWith('node_modules')),
    escapeRefused: true,
    uiRows: ui.rows.length,
    clickedFile: ui.loadedPath,
  }));

  detach?.();
  bus.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  server.closeAllConnections();
  server.close(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
    app.exit(0);
  });
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
