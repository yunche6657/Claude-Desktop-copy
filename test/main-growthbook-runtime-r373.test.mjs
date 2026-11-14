import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMainGrowthBookRuntime } = require('../desktop/main-growthbook-runtime.cjs');
const { hardcodedMainGrowthBookFeatures } = require('../desktop/growthbook-3p-policy.cjs');
const { resolveIdleTimeout } = require('../desktop/session-idle-policy.cjs');

test('main runtime receives controlled HTTP features, persists native fcache, resumes offline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-growthbook-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ features: { '4041267332': { value: 90001, on: true } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = { mode: '1p', source: { kind: 'remote', fetch: () => fetch(`http://127.0.0.1:${server.address().port}/api/desktop/features`) } };
  const make = () => createMainGrowthBookRuntime({ getContext: () => context, userData: dir });
  let runtime = make();
  try {
    await runtime.init();
    assert.deepEqual(requests, ['/api/desktop/features']);
    assert.equal(resolveIdleTimeout({ unattended: false }, runtime.getFeatureValue), 90001);
    let bytes;
    for (let i = 0; i < 100; i++) {
      try { bytes = await fs.readFile(path.join(dir, 'fcache')); break; } catch { await new Promise(r => setTimeout(r, 5)); }
    }
    assert.equal(bytes.subarray(0, 8).toString('hex'), '434c4602009ab7e2');
    runtime.dispose(); context.source.fetch = async () => { throw Error('offline'); };
    runtime = make(); await runtime.init();
    assert.equal(resolveIdleTimeout({ unattended: false }, runtime.getFeatureValue), 90001);
  } finally {
    runtime.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('local 3p static policy never calls transport or creates fcache and absent idle key stays zero', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-growthbook-static-'));
  const runtime = createMainGrowthBookRuntime({ userData: dir, getContext: () => ({ mode: '3p', source: {
    kind: 'static', features: hardcodedMainGrowthBookFeatures({ builtinBrowserEnabled: true, selfHostedSessions: false }),
    fetch: () => { throw Error('static must not fetch'); },
  } }) });
  try {
    assert.equal(await runtime.init(), 'static');
    assert.equal(resolveIdleTimeout({ unattended: false }, runtime.getFeatureValue), 0);
    assert.equal(resolveIdleTimeout({ unattended: true }, runtime.getFeatureValue), 900000);
    await assert.rejects(fs.stat(path.join(dir, 'fcache')), { code: 'ENOENT' });
  } finally { runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
