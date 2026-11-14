// The packaged acceptance runner must derive CLAUDE_AGENT_MODEL itself.
//
// The runner spawns Electron directly instead of going through tools/launch-replica.cjs, and the
// launcher is what normally exports the model from the gateway config. Without it the kernel
// resolves an EMPTY model.
//
// MEASURED before this fix, running the seed phase:
//
//   report.error = 'AssertionError: {"ok":false,"error":"API 502: Upstream authentication
//                   failed, please contact administrator","code":"server"}'
//
//   resolveConfig().model -> ''
//
// The failure names the provider, so it reads as an outage rather than a harness defect. The
// gateway was in fact reachable (/v1/models returned 200) — the request simply carried no model.
//
// This is the same class as round 328's session-default bug: a value that one entry point
// exports and another entry point forgets. The test below pins the second entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROOF = path.join(ROOT, 'tools', 'packaged-proof.cjs');
const LAUNCHER = path.join(ROOT, 'tools', 'launch-replica.cjs');

test('the proof runner and launcher use the executable startup resolver', () => {
  const proof = fs.readFileSync(PROOF, 'utf8');
  const launcher = fs.readFileSync(LAUNCHER, 'utf8');
  assert.match(proof, /require\('\.\.\/desktop\/startup-defaults\.cjs'\)\.applyStartupDefaults\(env\)/);
  assert.match(launcher, /require\('\.\.\/desktop\/startup-defaults\.cjs'\)\.applyStartupDefaults\(env\)/);
  assert.doesNotMatch(proof, /env\.CLAUDE_AGENT_MODEL\s*=.*claude-sonnet/);
});

test('the configuration phase still runs WITHOUT a model on purpose', () => {
  // That phase proves the app boots and shows settings before any provider is configured, so
  // it deletes the model again. Losing this would hide the 'no credentials' path.
  const source = fs.readFileSync(PROOF, 'utf8');
  assert.match(source, /phase === 'configuration'[^\n]*delete phaseEnv\.CLAUDE_AGENT_MODEL/, 'the configuration phase no longer clears the model');
});
