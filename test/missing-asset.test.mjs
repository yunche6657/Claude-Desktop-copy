// A missing asset must be a 404, not the SPA shell.
//
// `resolveRequestPath` has three distinct failure outcomes and they need three different
// HTTP responses:
//   undefined      -> 403 (path traversal / NUL)
//   MISSING_ASSET  -> 404 (a dotted asset that is not on disk)
//   null           -> 200 with index.html (a client route)
//
// The middle one used to return `null` as well. That meant a request for a locale catalog
// the build does not ship -- /i18n/zh-Hans-CN.json -- answered HTTP 200 with index.html in
// the body. The locale loader then ran `await response.json()` on an HTML document and
// threw "Unexpected token '<'", which is why a Chinese-language request could not even
// fail cleanly.
//
// Observed on the live replica before the fix:
//   /i18n/ja-JP.json      -> 200, 36099 keys   (shipped)
//   /i18n/zh-Hans-CN.json -> 200, "<!doctype " (the SPA shell -- wrong)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRequestPath, MISSING_ASSET } = require('../desktop/app-protocol.cjs');

function makeRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fx-i18n-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  mkdirSync(path.join(dir, 'i18n'));
  writeFileSync(path.join(dir, 'i18n', 'en-US.json'), '{"a":"b"}');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'export default 1;');
  return dir;
}

test('an existing locale catalog resolves to the file', () => {
  const root = makeRoot();
  const result = resolveRequestPath(root, '/i18n/en-US.json');
  assert.equal(result, path.join(root, 'i18n', 'en-US.json'));
});

test('a missing locale catalog reports MISSING_ASSET, not the SPA shell', () => {
  // This is the defect: a build that ships 11 locales must answer 404 for the 12th,
  // not 200 with HTML.
  const root = makeRoot();
  const result = resolveRequestPath(root, '/i18n/zh-Hans-CN.json');
  assert.equal(result, MISSING_ASSET);
  assert.notEqual(result, null, 'null means "client route -> serve index.html"');
});

test('a missing JS asset also reports MISSING_ASSET', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/assets/v1/nope.js'), MISSING_ASSET);
});

test('a client route still resolves to the SPA shell', () => {
  const root = makeRoot();
  assert.equal(resolveRequestPath(root, '/epitaxy'), null);
  assert.equal(resolveRequestPath(root, '/customize/skills'), null);
  assert.equal(resolveRequestPath(root, '/'), path.join(root, 'index.html'));
});

test('the three outcomes are distinguishable', () => {
  // The whole point: three sentinels, three meanings, no collision.
  const root = makeRoot();
  const missing = resolveRequestPath(root, '/i18n/nope.json');
  const route = resolveRequestPath(root, '/epitaxy');
  const traversal = resolveRequestPath(root, '/../../etc/passwd');

  assert.equal(missing, MISSING_ASSET);
  assert.equal(route, null);
  assert.equal(traversal, undefined);

  const seen = new Set([String(missing), String(route), String(traversal)]);
  assert.equal(seen.size, 3, 'the three sentinels must not collide');
});

test('MISSING_ASSET is exported so callers can compare against it', () => {
  // Without the export the handler cannot tell 404 from "serve the shell", and a test
  // comparing against an undefined symbol silently passes everything.
  assert.ok(MISSING_ASSET !== undefined && MISSING_ASSET !== null);
  assert.equal(typeof MISSING_ASSET, 'symbol');
});

test('a directory without index.html is not served as a file', () => {
  const root = makeRoot();
  mkdirSync(path.join(root, 'emptydir'));
  // Not a dotted asset and not a file: it is a client route by the existing rule.
  assert.equal(resolveRequestPath(root, '/emptydir'), null);
});
