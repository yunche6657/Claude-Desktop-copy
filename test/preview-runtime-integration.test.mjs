import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function setup({ dataDir, cowork = true, remote = true, captureHostOptions = false, hostedSiteCheck } = {}) {
  const handlers = new Map(), contexts = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: c => handlers.delete(c) };
  const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ async run() { return { text: '' }; } }) });
  const host = {
    async createPreview(id, url, cwd, sessionId) { contexts.set(id, { url, cwd, sessionId }); return { tabId: 'seed' }; },
    getPreviewTabs(id) { return contexts.has(id) ? { tabs: [{ tabId: 'seed' }], activeTabId: 'seed' } : { tabs: [] }; },
    getPreviewUrl(id) { return contexts.get(id)?.url; },
    getReadStamp() { return null; }, getHtmlPreviews() { return []; },
    getAllSessionPreviewTabs() { return []; },
    destroyPreview(id) { return contexts.delete(id); },
    teardownRemoteSessionPreview(id) { for (const [key, v] of contexts) if (v.sessionId === id) contexts.delete(key); },
    loadHtmlPreview(...args) { return args.join('|'); }, loadHtmlPreviewContent() { return 'content'; },
    loadClaudePagePreview() { return null; }, setArtifactPaneHost() { return false; }, dispose() {},
  };
  const trustedSender = {};
  const modulePath = require.resolve('../desktop/preview-host.cjs');
  const moduleObject = require.cache[modulePath] || (require(modulePath), require.cache[modulePath]);
  const originalHost = moduleObject.exports;
  let hostOptions;
  if (captureHostOptions) moduleObject.exports = { createPreviewHost: options => { hostOptions = options; return host; } };
  let service;
  try { service = registerBridgeServices({ ipcMain, bridgeMap: require('../desktop/shim/bridge-map.json'),
    ...(captureHostOptions ? { enablePreviewHost: true } : { previewHost: host }), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    consumePreviewUserGesture: sender => sender === trustedSender,
    previewProviders: { getPolicyInput: () => ({ builtinBrowserEnabled: true, featureGates: { '17519066': true, '3990395613': cowork } }),
      getRemoteSession: remote ? async () => ({ verified: true, identityEpoch: 1 }) : undefined, hostedSiteCheck },
    settings: { dataDir, kernelFactory: () => kernel }, frontend: { root: process.cwd() } });
  } finally { moduleObject.exports = originalHost; }
  const invoke = (name, event, ...args) => {
    const channel = [...handlers.keys()].find(c => c.endsWith('_$_Launch_$_' + name));
    assert.ok(channel, name); return handlers.get(channel)(event, ...args);
  };
  return { invoke, service, trustedSender, contexts, kernel, hostOptions };
}

test('bridge delegates HTML methods and rejects unverified remote identities', async () => {
  const s = setup({ remote: false });
  assert.equal(await s.invoke('loadHtmlPreview', {}, 'a', 'b'), 'a|b');
  assert.equal(await s.invoke('loadHtmlPreviewContent', {}), 'content');
  assert.equal(await s.invoke('setArtifactPaneHost', {}), false);
  assert.equal(await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo'), null);
  await s.service.dispose();
});

test('bridge separates Cowork gate and uses sender identity for consent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-bridge-'));
  const s = setup({ dataDir: dir, cowork: false });
  assert.equal(await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo', true), null);
  assert.equal(await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo', false), 'preview-remote-session_foo');
  const card = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'http://localhost:3100' });
  assert.equal(card.kind, 'card');
  assert.equal(await s.invoke('recordRemotePaneOriginDecision', { sender: s.trustedSender }, 'session_foo', card.origin, true), false);
  assert.equal(await s.invoke('admitRemotePaneOriginOnce', { sender: {} }, 'session_foo', card.origin, true), false);
  assert.equal(await s.invoke('admitRemotePaneOriginOnce', { sender: s.trustedSender }, 'session_foo', card.origin), true);
  await s.service.dispose();
});

test('bridge refuses remembered site when preference write fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-write-'));
  fs.mkdirSync(path.join(dir, 'preferences.json'));
  const s = setup({ dataDir: dir });
  await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo');
  const card = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'http://localhost:3100' });
  assert.equal(card.kind, 'card');
  assert.equal(await s.invoke('recordRemotePaneOriginDecision', { sender: s.trustedSender }, 'session_foo', card.origin, true), false);
  const second = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'http://localhost:3100' });
  assert.equal(second.kind, 'card');
  await s.service.dispose();
});

test('remembered site is written to workspace preferences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-persist-'));
  const s = setup({ dataDir: dir });
  await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo');
  const card = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'http://localhost:3100' });
  assert.equal(await s.invoke('recordRemotePaneOriginDecision', { sender: s.trustedSender }, 'session_foo', card.origin, true), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8')).launchPreviewAllowedOrigins, [card.origin]);
  await s.service.dispose();
});

test('canonical file URL outside session roots is rejected by bridge authorization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-path-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const inside = path.join(workspace, 'inside.html'), outside = path.join(dir, 'outside.html');
  fs.writeFileSync(inside, '<p>inside</p>'); fs.writeFileSync(outside, '<p>outside</p>');
  const s = setup({ dataDir: path.join(dir, 'data'), captureHostOptions: true });
  const session = s.kernel.start({ cwd: workspace });
  const artifacts = require('../desktop/preview-artifact.cjs').createPreviewArtifacts(s.hostOptions);
  const args = { sessionId: session.sessionId, cwd: workspace, interactive: false };
  assert.ok(await artifacts.sourceInfo(pathToFileURL(inside).href, args.sessionId, args.cwd, false));
  assert.equal(await artifacts.sourceInfo(pathToFileURL(outside).href, args.sessionId, args.cwd, false), null);
  assert.equal(await s.hostOptions.authorizeHtmlFile({ ...args, requestedPath: inside, sourcePath: outside }), false);
  artifacts.dispose(); await s.service.dispose();
});

test('active flat profile blocklist reaches the origin classifier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-policy-'));
  const config = path.join(dir, 'Claude-3p', 'configLibrary'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, '_meta.json'), JSON.stringify({ entries: [{ id: 'fixture' }], appliedId: 'fixture' }));
  fs.writeFileSync(path.join(config, 'fixture.json'), JSON.stringify({ builtinBrowserEnabled: true,
    builtinBrowserBlockedDomains: ['blocked.example.com'], builtinBrowser: { blockedDomains: [] } }));
  const previous = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = dir;
  let s;
  try {
    s = setup({ dataDir: path.join(dir, 'data'), hostedSiteCheck: async () => ({ category: 'category0' }) });
    await s.invoke('ensureRemoteBlankPreview', {}, 'session_foo');
    const blocked = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'https://blocked.example.com/' });
    const allowed = await s.invoke('resolveRemotePaneConsent', {}, { sessionId: 'session_foo', toolName: 'navigate', url: 'https://allowed.example.com/' });
    assert.equal(blocked.kind, 'deny'); assert.equal(blocked.message, 'This site cannot be used in the browser pane.');
    assert.equal(allowed.kind, 'card');
  } finally {
    if (s) await s.service.dispose();
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
  }
});
