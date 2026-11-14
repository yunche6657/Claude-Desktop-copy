// The cap notice reaches the model, not just the tool result.
//
// Rounds 210-212 established that every cap announces itself and that the announced fix
// works. This round closes the last link: does the notice survive into the request the model
// actually sees?
//
// Measured by running the real agent loop against a fake fetch that records each request body:
//
//   model calls: 2
//   has tool_result: true
//   has cap note: true
//   ... "… [60 more matches not shown; raise max_results or narrow the pattern]"
//
// So the chain is complete: tool -> approval executor -> agent tool_result block -> model.
// A notice that stopped at the tool result would be invisible to the only reader that matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
const { defineTools, definitionsFor } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));

/**
 * Run one agent turn that calls Glob, capturing every request body sent to the model.
 * The fake model asks for Glob once, then answers.
 */
async function captureModelRequests(workspace) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init && init.body ? init.body : ''));
    call += 1;
    const payload = call === 1
      ? {
        type: 'message',
        content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.test.mjs' } }],
        stop_reason: 'tool_use',
      }
      : { type: 'message', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    const body = JSON.stringify(payload);
    return { ok: true, status: 200, async text() { return body; } };
  };
  try {
    const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace] });
    const execute = createApprovalExecutor({
      mode: 'bypassPermissions',
      ask: async () => 'allow',
      tools,
      onEvent: () => {},
    });
    await runAgent({
      baseUrl: 'http://unused', apiKey: 'k', model: 'm', system: 's',
      messages: [{ role: 'user', content: 'list tests' }],
      tools: definitionsFor(tools),
      execute,
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

test('a tool result is fed back to the model as a tool_result block', async () => {
  // Without this the model would call a tool and never learn the outcome.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), '');
    const bodies = await captureModelRequests(dir);
    assert.equal(bodies.length, 2, 'expected two model calls');
    assert.ok(bodies[1].includes('tool_result'), 'the tool outcome never reached the model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the truncation notice reaches the model', async () => {
  // The whole point of announcing a cap: the reader must see the announcement.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-note-'));
  try {
    for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(4, '0') + '.test.mjs'), '');
    const bodies = await captureModelRequests(dir);
    assert.ok(bodies[1].includes('not shown'),
      'the model was given a truncated list with no indication it was truncated');
    assert.ok(/more matches? not shown/.test(bodies[1]), 'the notice text is malformed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a complete tool result carries no notice to the model', async () => {
  // Otherwise the model would distrust complete answers.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-clean-'));
  try {
    fs.writeFileSync(path.join(dir, 'only.test.mjs'), '');
    const bodies = await captureModelRequests(dir);
    assert.equal(/more matches? not shown/.test(bodies[1]), false,
      'a complete result claimed truncation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
