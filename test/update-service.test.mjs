import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { UpdateService, checkedUrl, validateManifest } = require('../desktop/update-service.cjs');
const { writeReleaseManifest } = require('../tools/release-update-manifest.cjs');
const payload = Buffer.from('fixture NSIS installer');
const thumbprint = 'A'.repeat(40);
async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccd-update-'));
  let manifest; let installerRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/manifest') { res.end(JSON.stringify(manifest)); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://example.com/update.exe' }); res.end(); }
    else { installerRequests++; res.setHeader('Content-Length', payload.length); res.end(payload); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  manifest = { version: '0.2.0', platform: 'win32', arch: 'x64', installer: 'nsis', url: base + '/update.exe', size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const service = new UpdateService({ source: base + '/manifest', currentVersion: '0.1.0', platform: 'win32', arch: 'x64', directory, signerThumbprint: thumbprint, allowLoopbackHttp: true, verifySignature: async () => ({ status: 'Valid', thumbprint }), launchInstaller: async () => {} });
  try { await fn({ service, manifest, directory, base, installerRequests: () => installerRequests }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
}
test('unconfigured update source explicitly offers manual update', async () => {
  const service = new UpdateService({ currentVersion: '0.1.0' });
  assert.equal((await service.check()).status, 'manual');
  assert.match(service.getState().message, /手动更新/);
});
test('checks without downloading, streams progress, verifies and launches on request', () => fixture(async ({ service, installerRequests }) => {
  assert.equal((await service.check()).status, 'available');
  assert.equal(installerRequests(), 0);
  const states = []; service.on('state', s => states.push(s));
  assert.equal((await service.download()).canInstall, true);
  assert.ok(states.some(s => s.status === 'downloading' && s.progress > 0));
  assert.equal((await service.install()).status, 'installing');
}));
test('digest failure cleans partial files and preserves current version', () => fixture(async ({ service, manifest, directory }) => {
  manifest.sha256 = '0'.repeat(64); await service.check();
  assert.equal((await service.download()).status, 'error');
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(service.getState().currentVersion, '0.1.0');
}));
test('downgrades and foreign architectures are rejected', () => fixture(async ({ service, manifest }) => {
  manifest.version = '0.0.9'; assert.equal((await service.check()).status, 'error');
  manifest.version = '0.2.0'; manifest.arch = 'arm64'; assert.equal((await service.check()).status, 'error');
}));
test('invalid signer configuration reports an error without breaking app startup', async () => {
  const service = new UpdateService({ currentVersion: '0.1.0', source: 'https://example.com/update.json', signerThumbprint: 'bad' });
  assert.equal((await service.check()).status, 'error');
  assert.match(service.getState().message, /指纹/);
});
test('HTTPS required and credentials forbidden including loopback', () => {
  assert.throws(() => checkedUrl('http://example.com/update.json'));
  assert.throws(() => checkedUrl('https://user:pass@example.com/update.json'));
  assert.throws(() => checkedUrl('http://user:pass@127.0.0.1/update.json', true));
  assert.throws(() => checkedUrl('http://localhost/update.json', true));
});
test('cross-origin redirects fail', () => fixture(async ({ service, manifest, base }) => {
  manifest.url = base + '/redirect.exe';
  // fixture redirects only this route
  service.source = base + '/redirect';
  assert.equal((await service.check()).status, 'error');
  assert.match(service.getState().message, /跨越源站/);
}));
test('unsigned and unpinned downloads use manual installer handling', () => fixture(async ({ service }) => {
  service.signerThumbprint = ''; service.verifySignature = async () => ({ status: 'NotSigned', thumbprint: '' });
  await service.check(); const s = await service.download();
  assert.equal(s.status, 'downloaded'); assert.equal(s.canInstall, false);
  assert.equal((await service.install()).status, 'error');
}));
test('signature mismatch and changed installer block launch', () => fixture(async ({ service }) => {
  await service.check(); service.verifySignature = async () => ({ status: 'Valid', thumbprint: 'B'.repeat(40) });
  assert.equal((await service.download()).status, 'error');
  service.verifySignature = async () => ({ status: 'Valid', thumbprint });
  await service.download(); await fs.appendFile(service.file, 'tamper');
  assert.equal((await service.install()).status, 'error');
}));
test('release helper writes matching HTTPS manifest and leaves installer', () => fixture(async ({ directory }) => {
  const installer = path.join(directory, 'setup.exe'); await fs.writeFile(installer, payload);
  const result = await writeReleaseManifest({ installer, version: '0.2.0', url: 'https://updates.example.com/setup.exe' });
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(manifest.size, payload.length); assert.ok(await fs.stat(installer));
}));
