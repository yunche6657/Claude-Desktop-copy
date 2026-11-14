// The runner must adopt the mode it was constructed for.
//
// main.cjs keys its runner cache by permission mode and passes the value to
// createAgentRunner, but the function's destructuring did not list permissionMode, so the
// argument was dropped on the floor and resolveConfig() picked the mode from env/profile
// alone. Measured on the live replica:
//
//   createAgentRunner({ permissionMode: 'acceptEdits' }).permissionMode  ->  'ask'
//   a session recorded as acceptEdits: Write -> approval card,
//   reason 'ask mode prompts before edits and commands'
//
// After the fix the same runner reports 'acceptEdits', the executor emits
// tool_auto_allowed instead of asking, and the Write completes with no card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createAgentRunner } = require(path.join(ROOT, 'desktop', 'agent-config.cjs'));

// Minimal env that satisfies the runner's configuration checks without touching the
// real credential store.
const ENV = { ANTHROPIC_AUTH_TOKEN: 'test-token', CLAUDE_AGENT_MODEL: 'test-model' };

const makeRunner = (permissionMode) => createAgentRunner({
  workspaceRoot: ROOT,
  env: ENV,
  approve: async () => 'deny',
  ...(permissionMode ? { permissionMode } : {}),
});

test('the runner adopts the mode it was constructed for', () => {
  for (const mode of ['acceptEdits', 'plan', 'dontAsk']) {
    assert.equal(makeRunner(mode).permissionMode, mode, 'runner ignored ' + mode);
  }
});

test('an unset mode falls back to the process configuration', () => {
  // Headless callers that pass no mode must keep working.
  assert.equal(makeRunner(undefined).permissionMode, 'ask');
});

test('an invalid mode is refused rather than adopted', () => {
  // A typo must not silently become a mode the gate cannot act on.
  assert.equal(makeRunner('not-a-mode').permissionMode, 'ask');
});

test('acceptEdits gates an edit the way the decision table says', () => {
  // Asserting on a live turn would need a network model; assert on the decision the
  // executor consults, which is what made the card appear in the first place.
  const { decide, ACTIONS } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));
  assert.equal(decide(makeRunner('acceptEdits').permissionMode, ACTIONS.EDIT).prompt, false,
    'a runner built for acceptEdits must not prompt for an edit');
  assert.equal(decide(makeRunner('ask').permissionMode, ACTIONS.EDIT).prompt, true,
    'a runner built for ask must still prompt');
});
