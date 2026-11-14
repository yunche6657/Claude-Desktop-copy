// R478: the notification banner no longer swallows the send click.
//
// WHAT WAS WRONG
//   resources/ion-dist renders a notification-permission banner at rect [764, 676, 420, 108] with
//       data-testid="desktop-notification-permission-banner"
//       data-cds-covers-content=""
//   The send button sits at [1096, 733, 24, 24], entirely inside that rect. R477 proved the overlap is
//   the sole cause of the dead click: with the banner present, clicking send produced no page change and
//   no `sendMessage`; hiding the banner and clicking the same point produced
//       sendMessage ["local_f59b7601-…", "R477 before unblock", …]
//   plus a rendered turn.
//
// THE FIX
//   desktop/frontend-layout-patches.cjs injects one stylesheet scoped to that banner's own testid:
//       <banner>, <banner> *            { pointer-events: none !important }
//       <banner> button, [role=button], a, [data-cta-layout] * { pointer-events: auto !important }
//   The banner stays visible and its call-to-action stays clickable; only the dead area stops eating
//   input. Injected via webContents.insertCSS after loadURL, so no file in resources/ion-dist changes and
//   a package upgrade cannot be broken by it.
//
// WHY CSS RATHER THAN A BUNDLE PATCH
//   app-protocol.cjs's existing patches rewrite literals (a boolean, a locale array) inside named chunks.
//   Those anchors survive minification. A layout overlap has no such literal — moving a box would mean
//   rewriting minified component code, which breaks on every rebuild. A rule keyed on a data attribute is
//   independent of chunk hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// A dynamic import needs a file:// URL on Windows; a bare absolute path is read as the scheme "c:".
const patches = await import(
  pathToFileURL(path.join(ROOT, 'desktop', 'frontend-layout-patches.cjs')).href
).then((m) => m.default || m);

test('the rule disables only the banner box, never a blanket subtree', () => {
  const css = patches.bannerPointerEventsCss();

  assert.equal(patches.BANNER_SELECTOR, '[data-testid="desktop-notification-permission-banner"]',
    'the selector changed: re-derive it from the live DOM before trusting the rule');

  // Rule 1: the banner's own box stops intercepting.
  assert.match(css, /\[data-testid="desktop-notification-permission-banner"\] \{[\s\S]{0,60}pointer-events: none !important/,
    'the banner box no longer disables pointer events');

  // Rule 2 must restore interactivity INSIDE it — the composer lives in that subtree.
  assert.match(css, /pointer-events: auto !important/,
    'nothing restores pointer events, so the composer inside the banner would stay dead');

  // THE v1 REGRESSION: a `*` descendant rule reached the send button and turned it transparent.
  // Measured live: sendPointerEvents "none", sendDisabled… the click still failed. The fix must not
  // reintroduce a universal selector inside the banner.
  assert.ok(!/\[data-testid="desktop-notification-permission-banner"\][^,{]*\*\s*\{/.test(css),
    'a universal descendant selector is back: it will disable the composer, which is inside the banner');
  assert.ok(!/\*\s*\{[\s\S]{0,80}pointer-events:\s*none/.test(css),
    'a bare * rule disables pointer events somewhere: that reaches the composer');

  // The composer's own controls are named explicitly, because the rule has to survive being
  // out-specified by the component's utility classes.
  assert.match(css, /data-testid="code-prompt-send"/,
    'the send button is not named in the restore rule');
  assert.match(css, /data-testid="code-prompt-input"/,
    'the editor is not named in the restore rule');
});

test('every selector stays rooted in the banner', () => {
  const css = patches.bannerPointerEventsCss();
  // Strip comments, then take only the text preceding each opening brace.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = stripped.match(/[^{}]+(?=\{)/g) || [];
  assert.ok(blocks.length >= 2,
    'expected at least the banner rule and the restore rule, got ' + blocks.length);
  for (const block of blocks) {
    assert.ok(block.includes('data-testid="desktop-notification-permission-banner"'),
      'a selector escapes the banner scope: ' + block.trim().slice(0, 120));
  }
});

test('the live DOM carried exactly the attributes the selector relies on', (t) => {
  const cap = path.join(ROOT, '..', '.tmp', 'banner-identity-r478.json');
  if (!fs.existsSync(cap)) {
    t.skip('capture absent — run .tmp/banner-identity-r478.cjs');
    return;
  }
  const report = JSON.parse(read(cap));
  const id = (report.identity && report.identity.result && report.identity.result.value) || {};

  // The banner's own element carries the testid used by the selector.
  const banner = (id.subtree || []).find((n) =>
    n.testid === 'desktop-notification-permission-banner');
  assert.ok(banner, 'the banner node with that testid was not observed');
  assert.equal(banner.attrs['data-cds-covers-content'], '',
    'the covers-content marker is gone: the overlap may be intentional elsewhere now');

  // And the overlap that motivated the patch.
  const [bx, by, bw, bh] = id.buttonRect;
  const [ox, oy, ow, oh] = banner.rect;
  assert.ok(bx >= ox && by >= oy && bx + bw <= ox + ow && by + bh <= oy + oh,
    `send button [${id.buttonRect}] is not inside the banner [${banner.rect}] — re-derive the defect`);
});

test('main.cjs injects the patch after loading the window', () => {
  const main = read(ROOT, 'desktop', 'main.cjs');
  const loadIdx = main.indexOf('await win.loadURL(useFrontend ? FRONTEND_URL : origin)');
  assert.ok(loadIdx > 0, 'the loadURL call moved');

  const patchIdx = main.indexOf('applyFrontendLayoutPatches');
  assert.ok(patchIdx > 0, 'main.cjs no longer applies the layout patches');

  // Injection must come AFTER the document exists, otherwise insertCSS has no page to attach to.
  assert.ok(patchIdx > loadIdx,
    'the patch is applied before loadURL: insertCSS would target the previous document');

  // And a miss must be reported, not swallowed — the failure mode patchUsagePanelGate documents.
  assert.match(main.slice(patchIdx, patchIdx + 500), /patched\.applied\.length/,
    'the applied result is not inspected, so a silent miss cannot be noticed');
});

test('a failed injection is reported rather than swallowed', async () => {
  // The module must return `failed` for a throwing webContents, because a silently un-applied patch is
  // exactly what left the usage panel hidden in an earlier round.
  const result = await patches.applyFrontendLayoutPatches(
    { webContents: { insertCSS: async () => { throw new Error('synthetic failure'); } } },
    () => {},
  );
  assert.deepEqual(result.applied, [], 'a throwing insertCSS was reported as applied');
  assert.deepEqual(result.failed, ['notification-banner-pointer-events'],
    'the failure was not reported: ' + JSON.stringify(result));
});

test('the module leaves resources/ion-dist untouched', () => {
  // The fix is an injection, not an edit, so a package upgrade keeps it valid.
  const source = read(ROOT, 'desktop', 'frontend-layout-patches.cjs');
  assert.ok(!/writeFile|appendFile|rename/.test(source),
    'the patch module writes files; it must only inject CSS');
  assert.match(source, /insertCSS/, 'the module no longer uses insertCSS');
});
