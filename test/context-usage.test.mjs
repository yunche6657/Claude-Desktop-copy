import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRequestUsageTracker } = require('../desktop/context-usage.cjs');
const frame = event => ({ type: 'stream_event', event });
const start = (id, usage = {}) => frame({ type: 'message_start', message: { id, model: 'fixture', usage: { input_tokens: 20, output_tokens: 0, ...usage } } });
const delta = usage => frame({ type: 'message_delta', usage });
const stop = () => frame({ type: 'message_stop' });

test('commits only complete requests, replacing cumulative delta values', () => {
  const completed = [];
  const tracker = createRequestUsageTracker(value => completed.push(value));
  tracker.observe(start('one', { cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }));
  tracker.observe(delta({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 }));
  tracker.observe(delta({ output_tokens: 4 }));
  tracker.observe(stop());
  assert.deepEqual(completed, [{ messageId: 'one', model: 'fixture', usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } }]);
  tracker.observe(start('interrupted'));
  tracker.observe(delta({ output_tokens: 99 }));
  assert.equal(completed.length, 1);
  tracker.observe(start('second'));
  tracker.observe(stop());
  assert.equal(completed.length, 1);
  tracker.observe(start('third'));
  tracker.observe(delta({ output_tokens: 3 }));
  tracker.observe(stop());
  assert.equal(completed.length, 2);
  assert.deepEqual(completed[1].usage, { input_tokens: 20, output_tokens: 3 });
});

test('ignores nested agent stream and result cumulative usage', () => {
  const completed = [];
  const tracker = createRequestUsageTracker(value => completed.push(value));
  tracker.observe({ ...start('nested'), parent_tool_use_id: 'tool' });
  tracker.observe(delta({ output_tokens: 1 }));
  tracker.observe(stop());
  tracker.observe({ type: 'result', usage: { input_tokens: 900, output_tokens: 100 } });
  assert.deepEqual(completed, []);
});
