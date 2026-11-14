import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The IndexedDB fix must be judged by the warnings it removes, not by open() returning.
//
//   before the fix (every mount, 9x + 4x):
//     [LOCAL_STORAGE] IndexedDB state read rejected; continuing without persisted state
//     [LOCAL_STORAGE] ccd_retired_pin_purge_failed {"name":"epitaxy-tasks-store",...}
//
//   after (fresh launch, measured):
//     IndexedDB rejected 0, pin purge failed 0, other LOCAL_STORAGE 0
//     databases: [keyval-store, ...]   stored preference keys: 13 (was 11)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the storage warning text the fix targets is still the shipped one', () => {
  // If the bundle renames this message, a live check counting it would report zero for the
  // wrong reason -- a green result with no coverage.
  const dir = PINNED_ION_DIST + '/assets/v1';
  if (!fs.existsSync(dir)) return;
  const text = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
  assert.ok(text.includes('IndexedDB state read rejected'),
    'the warning text changed; the live verification would count nothing');
});

test('every Chromium storage root lives under .data', () => {
  // Parse the candidate by meaning, not by a literal path.
  //
  // The first version asserted that the block does not contain the string 'resources/ion-dist'.
  // A mutation that retargeted the root to resources/ion-dist stayed GREEN, because the mutated
  // line spelled it as two path.join arguments — the assertion was testing prose, not behaviour.
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const at = main.indexOf('(function relocateChromiumStorage()');
  assert.ok(at > 0, 'the relocation helper is missing');
  const block = main.slice(at, at + 1200);
  const candidate = block.match(/const candidate = path\.join\(([^;]+)\);/);
  assert.ok(candidate, 'the candidate path is not built with path.join');
  const expr = candidate[1];
  assert.match(expr, /workspace/, 'the storage root ignores the workspace');
  assert.match(expr, /['"]\.data['"]/, 'the storage root is not inside .data');
  assert.equal(/ion-dist|resources/.test(expr), false,
    'the storage root points into the read-only vendor bundle: ' + expr);
});
