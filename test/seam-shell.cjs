// Seam continuity check.
//
// The real window's sidebar hairline runs the full height: pixel measurement at
// y=10/30/50/70/100/200 of evidence/code-view.png all read
// x=294 #fbfbf9, x=295 #e2e2e1, x=296 #fcfcfb. This test renders the
// reconstruction at the same size and samples the same rows, so the structural
// claim is checked against pixels rather than against the DOM.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  server = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'seam-')), mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  // Match the real capture's client area: 1920x1032 inside an 8px frame.
  const win = new BrowserWindow({
    show: false,
    width: 1936,
    height: 1048,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 900))');

  // Geometry from the live layout: where is the rail's right edge?
  const geom = await win.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('.sidebar');
    const bar = document.querySelector('.titlebar');
    const railTop = document.querySelector('.rail-top');
    const main = document.querySelector('.main');
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return { rail: rect(rail), bar: rect(bar), railTop: rect(railTop), main: rect(main) };
  })()`);

  // The rail must start at the very top and reach the bottom of the window.
  assert.equal(Math.round(geom.rail.y), 0, 'the sidebar must start at the top of the window');
  assert.ok(geom.rail.h > 1000, `the sidebar must span the full height, got ${geom.rail.h}`);
  assert.equal(Math.round(geom.rail.x), 0, 'the sidebar must start at the left edge');
  // The title bar must NOT start at x=0: it sits over the main column only.
  assert.ok(geom.bar.x > 200, `the title bar must start right of the rail, got x=${geom.bar.x}`);
  assert.equal(Math.round(geom.bar.y), 0, 'the title bar must still be at the top');

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(path.join(__dirname, '../evidence/seam-check.png'), png);

  const size = image.getSize();
  const bmp = image.toBitmap();
  const stride = size.width * 4;
  const at = (x, y) => {
    const i = y * stride + x * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i]];
  };
  const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  // Sample the seam column across the chrome band and the content area.
  // Under box-sizing: border-box, a 295px sidebar occupies x=0..294 and draws its
  // 1px border-right at x=294 (width - 1), while x=295 is the first column of .main.
  const seamX = Math.round(geom.rail.x + geom.rail.w) - 1;
  const rows = [10, 30, 50, 60, 70, 100, 200];
  const samples = rows.map(y => {
    const left = hex(at(seamX - 2, y));
    const seam = hex(at(seamX, y));
    const right = hex(at(seamX + 1, y));
    return { y, left, seam, right };
  });

  // A hairline is present when the seam column differs from both neighbours at
  // every sampled row, including rows inside the 52px chrome band.
  for (const sample of samples) {
    assert.notEqual(sample.seam, sample.left,
      `no hairline at y=${sample.y}: seam matches the rail fill ${sample.left}`);
    assert.notEqual(sample.seam, sample.right,
      `no hairline at y=${sample.y}: seam matches the main fill ${sample.right}`);
  }

  // Left of the seam is the rail ground, right of it the main ground, and they
  // differ - which is what makes the seam visible at all.
  const leftColour = samples[0].left;
  const rightColour = samples[0].right;
  assert.notEqual(leftColour, rightColour,
    'the rail and main grounds must differ, as they do in the real window');

  // Continuity: the seam colour must be the same value above and below the
  // chrome band. A two-slab layout would break at y=52.
  const seamAbove = new Set(samples.filter(s => s.y < 52).map(s => s.seam));
  const seamBelow = new Set(samples.filter(s => s.y > 52).map(s => s.seam));
  assert.equal(seamAbove.size, 1, `seam colour must be uniform in the chrome band: ${[...seamAbove]}`);
  assert.equal(seamBelow.size, 1, `seam colour must be uniform below it: ${[...seamBelow]}`);
  assert.deepEqual([...seamAbove], [...seamBelow],
    'the seam colour must be identical above and below the chrome boundary');

  console.log(JSON.stringify({
    ok: true,
    rail: geom.rail,
    titlebar: geom.bar,
    seamX,
    samples,
    seamColour: samples[0].seam,
  }, null, 1));

  win.destroy();
  server.closeAllConnections();
  server.close(() => app.exit(0));
}).catch(error => {
  console.error(error);
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
