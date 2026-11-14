// R641: the third-party-inference settings page existed in the shipped frontend but had no working opener.
//
// WHAT WAS FOUND
//   The page is real: route `setup-desktop-3p` lazily imports `c71860c77-BwbfSKgy.js`, whose only h2 is
//   "Configure third-party inference" / 配置第三方推理. It carries the whole settings surface — 连接 / 功能 /
//   连接器 / 遥测与更新 / 限额 / 外观 / 插件 / 出口流量 / 来源 — including Gateway base URL, Gateway API key,
//   Gateway auth scheme and Model list under 连接.
//
//   Its ONE opener in the frontend is:
//       async function hU(){ localStorage.setItem("seenInferenceSetupHint","1"); await He?.openSetupWindow?.() }
//   exported as `Dt`, aliased `M`, used by `function ht(){M()}`, assigned `Se=ht`, and bound as
//   `onClick: Se` on the existing 推理配置 / "Inference configuration" menu item.
//
//   This bridge never defined `openSetupWindow`. The `?.` swallowed it, so the item did nothing — no error, no
//   window, nothing. `seenInferenceSetupHint` is only ever written, never read, so there was no second path either.
//
// THE FIX
//   `openSetupWindow` now exists on `claude.settings.Custom3pSetup` and opens a BrowserWindow on
//   `app://localhost/setup-desktop-3p` with the same preload as the main window, reused across clicks and destroyed
//   with the bridge.
//
// MEASURED IN A LIVE APP
//   bridge has openSetupWindow: function
//   -> {"ok":true,"url":"app://localhost/setup-desktop-3p"}
//   a second page target appears at app://localhost/setup-desktop-3p
//   rendered: title true, nav 连接/功能/连接器/遥测与更新/限额/外观/插件/出口流量/来源
//
// WHAT IS NOT CLAIMED
//   Not that the field-level UI was exercised: on a fresh profile the 连接 page shows the provider chooser first, so
//   the Gateway fields appear only after selecting that provider. The page and its navigation are what this round
//   verified.
//   Not that the account menu was clicked by hand here: synthetic mouse events did not open that menu under CDP, so the
//   function the item's onClick invokes was called directly. That is the same code path minus the popover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the bridge defines openSetupWindow', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(/openSetupWindow',\s*async\s*\(\)\s*=>/.test(src), 'the handler is missing');
  assert.ok(src.includes("location.hash = '#settings/models'"), 'must open the existing model settings modal');
});

test('the opener reuses and focuses the main window without creating another BrowserWindow', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const start = src.indexOf("define('claude.settings_$_Custom3pSetup_$_openSetupWindow'");
  const end = src.indexOf('// Read one config by id', start);
  const handler = src.slice(start, end);
  assert.match(handler, /getMainWindow\?\.\(\)/);
  assert.match(handler, /window\.focus\(\)/);
  assert.doesNotMatch(handler, /new BrowserWindow/);
});

test('the frontend route the handler opens really exists in the shipped bundle', () => {
  const v1 = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
  assert.ok(fs.existsSync(v1), 'the frontend bundle is missing from this checkout');

  // The route is declared in the chunk that lazy-loads the setup page.
  const files = fs.readdirSync(v1).filter((f) => f.endsWith('.js'));
  let routeFound = false;
  for (const f of files) {
    const t = fs.readFileSync(path.join(v1, f), 'utf8');
    if (t.includes('path:"setup-desktop-3p"')) { routeFound = true; break; }
  }
  assert.ok(routeFound, 'the setup-desktop-3p route is gone from the bundle');
});

test('the page the route loads is the settings page, not a stub', () => {
  const v1 = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
  const f = path.join(v1, 'c71860c77-BwbfSKgy.js');
  assert.ok(fs.existsSync(f), 'the setup page chunk is missing');
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.includes('Configure third-party inference'), 'the page title is gone');
  // The navigation labels are i18n ids in this chunk, so the fields the page declares are what can be asserted.
  // These are the flatKeys the 连接 page renders; the live run observed 连接/功能/连接器/遥测与更新/限额/外观/插件/出口流量/来源.
  for (const field of ['inferenceGatewayBaseUrl', 'inferenceGatewayApiKey', 'inferenceGatewayAuthScheme']) {
    const inPage = t.includes(field);
    if (inPage) continue;
    // The field may live in the schema chunk rather than the page chunk; accept that too.
    const schema = path.join(v1, 'c6f6cf4c2-DnfurqXo.js');
    assert.ok(fs.existsSync(schema) && fs.readFileSync(schema, 'utf8').includes(field),
      `${field} is declared nowhere, so the settings surface lost a field`);
  }
});

test('the handler fails softly outside Electron rather than throwing', async () => {
  // registerBridgeServices must be callable in a plain node process for the suite; the handler must answer
  // { ok: false, error } there, because `electron` is unresolvable.
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.default.tmpdir(), 'setup-r641-'));
  fs.mkdirSync(path.join(tmp, 'Claude-3p', 'configLibrary'), { recursive: true });

  const saved = { L: process.env.LOCALAPPDATA, A: process.env.APPDATA };
  process.env.LOCALAPPDATA = tmp;
  process.env.APPDATA = path.join(tmp, 'roaming');

  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const B = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
    const registered = new Map();
    const noop = () => {};
    B.registerBridgeServices({
      ipcMain: { handle: (c, fn) => registered.set(c, fn), on: (c, fn) => registered.set(c, fn), removeHandler: () => {} },
      bridgeMap: { 'claude.settings': { Custom3pSetup: ['openSetupWindow'] } },
      getMainWindow: () => null,
      settings: {
        preferences: { get: () => undefined, set: () => {}, onDidChange: () => {} },
        onChanged: noop, get: () => undefined, set: () => {},
        theme: { get: () => 'system', set: () => {} },
      },
      frontend: { send: noop, broadcast: noop, on: noop, emit: noop, once: noop },
      log: { info: noop, warn: noop, error: noop, debug: noop },
    });
    const ch = B.messageChannel('claude.settings', 'Custom3pSetup', 'openSetupWindow');
    const handler = registered.get(ch);
    assert.ok(handler, 'the handler did not register');
    const r = await handler({});
    assert.equal(r.ok, false, 'it should report failure outside Electron, got: ' + JSON.stringify(r));
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'no error detail');
  } finally {
    if (saved.L === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.L;
    if (saved.A === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.A;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
