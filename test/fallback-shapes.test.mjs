// The generic fallback decides what an unimplemented getter answers. Two methods
// ending in "Sessions" want DIFFERENT containers:
//
//   searchSessions   -> array, iterated directly       (fixed in round 8)
//   listCliSessions  -> array, passed to `select: e => e.map(jo)`
//   getSessionList   -> { sessions, archived, pinned }
//
// Getting it wrong is silent: React Query catches the select error, so the list
// renders empty and nothing looks broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// ESM has no __dirname; the two tests appended in round 234 need a real path.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

/** Register only a bare service so the fallback path is what answers. */
function makeFallbackBridge(methods) {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  registerBridgeServices({
    ipcMain,
    bridgeMap: { 'claude.web': { SomeService: methods } },
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system' },
    frontend: { root: process.cwd() },
  });
  const call = (method) => {
    const channel = [...handlers.keys()].find((c) => c.endsWith(`_$_${method}`));
    return handlers.get(channel)({}, 200);
  };
  return { call };
}

test('listCliSessions answers an array the caller can .map()', async () => {
  // `select: Mo` is `e => e.map(jo)`, so an object here throws inside React Query
  // and the CLI session list silently stays empty.
  const { call } = makeFallbackBridge(['listCliSessions']);
  const answer = await call('listCliSessions');
  assert.ok(Array.isArray(answer), 'must be an array, not {sessions: []}');
  assert.doesNotThrow(() => answer.map((x) => x));
});

test('searchSessions still answers an array', async () => {
  const { call } = makeFallbackBridge(['searchSessions']);
  const answer = await call('searchSessions');
  assert.ok(Array.isArray(answer));
});

test('getSessionList still answers its object container', async () => {
  // The counterpart: this one genuinely is an object, and must not be converted.
  const { call } = makeFallbackBridge(['getSessionList']);
  const answer = await call('getSessionList');
  assert.equal(Array.isArray(answer), false);
  assert.ok(Array.isArray(answer.sessions));
  assert.ok(Array.isArray(answer.archived));
  assert.ok(Array.isArray(answer.pinned));
});

test('the three shapes coexist in one bridge without leaking into each other', async () => {
  // A single rule that "everything ending in Sessions is an array" would break
  // getSessionList, and the reverse broke the other two.
  const { call } = makeFallbackBridge(['searchSessions', 'listCliSessions', 'getSessionList']);
  assert.ok(Array.isArray(await call('searchSessions')));
  assert.ok(Array.isArray(await call('listCliSessions')));
  assert.equal(Array.isArray(await call('getSessionList')), false);
});

test('getAll answers an array', async () => {
  const { call } = makeFallbackBridge(['getAll']);
  assert.ok(Array.isArray(await call('getAll')));
});
// ---- round 234: every channel that actually falls back has a typed shape -------------
//
// Classified all 80 channels appearing across the 73 recorded replica runs against the
// emptyFor table: 80 covered, 0 that would answer a bare null. Confirmed live through the
// bridge (dotted namespace keys, not nested objects):
//   LocalPlugins.getPlugins                   -> array:0
//   LocalSessions.getSSHConfigs               -> array:0
//   CoworkScheduledTasks.getAllScheduledTasks -> array:0
//   LocalSessions.listWslDistros              -> array:0
//   Extensions.isExtensionsEnabled            -> false
//
// The point of pinning it: the day a channel is added without an emptyFor rule, boot breaks
// instead of degrading — so the table's coverage is a load-bearing property, not a detail.

test('every channel that STILL falls back has a typed empty answer', async (t) => {
  // Two corrections came out of writing this:
  //   1. a rule line can hold two patterns joined by || (`/Sessions$/ || /fetchAllSessions$/`),
  //      and treating the whole line as one regex silently matched the wrong channels —
  //      which made the first version of this test green when it should have been red;
  //   2. the recorded logs include channels that HAVE since gained real handlers
  //      (rewindV2, rewind, clearSession, interrupt), so they are not fallbacks any more.
  //
  // What matters is: a channel that still answers from the fallback must answer a shape its
  // caller can consume. Setters (set*/mark*/report*/...) are excluded — nothing reads their
  // return value, which is why answering null for them is correct rather than a defect.
  const fs = require('node:fs');
  const liveDir = path.join(HERE, '..', 'evidence', 'live');
  // A checkout without recorded runs cannot answer this: skip with a reason, never a silent pass.
  if (!fs.existsSync(liveDir)) return t.skip('no recorded replica runs in evidence/live');
  const bridge = fs.readFileSync(path.join(HERE, '..', 'desktop', 'bridge-services.cjs'), 'utf8');
  const channels = new Set();
  for (const file of fs.readdirSync(liveDir).filter((f) => /^replica-\d+\.out$/.test(f))) {
    for (const line of fs.readFileSync(path.join(liveDir, file), 'utf8').split('\n')) {
      if (line.includes('[fallback]')) channels.add(line.replace('[fallback] ', '').trim());
    }
  }
  if (!channels.size) return t.skip('the recorded runs contain no [fallback] lines');
  // Does the generic dispatcher still answer false for is*/can* before consulting emptyFor?
  const dispatcherAnswersFalseForIsCan = /if \(\/\^is\|\^can\/\.test\(method\)\) return false;/.test(bridge);
  const start = bridge.indexOf('function emptyFor(frag) {');
  const end = bridge.indexOf('\n}', start) + 2;
  const body = bridge.slice(start, end);
  const rules = [...body.matchAll(/if \((.+?)\) return/g)]
    .flatMap((m) => [...m[1].matchAll(/\/((?:[^\/\\]|\\.)+)\/i?/g)].map((p) => p[1]));
  const methodOf = (channel) => channel.split('.').pop();
  const offenders = [];
  for (const channel of channels) {
    const method = methodOf(channel);
    // A real handler means it no longer falls back.
    //
    // The channel name may be closed by ANY quote: this file adds handlers both as plain
    // strings and as template literals, and an earlier version only recognised the backtick
    // form. MEASURED: two newly-implemented channels were reported as still falling back
    // purely because they were written with single quotes.
    const implemented = new RegExp("\\$_" + method + "[`'\"]").test(bridge);
    if (implemented) continue;
    // Setters answer null on purpose: no caller reads the value.
    if (/^(set|mark|claim|report|declare|warm)[A-Z]/.test(method)) continue;
    // The generic dispatcher answers `false` for every is*/can* method BEFORE emptyFor runs,
    // so those channels do have a typed answer and are not offenders. Checking only the
    // emptyFor table missed this — measured: five is*/can* channels were reported as uncovered
    // while the dispatcher was already answering false for them.
    //
    // The exemption is read from the SOURCE rather than assumed: hard-coding it here made the
    // test unable to notice the rule being deleted (mutation stayed green).
    if (dispatcherAnswersFalseForIsCan && /^(is|can)[A-Z]/.test(method)) continue;
    const covered = rules.some((source) => {
      try { return new RegExp(source, 'i').test(channel); } catch { return false; }
    });
    if (!covered) offenders.push(channel);
  }
  assert.deepEqual(offenders, [], 'readers still falling back with no typed answer: ' + offenders.join(', '));
});
test('the emptyFor table never answers null', () => {
  // null is reserved for methods whose consumers null-check, which is the opposite case.
  const fs = require('node:fs');
  const bridge = fs.readFileSync(path.join(HERE, '..', 'desktop', 'bridge-services.cjs'), 'utf8');
  const start = bridge.indexOf('function emptyFor(frag) {');
  const end = bridge.indexOf('\n}', start) + 2;
  const body = bridge.slice(start, end);
  const nullRules = [...body.matchAll(/if \(\/(.+?)\/i?\.test\(frag\)\) return null;/g)];
  assert.deepEqual(nullRules.map((m) => m[1]), []);
});

test('the dispatcher really does answer false for is*/can* before emptyFor', () => {
  // The exemption above is only honest if this rule exists. Pinned separately so deleting it
  // fails a named test rather than silently widening what counts as 'covered'.
  const bridge = fs.readFileSync(path.join(HERE, '..', 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(bridge, /if \(\/\^is\|\^can\/\.test\(method\)\) return false;/, 'the is*/can* dispatch rule is gone');
  // And it must run BEFORE the emptyFor branch.
  const dispatchAt = bridge.indexOf('if (/^is|^can/.test(method)) return false;');
  const emptyForAt = bridge.indexOf('const empty = emptyFor(frag);');
  assert.ok(dispatchAt > 0 && emptyForAt > dispatchAt, 'emptyFor now runs before the is*/can* rule');
});