// Tests for the measurement tooling itself.
//
// Several earlier rounds concluded "the UI never calls the bridge" from probes that
// were pointed at the ORIGINAL instance (9229) rather than the reconstruction (9340),
// and from a trace flag that was never set. Both are pinned here so the same
// measurement error cannot recur silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('the CDP client defaults to the reconstruction, not the original', () => {
  // Reading the source is the only way to assert a default that is resolved at call
  // time; the value itself is exercised by every probe run.
  const src = readFileSync('tools/cdp.mjs', 'utf8');
  const m = src.match(/process\.env\.CDP_ENDPOINT\s*\|\|\s*'([^']+)'/);
  assert.ok(m, 'the endpoint default must be visible in source');
  assert.equal(m[1], 'http://127.0.0.1:9340',
    'defaulting to 9229 measured the original and invalidated earlier conclusions');
});

test('the evaluator defaults to the reconstruction too', () => {
  const src = readFileSync('tools/eval.mjs', 'utf8');
  const m = src.match(/process\.env\.CDP_ENDPOINT\s*\|\|\s*'([^']+)'/);
  assert.ok(m, 'eval.mjs must define an endpoint default');
  assert.equal(m[1], 'http://127.0.0.1:9340');
});

test('the launcher passes --no-sandbox, without which Electron aborts', () => {
  // Bisected in tools/probe-flags.cjs: every invocation including --version exits
  // 0x80000003 unless --no-sandbox is present; with it the same binary prints its
  // version and exits 0.
  const src = readFileSync('tools/launch-replica.cjs', 'utf8');
  assert.match(src, /--no-sandbox/, 'the launcher must pass --no-sandbox');
});

test('the launcher strips ELECTRON_RUN_AS_NODE from the child environment', () => {
  // The harness exports it as 1, which makes Electron behave as plain Node
  // (require('electron') is undefined, --version prints the Node version).
  const src = readFileSync('tools/launch-replica.cjs', 'utf8');
  assert.match(src, /delete\s+env\.ELECTRON_RUN_AS_NODE/);
});

test('the launcher enables bridge tracing so channel entry is observable', () => {
  // Without CLAUDE_TRACE the main process records nothing, and "no calls" cannot be
  // distinguished from "not measured".
  const src = readFileSync('tools/launch-replica.cjs', 'utf8');
  assert.match(src, /env\.CLAUDE_TRACE\s*=/, 'the launcher must set CLAUDE_TRACE');
});

test('the launcher reads gateway settings from the shipped config, not literals', () => {
  const src = readFileSync('tools/launch-replica.cjs', 'utf8');
  assert.match(src, /applyStartupDefaults\(env\)/, 'the launcher must share executable startup configuration');
  assert.doesNotMatch(src, /sk-[0-9a-f]{16,}/, 'no API key may be hard-coded');
});
