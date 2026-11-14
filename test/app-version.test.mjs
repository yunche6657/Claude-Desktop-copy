// getSystemInfo must answer `app_version`, and it must be the version the user has.
//
// The frontend reads `app_version`, not `version`:
//   About panel:  `${y.app_version} · ${t} (${y.arch})`
//                 -> rendered "undefined · Windows 10.0.26200 (x64)"
//   analytics:    app_version in `desktop_dxt_installed` and the feedback payload
//   support:      clientVersion: e?.app_version
//
// Measured on the live replica before the fix:
//   providedKeys: platform, arch, version, electron, chrome, node, os_version, osRelease,
//                 totalMemoryMb, cpus, locale
//   app_version: undefined
//   aboutLine: "undefined · Windows 10.0.26200 (x64)"
// while the installed package is 3.1623.1.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { resolveInstalledVersion } = require('../desktop/bridge-services.cjs');

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

/** The installed Claude package version from the registry, or null. */
function installedVersion() {
  try {
    const out = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages',
      '/s', '/f', 'Claude_', '/k',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/Claude_(\d+\.\d+\.\d+\.\d+)_/);
    return m ? m[1] : null;
  } catch { return null; }
}

test('getSystemInfo answers app_version, not just version', async () => {
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  assert.ok('app_version' in info, 'the frontend reads app_version; version alone is not enough');
  assert.equal(typeof info.app_version, 'string');
  assert.match(info.app_version, /^\d+\.\d+\.\d+/, 'it must look like a version');
});

test('app_version is never the string "undefined"', async () => {
  // The About panel interpolates it directly, so an absent value renders "undefined · ...".
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  assert.notEqual(info.app_version, undefined);
  assert.notEqual(info.app_version, 'undefined');
  assert.notEqual(String(info.app_version), '');
});

test('the About line no longer starts with "undefined"', async () => {
  // Replay the consumer's expression exactly.
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  const os = info.platform === 'win32' ? `Windows ${info.os_version}` : info.platform;
  const line = `${info.app_version} · ${os} (${info.arch})`;
  assert.ok(!line.startsWith('undefined'), `About line was: ${line}`);
  assert.match(line, /^\d+\.\d+\.\d+/);
});

test('app_version reports the installed package when one is registered', async () => {
  const expected = installedVersion();
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  if (expected) {
    assert.equal(info.app_version, expected,
      'the version shown must be the package the user actually has');
  }
});

test('resolveInstalledVersion picks the highest version numerically', () => {
  // Lexical sorting would put 3.1623.9.0 above 3.1623.10.0.
  const result = resolveInstalledVersion(() => [
    'Claude_3.1623.9.0_x64__pzs8sxrjxfjjc',
    'Claude_3.1623.10.0_x64__pzs8sxrjxfjjc',
  ]);
  assert.equal(result, '3.1623.10.0');
});

test('resolveInstalledVersion answers null when nothing is registered', () => {
  assert.equal(resolveInstalledVersion(() => []), null);
  assert.equal(resolveInstalledVersion(() => null), null);
});

test('resolveInstalledVersion ignores names without a version', () => {
  assert.equal(resolveInstalledVersion(() => ['NotClaude', 'Claude_bad']), null);
});

test('installer_variant names the packaging on Windows', async () => {
  // YE() checks `=== "deb"`; this is an MSIX build, so the honest value is "msix" rather
  // than claiming a Linux package format.
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  if (process.platform === 'win32') {
    assert.equal(info.installer_variant, 'msix');
    assert.notEqual(info.installer_variant, 'deb');
  }
});

test('the fields the terminal backend reads are still intact', async () => {
  // Regression guard: os_version is split to derive the conpty build number.
  const { call } = makeBridge();
  const info = await call('DesktopInfo', 'getSystemInfo');
  assert.equal(info.platform, process.platform);
  assert.ok(info.os_version, 'os_version is split by the terminal backend');
  assert.equal(Number(String(info.os_version).split('.')[0]) > 0, true);
  assert.ok('electron' in info);
  assert.ok('chrome' in info);
});
