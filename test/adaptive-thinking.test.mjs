import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { callMessages, thinkingOptions } = require('../desktop/agent.cjs');

test('adaptive Claude models carry effort without the rejected token budget', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-5-5']) {
    for (const effort of ['low', 'medium', 'high']) {
      assert.deepEqual(thinkingOptions(model, effort, 4096), { thinking: { type: 'adaptive' }, output_config: { effort } });
    }
  }
});

test('older Claude and non-Claude gateways preserve the existing thinking contract', () => {
  for (const model of ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'deepseek-v4.1-flash']) {
    assert.deepEqual(thinkingOptions(model, 'medium', 4096), { thinking: { type: 'enabled', budget_tokens: 1024 } });
    assert.deepEqual(thinkingOptions(model, 'low', 4096), {});
  }
});

test('the adaptive thinking selection reaches the actual HTTP request body', async () => {
  let body;
  await callMessages({ baseUrl: 'http://local.test', apiKey: 'k', model: 'claude-sonnet-5-5', effort: 'medium', messages: [],
    fetchImpl: async (_url,options) => { body=JSON.parse(options.body); return { ok: true, text: async()=>JSON.stringify({type:'message',content:[]}) }; } });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal(body.thinking.budget_tokens, undefined);
});
