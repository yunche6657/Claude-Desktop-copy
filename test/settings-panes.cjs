// Settings panes, exercised in a real window.
//
// Every pane must either render real content or say plainly why it cannot. A
// pane that silently renders an empty body is the failure mode this guards
// against: it looks implemented and is not.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let detach;
let dir;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panes-'));
  server = createApp({ dataDir: path.join(dir, 'data'), mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const win = new BrowserWindow({
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
  detach = registerDesktopServices({ bus, mainWindow: win, sessions: server.sessions, mode: 'demo', consent: null });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  // Seed sessions so the Usage pane has numbers to report.
  server.sessions.create({ title: '会话一', projectPath: '' });
  const second = server.sessions.create({ title: '会话二', projectPath: '' });
  server.sessions.send(second.id, '你好', () => {});
  await new Promise(resolve => setTimeout(resolve, 900));

  const js = code => win.webContents.executeJavaScript(code);

  await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(700);
    document.getElementById('settings').click();
    await wait(150);
    document.querySelector('#account-menu .menu-row[data-menu=settings]').click();
    await wait(400);
  })()`);

  const panes = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    const names = [...document.querySelectorAll('.settings-item')].map(i => i.dataset.pane);
    for (const name of names) {
      document.querySelector('.settings-item[data-pane="' + name + '"]').click();
      await wait(320);
      const pane = document.getElementById('settings-pane');
      out[name] = {
        title: pane.querySelector('.pane-title')?.textContent || '',
        rows: pane.querySelectorAll('.pane-row').length,
        buttons: pane.querySelectorAll('.pane-action').length,
        controls: pane.querySelectorAll('select, textarea, .toggle, .seg').length,
        notes: [...pane.querySelectorAll('.pane-unavailable')].map(n => n.textContent),
      };
    }
    return { names, out };
  })()`);

  const { names, out } = panes;
  assert.ok(names.length >= 11, `expected the full rail, got ${names.length}`);

  // No pane may render as an empty body with no explanation.
  for (const name of names) {
    const pane = out[name];
    const hasBody = pane.rows > 0 || pane.buttons > 0 || pane.controls > 0;
    const hasExplanation = pane.notes.length > 0 && pane.notes.some(note => note.trim().length > 10);
    assert.ok(hasBody || hasExplanation,
      `pane "${name}" rendered neither content nor a reason: ${JSON.stringify(pane)}`);
    assert.ok(pane.title.length > 0, `pane "${name}" must have a title`);
  }

  // Panes backed by local state must show real values.
  assert.ok(out.usage.rows >= 4, `Usage should report several figures, got ${out.usage.rows}`);
  assert.ok(out.skills.rows >= 6, `Skills should list the tools, got ${out.skills.rows}`);
  assert.equal(out.import.buttons, 2, 'Import & export must offer both actions');
  assert.ok(out.general.controls >= 3, 'General must render real controls');

  // Usage numbers must reflect the seeded sessions, not placeholders.
  const usageText = await js(`(async () => {
    document.querySelector('.settings-item[data-pane="usage"]').click();
    await new Promise(r => setTimeout(r, 320));
    return document.getElementById('settings-pane').textContent;
  })()`);
  assert.match(usageText, /2/, 'two live sessions were seeded, so a count must be 2');

  // Panes without a local source must say so rather than showing dead controls.
  for (const name of ['privacy', 'cowork', 'plugins']) {
    assert.equal(out[name].controls, 0, `pane "${name}" must not render interactive controls it cannot honour`);
    assert.ok(out[name].notes.length > 0, `pane "${name}" must explain why it is empty`);
  }

  console.log(JSON.stringify({
    ok: true,
    panes: names.length,
    usageRows: out.usage.rows,
    skillsRows: out.skills.rows,
    importButtons: out.import.buttons,
    explained: names.filter(n => out[n].notes.length > 0),
  }));

  detach?.();
  bus.dispose();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  server.closeAllConnections();
  server.close(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(0);
  });
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
