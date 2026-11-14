'use strict';
// Locale overlay: the shipped ion-dist ships 11 locale catalogs and no Chinese.
//
// Measured on this host:
//   resources/ion-dist/i18n/*.json        -> de-DE en-US es-419 es-ES fr-FR hi-IN id-ID it-IT ja-JP ko-KR pt-BR
//   resources/ion-dist is a JUNCTION into "C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\resources\\ion-dist"
//   -> writing a 12th catalog there is denied (verified: Set-Content -> "Access to the path ... is denied")
//
// The real app does show Chinese. Its locale is NOT in the package either; it is fetched at
// runtime from the web origin:
//   GET https://claude.ai/i18n/zh-Hans.json          -> 200, 2,720,080 bytes
//   GET https://claude.ai/i18n/dynamic/zh-Hans.json  -> 200, 2,525 bytes
// (both with a desktop User-Agent; the same URLs answer 403 to a bare client)
//
// Those two files are vendored under resources/i18n-overlay and served here, so the replica
// never needs the network at runtime. Nothing is translated by hand: the bytes are the
// upstream catalogs, byte-identical (SHA-256 recorded in evidence/chinese-locale.md).
const path = require('node:path');
const fs = require('node:fs');

/** Request pathname -> {locale, dynamic} when it is a locale catalog request, else null. */
function parseCatalogRequest(pathname) {
  const m = /^\/i18n\/(dynamic\/)?([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/.exec(String(pathname || ''));
  if (!m) return null;
  return { locale: m[2], dynamic: Boolean(m[1]) };
}

/**
 * Resolve an overlay catalog file for a /i18n/ request.
 *
 * The overlay is consulted only for catalogs the shipped bundle does not carry, so a
 * package upgrade that adds a real zh-Hans.json wins over the vendored copy.
 *
 * @param {string} overlayRoot
 * @param {string} pathname
 * @returns {string|null} absolute file path, or null when the overlay has nothing
 */
function resolveCatalogOverlay(overlayRoot, pathname) {
  if (!overlayRoot) return null;
  const req = parseCatalogRequest(pathname);
  if (!req) return null;
  const abs = path.join(overlayRoot, req.dynamic ? 'dynamic' : '', `${req.locale}.json`);
  const rel = path.relative(overlayRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

module.exports = { parseCatalogRequest, resolveCatalogOverlay };
