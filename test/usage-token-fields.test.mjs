// The usage cards must carry the field names the row template binds.
//
// Measured live on Settings > Usage:
//
//   Code 387.9万 输入 + 输出 token
//   缓存 token：读取 NaN · 写入 NaN        <- the defect
//
// A real token total next to two NaN cells means the totals object existed but two of
// its keys did not. The row template (c71860c77-C-Aidqqd.js) binds:
//
//   values: { read: <fmt>(t.cacheReadTokens), write: <fmt>(t.cacheWriteTokens) }
//
// The handler served cacheReadInputTokens / cacheCreationInputTokens — the names used by
// a different schema in the bundle (Xh) — so both slots were undefined and each one
// rendered as NaN. Both spellings are now present, because both are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('the usage totals carry the names the row template binds', () => {
  // These two are what the card reads; without them the line is NaN.
  for (const field of ['cacheReadTokens', 'cacheWriteTokens']) {
    assert.match(SRC, new RegExp('\\b' + field + '\\s*:'), 'usage totals are missing ' + field);
  }
});

test('the other schema spelling is kept too', () => {
  // A different consumer in the bundle reads these; keeping both costs nothing and
  // avoids trading one NaN for another.
  for (const field of ['cacheReadInputTokens', 'cacheCreationInputTokens']) {
    assert.match(SRC, new RegExp('\\b' + field + '\\s*:'), 'usage totals dropped ' + field);
  }
});

test('every totals object is built by one helper', () => {
  // If a group inlined its own literal, a new field would silently miss it — exactly
  // how the cache fields went missing from the daily bars as well as the surfaces.
  assert.match(SRC, /const emptyTotals = \(\) => \(\{/, 'the totals helper is missing');
  const calls = (SRC.match(/emptyTotals\(\)/g) || []).length;
  assert.ok(calls >= 2, 'totals are not built through the helper (found ' + calls + ' uses)');
});
