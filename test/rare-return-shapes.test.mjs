// The rare return shapes, each checked against the caller that consumes it.
//
// Six of the seven answer a NAMED FIELD; one answers a bare boolean. The boolean one was
// wrong, because its caller tests the value itself:
//   g.checkVirtualMachinePlatform().then(t => { e || c(t ? null : 'not_enabled') })
// An object is always truthy, so not_enabled was unreachable.
//
// NOTE ON ASSERTION SCOPE. An earlier version of this file used `indexOf(handler)` plus a
// 1400-character window and asserted /trusted/. Measured: the window reached into the NEXT
// handler, and /trusted/ matched the handler name inside the marker string, so the assertion
// stayed green when every `trusted:` key in the body was renamed. The helpers below cut the
// window at the next define() and assert the exact return expression instead of a bare word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The text of ONE handler, cut at the next define() so it cannot bleed into its neighbour. */
function handler(method) {
  const marker = "'" + method + "'";
  const at = SRC.indexOf(marker);
  assert.ok(at > 0, 'handler not found: ' + method);
  const next = SRC.indexOf('define(', at + marker.length);
  assert.ok(next > at, 'could not find the end of ' + method);
  return SRC.slice(at, next);
}

test('checkVirtualMachinePlatform answers a boolean, not an object', () => {
  // The caller branches on the value; an object makes the negative branch dead.
  const block = handler('claude.web_$_ClaudeVM_$_checkVirtualMachinePlatform');
  assert.match(block, /return start === 2 \|\| start === 3;/, 'it no longer answers a boolean');
  assert.match(block, /return false;/, 'the failure path no longer answers false');
  assert.doesNotMatch(block, /return \{/, 'an object return is back');
});

test('checkTrust answers an object with a trusted field', () => {
  // This one DOES read a field. Assert the exact key inside the handler, not the word
  // 'trusted' (which also appears in the marker string and in comments).
  const block = handler('claude.web_$_LocalSessions_$_checkTrust');
  assert.match(block, /return \{ trusted: /, 'the trusted key is not returned');
  assert.doesNotMatch(block, /return \{ trustFlag: /, 'the key was renamed');
});

test('checkGitAvailable answers an object with an available field', () => {
  const block = handler('claude.web_$_ClaudeCode_$_checkGitAvailable');
  assert.match(block, /return \{ available: /, 'the available key is not returned');
});

test('readLocalFile answers both status and content', () => {
  // A caller reads .content; dropping it would silently show an empty editor.
  const block = handler('claude.web_$_FileSystem_$_readLocalFile');
  assert.match(block, /return \{ status: READ_STATUS\.\w+, content: /, 'status and content are not returned together');
});

test('a boolean-returning probe does not wrap its answer in a field', () => {
  // Generalised: a probe whose caller tests truthiness must answer the value itself.
  const block = handler('claude.web_$_ClaudeVM_$_checkVirtualMachinePlatform');
  assert.doesNotMatch(block, /return \{ installed/, 'the boolean is wrapped in an object again');
});
