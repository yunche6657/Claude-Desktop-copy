import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The language picker must actually change the rendered UI, not just store a choice.
//
// Verified live this round with real pointer input (element.click() proves nothing —
// see round 145):
//
//   user menu -> 语言 -> dialog 「选择您的语言」 with 20+ role=radio rows
//   click 「中文（简体） Chinese (Simplified)」  -> documentElement.lang = 'zh-Hans'
//   click 「English (United States)」            -> documentElement.lang = 'en-US'
//        and the sidebar re-rendered: 「What's new / New Ctrl + N / Customize」
//   click 「Italiano (Italia)」                  -> lang = 'it-IT'
//        and the user menu read 「Impostazioni Ctrl + , / Lingua / Esci」
//
// So the translation pipeline works end to end: catalogue -> render -> re-render on
// change. What this test pins is the part that can silently rot: the catalogues those
// locales resolve to must exist, or the UI would fall back to English while the
// <html lang> attribute still claimed the new language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseCatalogRequest, resolveCatalogOverlay } = require(path.join(ROOT, 'desktop', 'i18n-overlay.cjs'));
const OVERLAY_ROOT = path.join(ROOT, 'resources', 'i18n-overlay');

// Locales the picker offered in the live run, minus en-US which the bundle ships.
// zh-Hant is excluded on purpose: the shipped bundle carries no Traditional Chinese
// catalogue and neither does the overlay, so picking it leaves <html lang> at zh-Hant
// while the text stays Simplified. That is an upstream gap this reconstruction does not
// paper over — inventing Traditional Chinese translations would be worse than saying so.
const PICKER_LOCALES = ['zh-Hans', 'fr-FR', 'de-DE', 'hi-IN', 'id-ID', 'it-IT', 'ja-JP', 'ko-KR', 'pt-BR', 'es-ES', 'es-419'];

test('the catalogue request parser accepts every picker locale', () => {
  for (const locale of PICKER_LOCALES) {
    const req = parseCatalogRequest('/i18n/' + locale + '.json');
    assert.ok(req, 'the parser rejected ' + locale);
    assert.equal(req.locale, locale);
    assert.equal(req.dynamic, false);
  }
});

test('a locale resolves to a real catalogue or a deliberate fallback', () => {
  // Either the overlay serves a file, or the shipped bundle carries that locale —
  // both are fine. What must not happen is the picker offering a language whose
  // catalogue nothing can serve, which would leave an untranslated UI.
  const shippedRoot = PINNED_ION_DIST + '/i18n';
  for (const locale of PICKER_LOCALES) {
    const overlay = resolveCatalogOverlay(OVERLAY_ROOT, '/i18n/' + locale + '.json');
    const shipped = fs.existsSync(path.join(shippedRoot, locale + '.json'));
    assert.ok(overlay || shipped, 'no catalogue can serve ' + locale);
  }
});

test('en-US is served by the bundle, not the overlay', () => {
  // The overlay must not shadow the shipped English catalogue.
  assert.equal(resolveCatalogOverlay(OVERLAY_ROOT, '/i18n/en-US.json'), null);
});

test('the bootstrap advertises a locale the shipped app supports', () => {
  // The boot document seeds the first render; advertising an unknown tag would leave
  // the UI in whichever language the bundle defaults to.
  const shared = fs.readFileSync(path.join(ROOT, 'desktop', 'bootstrap-service.cjs'), 'utf8');
  assert.match(shared, /zh-Hans/, 'the bootstrap must name the shipped locale tag');
});
test('a locale with no catalogue is a known gap, not a silent pass', () => {
  // Measured live: picking 中文（繁體） sets documentElement.lang = 'zh-Hant' but the text
  // stays Simplified, because neither the bundle nor the overlay carries zh-Hant.json.
  // The upstream ships 11 catalogues and Traditional Chinese is not one of them.
  //
  // This test states the gap so nobody reads the passing locale tests as 'all 20+
  // languages work'. If a zh-Hant catalogue is ever added, this test should be
  // replaced by a real assertions-on-text check.
  const shippedRoot = PINNED_ION_DIST + '/i18n';
  const overlay = resolveCatalogOverlay(OVERLAY_ROOT, '/i18n/zh-Hant.json');
  const shipped = fs.existsSync(path.join(shippedRoot, 'zh-Hant.json'));
  assert.equal(overlay, null, 'the overlay gained a zh-Hant catalogue; update this test to assert the translation');
  assert.equal(shipped, false, 'the bundle now ships zh-Hant; update this test');
});
