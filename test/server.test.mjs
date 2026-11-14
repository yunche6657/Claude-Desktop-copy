import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

async function start(dataDir) {
  const server = createApp({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-server-'));
  const app = await start(dir);
  t.after(async () => { await stop(app.server); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, value, options = {}) => {
    const response = await fetch(app.base + route, value === undefined ? options : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), ...options });
    return response;
  };
  return { ...app, dir, request };
}
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
async function newSession(f) {
  const response = await f.request('/api/sessions', { title: '测试会话', projectPath: 'C:\\demo' });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.deepEqual(session.messages, []);
  return session;
}

test('config, session persistence, streaming, terminal replay and resume', async t => {
  const f = await fixture(t);
  const config = await (await f.request('/api/config')).json();
  assert.equal(config.mode, 'demo');
  assert.equal(config.tools, 'disabled');
  assert.equal(config.authentication, 'none');
  // The account block reports the real session identity; it must not be absent
  // or fabricated, but its exact user name depends on the host.
  assert.equal(typeof config.account.name, 'string');
  assert.ok(config.account.name.length > 0);
  assert.equal(config.account.kind, 'Demo');
  const session = await newSession(f);
  const response = await f.request(`/api/sessions/${session.id}/messages`, { text: '你好，世界！' });
  assert.equal(response.status, 202);
  const { runId } = await response.json();
  const stream = await f.request(`/api/runs/${runId}/events`);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const raw = await stream.text();
  const data = events(raw);
  assert.deepEqual(data[0], { type: 'status', status: 'running' });
  assert.deepEqual(data.at(-1), { type: 'done' });
  assert.deepEqual(data.at(-2), { type: 'status', status: 'completed' });
  const content = data.filter(event => event.type === 'text').map(event => event.text).join('');
  assert.match(content, /Demo 演示模式/);
  assert.match(content, /未执行任何 shell/);
  assert.match(content, /你好，世界！/);
  assert.equal(await (await f.request(`/api/runs/${runId}/events`)).text(), raw);
  const resumed = await f.request(`/api/runs/${runId}/events`, undefined, { headers: { 'Last-Event-ID': '1' } });
  assert.deepEqual(events(await resumed.text()), data.slice(1));
  const saved = await (await f.request(`/api/sessions/${session.id}`)).json();
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[0].role, 'user');
  assert.equal(saved.messages[1].content, content);
  assert.equal(saved.messages[1].status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'sessions.json'), 'utf8')), [saved]);
  assert.deepEqual(await readdir(f.dir), ['sessions.json']);
  const second = await start(f.dir);
  try {
    const listing = await (await fetch(second.base + '/api/sessions')).json();
    assert.deepEqual(listing.sessions, [saved]);
  } finally { await stop(second.server); }
});

test('same-session exclusion, cancellation, late events and next run', async t => {
  const f = await fixture(t);
  const session = await newSession(f);
  const { runId } = await (await f.request(`/api/sessions/${session.id}/messages`, { text: '测试取消' })).json();
  assert.equal((await f.request(`/api/sessions/${session.id}/messages`, { text: '并发' })).status, 409);
  const stream = await f.request(`/api/runs/${runId}/events`);
  const done = stream.text();
  const cancelled = await f.request(`/api/runs/${runId}/cancel`, {});
  assert.equal((await cancelled.json()).status, 'cancelled');
  const data = events(await done);
  assert.deepEqual(data.at(-2), { type: 'status', status: 'cancelled' });
  assert.deepEqual(data.at(-1), { type: 'done' });
  assert.deepEqual(events(await (await f.request(`/api/runs/${runId}/events`)).text()), data);
  assert.equal((await f.request(`/api/runs/${runId}/cancel`, {})).status, 200);
  const next = await f.request(`/api/sessions/${session.id}/messages`, { text: '第二轮' });
  assert.equal(next.status, 202);
  const nextId = (await next.json()).runId;
  assert.notEqual(nextId, runId);
  await f.request(`/api/runs/${nextId}/cancel`, {});
  const stored = JSON.parse(await readFile(path.join(f.dir, 'sessions.json'), 'utf8'));
  assert.equal(stored[0].messages.length, 4);
  assert.equal(stored[0].messages[1].status, 'cancelled');
});

test('input limits, malformed requests, missing routes and static whitelist', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 2, { title: '' }, { title: 4 }, { title: 'a'.repeat(201) }, { projectPath: false }]) {
    assert.equal((await f.request('/api/sessions', value)).status, 400);
  }
  assert.equal((await f.request('/api/sessions', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.request('/api/sessions', undefined, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.request('/api/sessions', { title: 'a'.repeat(40_000) })).status, 413);
  const session = await newSession(f);
  for (const text of ['', '  ', null, 12, 'x'.repeat(8001), '\0']) {
    assert.equal((await f.request(`/api/sessions/${session.id}/messages`, { text })).status, 400);
  }
  for (const route of ['/api/sessions/missing', '/api/runs/missing/events', '/server.mjs', '/data/sessions.json', '/renderer/app.js', '/%2e%2e/server.mjs']) {
    assert.equal((await f.request(route)).status, 404);
  }
  assert.equal((await f.request('/api/config', {})).status, 405);
  const { runId } = await (await f.request(`/api/sessions/${session.id}/messages`, { text: 'ok' })).json();
  assert.equal((await f.request(`/api/runs/${runId}/events`, undefined, { headers: { 'Last-Event-ID': '-1' } })).status, 400);
  await f.request(`/api/runs/${runId}/cancel`, {});
});

test('Host and Origin checks reject cross-site localhost writes', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: 'evil.example' },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: 'http://127.0.0.1:19387' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    // Native fetch normalizes Host; use http.request to exercise exact wire headers.
    const status = await new Promise((resolve, reject) => {
      const request = http.request(f.base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ title: 'blocked' }));
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await f.request('/api/sessions', { title: 'same origin' }, { headers: { 'Content-Type': 'application/json', Origin: f.base } })).status, 201);
  assert.equal((await (await f.request('/api/sessions')).json()).sessions.length, 1);
});

test('shutdown finalizes active runs and startup rejects corrupt data and non-demo mode', async t => {
  const f = await fixture(t);
  const session = await newSession(f);
  const { runId } = await (await f.request(`/api/sessions/${session.id}/messages`, { text: 'close' })).json();
  const response = await f.request(`/api/runs/${runId}/events`);
  const stream = response.text();
  await stop(f.server);
  assert.equal(events(await stream).at(-2).status, 'cancelled');
  // Keep fixture cleanup valid after testing close.
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  assert.throws(() => createApp({ dataDir: f.dir, mode: 'live' }), /Unsupported mode/);
  // The three supported modes are demo, claude and agent. Each still refuses to
  // start without what it needs.
  assert.throws(() => createApp({ dataDir: f.dir, mode: 'claude' }), /needs an explicit CLAUDE_EXECUTABLE/);
  assert.throws(() => createApp({ dataDir: f.dir, mode: 'agent' }), /agent mode needs an agent configuration/);
  await writeFile(path.join(f.dir, 'sessions.json'), 'broken');
  assert.throws(() => createApp({ dataDir: f.dir }), SyntaxError);
});
