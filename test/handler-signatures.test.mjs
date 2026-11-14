// Handler signatures, checked against the CALLERS rather than against our own parameter names.
//
// Round 257 found savePastedFile declared as (sessionId, name, content) while the renderer calls
// it as (contentBase64, mimeType, fileName) and reads `.path` off the answer. Nothing failed
// loudly: the chip rendered, the file was never written, and the model reported 'not found'.
// The lesson was that a parameter name is a comment we wrote, not evidence.
//
// This file records the signatures that WERE verified against their call sites in the shipped
// bundle, with the call text that settles each one:
//
//   writeFileDownload(name, source)
//     shared-6-sd9jbJqs.js: `Xt?.writeFileDownload?.(e,t)` then `showInFolder(n)`
//   startShellPty(sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options)
//     c03935b01-yhcY34vt.js: `b?.startShellPty?.(e,t,n,r,i,!0,{hostShellAware:!0,shell:a})`
//   updateSession(sessionId, patch)
//     c73f45bc3-B7hbL7H9.js: `X?.updateSession?.(e,{title:...,titleSource:'auto'})`
//   setPermissionMode(sessionId, mode)
//     c227f4d5e-B-FYKrwT.js: `In?.setPermissionMode?.(Fn,e)`
//   getTranscriptTail(sessionId, limit)
//     cef1e6037-C9OZ_iaL.js: `r(e,t)`
//   writeLocalFile(sessionId, encodedPath, content)
//     c21f11e6d-Cyd8_HO8.js: `_t?.writeLocalFile?.(e,encodeURIComponent(t),n)`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The parameter list a handler declares, excluding the event argument. */
function signature(method) {
  const at = SRC.indexOf("_$_" + method + "'");
  assert.ok(at > 0, 'handler not found: ' + method);
  const line = SRC.slice(at, at + 400).split('\n')[0];
  const m = line.match(/\(([^)]*)\)\s*=>/);
  assert.ok(m, 'could not read the signature of ' + method);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).slice(1);
}

test('writeFileDownload takes (name, source)', () => {
  // The caller passes the download name then the source, and uses the answer with showInFolder.
  assert.deepEqual(signature('writeFileDownload'), ['name', 'source']);
});

test('updateSession takes (sessionId, patch)', () => {
  // The caller passes an object second: {title, titleSource}.
  assert.deepEqual(signature('updateSession'), ['sessionId', 'patch']);
});

test('setPermissionMode takes (sessionId, mode)', () => {
  assert.deepEqual(signature('setPermissionMode'), ['sessionId', 'mode']);
});

test('getTranscriptTail takes (sessionId, limit)', () => {
  assert.deepEqual(signature('getTranscriptTail'), ['sessionId', 'limit']);
});

test('writeLocalFile takes an encoded path between session and content', () => {
  // The caller applies encodeURIComponent to the path, so the middle argument is optional.
  const params = signature('writeLocalFile');
  assert.deepEqual(params.slice(0, 3), ['sessionId', 'encodedPath', 'content']);
});

test('savePastedFile takes the content first, and no session', () => {
  // The one that was wrong for many rounds; see the round-257 note at the top.
  const params = signature('savePastedFile');
  assert.deepEqual(params.slice(0, 3), ['content', 'mimeType', 'fileName']);
  assert.equal(params.includes('sessionId'), false, 'a sessionId parameter reappeared');
});
