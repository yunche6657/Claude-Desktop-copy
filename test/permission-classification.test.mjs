// allow / ask / deny must be distinguishable, not folded into one boolean.
//
// `decide()` returns { prompt: boolean }, and every caller reads prompt:false as
// "run it unattended". Round 182 nearly broke this: dontAsk was set to prompt:false
// while correcting a misleading comment, which would have made "deny unapproved
// actions" mean "run them without asking" — byte-for-byte bypassPermissions.
//
// `classify()` now states the three outcomes by name. The assertions below pin:
//   - the classification of every mode/action pair
//   - that classify() and decide() can never disagree about permission
//   - that dontAsk is DENY, never ALLOW, for changes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  MODES, ACTIONS, DECISIONS, decide, classify,
} = require(path.join(ROOT, 'desktop', 'permissions.cjs'));

test('the three outcomes are distinct strings', () => {
  assert.equal(DECISIONS.ALLOW, 'allow');
  assert.equal(DECISIONS.ASK, 'ask');
  assert.equal(DECISIONS.DENY, 'deny');
  assert.equal(new Set(Object.values(DECISIONS)).size, 3);
});

test('dontAsk denies changes and allows reads', () => {
  // The distinguishing property of this mode: it never asks, and it never grants a change.
  assert.equal(classify(MODES.DONT_ASK, ACTIONS.EDIT), DECISIONS.DENY);
  assert.equal(classify(MODES.DONT_ASK, ACTIONS.EXEC), DECISIONS.DENY);
  assert.equal(classify(MODES.DONT_ASK, ACTIONS.READ), DECISIONS.ALLOW);
});

test('dontAsk never classifies as ALLOW for a change', () => {
  // The exact regression that was nearly introduced: if this ever passes, edits run with
  // no approval in a mode whose whole point is to refuse them.
  for (const action of [ACTIONS.EDIT, ACTIONS.EXEC]) {
    assert.notEqual(classify(MODES.DONT_ASK, action), DECISIONS.ALLOW,
      'dontAsk would run ' + action + ' unattended');
  }
});

test('classify and decide never disagree about permission', () => {
  // classify() is a view over decide(); a divergence means one of them lies to its caller.
  for (const mode of Object.values(MODES)) {
    for (const action of Object.values(ACTIONS)) {
      const permitted = decide(mode, action).prompt === false;
      const classified = classify(mode, action) === DECISIONS.ALLOW;
      assert.equal(classified, permitted,
        mode + '/' + action + ': classify says ' + classify(mode, action)
        + ' but decide says prompt=' + decide(mode, action).prompt);
    }
  }
});

test('the full classification matrix is what the modes promise', () => {
  // Written out rather than derived: a change to any cell should require editing this test.
  const expected = {
    ask: { read: 'allow', edit: 'ask', exec: 'ask' },
    acceptEdits: { read: 'allow', edit: 'allow', exec: 'ask' },
    bypassPermissions: { read: 'allow', edit: 'allow', exec: 'allow' },
    plan: { read: 'allow', edit: 'ask', exec: 'ask' },
    auto: { read: 'allow', edit: 'allow', exec: 'ask' },
    default: { read: 'allow', edit: 'ask', exec: 'ask' },
    dontAsk: { read: 'allow', edit: 'deny', exec: 'deny' },
  };
  for (const [mode, row] of Object.entries(expected)) {
    for (const [action, want] of Object.entries(row)) {
      assert.equal(classify(mode, action), want, mode + '/' + action);
    }
  }
});

test('a bridge session downgrades bypass to acceptEdits before classifying', () => {
  // The shipped app refuses a blanket bypass over a bridge; the downgrade must be visible
  // in the classification, not just in the reason string.
  assert.equal(classify(MODES.BYPASS, ACTIONS.EXEC), DECISIONS.ALLOW);
  assert.equal(classify(MODES.BYPASS, ACTIONS.EXEC, { isBridge: true }), DECISIONS.ASK);
});
