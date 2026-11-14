// R586: three call sites carry the same flag id, and their failure modes are NOT the same. The third is silent.
//
// THE SITES (desktop/cli-mcp-host-sources.cjs)
//       :50   next.onFeatureChange('513873720', observe)
//       :51   next.observeFeatureGate('513873720', observe)
//       :60   runtime.getFeatureValue('513873720', undefined)
//
//   Reading the provider rather than assuming redundancy:
//
//       onFeatureChange    subscribes to changeListeners AND fires immediately with the current value
//       observeFeatureGate subscribes to gateListeners only — no immediate call
//       getFeatureValue    synchronize(), then features[key], then exposure(key,item); the return is DISCARDED here
//
// WHAT EACH TYPO DOES
//       :50   change subscription dead → the gate freezes at whatever it read when features first loaded
//       :51   gate subscription dead  → same freeze, reached by a different mechanism
//       :60   NO BEHAVIOURAL CHANGE    → synchronise() takes no key, so it still runs; exposure is attributed to the
//                                        wrong flag, silently and in every environment
//
//   The third is the purest instance of the shape R585 described: a duplicate whose failure is a missing FACT rather than a
//   wrong behaviour. Nothing throws, no assertion notices, no user sees it.
//
// WHY THE EXISTING TEST CANNOT CATCH EITHER SUBSCRIPTION TYPO
//   `cli-mcp-host-sources-r378.test.mjs` drives a change with `runtime.sourceChanged()`, which re-projects and notifies
//   through BOTH listener maps. Either path alone delivers the value, so a typo in the other survives the test. That is a
//   property of the design — two channels carrying one fact — not a gap in the test.
//
// AND WHY NO TEST SHOULD BE ADDED FOR IT
//   The only assertion that would catch a mistyped id checks the exact string, which is the text-assertion class R570
//   listed as fragile: it fails when the line moves, for a behaviour that has not changed. What is worth having is this
//   note — a reader editing the function now knows which of the three sites to look at, and that the third one is the one
//   whose failure no test can show.
//
// WHAT IS NOT CLAIMED
//   Not that any id is mistyped today. This round compared literal strings at three coordinates and found them equal.
//   Not that the two subscription channels are redundant: they differ in whether the listener fires immediately, and the
//   initial value depends on that difference. They are redundant only for DELIVERING A LATER CHANGE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES, TEST_COVERAGE } from '../desktop/gate-subscription-sites.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'desktop', 'cli-mcp-host-sources.cjs');
const PROV = path.join(ROOT, 'desktop', 'growthbook-provider.cjs');

test('all three sites still carry the same id', () => {
  const lines = fs.readFileSync(CLI, 'utf8').split('\n');
  for (const s of SITES) {
    assert.ok(lines[s.line - 1].includes('513873720'), `line ${s.line} no longer names the id`);
    assert.ok(lines[s.line - 1].includes(s.call.split('(')[0]), `line ${s.line} is no longer ${s.call}`);
  }
  // Same literal at all three — that is what makes the difference a silent one.
  const ids = SITES.map((s) => /'(\d+)'/.exec(lines[s.line - 1])[1]);
  assert.equal(new Set(ids).size, 1, `the three sites now name different ids: ${ids.join(', ')}`);
});

test('the provider distinguishes immediate-fire from subscribe-only', () => {
  const prov = fs.readFileSync(PROV, 'utf8');
  const ofc = prov.slice(prov.indexOf('function onFeatureChange'), prov.indexOf('function subscribeSignal'));
  assert.match(ofc, /fn\(features\[key\]\)/, 'onFeatureChange no longer fires immediately');
  assert.match(ofc, /subscribe\(changeListeners/, 'onFeatureChange no longer uses changeListeners');

  const ofg = /function observeFeatureGate\(key,fn\) \{[^}]*\}/.exec(prov);
  assert.ok(ofg, 'observeFeatureGate is gone');
  assert.ok(!/fn\(/.test(ofg[0]), 'observeFeatureGate now fires immediately, so the two paths are no longer distinct');
  assert.match(ofg[0], /gateListeners/, 'observeFeatureGate no longer uses gateListeners');
});

test('getFeatureValue discards its return at the third site, which is why a typo there is silent', () => {
  const prov = fs.readFileSync(PROV, 'utf8');
  const gfv = prov.slice(prov.indexOf('function getFeatureValue'), prov.indexOf('function getFeatureOn'));
  assert.match(gfv, /synchronize\(\)/, 'getFeatureValue no longer synchronises');
  assert.match(gfv, /exposure\(key,item\)/, 'getFeatureValue no longer records exposure');
  // synchronize takes no key — that is the fact that makes a wrong key behaviourally harmless and attribution-wrong.
  const sync = prov.slice(prov.indexOf('function synchronize'), prov.indexOf('function getFeatureValue'));
  assert.match(sync, /function synchronize\(\{markStale = true\} = \{\}\)/, 'synchronize now takes a key');
  // And the call site ignores the value.
  const line = fs.readFileSync(CLI, 'utf8').split('\n')[59];
  assert.ok(!/=\s*runtime\.getFeatureValue/.test(line), 'the third site now assigns the return value');
});

test('the existing test relies on a change that both channels deliver', () => {
  const t = fs.readFileSync(path.join(ROOT, TEST_COVERAGE.file), 'utf8');
  assert.match(t, /sourceChanged\(\)/, 'the test no longer drives sourceChanged');
  assert.equal(TEST_COVERAGE.canDistinguish, false);
  assert.match(TEST_COVERAGE.why, /BOTH listener maps/, 'the reason it cannot distinguish is not recorded');
  assert.match(TEST_COVERAGE.note, /property of the design/, 'the design point is not stated');
});

test('each site records a DIFFERENT failure mode', () => {
  assert.equal(SITES.length, 3);
  const modes = SITES.map((s) => s.ifMistyped);
  assert.equal(new Set(modes).size, 3, 'two sites share a failure description, so the difference is not recorded');
  // The third must be the silent one, and it must say so explicitly.
  assert.match(SITES[2].ifMistyped, /no behavioural difference/i, 'the silent case is not identified as such');
  assert.match(SITES[2].ifMistyped, /wrong flag/i, 'the attribution consequence is missing');
});

test('the record refuses to add a string assertion, and says why', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'gate-subscription-sites.cjs'), 'utf8');
  assert.match(src, /text-assertion class R570/, 'the precedent against the obvious assertion is missing');
  assert.match(src, /fails when the line moves/, 'the reason that assertion is fragile is not stated');
});

test('no id is claimed to be mistyped', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'gate-subscription-sites.cjs'), 'utf8');
  assert.match(src, /Not that any id is mistyped today|found them equal/i, 'the no-defect caveat is missing');
});
