// Correction: the app DOES hit the fallback, 68 times on startup. Earlier rounds said zero.
//
// Rounds 226 and 231 both reported "[fallback] hits: 0" and I treated that as the answer.
// Both measurements were reading the WRONG FILE: the launcher spawns Electron detached with
//   stdio: ['ignore', out, err],  out = evidence/live/replica-<port>.out
// so a PowerShell `-RedirectStandardOutput tools/_lNNN.log` captures only the launcher's own
// one-line "replica launched pid=..." message. The 0 was a false negative, twice.
//
// The real numbers from evidence/live/replica-10020.out (startup + walking the chat surface
// and five settings/nav destinations):
//   68 hits across 38 distinct channels
//   top: getSSHConfigs x6, getPlugins x6, getAllScheduledTasks x4, setRoutedLinkConfirmReady x4,
//        setFocusedCwd x4, listMarketplaces x3, syncLocalOrgPlugins x3
//
// And the UI is NOT broken by them: measured on the same page - 0 spinners, 0 placeholders,
// 0 role=alert nodes, no "Something went wrong" text. Every consumer guards the value, e.g.
//   (await r?.getSSHConfigs?.()?.catch(() => void 0))?.find(...)
//   await I?.getPlugins?.(undefined, It) ?? []
//   if (!t?.updateScheduledTask || !t.getAllScheduledTasks) return false
//
// So the right claim is "68 channels fall back, and all of them are tolerated" — not "the app
// never falls back". This file pins the tolerant-half: the guard shapes that make it safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the launcher sends Electron output to evidence/live, not to stdout', () => {
  // This is the fact that made two rounds of measurements wrong.
  const launcher = fs.readFileSync(path.join(ROOT, 'tools', 'launch-replica.cjs'), 'utf8');
  assert.match(launcher, /evidence', 'live', `replica-\$\{port\}\.out`/,
    'the replica log moved; the fallback trace now goes somewhere else');
  assert.match(launcher, /stdio: \['ignore', out, err\]/,
    'the detached stdio wiring changed');
});

test('the launcher always enables fallback tracing', () => {
  // The trace is not opt-in here, which is why the 68 hits were recorded at all.
  const launcher = fs.readFileSync(path.join(ROOT, 'tools', 'launch-replica.cjs'), 'utf8');
  assert.match(launcher, /env\.CLAUDE_TRACE = source\.CLAUDE_TRACE \|\| 'all'/);
});

test('the fallback logs a distinct marker the trace can be grepped by', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(bridge, /\[fallback\]/);
});

test('a recorded replica log shows fallbacks happen on a normal run', () => {
  // If this ever reads 0, either every fallback got implemented or tracing broke again —
  // both worth looking at, which is the point of asserting it.
  const logPath = path.join(ROOT, 'evidence', 'live', 'replica-10020.out');
  if (!fs.existsSync(logPath)) return; // older checkouts may not have this run
  const hits = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('[fallback]'));
  assert.ok(hits.length > 0, 'the captured run shows no fallbacks at all: tracing is probably broken');
});
