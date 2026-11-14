// Every stored session must open — not just the largest, and not just the sampled shapes.
//
// Round 342 opened only the biggest transcript and passed. Round 343 then found that 43 of the
// 198 stored sessions (34 with real content) crashed the route with
//   TypeError: Cannot read properties of null (reading 'replace')
// because the largest one happened to be healthy. A sample drawn by 'biggest' is not a sample
// by 'shape'.
//
// So the harness now sweeps EVERY session: navigate, settle, ask whether <main> survived and
// whether the error boundary fired.
//
// MEASURED after the round-343 folderless fix, on the real store:
//   sessionCount   205
//   visited        205
//   failures       []
//
// The sweep is the assertion that would have caught the folderless bug on its own, which is why
// it is worth its runtime (205 × ~220 ms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'evidence', 'live', 'round344-sweep', 'history.json');

test('the harness sweeps every session, not a sample', () => {
  const harness = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  assert.match(harness, /report\.sweep/, 'the sweep is gone from the history phase');
  assert.match(harness, /for \(const candidate of all\.slice\(0, sweepLimit\)\)/, 'the sweep no longer iterates the store');
  // A sweep that stopped after the first failure would hide the rest of the picture.
  assert.match(harness, /failures\.push/, 'the sweep no longer records failures');
});

test('the history phase gets a longer deadline than the other phases', () => {
  const harness = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  const match = harness.match(/const deadline = (phase[^;]+);/);
  assert.ok(match, 'the phase-aware deadline is gone');
  const deadline = new Function('phase', `return ${match[1]};`);
  assert.match(harness, /setTimeout\([^\n]+deadline\)/, 'the watchdog does not use the deadline');
  for (const [phase, expected] of [['history', 180000], ['git', 80000], ['model-switch', 120000], ['model-switch-resume', 120000], ['message', 60000]]) {
    assert.equal(deadline(phase), expected, `${phase} deadline`);
    if (phase !== 'history') assert.ok(deadline('history') > deadline(phase), `history must outlast ${phase}`);
  }
});

test('the recorded sweep opened every session without a failure', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no sweep run recorded in evidence/live/round344-sweep');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(report.ok, true, 'the sweep run failed: ' + JSON.stringify(report.error || null));
  assert.equal(report.visible, false, 'the window was supposed to stay invisible');
  assert.ok(report.sweep, 'the report carries no sweep section');
  assert.equal(report.sweep.failures.length, 0,
    report.sweep.failures.length + ' sessions failed to open: ' + JSON.stringify(report.sweep.failures.slice(0, 3)));
  // And it must actually have visited everything: a sweep of 3 rows proves nothing.
  assert.equal(report.sweep.visited, report.sessionCount,
    'the sweep visited ' + report.sweep.visited + ' of ' + report.sessionCount + ' sessions');
  assert.ok(report.sessionCount >= 100, 'the store shrank to ' + report.sessionCount + ' sessions');
});

test('the sampled edge shapes still pass alongside the sweep', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no sweep run recorded');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  for (const [label, shape] of Object.entries(report.edgeShapes || {})) {
    assert.equal(shape.present, true, label + ' was not found in the store');
    assert.equal(shape.errorText, null, label + ' opened into an error boundary');
    assert.equal(shape.hasMain, true, label + ' left no <main>');
  }
});
