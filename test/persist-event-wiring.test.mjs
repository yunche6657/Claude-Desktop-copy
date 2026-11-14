// The persist_failed event reaches the renderer's event channel — verified as far as possible.
//
// What is established:
//   1. the kernel emits { type: 'persist_failed', reason, path } once per failure streak
//      (test/persist-failure-reporting.test.mjs)
//   2. emitSessionEvent forwards EVERY event object to
//        $eipc_event$_<NS>_$_claude.web_$_LocalSessions_$_OnEvent
//      without filtering by type, so a new type needs no bridge change
//   3. the renderer exposes onOnEvent on LocalSessions, so the channel has a subscriber API
//
// What is NOT established, and is recorded here rather than claimed:
//   - whether the shipped UI reacts to type 'persist_failed'. The bundle contains the string
//     'persist_failed' only as a telemetry source name (device_binding_key_persist_failed),
//     and the renderer's event handling is minified beyond what a static scan can attribute.
//
// So this file pins the wiring it can prove and states the gap explicitly. An earlier round
// (157) shipped a handler nobody called; the lesson is not to repeat that by ASSUMING the
// other end is connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const KERNEL = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');

test('the kernel emits persist_failed and persist_recovered', () => {
  assert.match(KERNEL, /type: 'persist_failed'/);
  assert.match(KERNEL, /type: 'persist_recovered'/);
});

test('the session event forwarder does not filter by event type', () => {
  // This is why a new event needs no bridge change. If a whitelist appears here, a new type
  // would silently stop reaching the renderer — exactly the round-157 failure mode.
  const at = BRIDGE.indexOf('const emitSessionEvent = (event) => {');
  assert.ok(at > 0, 'emitSessionEvent is missing');
  const block = BRIDGE.slice(at, at + 900);
  assert.match(block, /win\.webContents\.send\(/, 'the forwarder does not send');
  assert.equal(/event\.type\s*===/.test(block), false,
    'the forwarder now filters on event.type, so new events would be dropped');
});

test('the renderer has a subscription entry point for that channel', () => {
  // bridge-map lists the method the preload turns into a channel; without it there is nobody
  // to receive the payload.
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));
  const text = JSON.stringify(map);
  assert.ok(text.includes('onOnEvent') || text.includes('OnEvent'),
    'no OnEvent subscription is declared in bridge-map.json');
});

test('the unverified part is recorded in the evidence log', () => {
  // A future round should be able to see what was and was not confirmed.
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('persist_failed'), 'the event is not mentioned in the log');
});
