// One command runs the whole offline acceptance, and fails honestly.
//
// MEASURED: `node tools/acceptance.mjs` -> four phases, 102 seconds, exit 0:
//
//   configuration  ok  #settings/claude-code
//   surfaces       ok  9 panels
//   history        ok  207 sessions, 0 open failures
//   message        ok  reply 'ACCEPTANCE-OK'
//
// The wrapper exists because the raw runner takes four decisions that are easy to get wrong,
// and two rounds were lost to that: a 502 that was actually an empty model, and a 'packaged
// acceptance timeout' that was the parent killing the child before its own watchdog.
//
// The rule it encodes: judge by the REPORTS. A phase that never wrote one is a failure even if
// the process exited 0, because that is exactly how the timeout above looked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'tools', 'acceptance.mjs');

test('the acceptance entry exists and is wired into npm scripts', () => {
  assert.ok(fs.existsSync(ENTRY), 'tools/acceptance.mjs is gone');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.acceptance, 'node tools/acceptance.mjs');
});

test('the default phases are the ones that work without a provider', () => {
  // A default that needs the gateway would fail for external reasons and train people to
  // ignore the result. The offline set is the one with evidence behind it.
  const source = fs.readFileSync(ENTRY, 'utf8');
  assert.match(source, /const OFFLINE_PHASES = \['configuration', 'surfaces', 'history', 'message'\]/);
  assert.match(source, /arg\('phases', OFFLINE_PHASES\.join\(','\)\)/);
});

test('the provider-dependent phases are known and announced', () => {
  // If someone asks for seed/restore while the gateway is down, they should see why it failed
  // rather than infer a product defect.
  const source = fs.readFileSync(ENTRY, 'utf8');
  assert.match(source, /const ONLINE_PHASES = \['seed', 'restore', 'files'\]/);
  assert.match(source, /will fail if the gateway is unreachable/);
});

test('a missing report is treated as a failure, not as success', () => {
  // The exit code alone lied in round 352: the parent killed the child and the run reported a
  // timeout with configuration.json and surfaces.json already on disk.
  const source = fs.readFileSync(ENTRY, 'utf8');
  assert.match(source, /present !== true \|\| r\.ok !== true \|\| r\.visible !== false/, 'the verdict no longer requires a report per phase');
  assert.match(source, /if \(!fs\.existsSync\(file\)\) return \{ phase, present: false \}/);
});

test('the wrapper sets the stub text so the message phase never needs the model', () => {
  const source = fs.readFileSync(ENTRY, 'utf8');
  assert.match(source, /CLAUDE_AGENT_STUB_TEXT: stubText/);
  assert.match(source, /arg\('stub-text', 'ACCEPTANCE-OK'\)/);
});

test('the wrapper refuses to start without electron instead of failing mid-run', () => {
  const source = fs.readFileSync(ENTRY, 'utf8');
  assert.match(source, /electron is not installed/);
  assert.match(source, /process\.exit\(2\)/);
});

test('the recorded default run passed every phase with an invisible window', (t) => {
  const out = path.join(ROOT, 'evidence', 'live', 'acceptance-latest');
  if (!fs.existsSync(out)) { t.skip('no recorded acceptance run'); return; }
  const phases = fs.readdirSync(out).filter((f) => f.endsWith('.json') && f !== 'navigation.json');
  assert.ok(phases.length >= 4, 'the recorded run covers only ' + phases.length + ' phases');
  for (const file of phases) {
    const body = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
    assert.equal(body.ok, true, file + ' did not pass');
    assert.equal(body.visible, false, file + ' ran with a visible window');
  }
});
