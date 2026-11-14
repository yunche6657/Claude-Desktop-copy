// The stop button must end the turn, not just hide itself.
//
// Measured on the replica: pressing stop emitted exactly one bridge call —
//
//   [trace] claude.web.LocalSessions.interrupt [sessionId]
//
// — and nothing else. `stop` was implemented and delegated to kernel.cancel, but the
// frontend never calls it: the real name is `interrupt`, which fell through to the
// generic fallback and answered null. The observable result was the worst possible one:
//
//   after stop: { stillRunning: 1, stopStillShown: false }
//
// The button disappeared and the turn kept running, so the user lost both the indicator
// AND the ability to stop. Only waiting it out ended it.
//
// After adding `interrupt`: { stillRunning: 0, stopStillShown: false } — the turn ends
// and the button hides because there is nothing left to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

test('both cancellation entry names are handled', () => {
  // `interrupt` is what the composer calls; `stop` is kept because other surfaces use it.
  // A missing handler answers null silently, which is how the button hid itself while the
  // turn kept running.
  for (const svc of ['LocalSessions', 'LocalAgentModeSessions']) {
    for (const method of ['interrupt', 'stop']) {
      const channel = svc + '_$_' + method + "'";
      assert.ok(SRC.includes(channel), 'no handler for ' + svc + '.' + method);
    }
  }
});

test('interrupt delegates to the kernel rather than answering a canned ok', () => {
  // A handler returning {ok:true} without cancelling would look identical in the UI.
  const at = SRC.indexOf("_$_interrupt'");
  assert.ok(at > 0, 'interrupt is missing');
  const body = SRC.slice(at, at + 400);
  assert.match(body, /kernel\.cancel\(sessionId\)/, 'interrupt must call kernel.cancel');
});

test('cancelling a running turn leaves isRunning false', async () => {
  // The end-to-end behaviour, without a live model: a turn that never settles, then a
  // cancel through the same kernel call the bridge uses.
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({ model: 'deaf', tools: [], run: () => new Promise(() => {}) }),
  });
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'go').catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(kernel.getSession(s.sessionId).isRunning, true, 'the turn should be running');

  const result = kernel.cancel(s.sessionId);
  assert.equal(result.ok, true, 'cancelling a running turn must report success');
  assert.equal(kernel.getSession(s.sessionId).isRunning, false, 'the turn did not stop');
});

test('cancelling an idle session reports nothing to cancel instead of throwing', () => {
  // The stop button can be pressed a beat after the turn finished; that must not error.
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
  });
  const s = kernel.start({ cwd: 'C:\\w' });
  const result = kernel.cancel(s.sessionId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no running turn');
});
