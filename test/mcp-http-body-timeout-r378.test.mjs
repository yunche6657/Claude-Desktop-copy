import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const { HttpConnection } = createRequire(import.meta.url)('../desktop/mcp-host.cjs');

async function fixture() {
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'fixture-session' });
    res.write('event: message\ndata: ');
    bodyStarted();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, started, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('HTTP request deadline covers a response body that never finishes', async () => {
  const f = await fixture();
  try {
    const connection = new HttpConnection({name:'fixture', url:f.url}, {timeoutMs:100});
    await assert.rejects(connection.request('tools/list'), error => error.code === 'timeout');
    await connection.stop();
  } finally { await f.close(); }
});

test('stopping an HTTP connection aborts an in-flight response body', async () => {
  const f = await fixture();
  try {
    const connection = new HttpConnection({name:'fixture', url:f.url}, {timeoutMs:5000});
    const pending = connection.request('tools/list');
    const rejected = assert.rejects(pending, error => error.code === 'disconnected');
    await f.started;
    await connection.stop();
    await rejected;
  } finally { await f.close(); }
});
