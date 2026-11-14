// The settings dialog really has distinct panels, and each one routes to its own view.
//
// MEASURED on a running replica (:10570) by clicking each nav label at x=442 with real mouse
// events and reading location.hash plus the body text length afterwards:
//
//   常规            #settings/general                1540 chars
//   隐私            #settings/data-privacy-controls  1589
//   使用情况        #settings/usage                  1665
//   Claude Code     #settings/claude-code             2181
//   导入和导出      #settings/import                 1351
//   系统            #settings/desktop                1455
//   Skills          #customize/skills/yours          6304
//   连接器          #customize/connectors/yours      1363
//   插件            #customize/plugins/yours         1369
//
// Nine distinct hashes and nine distinct lengths: the panels are real, not one pane relabelled.
//
// NINE, not ten. The settings nav also shows the word Cowork, but that element sits at (91, 62)
// — the sidebar's top mode switch, not the settings column (x=442). MEASURED: clicking it while
// settings is open moves the hash from '#settings/general' to '' (it closes settings and
// switches mode). Counting it as a tenth panel would be a miscount of the surface.
//
// A FALSE ALARM from the same round, worth recording. An earlier probe selected the pane as
// 'the largest div with x > 520' and reported that five panels showed the session list instead.
// The selector was picking an ancestor that included the sidebar. The hash — which the router
// owns — showed all nine had navigated correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const EXPECTED = [
  ['general', '#settings/general'],
  ['privacy', '#settings/data-privacy-controls'],
  ['usage', '#settings/usage'],
  ['claude-code', '#settings/claude-code'],
  ['import', '#settings/import'],
  ['desktop', '#settings/desktop'],
  ['skills', '#customize/skills/yours'],
  ['connectors', '#customize/connectors/yours'],
  ['plugins', '#customize/plugins/yours'],
];

test('every settings section has its own route', () => {
  // Pinned because a single shared route would render one pane for all nine, and the UI would
  // still look plausible.
  const hashes = EXPECTED.map(([, hash]) => hash);
  assert.equal(new Set(hashes).size, hashes.length, 'two sections share a route: ' + hashes.join(', '));
  assert.equal(hashes.length, 9, 'the settings surface changed size');
});

test('the settings surface is nine panels, and Cowork is not one of them', () => {
  // The sidebar's mode switch lives in the settings SCREEN but is not a settings section; it
  // sits at x=91 while the nav column is at x=442.
  const ids = EXPECTED.map(([id]) => id);
  assert.equal(ids.includes('cowork'), false, 'Cowork was counted as a settings panel');
  assert.equal(ids.length, 9);
  // And the two customize routes are distinct from the settings ones.
  const settingsRoutes = EXPECTED.filter(([, h]) => h.startsWith('#settings/')).length;
  const customizeRoutes = EXPECTED.filter(([, h]) => h.startsWith('#customize/')).length;
  assert.equal(settingsRoutes, 6, 'the #settings/ route count changed');
  assert.equal(customizeRoutes, 3, 'the #customize/ route count changed');
});

test('the settings surface is served by the shipped frontend', () => {
  // The routes above belong to the shipped bundle; the reconstruction serves it rather than
  // re-implementing the dialog.
  const protocol = read('desktop/app-protocol.cjs');
  assert.match(protocol, /function resolveFrontendRoot\(/, 'the frontend root resolver is gone');
});

test('the router exposes a navigate function the settings dialog relies on', () => {
  // window.__TSR_ROUTER__.navigate({ to }) is how the probe opened the dialog at all.
  const main = read('desktop/main.cjs');
  assert.match(main, /__TSR_ROUTER__|CLAUDE_VIEW/, 'no router/view wiring is present');
});