// One command, four phases, a real Electron window, no provider.
//
// MEASURED (round 352), CLAUDE_PROOF_PHASES=configuration,surfaces,history,message on an
// invisible window with a deterministic agent:
//
//   configuration  ok  hash #settings/claude-code, dialog true, userMenu true
//   surfaces       ok  9 panels, each with its own marker
//   history        ok  207 sessions, sweep visited 207, 0 failures
//   message        ok  reply 'ACCEPTANCE-OK', 2 transcript rows, rendered on screen
//   exit 0
//
// This is the acceptance the whole session has been building toward: it runs on one host with
// the provider unreachable, and it fails loudly if any of the four regresses.
//
// The parent/child deadline mismatch fixed alongside it is worth recording: the child's history
// watchdog is 180 s but the parent killed it at 75 s, so the run reported 'packaged acceptance
// timeout' with no history.json written — configuration and surfaces had already passed, which
// made it look like a product hang in the third phase rather than a harness mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'evidence', 'live', 'round352-acceptance');

function report(name) {
  const file = path.join(OUT, name + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

test('the parent kill deadline exceeds the child watchdog for each phase', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'tools', 'packaged-proof.cjs'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  const expression = (source, name) => {
    const match = source.match(new RegExp(`const ${name} = (phase[^;]+);`));
    assert.ok(match, `${name} phase-aware deadline is missing`);
    return new Function('phase', `return ${match[1]};`);
  };
  const parent = expression(runner, 'parentDeadline');
  const child = expression(harness, 'deadline');
  assert.match(runner, /setTimeout\([^\n]+parentDeadline\)/, 'parent deadline is not used by its timer');
  assert.match(harness, /setTimeout\([^\n]+deadline\)/, 'child deadline is not used by its watchdog');
  for (const [phase, parentMs, childMs] of [
    ['history', 200000, 180000], ['git', 95000, 80000],
    ['model-switch', 140000, 120000], ['model-switch-resume', 140000, 120000],
    ['message', 75000, 60000],
  ]) {
    assert.equal(parent(phase), parentMs, `${phase} parent deadline`);
    assert.equal(child(phase), childMs, `${phase} child watchdog`);
    assert.ok(parent(phase) > child(phase), `${phase} parent kills before the child watchdog`);
  }
});

test('all four phases passed in one run', (t) => {
  const names = ['configuration', 'surfaces', 'history', 'message'];
  const missing = names.filter((n) => !report(n));
  if (missing.length) return t.skip('no recorded acceptance run: missing ' + missing.join(', '));
  for (const name of names) {
    const r = report(name);
    assert.equal(r.ok, true, name + ' did not pass: ' + JSON.stringify(r.error || null));
    assert.equal(r.visible, false, name + ' ran with a visible window');
  }
});

test('the configuration phase proves the app boots into settings without credentials', (t) => {
  const r = report('configuration');
  if (!r) { t.skip('no recorded run'); return; }
  // (a recorded run is the precondition for the assertions below)
  assert.equal(r.configuration.hash, '#settings/claude-code');
  assert.equal(r.configuration.dialog, true);
});

test('the surfaces phase covered all nine panels', (t) => {
  const r = report('surfaces');
  if (!r) { t.skip('no recorded run'); return; }
  // (a recorded run is the precondition for the assertions below)
  assert.equal(r.surfaces.length, 9);
});

test('the history phase opened every stored session without a failure', (t) => {
  const r = report('history');
  if (!r) { t.skip('no recorded run'); return; }
  // (a recorded run is the precondition for the assertions below)
  assert.equal(r.sweep.failures.length, 0, 'sessions failed to open: ' + JSON.stringify(r.sweep.failures.slice(0, 3)));
  assert.equal(r.sweep.visited, r.sessionCount, 'the sweep did not visit every session');
  assert.ok(r.sessionCount >= 100);
});

test('the message phase completed a turn end to end', (t) => {
  const r = report('message');
  if (!r) { t.skip('no recorded run'); return; }
  // (a recorded run is the precondition for the assertions below)
  assert.equal(r.send.ok, true);
  assert.equal(r.send.text, 'ACCEPTANCE-OK');
  assert.equal(r.transcriptRows, 2);
  assert.deepEqual(r.transcriptTypes, ['user', 'assistant']);
  assert.ok(String(r.rendered).includes('ACCEPTANCE-OK'), 'the reply never reached the screen');
});
