// Every agent configuration error keeps its own code — none is relabelled as 'network'.
//
// FOUND BROKEN. messagesEndpoint(baseUrl) sits INSIDE the fetch try/catch, so a missing base URL
// threw AgentError('invalid-base-url') and was immediately rewritten:
//
//   BEFORE  runAgent({ no baseUrl }) -> { code: 'network', message: 'request failed: a base URL is required' }
//
// The sentence was right and the code was wrong, which is the worst pairing: a caller that
// branches on `code` would chase a network problem that does not exist.
//
// MEASURED AFTER the fix:
//   no baseUrl        invalid-base-url   a base URL is required
//   empty baseUrl     invalid-base-url   a base URL is required
//   no apiKey         missing-key        an API key is required
//   no model          missing-model      a model id is required
//   no execute        missing-executor   an execute function is required
//   dead host         network            request failed: fetch failed
//
// The last line is the control: real transport failures must STILL be 'network', otherwise the
// fix would have swung too far.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const BASE = {
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'k',
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  execute: async () => ({ content: 'x' }),
  maxTokens: 16,
  onEvent: () => {},
};

/** Run the agent and return the error code it raised, or null. */
async function codeFor(overrides) {
  const { runAgent } = require(path.join(ROOT, 'desktop', 'agent.cjs'));
  try {
    await runAgent({ ...BASE, ...overrides });
    return null;
  } catch (e) {
    return e.code;
  }
}

test('a missing base URL reports invalid-base-url, not network', async () => {
  assert.equal(await codeFor({ baseUrl: undefined }), 'invalid-base-url');
  assert.equal(await codeFor({ baseUrl: '   ' }), 'invalid-base-url');
});

test('missing credentials and model keep their own codes', async () => {
  assert.equal(await codeFor({ apiKey: undefined }), 'missing-key');
  assert.equal(await codeFor({ model: undefined }), 'missing-model');
});

test('a missing executor is reported before anything else', async () => {
  assert.equal(await codeFor({ execute: undefined }), 'missing-executor');
});

test('a genuine transport failure is still reported as network', async () => {
  // The control: without this, a fix that mapped everything to its own code would pass.
  assert.equal(await codeFor({}), 'network');
});

test('the fetch catch re-throws AgentErrors unchanged', () => {
  const agent = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  assert.match(agent, /if \(error instanceof AgentError\) throw error;/, 'the AgentError passthrough is gone');
});