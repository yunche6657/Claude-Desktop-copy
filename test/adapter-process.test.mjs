import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startClaude} from '../engine.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

test('adapter parses a real child process stream without duplicating text', async () => {
  const events = [];
  const status = await new Promise(resolve => {
    startClaude({ executable: fixture, prompt: 'user: hi', onEvent: event => events.push(event), onFinish: resolve, timeoutMs: 20000 });
  });
  assert.equal(status, 'completed');
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), '真实子进程流式片段');
});

test('cancelling a live child terminates it with a cancelled status', async () => {
  const statuses = [];
  const task = startClaude({ executable: fixture, prompt: 'x', onEvent: () => {}, onFinish: status => statuses.push(status), timeoutMs: 20000 });
  task.cancel();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(statuses, ['cancelled']);
});
