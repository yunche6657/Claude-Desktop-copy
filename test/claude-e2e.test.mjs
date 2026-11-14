import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

test('claude mode end to end through HTTP with a real child process', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-e2e-'));
  const server = createApp({ dataDir: dir, mode: 'claude', executable: fixture });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const session = await (await post('/api/sessions', { title: '端到端' })).json();
  const { runId } = await (await post(`/api/sessions/${session.id}/messages`, { text: '你好' })).json();
  const raw = await (await fetch(base + `/api/runs/${runId}/events`)).text();
  const events = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), '真实子进程流式片段');
  assert.deepEqual(events.at(-2), { type: 'status', status: 'completed' });
  assert.deepEqual(events.at(-1), { type: 'done' });
  const saved = await (await fetch(base + `/api/sessions/${session.id}`)).json();
  assert.equal(saved.messages.at(-1).status, 'completed');
  assert.equal(saved.messages.at(-1).content, '真实子进程流式片段');
});
