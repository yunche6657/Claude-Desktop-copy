// The effort picker must change the request, not just a label.
//
// The composer offers low / medium / high effort, the session record stores the choice as
// effortLevel, and bridge-services.cjs carries this comment:
//
//   "The effort options the picker offers. Every level the UI knows about is valid
//    here because the agent runner forwards whatever the caller picks."
//
// It did not. agent.cjs built its body from model/max_tokens/messages/system/tools and had
// no thinking field at all, so picking a level changed the label and nothing else.
// A grep for reasoning|thinking|effort|budget_tokens across agent.cjs returned nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runAgent, thinkingFor } = require(path.join(ROOT, 'desktop', 'agent.cjs'));

/** Capture the request body the agent would send. */
async function bodyFor({ effortLevel, maxTokens = 8192 } = {}) {
  let captured = null;
  const payload = JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => payload };
  };
  await runAgent({
    baseUrl: 'http://example.invalid',
    apiKey: 'k',
    model: 'test-model',
    effort: effortLevel,
    maxTokens,
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    execute: async () => ({ content: 'ok' }),
    fetchImpl,
  });
  return captured;
}

test('a high effort level enables extended thinking', async () => {
  const body = await bodyFor({ effortLevel: 'high' });
  assert.ok(body.thinking, 'the request carried no thinking field at all');
  assert.equal(body.thinking.type, 'enabled');
  assert.ok(body.thinking.budget_tokens > 0, 'the budget must be positive');
});

test('medium asks for less thinking than high', async () => {
  const medium = await bodyFor({ effortLevel: 'medium' });
  const high = await bodyFor({ effortLevel: 'high' });
  assert.ok(medium.thinking && high.thinking, 'both levels must think');
  assert.ok(high.thinking.budget_tokens > medium.thinking.budget_tokens, 'high must budget more');
});

test('low effort sends no thinking block', async () => {
  const body = await bodyFor({ effortLevel: 'low' });
  assert.equal(body.thinking, undefined, 'low should not pay for thinking');
});

test('an absent effort level sends no thinking block', async () => {
  // Headless callers must keep working and must not silently enable thinking.
  const body = await bodyFor({});
  assert.equal(body.thinking, undefined);
});

test('thinking is dropped when the budget would leave no room to answer', () => {
  // The budget must stay strictly below max_tokens or the API rejects the request.
  // With a fractional budget, only a very small max_tokens can be too tight.
  const tiny = thinkingFor('high', 1024);
  assert.equal(tiny, null, 'a 1024-token window cannot fund thinking');
});

test('the thinking budget always leaves room for the reply', () => {
  // Whatever the level, the budget must be strictly below max_tokens.
  for (const maxTokens of [2048, 4096, 8192, 16384]) {
    for (const effortLevel of ['medium', 'high']) {
      const thinking = thinkingFor(effortLevel, maxTokens);
      if (!thinking) continue;
      assert.ok(thinking.budget_tokens < maxTokens, effortLevel + '/' + maxTokens + ' left no headroom');
    }
  }
});
test('the session effort level reaches the runner', () => {
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const at = kernel.indexOf('createAgent({');
  assert.ok(at > 0);
  assert.match(kernel.slice(at, at + 500), /effortLevel:\s*selectedEffort\(session\.model, session\.effortLevel\)/,
    'session-kernel must forward the stored effort level');
  const local = fs.readFileSync(path.join(ROOT, 'desktop', 'local-kernel.cjs'), 'utf8');
  assert.match(local, /opts\.effortLevel/, 'local-kernel must read it from the turn options');
  const runAt = local.indexOf('await agent.run({');
  assert.match(local.slice(runAt, runAt + 400), /effortLevel,/, 'agent.run must receive it');
  const config = fs.readFileSync(path.join(ROOT, 'desktop', 'agent-config.cjs'), 'utf8');
  assert.match(config, /effort:\s*effortLevel/, 'the runner must put it on the request');
});
test('the CCB turn path carries only model-validated effort per turn', () => {
  // The current control protocol acknowledges effort before sending user input.
  // End-to-end ordering and permission independence live in ccb-effort-control.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const at = kernel.indexOf('await backend.sendMessage(');
  assert.ok(at > 0, 'the backend turn path must exist');
  const block = kernel.slice(at, at + 700);
  assert.match(block, /effortLevel:\s*selectedEffort\(sessions\.get\(sessionId\)\?\.model, sessions\.get\(sessionId\)\?\.effortLevel\)/,
    'the CCB path must validate effort against the currently selected model');
  // ...while the in-process path still carries it.
  const createAt = kernel.indexOf('createAgent({');
  assert.match(kernel.slice(createAt, createAt + 500), /effortLevel:\s*selectedEffort\(session\.model, session\.effortLevel\)/);
});
