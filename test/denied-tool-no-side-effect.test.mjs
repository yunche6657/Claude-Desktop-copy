// A refused tool call must leave NO side effect — verified by RUNNING the executor.
//
// WHY THIS FILE WAS REWRITTEN. It asserted on source text ('the decline message is present',
// 'isError: true appears in the refusal branch'). Those stay green whether or not the tool is
// actually prevented from running. This version counts real side effects.
//
// MEASURED by driving createApprovalExecutor with each decision:
//
//   decision   isError   handler ran   message
//   deny       true      NO            'The user declined to run SideEffect.'
//   timeout    true      NO            'The user did not respond in time, so SideEffect was not run.'
//   cancel     true      NO            'The user declined to run SideEffect.'
//   allow      false     YES           'ran'
//
// Only `allow` runs the handler. That is the whole contract, and a counter is the only way to
// see it: the message text alone would still be right if the tool ran anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));

/** Build an executor over a tool that counts how often it actually runs. */
function makeExecutor(decision) {
  const state = { ran: 0 };
  const tools = [{
    name: 'SideEffect',
    handler: async () => { state.ran++; return { content: 'ran' }; },
  }];
  const execute = createApprovalExecutor({ mode: 'ask', ask: async () => decision, tools });
  return { execute, state };
}

test('a declined call does not run the tool', async () => {
  const { execute, state } = makeExecutor('deny');
  const result = await execute({ name: 'SideEffect', input: {} });
  assert.equal(state.ran, 0, 'the tool ran despite the refusal');
  assert.equal(result.isError, true, 'the refusal is not marked as an error');
  assert.match(String(result.content), /declined/, 'the refusal does not say it was declined');
});

test('a timed-out approval does not run the tool', async () => {
  // A timeout is not consent. Round 238 fixed a gate that let it through.
  const { execute, state } = makeExecutor('timeout');
  const result = await execute({ name: 'SideEffect', input: {} });
  assert.equal(state.ran, 0, 'the tool ran after the approval timed out');
  assert.equal(result.isError, true);
  assert.match(String(result.content), /did not respond in time/, 'the timeout is not distinguishable from a refusal');
});

test('a cancelled approval does not run the tool', async () => {
  const { execute, state } = makeExecutor('cancel');
  const result = await execute({ name: 'SideEffect', input: {} });
  assert.equal(state.ran, 0, 'the tool ran after the approval was cancelled');
  assert.equal(result.isError, true);
});

test('an allowed call DOES run the tool', async () => {
  // The control. Without this, an executor that never runs anything would pass the tests above.
  const { execute, state } = makeExecutor('allow');
  const result = await execute({ name: 'SideEffect', input: {} });
  assert.equal(state.ran, 1, 'the tool did not run after approval');
  assert.notEqual(result.isError, true, 'an allowed call was marked as an error');
  assert.equal(result.content, 'ran');
});

test('an unknown tool is refused without running anything', async () => {
  const { execute, state } = makeExecutor('allow');
  const result = await execute({ name: 'NoSuchTool', input: {} });
  assert.equal(state.ran, 0);
  assert.equal(result.isError, true);
  assert.match(String(result.content), /Unknown tool/, 'the unknown tool is not named');
});
