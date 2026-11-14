// listCliSessions: an array of CLI sessions, shaped for the sidebar.
//
// It used to be answered only by the generic emptyFor() fallback (which returns []). That is
// safe, which is exactly why the gap survived: nothing crashed, the list was just永远 empty.
// A fallback that is safe is not the same as a handler that is correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('listCliSessions has a real handler, not just an emptyFor rule', () => {
  assert.match(source, /define\('claude\.web_\$_LocalSessions_\$_listCliSessions'/, 'a handler must exist');
});

test('the handler maps to the fields the consumer reads', () => {
  // shared-11-_AVGLHEz.js does: id: `local_cli_${e.handle}`, timestamp: new Date(e.lastActivityAt)
  // .toISOString(), cwd: e.cwd, cliBridgeSessionId: e.bridgeSessionId.
  for (const field of ['handle:', 'title:', 'lastActivityAt:', 'cwd:', 'bridgeSessionId:', 'liveness:']) {
    assert.ok(source.includes(field), 'the answer must include ' + field);
  }
});

test('lastActivityAt is never null, because the consumer calls toISOString on it', () => {
  // new Date(null).toISOString() is actually valid (epoch), but new Date(undefined) throws.
  assert.match(source, /Number\.isFinite\(session\.lastActivityAt\) \? session\.lastActivityAt : Date\.now\(\)/);
});

test('only sessions carrying a cliHandle are listed', () => {
  // getAll() already lists local sessions; including them here would show each one twice.
  assert.match(source, /typeof session\.cliHandle === 'string' && session\.cliHandle/);
});

test('the emptyFor fallback for listCliSessions is now unreachable for this channel', () => {
  // Keep the rule (other namespaces may still need it) but assert the handler wins: a define()
  // is consulted before emptyFor().
  const defineIndex = source.indexOf("define('claude.web_$_LocalSessions_$_listCliSessions'");
  const fallbackIndex = source.indexOf('if (/listCliSessions$/i.test(frag)) return [];');
  assert.ok(defineIndex > 0 && fallbackIndex > 0);
  // define() calls live in the registration body; emptyFor is a top-level helper. Order in the
  // file is not what decides precedence — the dispatch checks handlers.get(frag) first — so
  // assert that instead, by reading the dispatch.
  assert.match(source, /const exact = handlers\.get\(frag\);\s*\n\s*ipcMain\.handle/, 'dispatch must look up the exact handler first');
});
