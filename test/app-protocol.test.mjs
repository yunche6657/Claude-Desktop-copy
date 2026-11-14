// Unit tests for the app:// protocol and backend proxy.
//
// The behaviours asserted here are the ones observed in the shipped bundle:
// hostname guard, origin guard, SPA fallback for client routes, 404 for a
// missing static asset, and the /edge-api -> /api rewrite before forwarding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  APP_ORIGIN,
  MISSING_ASSET,
  resolveRequestPath,
  createAppHandler,
} = require('../desktop/app-protocol.cjs');
const {
  rewriteApiPath,
  isBackendPath,
  createBackendProxy,
} = require('../desktop/backend-proxy.cjs');

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'ion-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(path.join(root, 'assets', 'v1'), { recursive: true });
  writeFileSync(path.join(root, 'assets', 'v1', 'app-abc.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'v1', 'font.woff2'), 'wOF2');
  return root;
}

const req = (url, headers = {}) => new Request(url, { headers });

test('resolveRequestPath serves a real file', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/assets/v1/app-abc.js'), path.join(root, 'assets', 'v1', 'app-abc.js'));
});

test('resolveRequestPath maps / to index.html', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/'), path.join(root, 'index.html'));
});

test('resolveRequestPath returns null for a client route', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/epitaxy'), null);
  assert.equal(resolveRequestPath(root, '/code'), null);
});

test('resolveRequestPath reports a missing asset distinctly from a client route', () => {
  // This test used to assert `null` here and its title claimed "(so it becomes a 404)".
  // `null` actually means "serve the SPA shell", so a missing asset answered 200 with
  // index.html -- the assertion was endorsing the bug it claimed to guard. A missing
  // asset now returns MISSING_ASSET, which the handler turns into a real 404.
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/assets/v1/missing.js'), MISSING_ASSET);
  assert.notEqual(resolveRequestPath(root, '/assets/v1/missing.js'), null);
});

test('resolveRequestPath rejects traversal', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/../../etc/passwd'), undefined);
  assert.equal(resolveRequestPath(root, '/assets/../../../etc/passwd'), undefined);
});

test('handler rejects a non-localhost host', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://evil/epitaxy'));
  assert.equal(res.status, 404);
});

test('handler rejects a foreign Origin', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://localhost/epitaxy', { Origin: 'https://example.com' }));
  assert.equal(res.status, 403);
});

test('handler accepts its own Origin', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://localhost/epitaxy', { Origin: APP_ORIGIN }));
  assert.equal(res.status, 200);
});

test('handler serves the SPA shell for a client route', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://localhost/epitaxy'));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="root">/);
});

test('handler serves a static asset with its content type', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://localhost/assets/v1/app-abc.js'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /immutable/);
});

test('handler serves fonts as font/woff2', async () => {
  const root = makeRoot();
  const handle = createAppHandler({ root });
  const res = await handle(req('app://localhost/assets/v1/font.woff2'));
  assert.equal(res.headers.get('content-type'), 'font/woff2');
});

test('edge-api path is rewritten to api', () => {
  assert.equal(rewriteApiPath('/edge-api/bootstrap'), '/api/bootstrap');
  assert.equal(rewriteApiPath('/edge-api/v1/x?y=1'), '/api/v1/x?y=1');
  assert.equal(rewriteApiPath('/api/bootstrap'), '/api/bootstrap');
  assert.equal(rewriteApiPath('/epitaxy'), '/epitaxy');
});

test('isBackendPath covers the observed prefixes', () => {
  for (const p of ['/edge-api/bootstrap', '/api/x', '/v1/code/sessions', '/oauth/token', '/claudeai-rpc/a.b', '/web-api/x', '/v2/x', '/mcp-registry/x']) {
    assert.equal(isBackendPath(p), true, p);
  }
  for (const p of ['/epitaxy', '/assets/v1/x.js', '/index.html']) {
    assert.equal(isBackendPath(p), false, p);
  }
});

test('proxy answers 503 when no backend origin is configured', async () => {
  const forward = createBackendProxy({ backendOrigin: null });
  const res = await forward(req('app://localhost/edge-api/bootstrap'));
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /json/);
});

test('proxy forwards to the rewritten path and streams the body', async () => {
  const seen = [];
  const forward = createBackendProxy({
    backendOrigin: 'https://backend.test',
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method, hasBody: init.body !== undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = await forward(new Request('app://localhost/edge-api/bootstrap?x=1', { method: 'GET' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://backend.test/api/bootstrap?x=1');
});

test('proxy forwards POST bodies', async () => {
  let seenBody = null;
  const forward = createBackendProxy({
    backendOrigin: 'https://backend.test',
    fetchImpl: async (_url, init) => {
      seenBody = init.body ? Buffer.from(init.body).toString() : null;
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = await forward(new Request('app://localhost/edge-api/send', { method: 'POST', body: '{"a":1}' }));
  assert.equal(res.status, 201);
  assert.equal(seenBody, '{"a":1}');
});

test('proxy strips app:// origin from forwarded headers', async () => {
  let seenHeaders = null;
  const forward = createBackendProxy({
    backendOrigin: 'https://backend.test',
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return new Response('{}', { status: 200 });
    },
  });
  await forward(req('app://localhost/api/x', { Origin: APP_ORIGIN }));
  assert.equal(seenHeaders.get('origin'), null);
});

test('proxy maps an upstream failure to 502', async () => {
  const forward = createBackendProxy({
    backendOrigin: 'https://backend.test',
    fetchImpl: async () => { throw new Error('boom'); },
  });
  const res = await forward(req('app://localhost/api/x'));
  assert.equal(res.status, 502);
});

test('handler routes backend paths to the forwarder, not the filesystem', async () => {
  const root = makeRoot();
  let forwarded = 0;
  const handle = createAppHandler({
    root,
    forward: async () => { forwarded++; return new Response('upstream', { status: 200 }); },
  });
  const res = await handle(req('app://localhost/edge-api/bootstrap'));
  assert.equal(forwarded, 1);
  assert.equal(await res.text(), 'upstream');
});
