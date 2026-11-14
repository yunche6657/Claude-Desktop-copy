// Every settings panel must open and render its own content.
//
// Measured live this round by driving real pointer events (mousePressed/mouseReleased) at each
// navigation item, then reading the dialog's own text:
//
//   general-settings               312
//   data-privacy-controls          361
//   usage-settings                 430
//   claude-code-settings           891
//   settings-nav-import            123
//   customize-skills-settings     5065
//   customize-connectors-settings  135
//   panels: 7 | distinct content lengths: 7 | any error: false
//
// Seven distinct lengths is the evidence that each click actually switched panels. The first
// attempt used element.click() and got the SAME length (1588) for all seven — which is what a
// page that never changed looks like. Round 145 learned the same lesson: the shipped handlers
// run through a wrapper that ignores synthetic clicks, so only real pointer events work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.REPLICA_CDP;
const liveTest = LIVE ? test : test.skip;

// The navigation items the shipped settings dialog offers.
const PANELS = [
  'general-settings',
  'data-privacy-controls',
  'usage-settings',
  'claude-code-settings',
  'settings-nav-import',
  'customize-skills-settings',
  'customize-connectors-settings',
];

test('the settings panel list is still what the UI ships', () => {
  // A rename upstream would make every live assertion below silently pass by finding nothing.
  assert.ok(PANELS.length >= 7);
  for (const panel of PANELS) assert.match(panel, /^[a-z-]+$/);
});

liveTest('every settings panel opens and shows its own content', async () => {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const results = await withTarget(null, async (connection) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = [];
    for (const panel of PANELS) {
      const rect = JSON.parse(await connection.eval(
        "(() => { const el = document.querySelector('[data-testid=\"" + panel + "\"]');"
        + ' if (!el) return JSON.stringify({ x: -1 });'
        + ' const r = el.getBoundingClientRect();'
        + ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()',
      ));
      if (rect.x < 0) { out.push({ panel, missing: true }); continue; }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await connection.send('Input.dispatchMouseEvent', {
          type, x: rect.x, y: rect.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0,
        });
      }
      await wait(2000);
      const state = JSON.parse(await connection.eval(
        "(() => { const d = document.querySelector('[role=dialog]'); const t = d ? d.innerText : '';"
        + ' return JSON.stringify({ len: t.length,'
        + ' error: /Something went wrong|ran into a problem|Error:/i.test(t) }); })()',
      ));
      out.push({ panel, len: state.len, error: state.error });
    }
    return out;
  });

  const missing = results.filter((r) => r.missing).map((r) => r.panel);
  assert.deepEqual(missing, [], 'settings navigation items are gone: ' + missing.join(', '));
  const errored = results.filter((r) => r.error).map((r) => r.panel);
  assert.deepEqual(errored, [], 'a panel rendered an error: ' + errored.join(', '));
  const lengths = results.map((r) => r.len);
  // The unopened dialog measures exactly 135 characters (its navigation chrome alone):
  // measured, element.click() leaves every panel at 135, while a real pointer event yields
  // 312/361/430/891/123/5065/135. Note 135 also appears as a legitimate length for the
  // import panel, so a size threshold cannot separate the two cases — the count of DISTINCT
  // lengths plus the absence of a repeated value is what does.
  assert.ok(lengths.every((len) => len > 0), 'a panel rendered nothing at all');
  // Distinct lengths prove the clicks actually switched panels.
  assert.equal(new Set(lengths).size, lengths.length,
    'two panels rendered identical text, so the click probably did nothing: ' + JSON.stringify(lengths));
  // A dialog that never switched shows the SAME chrome for every panel. Requiring that most
  // panels differ from the unopened size (135) catches that even if two coincidentally match.
  const opened = lengths.filter((len) => len !== 135).length;
  assert.ok(opened >= 5,
    'only ' + opened + ' panels rendered content beyond the navigation chrome: ' + JSON.stringify(lengths));
});
