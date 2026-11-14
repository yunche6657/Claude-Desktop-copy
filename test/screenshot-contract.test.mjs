// captureScreenshot must answer raw base64 in `.data`, because the caller adds its own prefix.
//
// CONTRACT (c49d37e5f-D7dfOEqs.js, two sites):
//   let e = await Z?.captureScreenshot?.(F, "annotate");
//   if (e?.data) { g(`data:image/png;base64,${e.data}`, ...) }
//   else Gn(..., e?.error, ..., e?.code)
//
//   let e = await Z?.captureScreenshot?.(V, "element_preview");
//   return e?.data === void 0 ? void 0 : `data:image/png;base64,${e.data}`
//
// The failure branch reads `.error` and `.code`, so those are part of the shape too.
//
// MEASURED BEFORE: the handler answered { ok: true, dataUrl: 'data:image/png;base64,...' }.
// `e.data` was undefined, so BOTH call sites took their missing/failed branch — every
// simulator screenshot fell back to a placeholder, with no error shown anywhere.
//
// MEASURED AFTER: keys ['data'], starts with 'iVBO', length 194608, no 'dataUrl' field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

function body() {
  const at = SRC.indexOf("'claude.web_$_WindowControl_$_captureScreenshot'");
  assert.ok(at > 0, 'captureScreenshot is missing');
  return SRC.slice(at, at + 1800);
}

test('the answer carries raw base64 in data, not a data URL', () => {
  const block = body();
  assert.match(block, /return \{ data: image\.toPNG\(\)\.toString\('base64'\) \};/,
    'the raw base64 is not returned in .data');
  assert.doesNotMatch(block, /dataUrl/, 'the old dataUrl field is back');
  assert.doesNotMatch(block, /data:image\/png;base64/, 'a data-URL prefix leaked into the answer');
});

test('a failure answers data, error and code — the three fields the caller reads', () => {
  // Without these the caller cannot distinguish 'no window' from 'capture threw'.
  const block = body();
  assert.match(block, /data: null, error: /, 'the failure shape does not carry an error');
  assert.match(block, /code: 'no_window'/, 'the missing-window case has no code');
  assert.match(block, /code: 'capture_failed'/, 'a thrown capture has no code');
});

test('the simulator arguments are accepted and ignored, not mismatched', () => {
  // The caller passes (udid, purpose). This build has no simulator, so they are ignored —
  // but the handler must still accept them rather than treating them as something else.
  assert.match(body(), /async \(_e, _udid, _purpose\)/);
});

test('a missing window does not throw', () => {
  // capturePage on a destroyed window rejects; the handler has to answer instead.
  const block = body();
  assert.match(block, /if \(!win \|\| win\.isDestroyed\(\)\)/, 'the destroyed-window case is not handled');
  assert.match(block, /try \{/, 'the capture is not guarded');
});
