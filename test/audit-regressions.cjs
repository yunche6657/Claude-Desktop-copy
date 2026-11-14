// Regression tests for the defects an external audit found.
//
// Each block names the defect it pins, so a future regression is identifiable
// from the failure message alone.
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

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
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

  // Collect CSP violations: a blocked inline style shows up here, not as a throw.
  const violations = [];
  win.webContents.on('console-message', event => {
    const text = typeof event === 'string' ? event : event.message;
    if (String(text).includes('Content Security Policy')) violations.push(String(text).slice(0, 120));
  });

  bus = new EipcBus();
  detach = registerDesktopServices({ bus, mainWindow: win, sessions: server.sessions, mode: 'demo', consent: null });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  const js = code => win.webContents.executeJavaScript(code);
  await js('new Promise(r => setTimeout(r, 900))');

  // ── Defect: `var(--line)` was referenced six times and never declared, so those
  // borders resolved to currentColor and rendered near-black.
  const lineResolves = await js(`(() => {
    const probe = document.createElement('div');
    document.body.append(probe);
    probe.style.border = '1px solid var(--line)';
    const computed = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return computed;
  })()`);
  assert.notEqual(lineResolves, 'rgb(20, 20, 19)',
    '--line must not collapse to the text colour; it was undeclared before');

  // ── Defect: twelve `#fff` surfaces stayed white in dark mode, and the guard
  // test's {6} hex regex could not see 3-digit values.
  const darkSurfaces = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.body.classList.add('dark');
    await wait(200);
    document.getElementById('settings').click();
    await wait(200);
    const menu = getComputedStyle(document.getElementById('account-menu')).backgroundColor;
    document.getElementById('settings').click();
    await wait(100);
    document.body.classList.remove('dark');
    await wait(150);
    const menuLight = getComputedStyle(document.getElementById('account-menu')).backgroundColor;
    return { menu, menuLight };
  })()`);
  assert.notEqual(darkSurfaces.menu, 'rgb(255, 255, 255)',
    'the account popover must not stay white in dark mode');
  assert.notEqual(darkSurfaces.menu, darkSurfaces.menuLight,
    'the popover surface must change with the theme');

  // ── Defect: the Cowork/Code segmented control had no handler at all.
  const segmented = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const tabs = [...document.querySelectorAll('.segmented [data-view]')];
    const hasHandlers = tabs.every(t => typeof t.onclick === 'function');
    const before = tabs.map(t => t.getAttribute('aria-selected'));
    tabs.find(t => t.dataset.view === 'cowork').click();
    await wait(400);
    const after = tabs.map(t => t.getAttribute('aria-selected'));
    const stored = await window.claudeAppSettings.getSidebarMode();
    // Restore so the rest of the run starts from code.
    tabs.find(t => t.dataset.view === 'code').click();
    await wait(300);
    return { hasHandlers, before, after, stored };
  })()`);
  assert.equal(segmented.hasHandlers, true, 'both segments must have a click handler');
  assert.notDeepEqual(segmented.before, segmented.after,
    'clicking a segment must change the selection');
  assert.equal(segmented.stored, 'cowork', 'the choice must be persisted to the main process');

  // ── Defect: three CSSOM style writes violated `style-src 'self'`.
  // Trigger the paths that used to write style: an empty task list and a settings
  // pane with a spaced heading.
  const cspAfter = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('search').value = 'zzz-no-such-task';
    document.getElementById('search').dispatchEvent(new Event('input'));
    await wait(200);
    document.getElementById('settings').click();
    await wait(150);
    document.querySelector('#account-menu .menu-row[data-menu=settings]').click();
    await wait(300);
    document.querySelector('.settings-item[data-pane="general"]').click();
    await wait(300);
    document.getElementById('close-dialog').click();
    await wait(150);
    return true;
  })()`);
  assert.equal(cspAfter, true);
  assert.deepEqual(violations, [],
    `no CSP violation may be raised; got: ${violations.join(' | ')}`);

  // ── Defect: the send affordance duplicated itself in the Code pill.
  const sendShape = await js(`(() => {
    const hero = document.querySelector('.hero-send');
    const conv = document.getElementById('send');
    const size = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return { hero: hero ? size(hero) : null, conv: conv ? size(conv) : null,
             enterHint: Boolean(document.getElementById('enter-hint')) };
  })()`);
  assert.ok(sendShape.hero, 'the hero composer needs a send control');
  assert.ok(sendShape.enterHint, 'the Code pill keeps its Enter hint');

  console.log(JSON.stringify({
    ok: true,
    lineResolves,
    darkMenuBg: darkSurfaces.menu,
    segmentedBefore: segmented.before,
    segmentedAfter: segmented.after,
    persisted: segmented.stored,
    cspViolations: violations.length,
    sendSizes: sendShape,
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
