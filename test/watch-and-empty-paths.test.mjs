// The directory-watch cap must be reported, like every other cap in this project.
//
// The first version of this file asserted source-code patterns and stayed green when the
// truncation report was mutated away — it was checking that text existed, not that the
// handler behaved. This version drives the real bridge through CDP.
//
// Measured live (40 directories requested):
//   { ok: true, watching: 32, truncated: true, requested: 40,
//     reason: 'only 32 directories are watched at once; ...' }
//   empty list  -> { ok: true, watching: 0 }            (documented stop path)
//   unusable    -> { ok: false, error: 'no watchable directory' }
//
// Without the truncation fields, `watching: 32` for a request of 40 reads as a complete
// success — the same silent-cap shape rounds 210-212 fixed three times already.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.REPLICA_CDP;
const liveTest = LIVE ? test : test.skip;

/** Run one watch request against the live bridge. */
async function watch(dirPaths) {
  const { pathToFileURL } = await import('node:url');
  const { withTarget } = await import(pathToFileURL(path.join(ROOT, 'tools', 'cdp.mjs')).href);
  const probe = "(async () => { const ns = window['claude.web'].LocalSessions;"
    + ' const out = await ns.watchSessionDirectories({ sessionId: \'probe\', watchId: \'w1\', dirPaths: '
    + JSON.stringify(dirPaths)
    + ' }); return JSON.stringify(out); })()';
  return withTarget(null, async (connection) => JSON.parse(await connection.eval(probe)));
}

liveTest('requesting more directories than the cap reports the truncation', async () => {
  const dirs = Array.from({ length: 40 }, () => 'C:/Windows');
  const result = await watch(dirs);
  assert.equal(result.ok, true, 'the watch request failed outright');
  assert.equal(result.watching, 32, 'the cap changed: ' + result.watching);
  assert.equal(result.truncated, true, 'a capped watch was reported as complete');
  assert.equal(result.requested, 40, 'the requested count is missing');
  assert.match(String(result.reason), /split them across two watches/, 'no next step given');
});

liveTest('an empty list stops the watch without a truncation notice', async () => {
  const result = await watch([]);
  assert.equal(result.ok, true);
  assert.equal(result.watching, 0);
  assert.equal(result.truncated, undefined, 'stopping a watch claimed truncation');
});

liveTest('a request with no usable directory reports failure', async () => {
  const result = await watch(['C:/definitely-not-here-xyz']);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /no watchable directory/);
});

test('the system prompt omits the skills section when there are none', async () => {
  // A new user has no skills. An empty heading would read as a broken feature.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { buildSystemPrompt } = require(path.join(ROOT, 'desktop', 'agent-config.cjs'));
  const withNone = buildSystemPrompt([]);
  assert.equal(typeof withNone, 'string');
  assert.ok(withNone.length > 0, 'the system prompt is empty');
  assert.equal(/skill/i.test(withNone), false, 'an empty skills section leaked into the prompt');
});

test('the system prompt gains the skills section when one exists', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { buildSystemPrompt } = require(path.join(ROOT, 'desktop', 'agent-config.cjs'));
  const withOne = buildSystemPrompt([{ name: 'demo', description: 'A demo skill', files: ['SKILL.md'] }]);
  assert.ok(withOne.length > buildSystemPrompt([]).length, 'adding a skill changed nothing');
  assert.match(withOne, /demo/);
});
