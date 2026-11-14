// The five most-called channels, and the shape each one must keep.
//
// Aggregated from 73 recorded runs: 59,975 calls over 228 channels. The top of that list is
// where a shape error would cost the most, so each was checked against its caller and then
// called once to see the real answer:
//
//   setPreference        5418   answer IGNORED by the caller (fire-and-forget)
//   getPreferences       4901   caller reads .claudeIosSimulatorAccessEnabled and friends
//   getTranscript        2091   caller iterates; an unknown id must answer []
//   getConfigHealth      1600   caller coalesces `n ?? e ?? null` — must be non-null
//   getLoginDesktop3pStatus 1316 caller coalesces `t ?? null` — must be non-null
//
// THREE HANDLERS ARE DELEGATES, not inline bodies:
//   getPreferences  -> returns an object literal directly (arrow body, no `return`)
//   getTranscript   -> transcriptFor(sessionId)
//   getConfigHealth -> buildConfigHealth
// A first version of this file asserted `return {` inside each handler and failed on all
// three. The shape was right; the assertion assumed an inline body. These assertions now
// check the delegate AND the delegate's own shape.
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
  return SRC.slice(at, next > at ? next : at + 400);
}

/** A `const name = ...` helper, which is how this file declares most of them. */
function namedHelper(name) {
  const at = SRC.indexOf('const ' + name + ' = ');
  assert.ok(at > 0, 'helper not found: ' + name);
  return SRC.slice(at, at + 1200);
}

test('getPreferences answers the preference object, not a wrapper', () => {
  // The shared snapshot is also sent to preference subscribers.
  const block = handler('claude.settings_$_AppPreferences_$_getPreferences');
  assert.match(block, /preferenceSnapshot/, 'the handler no longer delegates to the snapshot');
  assert.match(SRC, /const preferenceSnapshot = \(\) =>[\s\S]{0,180}sidebarMode: settings\.sidebarMode/, 'the snapshot omits sidebarMode');
  assert.doesNotMatch(block, /ok: true/, 'the answer is wrapped in { ok }');
});

test('getTranscript delegates to a helper that answers an array', () => {
  // The palette iterates the answer directly; an object throws 'l is not iterable'.
  const block = handler('claude.web_$_LocalSessions_$_getTranscript');
  assert.match(block, /transcriptFor\(sessionId\)/, 'the handler no longer delegates');
  const helper = namedHelper('transcriptFor');
  assert.match(helper, /kernel\.getTranscript\(sessionId\)/, 'the helper does not delegate to the kernel');
  // The empty-array guarantee lives in the kernel, so assert it there rather than here.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /function getTranscript\(sessionId\) \{[\s\S]{0,120}\|\| \[\]/,
    'the kernel no longer falls back to an empty array');
});

test('getConfigHealth delegates to a builder that never answers null', () => {
  // The caller coalesces `n ?? e ?? null`; a null freezes the previous value forever.
  const block = handler('claude.settings_$_Custom3pSetup_$_getConfigHealth');
  assert.match(block, /buildConfigHealth/, 'the handler no longer delegates');
  const builder = namedHelper('buildConfigHealth');
  assert.doesNotMatch(builder, /return null;/, 'the builder can answer null');
});

test('getLoginDesktop3pStatus never answers null', () => {
  const block = handler('claude.settings_$_Custom3pSetup_$_getLoginDesktop3pStatus');
  assert.doesNotMatch(block, /return null;/, 'a null answer is back');
});

test('setPreference may answer a bare acknowledgement', () => {
  // Its caller discards the answer: `o?.setPreference?.('wakeSchedulerEnabled', !0)`.
  const block = handler('claude.settings_$_AppPreferences_$_setPreference');
  assert.ok(block.length > 40, 'setPreference is missing');
});
