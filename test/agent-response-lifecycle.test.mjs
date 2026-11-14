import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { callMessages } = require('../desktop/agent.cjs');

async function fixture(action, check) {
  let received;
  const seen = new Promise(resolve => { received = resolve; });
  const server = http.createServer((req,res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    received();
    action?.(req,res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-key', model: 'm', messages: [] };
  try { await check(options, seen); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('body stayed pending after deadline')),700);})]); }
  finally { clearTimeout(timer); }
}

test('a response that sends headers but never ends still obeys the request deadline', async () => {
  await fixture(null, async options => {
    await assert.rejects(bounded(callMessages({ ...options, timeoutMs: 80 })), e=>e.code==='aborted'&&/timed out/.test(e.message));
  });
});

test('cancelling after headers interrupts the pending body read', async () => {
  await fixture(null, async (options, seen) => {
    const controller = new AbortController();
    const pending = callMessages({ ...options, timeoutMs: 5000, signal: controller.signal });
    await seen;
    // Give fetch time to hand its Response back before cancelling its body.
    await new Promise(resolve=>setTimeout(resolve,25));
    controller.abort();
    await assert.rejects(bounded(pending), e=>e.code==='aborted'&&/cancelled/.test(e.message));
  });
});

test('a connection lost during the response body keeps its network classification', async () => {
  await fixture((_req,res)=>setTimeout(()=>res.destroy(),25), async options => {
    await assert.rejects(bounded(callMessages({ ...options, timeoutMs: 5000 })), e=>e.code==='network');
  });
});
