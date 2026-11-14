// R642: a "Model" entry in the account menu, sharing the Settings item's click handler.
//
// WHY IT SHARES THE HANDLER
//   The setup page's own sections are source / connection / egress / plugins (four `Z==="..."` comparisons), and
//   every model field lives under `connection`: Model list (flatKey inferenceModels), Model discovery,
//   Test model discovery, "Set a model first". The page reads NO url parameter at all — location.search,
//   URLSearchParams and searchParams are all absent — so there is no way to deep-link to a model pane, and no
//   separate model dialog exists. "Same as Settings" is therefore the structure of the build, not a shortcut.
//
// HOW IT WAS INSERTED
//   1. No new hook slot. The component allocates J9(199), so an extra slot would shift every `$[n]` after it. The
//      new item rides inside the fragment helper the chunk already uses 15 times: i(a,{children:[...]}).
//   2. `onClick: jt` — the exact callback the Settings item uses, so both reach the same surface through the
//      verified openSetupWindow bridge method.
//   3. `data-testid="user-menu-model"` so a test can locate it.
//
// WHAT IS VERIFIED, AND WHAT IS NOT
//   verified: chunk parses (node --check), the app boots and renders, the bundle contains both testids.
//   NOT verified: the item appearing in the DOM. The account popover does not open under synthetic CDP input —
//   mouse event sequences, in-page PointerEvent dispatch, the Ctrl+, accelerator and URL navigation were all tried.
//   Without the popover there is no DOM to assert against.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js');
const BACKUP = CHUNK + '.bak-r642';

test('the account menu carries both entries', () => {
  assert.ok(fs.existsSync(CHUNK), 'the menu chunk is missing');
  const src = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(src.includes('user-menu-settings'), 'the Settings entry disappeared');
  assert.ok(src.includes('user-menu-model'), 'the Model entry is missing');
});

test('the Model entry renders with a click handler', () => {
  // R642 asserted this entry shared the Settings handler (onClick:jt). R647 measured that handler landing on
  // #settings/claude-code — the appearance dialog, which has no model fields — and repointed the entry at
  // openSetupWindow. What survives from R642 is existence plus a handler; R647 owns the destination.
  const src = fs.readFileSync(CHUNK, 'utf8');
  const i = src.indexOf('user-menu-model');
  assert.ok(i > 0, 'the Model entry is gone');
  const bag = src.slice(i, i + 260);
  assert.match(bag, /onClick:/, 'the Model entry has no click handler:\n' + bag);
});

test('no extra hook slot was allocated for the new entry', () => {
  // The file declares several J9(n) arrays, so the invariant is not "max slot < some capacity".
  // What must hold is that the EDIT did not move any slot index: the slot multiset is identical to the backup's.
  const src = fs.readFileSync(CHUNK, 'utf8');
  const orig = fs.readFileSync(BACKUP, 'utf8');
  const slots = (s) => [...s.matchAll(/\$\[(\d+)\]/g)].map((m) => m[1]).sort().join(',');
  assert.equal(slots(src), slots(orig), 'the hook slot indices changed, so the insert shifted the array');
});

test('the backup exists and predates the edit', () => {
  assert.ok(fs.existsSync(BACKUP), 'no rollback copy');
  const orig = fs.readFileSync(BACKUP, 'utf8');
  const now = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(!orig.includes('user-menu-model'), 'the backup already contains the new entry');
  assert.ok(now.length > orig.length, 'the edited chunk is not larger than the backup');
  assert.ok(orig.includes('user-menu-settings'), 'the backup is not a valid pre-edit copy');
});

test('the underlying opener still exists in the bridge', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(/openSetupWindow',\s*\(\)\s*=>/.test(bridge), 'openSetupWindow is gone, so both entries would be dead');
  assert.ok(bridge.includes('setup-desktop-3p'));
});
