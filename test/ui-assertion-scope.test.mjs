// A UI assertion must not search the whole document for a string.
//
// WHY. Three separate rounds (289, 308, 309) drew a wrong conclusion from `body.innerText`:
//
//   289  the prompt contained the answer, so finding it in the body proved nothing;
//   308  'x > 520 largest div' picked an ancestor that included the sidebar, so five working
//        panels looked broken;
//   309  the string '新建 Ctrl + N' looked like a promised shortcut, but innerText had joined two
//        separate nodes — the 新建 span has exactly one child and no shortcut hint.
//
// Each time the measurement was wrong, not the app. `body.innerText` is a FLATTENED view: it
// concatenates across element boundaries and across unrelated widgets, so a substring hit says
// only 'these characters appear somewhere on screen'.
//
// The fix is to assert on a scoped selector (a dialog, a row, a specific element) or on the
// app's own state (location.hash, the session store). This test enforces that for the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

test('no test asserts by searching the whole document text', () => {
  const offenders = [];
  for (const f of fs.readdirSync(TEST_DIR).filter((x) => x.endsWith('.test.mjs'))) {
    // This file names the pattern in its own comments, so skip it.
    if (f === 'ui-assertion-scope.test.mjs') continue;
    const lines = fs.readFileSync(path.join(TEST_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/body\.innerText/.test(line)) offenders.push(f + ':' + (i + 1));
    });
  }
  assert.deepEqual(offenders, [],
    'these assertions read the flattened document text: ' + offenders.join(', ')
      + ' — scope the selector or assert on app state instead');
});

test('the shipped UI checks assert on scoped selectors or app state', () => {
  // The three live-UI test files should each use at least one of these.
  // Only files that actually drive the live UI. resume-continuation.test.mjs is a source-text
  // test (it asserts on the bridge/kernel source, not on a rendered page), so it does not
  // belong in this list — measured: all six of its assertions are assert.match against source.
  const scoped = ['surface-rendering.test.mjs', 'settings-routes.test.mjs'];
  for (const f of scoped) {
    const p = path.join(TEST_DIR, f);
    assert.ok(fs.existsSync(p), f + ' is missing');
    const body = fs.readFileSync(p, 'utf8');
    const hasSelector = /role=dialog|querySelector|getBoundingClientRect|location\.hash|getAll\(/.test(body);
    assert.ok(hasSelector, f + ' asserts without a scoped selector or app state');
  }
});

test('the settings surface count is asserted from routes, not from screen text', () => {
  // Round 310 showed the screen contains ten clickable words but only nine panels: the tenth
  // (Cowork) belongs to the sidebar. Counting screen text would have said ten.
  const body = fs.readFileSync(path.join(TEST_DIR, 'settings-routes.test.mjs'), 'utf8');
  assert.match(body, /#settings\/general/, 'the routes are no longer asserted by hash');
  assert.match(body, /assert\.equal\(ids\.length, 9/, 'the nine-panel count is gone');
});