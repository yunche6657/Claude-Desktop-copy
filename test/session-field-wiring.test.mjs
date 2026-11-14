// The session record has 36 fields; only three reach the agent, and that is correct.
//
// METHOD. Following the previous round's lesson (trace from the CONSUMER backwards), I listed
// runAgent's parameters, then the call site, then every session field:
//
//   runAgent accepts 13: baseUrl apiKey model effort system messages tools execute onEvent
//                        maxTokens maxTurns signal fetchImpl
//   agent-config passes 10 — maxTokens/maxTurns/fetchImpl are left to their defaults
//   session record has 36 fields; permissionMode, effortLevel and model are consumed by a turn
//
// Each omission checked and found correct:
//
//   maxTokens / maxTurns   no session field or setter exists (LocalSessions has setEffort only),
//                          so there is no source to forward; defaults 4096 / 24 apply.
//   fetchImpl              a test seam, not user state.
//   fastMode               HAS a setter (setFastMode writes session.fastMode) but is deliberately
//                          NOT consumed. bridge-services.cjs says why:
//                            'Off is the honest default: this build always talks to the configured
//                             model, and claiming a faster one would be a lie about what runs.'
//                          So the toggle records intent without pretending to change the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the three session fields a turn consumes are all forwarded', () => {
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /permissionMode: session\.permissionMode,/, 'permissionMode is not forwarded');
  assert.match(kernel, /model: session\.model,/, 'model is not forwarded');
  assert.match(kernel, /effortLevel: session\.effortLevel,/, 'effortLevel is not forwarded');
});

test('fastMode is recorded but deliberately not acted on', () => {
  // A toggle that changed nothing would be a lie if it claimed to speed anything up.
  const bridge = read('desktop/bridge-services.cjs');
  assert.match(bridge, /setFastMode', \(_e, sessionId, value\) =>/, 'setFastMode is gone');
  assert.match(bridge, /claiming a faster one would be a lie about what runs/, 'the rationale comment was removed');
  const agent = read('desktop/agent.cjs');
  assert.equal(agent.split('fastMode').length - 1, 0, 'the agent started branching on fastMode');
});

test('maxTokens and maxTurns have no session-level source', () => {
  // Pinned so that adding a setter later is a deliberate change: if one appears, the turn must
  // forward it.
  const map = JSON.parse(read('desktop/shim/bridge-map.json'));
  const names = map['claude.web'].LocalSessions;
  const setters = names.filter((n) => /^set/.test(n) && /max|token|turn/i.test(n));
  assert.deepEqual(setters, [], 'a maxTokens/maxTurns setter appeared: ' + setters.join(', '));
});

test('the agent keeps sane defaults for the limits it is not given', () => {
  const agent = read('desktop/agent.cjs');
  assert.match(agent, /DEFAULT_MAX_TOKENS = 4096/, 'the token default changed');
  assert.match(agent, /DEFAULT_MAX_TURNS = 24/, 'the turn default changed');
});
