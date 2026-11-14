// Forking a session: three contracts, all verified by calling it.
//
// MEASURED LIVE (replica :10270):
//   source d758964a held 6 rows
//   forkSession(source, 'local_fork_probe_...', null, source)
//     -> { sessionId: <the id we passed> }        caller-supplied id is honoured
//     -> the new session held 6 rows             whole conversation copied
//   forkSession(source, 'local_fork_mid_...', <uuid of row 3>, source)
//     -> the new session held 3 rows             truncation at the message is inclusive
//
// The caller pattern, recorded in the handler's own comment:
//   let i = `local_${crypto.randomUUID()}`;
//   let a = await r(e.ref.id, i, e.forkAtMessageUuid, e.targetCwd);
//   hn(t, a.sessionId, {...})          // continues in a.sessionId
// so a null answer would make the Fork menu item do nothing at all — no session, no error,
// no navigation. That is why the answer MUST carry sessionId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

function handler(method) {
  const marker = "'" + method + "'";
  const at = SRC.indexOf(marker);
  assert.ok(at > 0, 'handler not found: ' + method);
  const next = SRC.indexOf('define(', at + marker.length);
  return SRC.slice(at, next > at ? next : at + 2400);
}

test('forkSession answers an object carrying sessionId', () => {
  // A null answer makes the menu item inert rather than erroring.
  const block = handler('claude.web_$_LocalSessions_$_forkSession');
  assert.match(block, /return \{[^}]*sessionId/, 'the answer does not carry sessionId');
});

test('forkSession honours the caller-supplied id when one is given', () => {
  // The caller creates an optimistic record under that id and expects the kernel to match.
  const block = handler('claude.web_$_LocalSessions_$_forkSession');
  assert.match(block, /typeof newSessionId === 'string' && newSessionId/, 'the supplied id is ignored');
});

test('forkSession truncates inclusively at the requested message', () => {
  // Measured: forking at row 3 of a 6-row session produced 3 rows, not 2.
  const block = handler('claude.web_$_LocalSessions_$_forkSession');
  assert.match(block, /entries\.slice\(0, at \+ 1\)/, 'the truncation is not inclusive');
});

test('an unknown source session is refused rather than forked empty', () => {
  const block = handler('claude.web_$_LocalSessions_$_forkSession');
  assert.match(block, /if \(!source\) return null;/, 'a missing source is not refused');
});

test('saveTrust takes a single key, which may carry a remote prefix', () => {
  // The caller passes 'ssh:host:cwd' / 'wsl:distro:cwd' / plain cwd as ONE argument.
  // checkTrust receives the same string, so the two agree on the key.
  const block = handler('claude.web_$_LocalSessions_$_saveTrust');
  assert.match(block, /trusted === undefined \? true/, 'the single-argument form is not defaulted');
});
