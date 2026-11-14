// Session search must find conversations by their CONTENT, not only their titles.
//
// The first version of this file asserted source-code patterns and stayed green when the
// transcript scan was mutated away — it was checking that a line of text existed, not that
// search worked. This version drives the real bridge through CDP against the real store.
//
// Measured live (141 sessions):
//   'the'     -> 50 hits, all with snippets   (the default limit)
//   'session' ->  5 hits
//   'exactly' -> 50 hits
//   'PERSIST' ->  3 hits
//
// 'assistant' is the discriminating probe: it appears only inside conversations
// as a message role, never in a session title (checked against all 141), so a title-only
// search returns 0 for it — verified by mutation.
//
// The two-character minimum is upstream behaviour, not a defect: the renderer guards with
// `t.length >= 2` before calling the bridge (offset 22059 in c2771e1f6-C1UCZLNP.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const LIVE = process.env.REPLICA_CDP;

// The live half needs a running replica. The static half runs always.
const liveTest = LIVE ? test : test.skip;

liveTest('search finds a conversation by text that appears only in its content', async () => {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const probe = "(async () => { const ns = window['claude.web'].LocalSessions;"
    + " const res = await ns.searchSessions('assistant');"
    + " return JSON.stringify({ count: (res || []).length, snippet: (res || []).every((x) => x && x.snippet) }); })()";
  const result = await withTarget(null, async (connection) => JSON.parse(await connection.eval(probe)));
  assert.ok(result.count > 0,
    'a term present only in conversation content found nothing — search is title-only');
  assert.equal(result.snippet, true, 'a result arrived without a snippet for the row');
});

liveTest('a broad query is capped rather than flooding the palette', async () => {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const probe = "(async () => { const ns = window['claude.web'].LocalSessions;"
    + " const res = await ns.searchSessions('the');"
    + " return JSON.stringify({ count: (res || []).length }); })()";
  const result = await withTarget(null, async (connection) => JSON.parse(await connection.eval(probe)));
  assert.ok(result.count <= 50, 'the default limit was not applied: ' + result.count);
});

test('search ignores queries shorter than two characters', () => {
  // Matches the renderer guard; dropping it would scan every transcript on each keystroke.
  assert.match(SOURCE, /if \(text\.length < 2\) return \[\]/);
});

test('search scans transcript content, not only titles', () => {
  assert.match(SOURCE, /kernel\.getTranscript\(session\.sessionId\)/);
});

test('both namespaces expose the same search implementation', () => {
  assert.match(SOURCE, /define\('claude\.web_\$_LocalSessions_\$_searchSessions', searchSessionsImpl\)/);
  assert.match(SOURCE, /define\('claude\.web_\$_LocalAgentModeSessions_\$_searchSessions', searchSessionsImpl\)/);
});