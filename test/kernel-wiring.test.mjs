// The wiring must match the report.
//
// This test exists because of a bug I just introduced and nearly shipped: main.cjs logged
// "backend=ccb" while kernelFactory still built the local kernel. The selection logic was
// correct, the log was correct, and the two disagreed about reality. So the assertions below
// check that the decision reaches the thing that BUILDS the kernel, not just the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackDecision, FALLBACK_LOG } from '../desktop/kernel-fallback.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

test('choosing ccb actually constructs the ccb backend', () => {
  assert.match(main, /createCcbKernel/, 'main must build a CcbKernel');
  assert.match(main, /choice\.id === 'ccb'/, 'the branch must key on the selected id');
  assert.match(main, /backend = createCcbBackend\(/, 'the branch must assign a backend');
});

test('the constructed backend is handed to the session kernel', () => {
  // The failure mode: a backend built and then dropped on the floor.
  // The createAgent branch is now a multi-line object (it forwards mode AND model), so the
  // assertion checks the ternary and the factory call rather than the one-line shape.
  assert.match(main, /\.\.\.\(useBackend \? \{ backend \} : \{/, 'the kernel factory must pass backend OR createAgent, never both and never neither');
  assert.match(main, /createAgent: \(opts\) => getAgent\(/, 'the createAgent branch is missing');
});

test('session-kernel gets exactly one of the two, because it refuses both', () => {
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /takes createAgent\(\) or a backend, not both/);
});

test('only an unavailable CCB runtime permits a reported construction fallback', () => {
  // R569: the rule moved into desktop/kernel-fallback.cjs so it could be asserted as BEHAVIOUR. This test used to match
  // four regular expressions against main.cjs's text, which proved the lines existed and nothing about what they decided
  // — and it broke the moment the logic was extracted, which is the tell for a text assertion.
  assert.equal(fallbackDecision({ available: true }), 'propagate',
    'a throw with the runtime PRESENT must propagate: that is a real failure, not a fallback');
  assert.equal(fallbackDecision({ available: false }), 'fallback');
  assert.equal(fallbackDecision(undefined), 'fallback',
    'a missing probe result must fall back: a slow turn beats a failed boot');

  // And main.cjs must still ACT on the decision, clear the backend, and log the fallback by name.
  assert.match(main, /fallbackDecision\(unavailable\) === 'propagate'/, 'main.cjs does not consult the decision');
  assert.match(main, /kernelSelection = selectKernel\(\{ requested: choice\.requested, probes: \[unavailable/);
  assert.match(main, /'\[kernel\] ' \+ FALLBACK_LOG/, 'the fallback log line is gone, so the fallback is invisible again');
  assert.match(main, /backend = null;/, 'the failure path must clear the backend');
});

test('the approval hook is wired, so the kernel does not silently deny everything', () => {
  assert.match(main, /canUseTool:/, 'the backend needs a canUseTool hook to reach the approval card');
  assert.match(main, /bridge\.requestApproval/, 'it must go through the renderer approval path');
});

test('permission mode is not bypassPermissions: that would silently disable approvals', () => {
  assert.match(main, /CLAUDE_CCB_PERMISSION_MODE \|\| 'default'/, 'approval must be ON by default');
  assert.doesNotMatch(main, /CLAUDE_CCB_PERMISSION_MODE \|\| 'bypassPermissions'/);
});

test('the CCB paths point into the repository, not %TEMP%', () => {
  assert.match(main, /agent-core', 'bun', 'bun\.exe'/, 'the runtime must come from agent-core');
  assert.match(main, /agent-core', 'claude-code', 'dist', 'cli-bun\.js'/, 'the bundle must come from agent-core');
  assert.doesNotMatch(main, /cc-best-ref/, 'the throwaway %TEMP% checkout must not be a default');
});

test('the startup log reports the path actually taken, not just the choice', () => {
  assert.match(main, /turn path = /, 'the log must state which path runs turns');
});
