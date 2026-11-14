// app:// protocol — the shipped frontend is served from resources/ion-dist.
//
// Observed in the shipped bundle (index.chunk-lzaSYO3Q.js, function k8r):
//
//   protocol.handle("app", async e => {
//     const t = new URL(e.url);
//     if (t.hostname !== "localhost") return new Response(null, { status: 404 });
//     const i = e.headers.get("Origin");
//     return i && i !== <app origin>
//       ? new Response(null, { status: 403 })
//       : await served(e) || (isClientRoute(t.pathname)
//           ? new Response(SHELL_HTML, { status: 503, headers: MK })
//           : staticHandler(e));
//   });
//
// The root is resolved by uIa(): process.resourcesPath/ion-dist when packaged.
// This module reproduces that: hostname guard, origin guard, static file serving
// from ion-dist, and an SPA fallback to index.html for client-routed paths such
// as /epitaxy and /code.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { isBackendPath } = require('./backend-proxy.cjs');
const { isBootstrapRequest } = require('./bootstrap-service.cjs');
const { resolveCatalogOverlay } = require('./i18n-overlay.cjs');

// The origin the shipped frontend treats as itself.
const APP_ORIGIN = 'app://localhost';

// Extensions that are always static assets, never client routes.
const ASSET_EXT = /\.(m?js|css|json|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|bmp|map|wasm|mp3|mp4|webm|wav|ogg|txt|xml|webmanifest)$/i;

// Sentinel returned by resolveRequestPath for "this looks like an asset and it is not
// there". It must be distinct from `null` (client route -> SPA shell) and from
// `undefined` (403), because those three cases need three different HTTP responses.
const MISSING_ASSET = Symbol('missing-asset');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Where the MSIX-installed Claude ships its ion-dist. The replica's
// `resources/ion-dist` is a JUNCTION to `ion-dist` inside this package so a 3 GB
// asset tree is not duplicated per checkout.
const WINDOWS_APPS = path.join(
  process.env.ProgramFiles || 'C:\\Program Files',
  'WindowsApps',
);

// The AppModel package repository. Every other way of locating an installed MSIX by
// its payload path fails in some context on this host:
//   - readdir("C:\Program Files\WindowsApps")  -> EPERM, always
//   - Get-AppxPackage (powershell)             -> UnauthorizedAccessException when
//                                                 called from Electron's main process,
//                                                 even though it works under plain node
//   - probing a guessable directory name       -> requires already knowing the version,
//                                                 which is the thing being discovered
// This registry key is readable from both contexts (verified in each), so it is the
// source of truth.
const APPX_REPO = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';

// Catalogs the shipped bundle does not ship (currently only Chinese) are vendored here.
// The package's own i18n directory cannot take them: it is a read-only junction target
// under Program Files\WindowsApps (verified: a write there is denied).
const DEFAULT_CATALOG_OVERLAY = path.resolve(__dirname, '..', 'resources', 'i18n-overlay');

/**
 * Installed Claude package directory names, newest first, e.g.
 * ["Claude_3.1623.0.0_x64__pzs8sxrjxfjjc"].
 * @returns {string[]}
 */
function listInstalledClaudePackages() {
  let raw;
  try {
    const { execFileSync } = require('node:child_process');
    raw = execFileSync('reg', ['query', APPX_REPO], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  } catch {
    return [];
  }
  const names = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\\Claude_[\d.]+_x64__/.test(line))
    .map((line) => line.split('\\').pop());
  return [...new Set(names)].sort((a, b) => {
    const av = (a.match(/_([\d.]+)_/) || [, '0'])[1].split('.').map(Number);
    const bv = (b.match(/_([\d.]+)_/) || [, '0'])[1].split('.').map(Number);
    for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
      const d = (bv[i] || 0) - (av[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/**
 * Find the installed Claude package's ion-dist, or null.
 *
 * The shipped app upgrades ITSELF in place, and an upgrade creates a new
 * `Claude_<version>_x64__<publisher>` directory and deletes the old one. A junction
 * pointed at the old directory then dangles: `fs.existsSync` reports false and
 * `stat` throws ENOENT. That is exactly what happened here (2.42304.2.0 ->
 * 3.1623.0.0) and it presented as "index.html is missing", which points at the wrong
 * thing entirely.
 * @returns {string|null}
 */
function findInstalledIonDist() {
  for (const name of listInstalledClaudePackages()) {
    const dir = path.join(WINDOWS_APPS, name, 'app', 'resources', 'ion-dist');
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Resolve the ion-dist root the way the shipped uIa() does: the packaged
 * resources directory, or an explicit override.
 *
 * When the resolved root has no index.html the junction target has most likely been
 * removed by an in-place app upgrade, so the newest installed package is used as a
 * fallback rather than failing the boot.
 * @param {{ resourcesPath?: string, override?: string }} opts
 */
function resolveFrontendRoot({ resourcesPath, override } = {}) {
  if (override) return override;
  const base = resourcesPath || path.resolve(__dirname, '..', '..', 'resources');
  const root = path.join(base, 'ion-dist');
  if (fs.existsSync(path.join(root, 'index.html'))) return root;
  return findInstalledIonDist() || root;
}

/**
 * Map a request pathname to a file inside `root`, or null when it is a client
 * route that must get the SPA shell instead.
 * @returns {string|null}
 */
function resolveRequestPath(root, pathname) {
  let rel = decodeURIComponent(pathname || '/');
  if (!rel.startsWith('/')) rel = '/' + rel;

  // Reject traversal before normalisation: posix.normalize() collapses ".."
  // away, so checking the normalised value would accept "/../../etc/passwd".
  if (rel.split('/').some((segment) => segment === '..')) return undefined; // 403

  if (rel === '/' || rel === '') rel = '/index.html';

  const normalized = path.posix.normalize(rel);
  if (normalized.includes('\u0000')) return undefined;

  const abs = path.join(root, normalized.replace(/^\/+/, ''));
  // Confine to root even if a symlink or odd name slipped through.
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return undefined;

  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    if (stat.isFile()) return abs;
    if (stat.isDirectory()) {
      const index = path.join(abs, 'index.html');
      if (fs.existsSync(index)) return index;
    }
  }

  // A dotted asset that does not exist is a genuine 404, NOT a client route.
  //
  // This used to return `null` here, and `null` means "serve the SPA shell", so a
  // missing /i18n/zh-Hans-CN.json came back as HTTP 200 with index.html in the body.
  // The locale loader then did `await response.json()` on an HTML document and threw
  // "Unexpected token '<'". The two outcomes need different sentinels: a missing asset
  // must be distinguishable from a client route.
  if (ASSET_EXT.test(normalized)) return MISSING_ASSET;
  return null; // client route -> SPA shell
}

/**
 * Runtime patches applied to served JavaScript.
 *
 * Each patch is a named rewrite with a detection step, so a miss is visible instead of
 * silent. The files on disk are never modified.
 *
 * Why patches exist at all: the shipped frontend contains build-time constants that switch
 * features off for some channels. `vRe` disables the whole usage panel; with it false the
 * panel's queryFn never runs, so no backend work can make the panel appear.
 */

/**
 * Enable the usage panel by flipping its build-time gate.
 *
 * Target (minified, one of several hashed chunks):
 *   var vRe=!1,yRe=["epitaxy","period-usage"];
 *
 * Replaced with `var vRe=!0,...`. Returns null when the pattern is absent.
 * @param {string} text
 * @returns {{text: string, changed: boolean}|null}
 */
function patchUsagePanelGate(text) {
  // Match the STRUCTURE, not the minifier's names.
  //
  // This patch used to hard-code `var vRe=!1,yRe=[...]` and silently stopped matching when
  // an upgrade renamed the variables to `var MVe=!1,NVe=[...]` -- the gate stayed closed and
  // the usage panel stayed hidden, with nothing anywhere to say the patch had gone inert.
  // The anchors that survive minification are the literal query key and the literal false:
  //
  //   var <gate>=!1,<keys>=["epitaxy","period-usage"]
  //
  // Only the boolean is flipped; every name is preserved as found.
  const re = /var (\w+)=!1,(\w+)=\["epitaxy","period-usage"\]/;
  const match = re.exec(text);
  if (!match) return null;
  return {
    text: text.replace(re, `var ${match[1]}=!0,${match[2]}=["epitaxy","period-usage"]`),
    changed: true,
  };
}

/**
 * Admit the Chinese catalogs to the frontend's locale allowlist.
 *
 * The shipped bundle hard-codes the 11 catalogs it carries:
 *
 *   var ay=["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"];
 *   var by=["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"];
 *
 * `wy()` (boot locale), `Dy()` (user choice) and `vy()` (matching) all fall back to en-US
 * for anything outside that list, so a zh-Hans catalog can be fetched and still never be
 * selected. Appending the two Chinese tags is what makes `spa:locale=zh-Hans` resolve to
 * `/i18n/zh-Hans.json`. The catalogs themselves come from the overlay (i18n-overlay.cjs).
 *
 * @param {string} text
 * @returns {{text: string, changed: boolean}|null}
 */
function patchLocaleAllowlist(text) {
  const shipped = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]';
  const widened = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID","zh-Hans","zh-Hant"]';
  if (!text.includes(shipped)) return null;
  return { text: text.split(shipped).join(widened), changed: true };
}

/** All patches, in order. Each entry: {name, pathMatch, apply}. */
const ASSET_PATCHES = [
  {
    name: 'cowork-durable-message-updates',
    pathMatch: /cb1e253a0-/,
    apply: require('./cowork-message-patch.cjs').patchCoworkMessages,
  },
  {
    name: 'transcript-row-focus-ring',
    pathMatch: /c4a9ee384-/,
    apply(text) {
      const before = 'var Zi="rounded-lg focus-visible:shadow-focus focus-visible:outline-hidden"';
      if (!text.includes(before)) return null;
      return { text: text.replace(before, 'var Zi="rounded-lg outline-none"'), changed: true };
    },
  },
  {
    name: 'session-render-error-log',
    pathMatch: /shared-26-/,
    apply: require('./renderer-boundary-patch.cjs').patchRendererBoundary,
  },
  {
    name: 'usage-panel-gate',
    // Only the chunk that owns the period-usage query.
    pathMatch: /c96d752d0/,
    apply: patchUsagePanelGate,
  },
  {
    name: 'locale-allowlist',
    // The chunk that owns the locale allowlist and the /i18n/ URL builder.
    pathMatch: /shared-52-/,
    apply: patchLocaleAllowlist,
  },
];

/**
 * Apply every matching patch to an asset body.
 *
 * A patch whose `pathMatch` hits but whose literal pattern is gone has MISSED: the chunk is
 * the right one, the code inside it changed. That is the failure mode a package upgrade
 * produces, and it is silent unless reported -- the app still boots, it just quietly stops
 * doing the patched thing (Chinese falls back to English, the quota panel reappears).
 *
 * @param {Buffer} body
 * @param {string} pathname
 * @returns {{body: Buffer, applied: string[], missed: string[]}|null} null when no patch
 *   matched this path at all (an ordinary, uninteresting asset)
 */
function applyAssetPatches(body, pathname) {
  let text = body.toString('utf8');
  const applied = [];
  const missed = [];
  for (const patch of ASSET_PATCHES) {
    if (!patch.pathMatch.test(pathname)) continue;
    const result = patch.apply(text);
    if (result && result.changed) {
      text = result.text;
      applied.push(patch.name);
    } else {
      missed.push(patch.name);
    }
  }
  if (!applied.length && !missed.length) return null;
  return { body: Buffer.from(text, 'utf8'), applied, missed };
}

/**
 * Build the protocol handler.
 * @param {{
 *   root: string,
 *   forward?: (request: Request) => Promise<Response>,
 *   bootstrap?: { respond: () => Response },
 *   intercept?: (request: Request, pathname: string) => Response|null,
 *   onRequest?: (info: {path: string, status: number}) => void,
 * }} opts
 */
function createAppHandler({ root, forward, bootstrap, intercept, onRequest, catalogOverlay, onPatchMiss = () => {} } = {}) {
  const shellPath = path.join(root, 'index.html');
  // Catalogs the shipped bundle does not carry (zh-Hans) are served from an overlay
  // directory outside the (read-only, junctioned) package. See i18n-overlay.cjs.
  const overlayRoot = catalogOverlay === undefined ? DEFAULT_CATALOG_OVERLAY : catalogOverlay;
  const note = (p, status) => { if (onRequest) { try { onRequest({ path: p, status }); } catch {} } };

  return async function handleAppRequest(request) {
    let url;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }

    // hostname guard: only app://localhost is served.
    if (url.hostname !== 'localhost') {
      note(url.pathname, 404);
      return new Response(null, { status: 404 });
    }

    // origin guard: a cross-origin caller is refused.
    const origin = request.headers.get('Origin');
    if (origin && origin !== APP_ORIGIN) {
      note(url.pathname, 403);
      return new Response(null, { status: 403 });
    }

    // Backend paths (/edge-api/, /api/, ...) belong to the service, not to the
    // static bundle. The shipped handler rewrites and forwards these before it
    // ever looks at the filesystem, and answers the bootstrap document itself.
    //
    // It also runs a local interception table (Jgn) BEFORE forwarding. This build
    // has no backend, so without an equivalent stage every API call answered 503
    // and the app behaved as permanently offline — the visible symptom was the
    // account Overview page stuck on "Loading Overview", because the profile query
    // it waits on never settled. Anything `intercept` does not answer still falls
    // through to the forwarder unchanged.
    if (isBackendPath(url.pathname)) {
      if (bootstrap && isBootstrapRequest(request.url)) {
        note(url.pathname, 200);
        return bootstrap.respond();
      }
      if (intercept) {
        let local = null;
        try { local = intercept(request, url.pathname); } catch { local = null; }
        if (local) {
          note(url.pathname, local.status);
          return local;
        }
      }
      if (forward) {
        const response = await forward(request);
        note(url.pathname, response.status);
        return response;
      }
      note(url.pathname, 503);
      return new Response(null, { status: 503 });
    }

    let target;
    try { target = resolveRequestPath(root, url.pathname); }
    catch { return new Response(null, { status: 400 }); }
    if (target === undefined) { note(url.pathname, 403); return new Response(null, { status: 403 }); }

    if (target === MISSING_ASSET) {
      // A locale catalog the package does not ship may still be available from the
      // overlay: the shipped ion-dist has 11 catalogs and no Chinese, and its directory
      // is a read-only junction, so a 12th catalog cannot live there.
      const overlay = resolveCatalogOverlay(overlayRoot, url.pathname);
      if (overlay) {
        note(url.pathname, 200);
        const body = await fs.promises.readFile(overlay);
        return new Response(body, {
          status: 200,
          headers: { 'content-type': MIME['.json'], 'cache-control': 'no-store' },
        });
      }
      // A real 404. Serving the SPA shell here made a missing locale catalog look like a
      // successful 200 whose body was HTML, and the loader crashed parsing it.
      note(url.pathname, 404);
      return new Response(null, { status: 404 });
    }

    if (target === null) {
      // Client route -> the SPA shell.
      if (!fs.existsSync(shellPath)) { note(url.pathname, 404); return new Response(null, { status: 404 }); }
      note(url.pathname, 200);
      const body = await fs.promises.readFile(shellPath);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' },
      });
    }

    note(url.pathname, 200);
    const ext = path.extname(target).toLowerCase();
    let body = await fs.promises.readFile(target);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
    // Fonts and hashed assets are immutable; the shell must not be cached.
    headers['cache-control'] = ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable';

    // ---- runtime patch: enable the usage panel -----------------------------
    //
    // The shipped bundle gates its period-usage query behind a build-time constant:
    //
    //   var vRe = !1, yRe = ["epitaxy","period-usage"];
    //   useQuery({ queryKey: yRe, queryFn: bRe, enabled: t /* = vRe */, ... })
    //
    // `enabled: false` means queryFn never runs, so `ClaudeCode.getPeriodUsage` is never
    // called and the quota panel can never render -- measured: 0 calls after 2.5 s.
    // `vRe` is never assigned true anywhere in the shipped frontend.
    //
    // The patch is applied to the RESPONSE only; the file on disk is untouched, so a
    // package upgrade cannot be broken by it. If the pattern is not found we say so
    // through the `onPatchMiss` hook instead of pretending the panel was enabled.
    if (ext === '.js' && typeof applyAssetPatches === 'function') {
      const patched = applyAssetPatches(body, url.pathname);
      if (patched) {
        if (patched.applied.length) {
          body = patched.body;
          headers['cache-control'] = 'no-store';
          headers['content-length'] = String(body.length);
        }
        // A patch that matched the chunk but not the code inside it. Reported rather than
        // swallowed: after a package upgrade this is the only signal that the frontend has
        // drifted and the patched behaviour is silently gone.
        for (const name of patched.missed) {
          try { onPatchMiss({ name, path: url.pathname }); } catch { /* a reporter must not break serving */ }
        }
      }
    }

    return new Response(body, { status: 200, headers });
  };
}

/**
 * Register the scheme. Must run before app ready.
 * @param {{ protocol: Electron.Protocol }} deps
 */
function registerAppScheme({ protocol, additionalSchemes = [] }) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true,
        codeCache: true,
      },
    },
    ...additionalSchemes,
  ]);
}

/**
 * Install the handler against a running app.
 * @param {{ protocol, root, forward?, bootstrap?, intercept?, onRequest? }} opts
 */
function installAppProtocol({ protocol, root, forward, bootstrap, intercept, onRequest, catalogOverlay, onPatchMiss }) {
  const handler = createAppHandler({ root, forward, bootstrap, intercept, onRequest, catalogOverlay, onPatchMiss });
  protocol.handle('app', handler);
  return handler;
}

module.exports = {
  APP_ORIGIN,
  ASSET_EXT,
  MISSING_ASSET,
  ASSET_PATCHES,
  applyAssetPatches,
  patchUsagePanelGate,
  patchLocaleAllowlist,
  DEFAULT_CATALOG_OVERLAY,
  findInstalledIonDist,
  listInstalledClaudePackages,
  resolveFrontendRoot,
  resolveRequestPath,
  createAppHandler,
  registerAppScheme,
  installAppProtocol,
};
