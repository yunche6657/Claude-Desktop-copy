// R409: Monitor surfaces an expiry notification, as the official contract promises.
//
// THE GAP
//   `timeout_ms`'s official doc ends with: "You are notified at expiry and can re-arm."
//   R406 implemented the deadline itself (clamp + killTask) but surfaced nothing — the watch
//   ended silently and the user had to notice on their own that their monitor had stopped.
//   That is a half-implementation of the field: the kill happened, the promise did not.
//
// WHY BOTH CHANNELS, AND WHY BOTH ARE OPTIONAL
//   `addNotification` is the in-REPL toast; `sendOSNotification` is the OS-level notification
//   (iTerm2/Kitty/Ghostty/bell). A monitor expires while the user is *not* looking at the REPL,
//   which is the whole point of a background watch — an in-REPL-only toast would be invisible in
//   exactly the case the feature exists for. Both are declared optional on ToolUseContext
//   ("Only wired in interactive (REPL) contexts; SDK/QueryEngine don't set this"), so each call
//   site is guarded rather than assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const MONITOR = path.join(
  SRC, 'packages', 'builtin-tools', 'src', 'tools', 'MonitorTool', 'MonitorTool.tsx',
);
const src = () => fs.readFileSync(MONITOR, 'utf8');

test('the official contract promises a notification at expiry', () => {
  // Pinning the promise this round is satisfying. If the wording ever changes, the
  // implementation should be re-read against it rather than assumed still correct.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  assert.ok(fs.existsSync(dts), 'the official sdk-tools.d.ts is missing');
  const text = fs.readFileSync(dts, 'utf8');
  assert.match(text, /You are notified at expiry and can re-arm\./,
    'the expiry-notification promise changed: re-derive this round');
});

test('expiry fires BOTH notification channels', () => {
  const s = src();
  assert.match(s, /context\.addNotification\?\.\(\{/,
    'no in-REPL notification at expiry');
  assert.match(s, /context\.sendOSNotification\?\.\(\{/,
    'no OS-level notification at expiry: a background monitor usually expires while the user is '
    + 'looking elsewhere, which is exactly the case an in-REPL-only toast misses');
});

test('both notification calls are optional-chained, because SDK contexts omit them', () => {
  // ToolContext declares these as optional. An unguarded call would throw inside the timeout
  // callback — after the task is already killed, so the monitor would die AND the notification
  // would crash, which is worse than the original silent expiry.
  const s = src();
  assert.match(s, /context\.addNotification\?\./, 'addNotification is called without ?.');
  assert.match(s, /context\.sendOSNotification\?\./, 'sendOSNotification is called without ?.');
  assert.ok(!/context\.addNotification\(/.test(s),
    'an unguarded addNotification call appeared');
  assert.ok(!/context\.sendOSNotification\(/.test(s),
    'an unguarded sendOSNotification call appeared');
});

test('the notification fires at expiry, not at start', () => {
  // Placement matters: inside setTimeout, after killTask. A notification at spawn time would tell
  // the user nothing they did not already know.
  const s = src();
  const timerAt = s.indexOf('const timer = setTimeout(');
  const killAt = s.indexOf('killTask(handle.taskId, setAppState)');
  const notifAt = s.indexOf('context.addNotification?.(');
  assert.ok(timerAt > 0, 'the deadline timer is gone');
  assert.ok(killAt > timerAt,
    'killTask no longer runs inside the timeout callback');
  assert.ok(notifAt > killAt,
    'the notification fires before the kill, or outside the timeout callback');

  // And it must be inside the callback's closing brace, i.e. before the `}, timeoutMs);` line.
  const timerEnd = s.indexOf('}, timeoutMs);', timerAt);
  assert.ok(timerEnd > 0, 'the setTimeout callback boundary is unclear');
  assert.ok(notifAt < timerEnd,
    'the notification sits outside the setTimeout callback, so it would fire immediately');
});

test('the notification text carries the description and reports clamping', () => {
  const s = src();
  // The description is what makes the toast identifiable when several monitors exist.
  assert.match(s, /Monitor ended after \$\{Math\.round\(timeoutMs \/ 1000\)\}s/,
    'the expiry text no longer states the elapsed deadline');
  assert.match(s, /\$\{description\}/,
    'the expiry text omits the description, so the user cannot tell which monitor expired');
  // Clamping is user-visible information: "you asked for an hour, I watched 30 minutes".
  assert.match(s, /wasClamped/,
    'clamping is no longer surfaced, so a capped deadline looks like the requested one');
  assert.match(s, /capped to/, 'the clamp note lost its wording');
});

test('the notification has a task-scoped key so concurrent monitors do not collide', () => {
  let ok = false;
  try {
    const { text } = findChunk('monitor-timeout-');
    const m = /key:\s*`monitor-timeout-\$\{([^}]+)\}`/.exec(text);
    assert.ok(m, 'the notification key is no longer template-scoped');
    assert.ok(/taskId/.test(m[1]),
      'the key is not scoped by taskId, so two monitors would overwrite each other\'s toast');
    ok = true;
  } catch (err) {
    assert.fail('the notification key marker is missing from the bundle: ' + err.message);
  }
  assert.ok(ok);
});

test('the adopted bundle carries the notification', () => {
  for (const marker of ['monitor-timeout-', 'monitor_timeout', 'Monitor ended after']) {
    assert.doesNotThrow(() => findChunk(marker),
      'marker missing from the adopted bundle: ' + JSON.stringify(marker));
  }
});
