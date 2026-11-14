// Icon rendering check.
//
// Asserts that every data-icon placeholder was replaced by a real SVG with a
// viewBox, that the Claude mark is present with its brand fill, and that no text
// glyph placeholders remain. Then captures the window so the result can be
// inspected as an image rather than trusted from DOM shape alone.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
  server = createApp({ dataDir, mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const win = new BrowserWindow({
    show: false,
    width: 1936,
    height: 1048,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // The renderer paints icons before doing anything else, but give the module
    // graph a moment to settle.
    for (let i = 0; i < 60 && document.querySelectorAll('[data-icon] > svg').length === 0; i++) await wait(50);

    const slots = [...document.querySelectorAll('[data-icon]')];
    const svgs = slots.map(node => node.querySelector('svg'));
    const missing = slots.filter((node, i) => !svgs[i]);
    const noViewBox = svgs.filter(svg => svg && !svg.getAttribute('viewBox'));

    // The mark keeps #D97757 regardless of the surrounding colour.
    const mark = document.querySelector('[data-mark] svg path');
    const markFill = mark ? mark.getAttribute('fill') : null;

    // A glyph placeholder would be a text node in a slot with no svg.
    const leftoverGlyphs = slots.filter(node => !node.querySelector('svg') && node.textContent.trim());

    return {
      slots: slots.length,
      painted: svgs.filter(Boolean).length,
      missing: missing.length,
      noViewBox: noViewBox.length,
      markFill,
      markPathLength: mark ? mark.getAttribute('d').length : 0,
      leftoverGlyphs: leftoverGlyphs.length,
      bodyHasStarburst: [...document.querySelectorAll('[data-mark] svg')].length,
      accountMark: Boolean(document.querySelector('.account [data-mark] svg')),
      heroMark: Boolean(document.querySelector('.welcome-mark svg')),
    };
  })()`);

  assert.equal(result.missing, 0, 'every data-icon slot must receive an svg');
  assert.equal(result.noViewBox, 0, 'every icon must declare a viewBox');
  assert.equal(result.painted, result.slots, 'painted count must match slot count');
  assert.equal(result.markFill, '#D97757', 'the mark must keep its brand fill');
  assert.ok(result.markPathLength === 2423, 'the mark path must be the shipped bytes');
  assert.equal(result.leftoverGlyphs, 0, 'no text glyph placeholders may remain');
  // The mark appears four times: account row, idle headline, Quick Entry, and About Claude.
  assert.equal(result.bodyHasStarburst, 4, 'account row, idle headline, Quick Entry, and About Claude each carry the mark');
  assert.ok(result.accountMark, 'the account row must carry a mark');
  assert.ok(result.heroMark, 'the idle headline must carry a mark');

  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '../evidence/icons-check.png'), image.toPNG());

  console.log(JSON.stringify({ ok: true, ...result }));

  win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
