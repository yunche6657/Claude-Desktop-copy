// A pasted attachment must reach the disk, or the model cannot read it.
//
// MEASURED BUG (round 257): the renderer's contract is
//   let t = await Cn.savePastedFile(n, e.type, e.name);
//   return t.path ? { path: t.path } : { path: null, failCause: 'ipc_write_failed' };
// where n = await eP(e) is the base64 payload of a data: URL — so the real signature is
//   savePastedFile(contentBase64, mimeType, fileName) -> { path }
// with no session id at all.
//
// Our handler took (sessionId, name, content) and returned a bare string. Both were wrong,
// and nothing complained: t.path was undefined, so every attachment was reported
// 'ipc_write_failed' while the chip still rendered in the composer. Measured downstream:
//   prompt text:  @"notes.txt" Count slowly from 1 to 200 ...
//   on disk:      no notes.txt anywhere in the workspace
//   model said:   "notes.txt isn't in the workspace (no match anywhere)"
//
// After the fix, savePastedFile(<base64 png>, 'image/png', 'probe.png') answers
//   { path: '<workspace>/probe.png' }
// and the file on disk starts 89 50 4E 47 0D 0A 1A 0A — a real PNG, not the base64 text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

function handlerBody() {
  const at = SRC.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  assert.ok(at > 0, 'savePastedFile is missing');
  return SRC.slice(at, at + 2800);
}

test('the handler signature matches the caller: content, mime, name', () => {
  // The caller passes (base64, type, name) and has no session to pass first.
  assert.match(handlerBody(), /async \(_e, content, mimeType, fileName\)/,
    'the parameter order does not match the caller');
  assert.doesNotMatch(handlerBody(), /async \(_e, sessionId/, 'a sessionId parameter is still expected');
});

test('the answer is { path }, because the caller reads .path', () => {
  // Returning a bare string made t.path undefined and every attachment fail.
  assert.match(handlerBody(), /return \{ path: target \};/);
  assert.match(handlerBody(), /ipc_write_failed/, 'the failure shape the caller expects is missing');
});

test('the payload is base64-decoded before writing', () => {
  // Writing the base64 text would create a file that exists and is corrupt — the worst
  // combination, because nothing looks broken until the model reads it.
  assert.match(handlerBody(), /Buffer\.from\(content, 'base64'\)/);
});

test('an attachment never overwrites an existing file', () => {
  // Round 255: three pastes named probe2.txt left one file. uniqueTarget is still in use.
  assert.match(handlerBody(), /await uniqueTarget\(root, name\)/);
  assert.match(handlerBody(), /flag: 'wx'/);
});

test('a path in the supplied name cannot escape the workspace', () => {
  assert.match(handlerBody(), /path\.basename\(fileName\)/);
});