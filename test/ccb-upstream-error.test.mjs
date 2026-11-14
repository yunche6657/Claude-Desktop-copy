// When the upstream is down, the failure must name the upstream — and be reported once.
//
// Measured during a gateway outage: a turn sat for the full timeout budget while the kernel
// retried 503s internally. The only error the UI ever saw was "CCB kernel turn timed out
// after 45000ms", which sends the reader to the kernel. The kernel was healthy; the gateway
// was down.
//
// Two defects were fixed here:
//   1. api_retry frames were not recorded at all — the handler was written as a TOP-LEVEL
//      case, but api_retry is a SUBTYPE OF system, so it was dead code.
//   2. the same failure produced TWO error events (ccb-kernel's rejectTurn emitted one, and
//      session-kernel's catch emitted another).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

// A child that emits system/api_retry frames and then never settles the turn, so the timeout
// path runs with a recorded upstream cause.
const FAKE = [
  'const readline = require("node:readline");',
  'const out = (f) => process.stdout.write(JSON.stringify(f) + "\\n");',
  'out({ type: "system", subtype: "init", session_id: "fake", tools: [] });',
  'const rl = readline.createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  '  let f; try { f = JSON.parse(line); } catch { return; }',
  '  if (f.type === "control_request" && f.request.subtype === "initialize") {',
  '    out({ type: "control_response", response: { subtype: "success", request_id: f.request_id,',
  '      response: { commands: [], agents: [], models: [], account: {}, output_style: "default", available_output_styles: [] } } });',
  '    return;',
  '  }',
  '  if (f.type === "control_request" && f.request.subtype === "apply_flag_settings") {',
  '    out({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response: {} } });',
  '    return;',
  '  }',
  '  if (f.type === "user") {',
  '    out({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, error_status: 503, retry_delay_ms: 500, session_id: "fake" });',
  '    // Never emit a result: the host must time out and explain why.',
  '  }',
  '});',
].join('\n');

function makeKernel(turnTimeoutMs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'upstream-err-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, FAKE);
  return createCcbKernel({
    bunPath: process.execPath,
    entryPath: entry,
    kernelRoot: dir,
    cwd: dir,
    startupTimeoutMs: 8000,
    turnTimeoutMs,
  });
}

test('a timeout names the upstream failure that caused it', async () => {
  const kernel = makeKernel(1500);
  try {
    const session = createSessionKernel({ emit: () => {}, backend: kernel });
    const started = session.start({ cwd: tmpdir() });
    const result = await session.sendMessage(started.sessionId, 'hi');
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/, 'it must still say what happened');
    assert.match(result.error, /upstream 503/, 'and must name the upstream status');
    assert.match(result.error, /retry 3\/10/, 'and which retry it gave up on');
  } finally {
    await kernel.dispose();
  }
});

test('api_retry is handled as a system subtype, not a top-level frame', () => {
  // The dead-code bug: a `case 'api_retry'` at the switch top level never runs.
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const source = fs.readFileSync(pathMod.join(process.cwd(), 'desktop', 'ccb-kernel.cjs'), 'utf8');
  assert.equal(/^\s+case 'api_retry':/m.test(source), false,
    'api_retry must not be a top-level case: it arrives as system/api_retry');
  assert.match(source, /frame\.subtype === 'api_retry'/, 'it must be handled inside the system branch');
});

test('the upstream retry is surfaced as an event, so the UI can say "retrying"', async () => {
  const kernel = makeKernel(2500);
  const events = [];
  kernel.onEvent((event) => events.push(event));
  try {
    const session = createSessionKernel({ emit: () => {}, backend: kernel });
    const started = session.start({ cwd: tmpdir() });
    await session.sendMessage(started.sessionId, 'hi');
    const retry = events.find((event) => event.type === 'upstream_retry');
    assert.ok(retry, 'a retry must be observable');
    assert.equal(retry.errorStatus, 503);
    assert.equal(retry.attempt, 3);
  } finally {
    await kernel.dispose();
  }
});

test('one failure produces exactly ONE error event', async () => {
  // Both ccb-kernel and session-kernel used to emit, so the user saw it twice.
  const kernel = makeKernel(1500);
  const events = [];
  try {
    const session = createSessionKernel({ emit: (event) => events.push(event), backend: kernel });
    const started = session.start({ cwd: tmpdir() });
    await session.sendMessage(started.sessionId, 'hi');
    const errors = events.filter((event) => event.type === 'error');
    assert.equal(errors.length, 1, 'the same failure must not be announced twice');
  } finally {
    await kernel.dispose();
  }
});

test('a backend that reports its own errors declares that capability', () => {
  const kernel = makeKernel(1000);
  try {
    assert.equal(typeof kernel.reportsTurnErrors, 'function');
    assert.equal(kernel.reportsTurnErrors(), true);
  } finally {
    kernel.dispose();
  }
});
