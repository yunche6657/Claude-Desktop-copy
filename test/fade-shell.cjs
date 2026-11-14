// Transcript scroll fade, exercised in a real window.
//
// The fade is stateful: it depends on scroll position and on whether the content
// overflows at all. These are the cases that matter, and the ones a CSS-only test
// cannot see.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  server = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fade-e2e-')), mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(800);
    const t = document.getElementById('messages');
    if (!t) return { error: 'no transcript element' };
    // Smooth scrolling animates, so a read right after an assignment would see
    // the previous offset. Force instant scrolling to make the probe deterministic.
    t.style.scrollBehavior = 'auto';
    const fades = () => [...t.classList].filter(c => c.startsWith('fade')).sort().join(',');

    // 1. Short content does not overflow => no fade on either edge.
    t.replaceChildren();
    const short = document.createElement('article');
    short.className = 'message assistant';
    short.textContent = 'one short line';
    t.append(short);
    await wait(150);
    t.scrollTop = 0;
    t.dispatchEvent(new Event('scroll'));
    await wait(120);
    const shortFades = fades();

    // 2. Tall content: fade follows the scroll position.
    t.replaceChildren();
    for (let i = 0; i < 40; i++) {
      const row = document.createElement('article');
      row.className = 'message assistant';
      row.textContent = 'line ' + i + ' ' + 'x'.repeat(30);
      t.append(row);
    }
    await wait(250);

    t.scrollTop = 0;
    t.dispatchEvent(new Event('scroll'));
    await wait(120);
    const top = fades();

    t.scrollTop = Math.floor((t.scrollHeight - t.clientHeight) / 2);
    t.dispatchEvent(new Event('scroll'));
    await wait(120);
    const middle = fades();

    t.scrollTop = t.scrollHeight;
    t.dispatchEvent(new Event('scroll'));
    await wait(120);
    const bottom = fades();

    // 3. The mask is actually applied, not just the class.
    const mask = getComputedStyle(t).maskImage || getComputedStyle(t).webkitMaskImage || '';

    return { scrollable: t.scrollHeight > t.clientHeight, shortFades, top, middle, bottom, mask: String(mask).slice(0, 90) };
  })()`);

  if (result.error) throw new Error(result.error);

  assert.equal(result.scrollable, true, 'the tall transcript must overflow');
  assert.equal(result.shortFades, '', 'content that fits must not fade');
  assert.equal(result.top, 'fade-bottom', 'at the top only the lower edge fades');
  assert.equal(result.middle, 'fade-bottom,fade-top', 'in the middle both edges fade');
  assert.equal(result.bottom, 'fade-top', 'at the bottom only the upper edge fades');
  assert.match(result.mask, /gradient/, 'the mask must be applied to the element');

  console.log(JSON.stringify({ ok: true, ...result }));

  win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
