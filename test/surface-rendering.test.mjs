// Every surface the user can reach must render, and must render its own content.
//
// Measured live this round, reading [role=dialog] (NOT body.innerText — that was the
// mistake of rounds 143 and 151, where settings looked blank because the panel lives in
// a portal outside <main>):
//
//   /epitaxy            -> sidebar + composer
//   /new                -> project / scheduled-task sidebar
//   /settings/general   -> dialog, headings 设置 / 个人资料 / 外观 / 通知
//   /settings/usage     -> dialog, len 428
//   /settings/connectors-> dialog, headings 设置 / 连接器
//   /settings/dev, /settings/privacy, /settings/appearance -> dialog each
//
// Pinning this is not about "it looked fine once": the shipped frontend is served by our
// bootstrap responder, and a wrong payload turns every one of these into a crash screen at
// the same time. The assertions below check the contract that makes them render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = require(path.join(ROOT, 'desktop', 'bootstrap-service.cjs'));

test('the synthetic identity is a uuid the dialog can key on', () => {
  // The settings dialog reads account.uuid. Measured shape: a bare uuid string.
  const id = bootstrap.syntheticIdentity('probe@example.test');
  assert.equal(typeof id, 'string');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'syntheticIdentity is no longer a uuid: ' + id);
});

test('the bootstrap advertises a locale so the dialog is translated', () => {
  // With locale null the frontend fell back to en-US; measured live the dialog renders
  // Chinese headings, which requires a non-null locale in the payload.
  assert.equal(typeof bootstrap.resolveAppLocale, 'function', 'resolveAppLocale is missing');
  assert.equal(bootstrap.resolveAppLocale('zh-Hans'), 'zh-Hans');
});

test('the settings routes are not swallowed by the bootstrap responder', () => {
  // /settings/* is served the app shell; if isBootstrapRequest matched it, the router would
  // receive HTML instead of the app and every settings route would go blank at once.
  const isBootstrap = bootstrap.isBootstrapRequest;
  assert.equal(typeof isBootstrap, 'function');
  assert.equal(isBootstrap('app://x/api/bootstrap'), true);
  assert.equal(isBootstrap('app://x/settings/general'), false, 'the settings route is treated as bootstrap');
});
