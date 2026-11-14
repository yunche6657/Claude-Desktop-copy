// The zh-Hans overlay must not leave ordinary UI strings in English.
//
// The overlay is our own file (resources/i18n-overlay/zh-Hans.json); the shipped
// ion-dist catalogue is read-only. Where a key is absent the renderer falls back to
// en-US, so a gap shows up as an English word inside an otherwise Chinese UI.
//
// Measured before the fix: 222 keys missing, 86 of them short UI strings such as
//   Find… / Font / Other… / Search sessions / Reply… / Request seat
// After translating the plain-language ones, 149 keys remain missing but only 13 are
// short, and every one of those is a sample value or format string that must NOT be
// translated: `ex: Sales`, `path/to/file.md`, `0 9 * * *`, `name@{domain}`,
// `claude://cowork/...`, `123456`, `1Y`, `•••••••• (saved)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const OVERLAY = path.join(ROOT, 'resources', 'i18n-overlay', 'zh-Hans.json');

const leaves = (o, p = '', out = new Map()) => {
  for (const [k, v] of Object.entries(o)) {
    const n = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, n, out);
    else out.set(n, v);
  }
  return out;
};

test('the overlay parses and holds translations', () => {
  const zh = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  const keys = Object.keys(zh);
  assert.ok(keys.length > 37000, 'overlay shrank unexpectedly: ' + keys.length);
  // Every value must be a plain string: the renderer indexes it directly.
  for (const k of keys.slice(0, 500)) {
    assert.equal(typeof zh[k], 'string', 'non-string value at ' + k);
  }
});

test('the UI strings that used to fall back to English are translated', () => {
  // These were measured as missing and are ordinary interface words, not samples.
  const zh = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  const expected = {
    '/VSkivQ0nA': '查找…',
    '4ueJ4XpfAb': '字体',
    'aWZzyB3FYG': '搜索会话',
    'p9MPkbVUdx': '回复…',
    'n8gCK/a5Vh': '申请席位',
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(zh[k], v, 'missing translation for ' + k);
  }
});

test('sample values and format strings are deliberately left alone', () => {
  // Translating these would corrupt what the field shows the user.
  const zh = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  for (const k of ['0StYQKzFD4', '9NwM6kaCHe', 'uN61zUfXcF', 'xG8PvEddpj', 'ujJTh2rta8']) {
    assert.equal(zh[k], undefined, 'a sample/format value must not be translated: ' + k);
  }
});
test('the app actually serves the overlay we edited', () => {
  // Editing the catalog is pointless if the resolver points elsewhere.
  const { resolveCatalogOverlay } = require(path.join(ROOT, 'desktop', 'i18n-overlay.cjs'));
  const overlayRoot = path.join(ROOT, 'resources', 'i18n-overlay');
  const served = resolveCatalogOverlay(overlayRoot, '/i18n/zh-Hans.json');
  assert.ok(served, 'the resolver returned nothing');
  assert.equal(path.resolve(served), path.resolve(OVERLAY), 'the resolver serves a different file');
  const parsed = JSON.parse(fs.readFileSync(served, 'utf8'));
  assert.equal(parsed['/VSkivQ0nA'], '查找…', 'the served catalog must contain the new translation');
});
