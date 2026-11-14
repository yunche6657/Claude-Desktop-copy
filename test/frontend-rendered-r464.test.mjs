// R464: the packaged app renders the shipped frontend — measured over CDP on the live window.
//
// THE QUESTION THIS CLOSES
//   R463 got the packaged app running but could not say what it displayed. Its specific open worry:
//   desktop/main.cjs computes
//       const FRONTEND_RESOURCES = process.env.CLAUDE_RESOURCES
//         || path.resolve(__dirname, '..', 'resources');
//   and inside app.asar that resolves to <resources>/app.asar/resources — an archive-internal path.
//   Plain Node cannot see into an asar, so a filesystem probe could not settle it. Electron patches
//   fs, and the answer is yes: the window loaded.
//
// HOW IT WAS MEASURED
//   Launch: packaged exe with --no-sandbox --disable-gpu --disable-software-rasterizer
//           --remote-debugging-port=9222, CLAUDE_VIEW=frontend.
//   Query:  raw CDP over the page's ws:// debugger URL (REA's browser tools reject app:// because
//           they validate HTTP(S) origins), Runtime.evaluate on the live document.
//
// MEASURED RESULT
//     href        app://localhost/epitaxy?coldLaunch=1
//     title       Claude
//     readyState  complete
//     DOM bytes   237,264
//     divs 374 / buttons 28 / svgs 5 / textarea+input 1
//     mounted root present
//     body text   "新功能 / Cowork / Code / 新建 Ctrl+N / 自定义 / 更多 / 最近使用 /
//                  您启动的会话将显示在这里 / Administrator · Gateway / 接下来做什么？"
//     html attrs  data-build-id="spa-dev" data-theme="claude" data-mode="light"
//                 data-density="comfortable" data-document-variant="full" lang="zh-Hans"
//     assets      74 references, all rooted at /assets/v1/... (served through app://)
//
//   So the frontend IS served from the archive, the SPA shell mounted, and the UI is the real
//   Chinese-localised Claude surface — not an error page and not a blank body.
//
// A FALSE NEGATIVE WORTH RECORDING
//   The first query counted assets whose URL contained "ion-dist" and got 0, which looked like "assets
//   are not coming from ion-dist". Wrong test: the frontend references /assets/v1/... and the
//   app:// handler resolves those INTO ion-dist. The absence of the string proves nothing. This is the
//   same class of mistake as R461's CRLF split and R455's false rescue — a negative from a pattern
//   that never described the thing being checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Captured from the live packaged window; checked in as a fixture so the assertions run without a
// window. Regenerate by launching with --remote-debugging-port and re-running the query.
const CAPTURE = path.join(ROOT, 'test', 'fixtures', 'cdp-dom-r464.json');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the packaged app renders the shipped frontend over app://', (t) => {
  if (!fs.existsSync(CAPTURE)) {
    // The capture is produced by launch + CDP query, which needs a live window. Committing the
    // fixture means this can be asserted in a normal run; if it is missing, say so rather than
    // passing silently.
    t.skip('CDP capture absent — run the R464 launch + query to regenerate .tmp/cdp-dom-r464.json');
    return;
  }
  const cap = JSON.parse(read(CAPTURE));
  const v = cap.value || {};

  assert.equal(cap.target.url, 'app://localhost/epitaxy?coldLaunch=1',
    'the window is no longer showing the shipped route');
  assert.equal(v.readyState, 'complete', 'the document never finished loading');

  // A blank shell or an error page would be small; the real SPA shell is ~230 KB of markup.
  assert.ok(v.htmlLength > 100_000,
    `DOM is only ${v.htmlLength} bytes: a blank body or an error page rather than the SPA shell`);

  // Landmarks a mounted React app has and an error page does not.
  assert.ok(v.counts.divs > 200, `only ${v.counts.divs} divs: the app did not mount`);
  assert.ok(v.counts.buttons > 10, `only ${v.counts.buttons} buttons`);
  assert.equal(v.hasRoot, true, 'no mount root present');

  // Localised text proves the real surface rather than a placeholder.
  assert.match(v.bodyTextHead, /最近使用|接下来做什么|新建/,
    'the body text is not the expected Claude surface: ' + String(v.bodyTextHead).slice(0, 120));

  assert.equal(cap.exception, null, 'evaluating the page threw: ' + cap.exception);
});

test('the shell declares itself the real frontend build', (t) => {
  if (!fs.existsSync(CAPTURE)) {
    t.skip('CDP capture absent');
    return;
  }
  const v = JSON.parse(read(CAPTURE)).value || {};
  const head = v.htmlHead || '';
  // These attributes are emitted by the shipped ion-dist document; a synthesised fallback would not
  // carry them.
  for (const attr of ['data-build-id', 'data-theme', 'data-density', 'data-document-variant']) {
    assert.ok(head.includes(attr), 'the document is missing ' + attr + ': not the shipped shell');
  }
  assert.match(head, /lang="zh-Hans"/, 'locale attribute changed');
});

test('assets are requested through app://, not from a filesystem path', (t) => {
  if (!fs.existsSync(CAPTURE)) {
    t.skip('CDP capture absent');
    return;
  }
  const v = JSON.parse(read(CAPTURE)).value || {};
  const sample = v.assetSample || [];
  assert.ok(sample.length > 0, 'no asset references captured');

  // All references are root-relative and served by the app:// handler.
  assert.ok(sample.every((s) => s.startsWith('/')),
    'an asset URL is not root-relative: ' + sample.find((s) => !s.startsWith('/')));

  // THE CORRECTION: do NOT assert that URLs contain "ion-dist". They never do — the frontend asks for
  // /assets/v1/... and app-protocol resolves that into the archive. A count of zero matching strings
  // is the expected value, not a failure.
  const hashNamed = sample.filter((s) => /\/assets\/v1\/[\w-]+-[A-Za-z0-9_-]{6,}\.(js|css|svg|png|woff2)$/.test(s));
  assert.ok(hashNamed.length >= 10,
    `only ${hashNamed.length} of ${sample.length} assets are content-hashed build outputs: the `
    + 'frontend may be loading unbundled sources instead of the shipped build');
});

test('the app:// handler exists and resolves into ion-dist', () => {
  // The mechanism behind the measurement: without this mapping, /assets/v1/... would 404.
  const proto = read(ROOT, 'desktop', 'app-protocol.cjs');
  assert.match(proto, /protocol\.handle\('app'/, 'the app:// handler is gone');
  assert.match(proto, /const root = path\.join\(base, 'ion-dist'\)/,
    'the handler no longer roots requests in ion-dist');
  // And the request path resolution refuses traversal — worth pinning alongside the asset serving.
  assert.match(proto, /segment === '\.\.'/,
    'the traversal guard is gone: app:// could serve files outside ion-dist');
});
