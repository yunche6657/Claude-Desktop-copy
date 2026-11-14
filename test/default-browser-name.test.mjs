// DesktopInfo.getDefaultBrowserName must name the browser, or answer null honestly.
//
// The Preview pane's external-link label reads (c8ae173c6-B7L_--bW.js):
//   let e = r?.getDefaultBrowserName?.();
//   e && e.then(e => { let t = e || null; t !== s && (s = t, l.notify()) })
//   ...
//   t === null ? formatMessage(o.generic) : formatMessage(o.named, { browserName: t })
// i.e. "Open in default browser" vs "Open in Microsoft Edge".
//
// The consumer is null-safe, so a missing handler was not a crash -- the label simply never
// named the browser. Measured on the live replica before the fix:
//   getDefaultBrowserName() -> null, labelWouldBe "Open in default browser"
// while the host does have a default browser:
//   HKCU\...\UrlAssociations\http\UserChoice  ProgId = MSEdgeHTM
//   HKCR\MSEdgeHTM\shell\open\command -> "...\MsEdge.exe"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

/** The ProgId this host actually has configured, or null. */
function hostProgId() {
  try {
    const out = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
      '/v', 'ProgId',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (out.match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1] || null;
  } catch { return null; }
}

test('the answer is a non-empty string or null, never undefined or an object', async () => {
  const { call } = makeBridge();
  const name = await call('DesktopInfo', 'getDefaultBrowserName');
  assert.ok(name === null || typeof name === 'string', `unexpected type ${typeof name}`);
  if (typeof name === 'string') assert.ok(name.trim().length > 0, 'an empty string is not a name');
});

test('on this host the browser is named, because one is configured', async () => {
  const { call } = makeBridge();
  const name = await call('DesktopInfo', 'getDefaultBrowserName');
  if (process.platform === 'win32' && hostProgId()) {
    assert.equal(typeof name, 'string', 'a configured browser must produce a name');
    assert.ok(name.length > 1, `too short to be a browser name: ${JSON.stringify(name)}`);
  }
});

test('the reported name matches the configured ProgId, not a guess', async () => {
  // Guards against returning a hard-coded "Google Chrome": the host is configured for
  // MSEdgeHTM, so the answer must be Edge and must not be a different browser.
  const { call } = makeBridge();
  const name = await call('DesktopInfo', 'getDefaultBrowserName');
  const progId = hostProgId();
  if (process.platform === 'win32' && progId && name) {
    const lower = name.toLowerCase();
    if (/msedge/i.test(progId)) {
      assert.match(lower, /edge/, `host ProgId is ${progId} but the name was ${JSON.stringify(name)}`);
      assert.doesNotMatch(lower, /chrome|firefox/, 'must not name a browser the host does not use');
    }
  }
});

test('the label the consumer builds is specific, not the generic fallback', async () => {
  // Replay the consumer's own expression.
  const { call } = makeBridge();
  const name = await call('DesktopInfo', 'getDefaultBrowserName');
  const label = name == null ? 'Open in default browser' : `Open in ${name}`;
  if (process.platform === 'win32' && hostProgId()) {
    assert.notEqual(label, 'Open in default browser', 'the generic fallback must not be used when a browser is known');
    assert.match(label, /^Open in \S/);
  }
});

test('the consumer\'s null-safe path still works if the name is null', async () => {
  // The consumer does `let t = e || null` before comparing, so falsy values all collapse to
  // null and the generic wording is used. Replay that exact expression -- note that an
  // empty string is handled by the `|| null`, not by the ternary.
  const label = (raw) => {
    const t = raw || null;
    return t === null ? 'Open in default browser' : `Open in ${t}`;
  };
  assert.equal(label(null), 'Open in default browser');
  assert.equal(label(undefined), 'Open in default browser');
  assert.equal(label(''), 'Open in default browser', 'the `|| null` collapses an empty string');
  assert.equal(label('Microsoft Edge'), 'Open in Microsoft Edge');
});

test('getSystemInfo still answers real data (the sibling that already worked)', async () => {
  // A regression guard on the service as a whole: adding a handler must not disturb the
  // one that was already correct.
  //
  // `electron` and `chrome` come from process.versions and are only populated inside
  // Electron; under plain node they are undefined. So the fields that are always present
  // are the ones asserted by value, and the Electron-provided ones by key.
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  assert.equal(typeof info, 'object');
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.ok('electron' in info, 'the electron field must exist (undefined outside Electron)');
  assert.ok('chrome' in info, 'the chrome field must exist (undefined outside Electron)');
  assert.ok(info.os_version, 'os_version is read by the terminal backend');
  assert.equal(typeof info.cpus, 'number');
});
