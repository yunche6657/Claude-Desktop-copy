// R643: the R642 menu edit IS in the runtime — but the popover cannot be opened under CDP, so there is still no DOM proof.
//
// WHAT THIS ROUND ESTABLISHED (the only new fact)
//   Fetched from INSIDE the running page — not from disk:
//       const r = await fetch('/assets/v1/cd75f6c8c-zFZzXb5w.js'); const t = await r.text();
//       -> { ok: true, length: 23276, hasModel: true, hasSettings: true }
//   So the renderer is served the edited bundle. The change reaches runtime.
//
// WHAT SIX INPUT METHODS FAILED TO DO
//       Input.dispatchMouseEvent (basic)          popover did not open
//       pointer sequence with pointerType:mouse   did not open
//       in-page PointerEvent + MouseEvent         did not open
//       Page.bringToFront then click              did not open (document.hasFocus() was true)
//       focus + Enter                             did not open
//       focus + Space / ArrowDown (Radix)         did not open
//
//   Along the way: elementFromPoint(105,272).closest('button') IS the Administrator row (190x24), so the click
//   coordinate was right; the button accepts .focus() and becomes activeElement, so it is reachable; a
//   [role="presentation"] wrapper confirms Radix. The blocker is synthetic input, not the code.
//
// WHY THIS STOPPED HERE
//   A seventh input variant yields no new information. This check needs a real pointer, i.e. the user.
//
// WHAT IS NOT CLAIMED
//   Not that the item renders: it is in the bundle and in the runtime, with no DOM evidence.
//   Not that the insertion point is correct: the item rides the Settings item's render path; if that popover has
//   more than one branch (desktop vs web), the insert may cover only one of them. Only a real click can tell.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1', 'cd75f6c8c-zFZzXb5w.js');
const BACKUP = CHUNK + '.bak-r642';

test('the edited chunk is the one the renderer is served', () => {
  // The page fetches this exact path; a mismatch between the file on disk and the served asset would mean the
  // edit never shipped. The route is /assets/v1/<file> under app://localhost, so the file must sit there.
  assert.ok(fs.existsSync(CHUNK), 'the chunk the renderer requests is missing');
  const src = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(src.includes('user-menu-model'), 'the served chunk lacks the Model entry');
  assert.ok(src.length > 0, 'the chunk is empty');
  const orig = fs.readFileSync(BACKUP, 'utf8');
  assert.ok(src.length > orig.length, 'the served chunk is not the edited one (not larger than its backup)');
  assert.notEqual(src, orig, 'the served chunk is byte-identical to the pre-edit copy');
});

test('the Model entry is on the same render path as Settings', () => {
  const src = fs.readFileSync(CHUNK, 'utf8');
  const i = src.indexOf('user-menu-model');
  // Both items must sit inside one fragment expression, which is what makes them co-rendered.
  const before = src.slice(Math.max(0, i - 600), i);
  assert.ok(before.includes('user-menu-settings'), 'the Model entry is not adjacent to the Settings entry');
  assert.ok(before.includes('children:['), 'the entries are not wrapped in the fragment that co-renders them');
});

test('a rollback copy exists and differs only by the edit', () => {
  assert.ok(fs.existsSync(BACKUP), 'no rollback copy');
  const orig = fs.readFileSync(BACKUP, 'utf8');
  const now = fs.readFileSync(CHUNK, 'utf8');
  assert.ok(!orig.includes('user-menu-model'));
  assert.ok(orig.includes('user-menu-settings'));
  // Slot indices must be identical: the insert added no hook.
  const slots = (s) => [...s.matchAll(/\$\[(\d+)\]/g)].map((m) => m[1]).sort().join(',');
  assert.equal(slots(now), slots(orig), 'the hook slots moved');
});

test('the opener both entries call is still verified-implemented', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(/openSetupWindow',\s*\(\)\s*=>/.test(bridge));
  assert.ok(bridge.includes('setup-desktop-3p'));
  assert.ok(bridge.includes('preload-frontend.cjs'), 'the new window lost its preload, so the page would have no bridge');
});

test('the evidence records the runtime check rather than claiming a DOM result', () => {
  const doc = path.join(ROOT, 'evidence', 'model-entry-runtime-verified-r643.md');
  assert.ok(fs.existsSync(doc), 'the evidence document is missing');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.includes('23276'), 'the runtime byte check is not recorded');
  assert.ok(text.includes('未验证'), 'the absence of DOM proof is not stated');
});
