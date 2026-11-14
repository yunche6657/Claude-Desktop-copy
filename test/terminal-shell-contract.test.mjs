// Terminal shell state: the answer must come from real processes, and `live` must be an array.
//
// THE BUG THIS REPLACED (documented in the handler's own comment): it returned a hard-coded
//   { live: [], busy: [], unknown: [], probed: true, tabs: [] }
// while a shell was demonstrably running. That is not an empty answer, it is a WRONG one:
// `probed: true` asserts the probe ran and `live: []` asserts nothing is alive, so the pane
// could not recognise its own live tab.
//
// CONSUMER SHAPE (measured): every call site treats these as ARRAYS.
//   ca41b3815: `noteShellProbe: (e, n, r = []) => { for (const t of n ? r : e) ... ; e.filter(...) }`
//   c11959232: `r.noteShellProbe(n.live, n.probed, n.unknown)`
//   c4363b976: `i.busy.map(...)`, `i.tabs`
//   shared-23:  `[...n.busy, ...n.unknown ?? []]`
// A Set here would throw on `.map`; an object would throw on spread.
//
// MEASURED LIVE (replica :10280):
//   before start: liveLen 0, probed true
//   startShellPty -> { ok, shell, isPty, pid }
//   after start:  liveLen 1, live is an array, getTerminalShells length 1
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
  return SRC.slice(at, next > at ? next : at + 1600);
}

test('getBusyShellPtyKeys derives live from the real shell list', () => {
  // A hard-coded [] with probed:true is the failure mode this replaced.
  const block = handler('claude.web_$_LocalSessions_$_getBusyShellPtyKeys');
  assert.match(block, /shells\.list\(\)/, 'the answer is not derived from real shells');
  assert.doesNotMatch(block, /const live = \[\];\s*return/, 'a hard-coded empty answer is back');
});

test('all four collections in the answer are arrays', () => {
  // The consumers use .map, spread and .filter on these.
  const block = handler('claude.web_$_LocalSessions_$_getBusyShellPtyKeys');
  // `live` uses shorthand (`live,`) because it is built with push; the other three are literals.
  assert.match(block, /\n\s*live,/, 'the answer lost its live field');
  for (const key of ['busy', 'unknown', 'tabs']) {
    assert.match(block, new RegExp(key + ': \\[\\]'), 'the answer lost its ' + key + ' field');
  }
  assert.match(block, /live\.push\(/, 'live is not built as an array');
});

test('startShellPty answers { ok, shell } and accepts the seven-argument form', () => {
  // The caller passes (sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options).
  const block = handler('claude.web_$_LocalSessions_$_startShellPty');
  assert.match(block, /\(_e, sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options\)/,
    'the seven-argument form was changed');
  assert.match(block, /shells\.start\(sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options\)/,
    'the arguments are not forwarded in order');
});

test('getTerminalShells answers the raw shell list, not a wrapper', () => {
  // The consumer iterates it directly.
  const block = handler('claude.web_$_LocalSessions_$_getTerminalShells');
  assert.match(block, /shells\.list\(\)/);
  assert.doesNotMatch(block, /return \{ ok:/, 'the list is wrapped in an object');
});