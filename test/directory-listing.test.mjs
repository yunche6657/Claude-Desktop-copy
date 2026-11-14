// Directory listings must not silently hide most of a folder.
//
// The contract here is a bare ARRAY, so unlike Glob's max_results there is nowhere to attach a
// truncation notice — a capped listing simply looks like a short folder. The fix is therefore
// not to report the cap but to set it where an ordinary directory never reaches it.
//
// Measured before the change: C:/Windows/System32 has 4,994 entries and the bridge returned
// 500 of them. Cost of returning all: readdir 2 ms, map 1 ms, 458 KB payload — so the low cap
// bought no measurable performance while hiding 90% of the folder.
//
// After: the same call returns 4,994 entries (verified live through the bridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const LIVE = process.env.REPLICA_CDP;
const liveTest = LIVE ? test : test.skip;

test('the directory listing cap covers ordinary system folders', () => {
  // 20,000 is above System32 (4,994) and every folder a user browses day to day.
  const match = SOURCE.match(/const LIST_DIRECTORY_MAX_ENTRIES = ([\d_]+)/);
  assert.ok(match, 'the listing cap constant is gone');
  const limit = Number(match[1].replace(/_/g, ''));
  assert.ok(limit >= 20000, 'the listing cap is too low to cover a normal folder: ' + limit);
});

test('both listing entry points use the shared cap', () => {
  // They used to hard-code 500 and 2000 — two different limits for the same concept.
  const uses = [...SOURCE.matchAll(/entries\.slice\(0, LIST_DIRECTORY_MAX_ENTRIES\)/g)];
  assert.equal(uses.length, 2, 'expected both listing paths to share the cap, found ' + uses.length);
  assert.equal(/entries\.slice\(0, 500\)/.test(SOURCE), false, 'a hard-coded 500 is back');
  assert.equal(/entries\.slice\(0, 2000\)/.test(SOURCE), false, 'a hard-coded 2000 is back');
});

test('the cap is declared before its first use', () => {
  // const is not hoisted: the first version placed the declaration 40 lines below its use,
  // which would have thrown a ReferenceError on every listing.
  const declaredAt = SOURCE.indexOf('const LIST_DIRECTORY_MAX_ENTRIES');
  const firstUseAt = SOURCE.indexOf('entries.slice(0, LIST_DIRECTORY_MAX_ENTRIES)');
  assert.ok(declaredAt > 0, 'the constant is not declared');
  assert.ok(declaredAt < firstUseAt, 'the constant is declared after it is used');
});

liveTest('a large system folder is listed in full', async () => {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const probe = "(async () => { const api = window['claude.web'].FileSystem;"
    + " const out = await api.listDirectory('C:/Windows/System32');"
    + ' return JSON.stringify({ count: (out || []).length, isArray: Array.isArray(out) }); })()';
  const result = await withTarget(null, async (connection) => JSON.parse(await connection.eval(probe)));
  assert.equal(result.isArray, true, 'the listing did not answer an array');
  assert.ok(result.count > 2000,
    'a system folder was cut down to ' + result.count + ' entries');
});
