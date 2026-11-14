// The two contract repairs from rounds 257 and 259, kept in one place.
//
// Both were SILENT: a pasted file was never written, and a screenshot was never returned,
// while the UI kept rendering a plausible result. Neither was found by a test — both were
// found by reading the CALLER and then calling the handler once to look at the answer.
//
//   savePastedFile(contentBase64, mimeType, fileName) -> { path }
//     was: (sessionId, name, content) -> bare string
//     effect: t.path undefined, every attachment reported 'ipc_write_failed', chip still shown
//
//   captureScreenshot(udid, purpose) -> { data }   (raw base64, no data-URL prefix)
//     was: () -> { ok: true, dataUrl: 'data:image/png;base64,...' }
//     effect: e.data undefined, both call sites took their failure branch and showed a
//             placeholder with no error
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('savePastedFile no longer takes a session id', () => {
  assert.doesNotMatch(SRC, /async \(_e, sessionId, name, content\)/,
    'the wrong signature is back');
  assert.match(SRC, /async \(_e, content, mimeType, fileName\)/);
});

test('savePastedFile answers { path }, not a bare string', () => {
  assert.match(SRC, /return \{ path: target \};/);
  // A bare `return target;` in this handler is the regression.
  const at = SRC.indexOf("'claude.web_$_FileSystem_$_savePastedFile'");
  const block = SRC.slice(at, at + 2800);
  assert.doesNotMatch(block, /return target;\n/, 'the bare-string return is back');
});

test('captureScreenshot answers { data }, without a data-URL prefix', () => {
  assert.match(SRC, /return \{ data: image\.toPNG\(\)\.toString\('base64'\) \};/);
  // Any *code* that builds a data URL here is the regression; the comment that quotes the old
  // shape is fine, so look only at lines that are not comments.
  const offenders = SRC.split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .filter((line) => /data:image\/png;base64/.test(line));
  assert.deepEqual(offenders, [], 'a data-URL prefix is being produced: ' + offenders.join(' | '));
});

test('both handlers report failures rather than throwing', () => {
  const shot = SRC.slice(SRC.indexOf("'claude.web_$_WindowControl_$_captureScreenshot'"), 1800);
  assert.match(SRC.slice(SRC.indexOf("'claude.web_$_WindowControl_$_captureScreenshot'"), SRC.indexOf("'claude.web_$_WindowControl_$_captureScreenshot'") + 1800), /code: 'no_window'|capture_failed/);
  const paste = SRC.slice(SRC.indexOf("'claude.web_$_FileSystem_$_savePastedFile'"), SRC.indexOf("'claude.web_$_FileSystem_$_savePastedFile'") + 2800);
  assert.match(paste, /ipc_write_failed/);
});
