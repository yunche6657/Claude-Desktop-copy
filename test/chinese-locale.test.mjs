// Chinese locale support: the overlay catalogs, the allowlist patch, the bootstrap locale.
//
// Facts this file pins (all measured, see evidence/chinese-locale.md):
//   - the shipped ion-dist carries 11 locale catalogs and no Chinese one;
//   - resources/ion-dist is a JUNCTION into the read-only MSIX package, so a 12th
//     catalog cannot be written there;
//   - the real app's Chinese comes from https://claude.ai/i18n/zh-Hans.json and
//     https://claude.ai/i18n/dynamic/zh-Hans.json, vendored under resources/i18n-overlay;
//   - the shipped frontend hard-codes the 11 tags in its locale allowlist, so a fetched
//     catalog is still never selected until that list is widened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseCatalogRequest, resolveCatalogOverlay } = require('../desktop/i18n-overlay.cjs');
const {
  createAppHandler,
  patchLocaleAllowlist,
  DEFAULT_CATALOG_OVERLAY,
  resolveRequestPath,
  MISSING_ASSET,
} = require('../desktop/app-protocol.cjs');
const { buildBootstrap, resolveAppLocale } = require('../desktop/bootstrap-service.cjs');

const REPO = path.resolve(import.meta.dirname, '..');
const SHIPPED_ALLOWLIST = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]';

function makeOverlay() {
  const dir = mkdtempSync(path.join(tmpdir(), 'i18n-overlay-'));
  mkdirSync(path.join(dir, 'dynamic'));
  writeFileSync(path.join(dir, 'zh-Hans.json'), JSON.stringify({ k: 'v' }));
  writeFileSync(path.join(dir, 'dynamic', 'zh-Hans.json'), JSON.stringify({ d: 'v' }));
  return dir;
}

function makeRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'i18n-root-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  mkdirSync(path.join(dir, 'i18n'));
  writeFileSync(path.join(dir, 'i18n', 'en-US.json'), '{"a":"b"}');
  return dir;
}

const req = (url) => new Request(url, { headers: { Origin: 'app://localhost' } });

test('parseCatalogRequest recognises base and dynamic catalogs', () => {
  assert.deepEqual(parseCatalogRequest('/i18n/zh-Hans.json'), { locale: 'zh-Hans', dynamic: false });
  assert.deepEqual(parseCatalogRequest('/i18n/dynamic/zh-Hans.json'), { locale: 'zh-Hans', dynamic: true });
  assert.equal(parseCatalogRequest('/i18n/en-US.json?v=1'), null, 'a query string is not part of the pathname');
  assert.equal(parseCatalogRequest('/assets/v1/x.js'), null);
  assert.equal(parseCatalogRequest('/i18n/../../secret.json'), null);
});

test('resolveCatalogOverlay finds the vendored catalog and nothing else', () => {
  const overlay = makeOverlay();
  assert.equal(resolveCatalogOverlay(overlay, '/i18n/zh-Hans.json'), path.join(overlay, 'zh-Hans.json'));
  assert.equal(resolveCatalogOverlay(overlay, '/i18n/dynamic/zh-Hans.json'), path.join(overlay, 'dynamic', 'zh-Hans.json'));
  assert.equal(resolveCatalogOverlay(overlay, '/i18n/fr-FR.json'), null, 'only vendored locales are served');
  assert.equal(resolveCatalogOverlay(overlay, '/i18n/../package.json'), null);
  assert.equal(resolveCatalogOverlay(null, '/i18n/zh-Hans.json'), null);
});

test('a shipped catalog still wins over the overlay', async () => {
  // A package upgrade that adds a real zh-Hans.json must not be shadowed by the vendored
  // copy: the overlay is only consulted for MISSING_ASSET.
  const root = makeRoot();
  const overlay = makeOverlay();
  const handle = createAppHandler({ root, catalogOverlay: overlay });
  const shipped = await handle(req('app://localhost/i18n/en-US.json'));
  assert.equal(shipped.status, 200);
  assert.equal(await shipped.text(), '{"a":"b"}');
});

test('the overlay answers a catalog the package does not ship', async () => {
  const root = makeRoot();
  const overlay = makeOverlay();
  const handle = createAppHandler({ root, catalogOverlay: overlay });
  const res = await handle(req('app://localhost/i18n/zh-Hans.json'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { k: 'v' });

  const dyn = await handle(req('app://localhost/i18n/dynamic/zh-Hans.json'));
  assert.equal(dyn.status, 200);
  assert.deepEqual(await dyn.json(), { d: 'v' });
});

test('without an overlay a missing catalog is still a 404, not the SPA shell', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root, catalogOverlay: null });
  const res = await handle(req('app://localhost/i18n/zh-Hans.json'));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '', 'must not be the HTML shell');
  assert.equal(resolveRequestPath(root, '/i18n/zh-Hans.json'), MISSING_ASSET);
});

test('patchLocaleAllowlist widens the hard-coded list and is a no-op elsewhere', () => {
  const text = `var ay=${SHIPPED_ALLOWLIST};function oy(e){return ay.includes(e)}`;
  const out = patchLocaleAllowlist(text);
  assert.ok(out && out.changed);
  assert.ok(out.text.includes('"zh-Hans","zh-Hant"]'), 'the Chinese tags must be appended');
  assert.ok(out.text.includes('"ja-JP"'), 'the existing tags must be preserved');

  assert.equal(patchLocaleAllowlist('var unrelated = 1;'), null);
});

test('the shipped bundle really contains the allowlist this patch targets', () => {
  // Guards against the patch silently no-op'ing after an app upgrade: the asset on disk
  // must still carry the exact literal. Skipped when the junction target is absent.
  const asset = path.join(REPO, 'resources', 'ion-dist', 'assets', 'v1', 'shared-52-uHFNjl7C.js');
  if (!existsSync(asset)) return;
  const text = readFileSync(asset, 'utf8');
  assert.ok(text.includes(SHIPPED_ALLOWLIST), 'the locale allowlist literal changed; update patchLocaleAllowlist');
  const patched = patchLocaleAllowlist(text);
  assert.ok(patched && patched.changed);
});

test('the vendored Chinese catalogs are present and complete', () => {
  const base = path.join(DEFAULT_CATALOG_OVERLAY, 'zh-Hans.json');
  const dyn = path.join(DEFAULT_CATALOG_OVERLAY, 'dynamic', 'zh-Hans.json');
  if (!existsSync(base)) return; // vendored files are optional in a bare checkout
  const zh = JSON.parse(readFileSync(base, 'utf8'));
  const en = JSON.parse(readFileSync(path.join(REPO, 'resources', 'ion-dist', 'i18n', 'en-US.json'), 'utf8'));
  assert.ok(Object.keys(zh).length > 30000, `expected a full catalog, got ${Object.keys(zh).length} keys`);
  const missing = Object.keys(en).filter((k) => !(k in zh));
  assert.ok(missing.length / Object.keys(en).length < 0.01, `${missing.length} shipped keys have no Chinese translation`);
  assert.equal(Object.keys(JSON.parse(readFileSync(dyn, 'utf8'))).length, 49);
});

test('buildBootstrap advertises the locale only when the catalog exists', () => {
  // The template carries locale:null, so this is the branch that actually runs.
  assert.equal(buildBootstrap({ seed: 'x' }).locale, resolveAppLocale());
  assert.equal(buildBootstrap({ seed: 'x', locale: 'ja-JP' }).locale, 'ja-JP');
  assert.equal(resolveAppLocale('  zh-Hant  '), 'zh-Hant');
  assert.equal(resolveAppLocale(''), resolveAppLocale());
});

test('the bootstrap locale is a tag the frontend can resolve', () => {
  const locale = buildBootstrap({ seed: 'x' }).locale;
  // A null locale is NOT a reason to skip: the frontend then falls back to en-US, which is
  // the exact defect this file exists to prevent. Assert it has a value, then assert its shape.
  assert.notEqual(locale, null, 'the bootstrap carries no locale, so the UI falls back to en-US');
  assert.match(locale, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
  assert.ok(SHIPPED_ALLOWLIST.includes(locale) || locale === 'zh-Hans' || locale === 'zh-Hant');
});
