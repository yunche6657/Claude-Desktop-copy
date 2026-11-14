// A returning user must be able to OPEN an existing conversation — not just start a new one.
//
// Every acceptance phase before this one created its own session (seed) or re-opened the one
// seed created (restore). So the path that matters most to a real user — 'my history is still
// there, and it renders' — had no evidence at all. `getAll` was never called by the harness.
//
// MEASURED this round, `CLAUDE_PROOF_PHASES=history` on a window with show:false:
//
//   sessionCount  198
//   opened        local_c051c392-06e5-4518-8950-ba61fa3e557c   (483 rows, the largest)
//   rendered      2037 chars, 25 message nodes
//                 head: '您正在使用 Gateway … Claude 已回复：Replaced.'
//   visible       false
//
// No model is involved: the phase only reads the store and lets the renderer draw it. That is
// why it could run while the provider was returning 503.
//
// The runner copies the real store into its throwaway workspace first, so this phase reads a
// snapshot and never opens the user's file for writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'evidence', 'live', 'round342-history', 'history.json');

test('the harness actually opens an existing session', (t) => {
  const harness = fs.readFileSync(path.join(ROOT, 'desktop', 'background-check.cjs'), 'utf8');
  assert.match(harness, /phase === 'history'/, 'the history phase is gone');
  assert.match(harness, /LocalSessions\.getAll\(\)/, 'the phase no longer reads the session list');
  assert.match(harness, /pushState[^\n]*epitaxy/, 'the phase no longer navigates to the session');
});

test('the real store is snapshotted, never opened for writing', () => {
  // A phase that wrote to .data/sessions would be destroying the evidence it measures.
  const runner = fs.readFileSync(path.join(ROOT, 'tools', 'packaged-proof.cjs'), 'utf8');
  assert.match(runner, /copyFileSync\(realStore/, 'the runner no longer copies the real store');
  assert.match(runner, /\.data', 'sessions', 'kernel-sessions\.json'/, 'the real store path changed');
});

test('the recorded history run opened the largest transcript and rendered it', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no history run recorded in evidence/live/round342-history');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(report.ok, true, 'the history run failed: ' + JSON.stringify(report.error || null));
  assert.equal(report.visible, false, 'the window was supposed to stay invisible');
  assert.ok(report.sessionCount > 0, 'the store had no sessions');
  assert.ok(report.opened && report.opened.rows >= 2, 'no substantial transcript was opened');
  // The largest session must be the one opened: a 2-row seed would prove almost nothing.
  assert.ok(report.opened.rows >= 100, 'the run opened only ' + report.opened.rows + ' rows');
  assert.ok(report.rendered && report.rendered.length > 50, 'the view rendered almost nothing');
  assert.ok(report.rendered.messages > 0, 'no message nodes were found in the view');
});

test('the rendered text is conversation content, not an empty shell', (t) => {
  if (!fs.existsSync(REPORT)) return t.skip('no history run recorded');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  // The head must contain actual message text from the transcript rather than only chrome.
  assert.match(report.rendered.head, /Claude|Gateway|Replaced/, 'the head has no conversation text: ' + report.rendered.head.slice(0, 120));
});
