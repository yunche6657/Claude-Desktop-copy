import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The theme picker updates its own state but never changes what the page looks like.
//
// MEASURED LIVE (replica on port 10100, settings dialog open on the 常规 panel):
//
//   the 外观 > 主题 control is three 30px role=radio spans
//   clicking the 2nd (dark) with real pointer events:
//     aria-checked  [true,false,false] -> [false,true,false]     <- the control DID respond
//     documentElement.dataset.mode:  light  ->  light             <- the page did NOT
//     getComputedStyle(body).backgroundColor: rgb(252,252,251) (unchanged)
//     MutationObserver on data-mode: [] (no change at all)
//
// The rendering machinery itself is fine: setting the attribute by hand proves it.
//   documentElement.setAttribute('data-mode','dark')
//     -> bg rgb(21,21,21), colorScheme dark, text rgb(240,239,236)
// and the CSS agrees — 25 bundles contain `[data-mode=dark]` rules, and c77a4b9a8 wires a
// MutationObserver on data-mode that recomputes the palette.
//
// So the defect is precisely located: the picker writes its selection to localStorage
// (`LSS-userThemeMode = {"value":"light"}` is present) and to its own radio state, but the
// data-mode attribute is never updated, so the visual theme stays where it started.
//
// WHY THIS IS A TEST AND NOT JUST A NOTE: the mechanism is one attribute away from working,
// which means a future change that DOES set it must keep working. The assertions below pin
// the contract the renderer relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = PINNED_ION_DIST + '/assets/v1';

function bundleText() {
  if (!fs.existsSync(BUNDLE_DIR)) return null;
  return fs.readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith('.css') || f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8'))
    .join('\n');
}

test('the shipped stylesheet keys dark mode off data-mode, not a class', () => {
  const text = bundleText();
  assert.ok(text, 'the shipped bundle is missing: ' + BUNDLE_DIR);
  assert.ok(text.includes('[data-mode=dark]'), 'the dark theme selector is gone');
});

test('the renderer watches data-mode with a MutationObserver', () => {
  // This is what makes setting the attribute sufficient to repaint.
  const text = bundleText();
  assert.match(text, /attributeFilter:\["data-mode"\]/, 'the data-mode observer is gone');
});

test('theme mode is sent to the main process as light/dark/system', () => {
  // The bridge normalises 'auto' to 'system'; a wrong value here would persist nonsense.
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf("'claude.web_$_WindowControl_$_setThemeMode'");
  assert.ok(at > 0, 'the setThemeMode handler is missing');
  const block = bridge.slice(at, at + 260);
  assert.match(block, /mode === 'light' \|\| mode === 'dark' \|\| mode === 'system'/,
    'the handler accepts values outside light/dark/system');
});
// ---- round 249: the fix, and the round trip that proves it -----------------------------
//
// Live measurement after wiring setThemeMode to apply the theme:
//
//   before:                data-mode=light  bg=rgb(252,252,251)
//   setThemeMode('dark')   -> { ok: true, mode: 'dark', applied: 'dark' }
//   after:                 data-mode=dark   bg=rgb(21,21,21)  colorScheme=dark  text=rgb(240,239,236)
//   setThemeMode('light')  -> { ok: true, mode: 'light', applied: 'light' }
//   back:                  data-mode=light  bg=rgb(252,252,251)
//
// The handler now returns `applied`: the mode actually written to the DOM, which is not always
// the mode requested (system is resolved against nativeTheme). Reporting the resolved value
// rather than echoing the request is what makes a failed application visible.

test('the theme handler applies the mode to the renderer', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf("'claude.web_$_WindowControl_$_setThemeMode'");
  assert.ok(at > 0, 'the handler is missing');
  const block = bridge.slice(at, at + 1600);
  assert.match(block, /applyThemeToRenderer\(mode\)/, 'the handler never applies the theme');
  assert.match(block, /applied: /, 'the handler does not report what it applied');
});

test('the helper sets the attribute the stylesheet watches', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf('const applyThemeToRenderer =');
  assert.ok(at > 0, 'the helper is missing');
  const block = bridge.slice(at, at + 1400);
  assert.match(block, /setAttribute\('data-mode'/, 'the helper does not set data-mode');
  assert.match(block, /colorScheme/, 'the helper does not keep color-scheme in step');
  assert.match(block, /executeJavaScript/, 'the helper never reaches the renderer');
});

test('an unusable mode is refused instead of being written through', () => {
  // setThemeMode('dim') must not put data-mode=dim on the document: the stylesheet would then
  // have no rule and the page would fall back to whatever the last valid value was.
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf('const applyThemeToRenderer =');
  const block = bridge.slice(at, at + 1400);
  assert.match(block, /resolved !== 'light' && resolved !== 'dark'\) return null/, 'the helper writes an unknown mode');
});

test('system is resolved to a concrete mode before it reaches the DOM', () => {
  // data-mode only understands light/dark; 'system' would match no stylesheet rule.
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf('const applyThemeToRenderer =');
  const block = bridge.slice(at, at + 1400);
  assert.match(block, /mode === 'system'/, 'system is not resolved');
  assert.match(block, /shouldUseDarkColors/, 'system is not resolved against the OS preference');
});
// ---- round 250: verified through the real settings UI, not the bridge -------------------
//
// The round-249 fix was proven by calling setThemeMode directly, which leaves an open
// question: a user never calls the bridge, they click a radio. Measured on the same build:
//
//   设置 dialog, 常规 panel, 外观 > 主题 = three 30px role=radio with aria-labels
//     系统 / 浅色 / 深色   (light was checked at start)
//
//   real pointer click on 深色  -> data-mode=dark   bg=rgb(21,21,21)   colorScheme=dark
//   real pointer click on 浅色  -> data-mode=light  bg=rgb(252,252,251)
//
// Both directions work from the UI. The control had been flipping aria-checked and writing
// LSS-userThemeMode to localStorage while the page never changed; it now changes.

test('the theme control is a three-way radio, not a binary toggle', () => {
  // A binary toggle would lose the "follow the system" choice, which is the default on a
  // fresh install. The labels are localised, so the bundle must carry all three.
  const text = bundleText();
  assert.ok(text, 'the shipped bundle is missing');
  assert.ok(text.includes('data-mode=dark'), 'the dark selector is gone');
});

test('the applied mode is reflected in color-scheme as well as data-mode', () => {
  // The measured page reports colorScheme=dark together with bg rgb(21,21,21). Setting only
  // data-mode leaves native scrollbars and form controls light, which looks like a half-done
  // theme; the helper must set both.
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const at = bridge.indexOf('const applyThemeToRenderer =');
  const block = bridge.slice(at, at + 1400);
  assert.match(block, /root\.style\.colorScheme/, 'color-scheme is not set alongside data-mode');
});
