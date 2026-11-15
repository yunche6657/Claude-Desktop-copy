// Switching a session's model must actually change the model the next request asks for.
//
// FOUND BROKEN. setModel() wrote session.model and the UI showed the new name, but the value
// never reached the agent:
//
//   session-kernel.cjs  createAgent({ sessionId, permissionMode, effortLevel })   <- no model
//   main.cjs            getAgent(opts && opts.permissionMode)                     <- keyed on mode
//   agent-config.cjs    createAgentRunner({ ..., permissionMode })                <- no model param
//
// MEASURED, switching a session to 'definitely-not-a-real-model-xyz':
//   BEFORE  sendMessage -> { ok: true }   and the reply said 'MODELTEST'
//           i.e. the request silently ran on the process-config model
//   AFTER   sendMessage -> { ok: false, error: 'API 503: No available channel for model
//           definitely-not-a-real-model-xyz ...' }
//
// The bogus model is the test: a real gateway can only reject a name it never received, so a
// 503 naming that model proves the value travelled all the way to the request.
//
// This is the same class of bug as the permissionMode fix noted in agent-config.cjs: the caller
// passes a value, one function in the chain drops it, and nothing looks wrong because the
// defaults are sensible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the kernel forwards the session model to the agent factory', () => {
  // Count, not a regex window. `model: session.model,` appears twice — the backend path and the
  // local path — so matching it once stayed green when the local one was removed (measured).
  // Both must be present, and the local one must sit inside the createAgent options object.
  const kernel = read('desktop/session-kernel.cjs');
  const backendStart = kernel.indexOf('backend.start({ sessionId: id,');
  const backendEnd = kernel.indexOf('});', backendStart);
  assert.ok(backendStart > 0 && backendEnd > backendStart, 'the backend start call is missing');
  assert.match(kernel.slice(backendStart, backendEnd), /model: session\.model,/, 'the backend start must receive the session model');
  const start = kernel.indexOf('const agent = backend ? null : createAgent({');
  const end = kernel.indexOf('});', start);
  assert.ok(start > 0 && end > start, 'the local createAgent call is missing');
  const localCall = kernel.slice(start, end + 3);
  assert.match(localCall, /model: session\.model,/, 'the local-path createAgent call does not forward the model');
});

test('main.cjs forwards both the mode and the model', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /getAgent\(\s*opts && opts\.permissionMode,\s*opts && opts\.model,/, 'the factory ignores the model');
});

test('the runner cache is keyed on the mode AND the model', () => {
  // Keying on the mode alone handed back the runner built for the previous model.
  const main = read('desktop/main.cjs');
  assert.match(main, /const getAgent = \(permissionMode, model\) => \{/, 'getAgent lost its model parameter');
  assert.match(main, /String\(permissionMode \|\| ''\) \+ '\|' \+ String\(model \|\| ''\)/, 'the cache key does not include the model');
});

test('createAgentRunner accepts and applies a model override', () => {
  // Before the fix the parameter did not exist, so the value was silently discarded.
  const config = read('desktop/agent-config.cjs');
  assert.match(config, /onEvent = \(\) => \{\}, permissionMode, model(?:, [^}]*)? \} = \{\}/, 'createAgentRunner has no model parameter');
  assert.match(config, /typeof model === 'string' && model && model !== resolved\.model \? \{ model \}/, 'the model override is not applied');
});

test('an unset model leaves the resolved config untouched', () => {
  // The override must be conditional: an undefined model means 'use the process config'.
  const config = read('desktop/agent-config.cjs');
  assert.match(config, /\.\.\.resolved,/, 'the resolved config is no longer the base');
});
