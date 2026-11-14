import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseTwoFALoginText, createSub2TwoFAClient, importTwoFA } = require('../desktop/sub2api-twofa.cjs');

const input = 'A@example.com----password-secret----MFA-SECRET';
const connection = { baseUrl: 'http://localhost:8080', adminToken: 'ADMIN-SECRET' };
const credential = { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET' };
function fixture(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      assert.notEqual(value, undefined, `unexpected ${options.method}`);
      return { ok: value.httpStatus ? value.httpStatus < 400 : true, async json() { return { code: 0, data: value }; } };
    },
    sleep: async () => {},
  };
}
function noSecrets(value) {
  const output = JSON.stringify(value);
  for (const secret of ['password-secret', 'MFA-SECRET', 'ADMIN-SECRET', 'ACCESS-SECRET', 'REFRESH-SECRET']) assert.equal(output.includes(secret), false);
}

test('strict parser matches official separator, CSV, normalization and batch limits', () => {
  assert.deepEqual(parseTwoFALoginText(`\n${input}\r\nb@example.com,pw,mfa\n`), [
    { email: 'a@example.com', password: 'password-secret', mfa_secret: 'MFA-SECRET' },
    { email: 'b@example.com', password: 'pw', mfa_secret: 'mfa' },
  ]);
  for (const value of ['', null, 'bad,pw,key', 'a@example.com,pw', 'a@example.com,pw,key,extra', `${input}\na@example.com,pw,key`, Array.from({ length: 101 }, (_, i) => `a${i}@example.com,pw,key`).join('\n')]) {
    assert.throws(() => parseTwoFALoginText(value), { message: 'invalid_batch' });
  }
  assert.equal(parseTwoFALoginText(Array.from({ length: 100 }, (_, i) => `a${i}@example.com,pw,key`).join('\n')).length, 100);
});

test('successful sequential batch posts operations login, polls, creates OpenAI account and deletes jobs', async () => {
  const deps = fixture([
    { id: 'job-1', status: 'running' }, { id: 'job-1', status: 'succeeded', credential }, { id: 12 }, {},
    { id: 'job-2', status: 'succeeded', credential: { access_token: 'ACCESS-SECRET' } }, { id: 13 }, {},
  ]);
  const result = await importTwoFA({ ...connection, input: `${input}\nb@example.com,pw,key` }, deps);
  assert.deepEqual(result, { status: 'succeeded', results: [
    { email: 'a@example.com', status: 'succeeded', accountId: 12 },
    { email: 'b@example.com', status: 'succeeded', accountId: 13 },
  ] });
  assert.deepEqual(deps.calls.map(call => call.method), ['POST', 'GET', 'POST', 'DELETE', 'POST', 'POST', 'DELETE']);
  assert.equal(deps.calls[0].url, 'http://localhost:8080/api/v1/admin/account-ops/token-guard/two-fa-login');
  assert.deepEqual(deps.calls[0].body, { email: 'a@example.com', password: 'password-secret', mfa_secret: 'MFA-SECRET', credential_target: 'operations' });
  assert.deepEqual(deps.calls[2].body, { name: 'a@example.com', platform: 'openai', type: 'oauth', credentials: credential, concurrency: 1, priority: 50 });
  assert.equal(deps.calls.every(call => call.headers.Authorization === 'Bearer ADMIN-SECRET'), true);
  assert.equal(deps.calls.every(call => call.redirect === 'error'), true);
  noSecrets(result);
});

test('failed login never creates an account, cleans job and continues next row', async () => {
  const deps = fixture([{ id: 'one', status: 'failed', error: 'password-secret' }, {}, { id: 'two', status: 'succeeded', credential }, { id: 2 }, {}]);
  const result = await importTwoFA({ ...connection, input: `${input}\nb@example.com,pw,key` }, deps);
  assert.equal(result.results[0].error, 'login_failed');
  assert.equal(result.results[1].accountId, 2);
  assert.equal(deps.calls.filter(call => call.url.endsWith('/accounts')).length, 1);
  noSecrets(result);
});

test('transport/account errors are redacted and cleanup errors preserve imported account', async () => {
  const deps = fixture([{ id: 'job', status: 'succeeded', credential }, new Error('https://password-secret@host/?token=ACCESS-SECRET'), new Error('MFA-SECRET')]);
  const result = await importTwoFA({ ...connection, input }, deps);
  assert.equal(result.results[0].error, 'request_failed');
  assert.equal(result.results[0].cleanupError, 'cleanup_failed');
  noSecrets(result);
  const successDeps = fixture([{ id: 'job', status: 'succeeded', credential }, { id: 1 }, new Error('ADMIN-SECRET')]);
  const success = await importTwoFA({ ...connection, input }, successDeps);
  assert.equal(success.results[0].status, 'succeeded');
  assert.equal(success.results[0].accountId, 1);
  assert.equal(success.results[0].cleanupError, 'cleanup_failed');
});

test('abort during polling still DELETEs job with independent signal and skips remaining accounts', async () => {
  const controller = new AbortController();
  const deps = fixture([{ id: 'job', status: 'running' }, {}]);
  deps.sleep = async () => { controller.abort(); };
  const result = await importTwoFA({ ...connection, input: `${input}\nb@example.com,pw,key`, signal: controller.signal }, deps);
  assert.deepEqual(result.results.map(row => row.status), ['canceled', 'canceled']);
  assert.deepEqual(deps.calls.map(call => call.method), ['POST', 'DELETE']);
  assert.equal(deps.calls[1].signal.aborted, false);
  noSecrets(result);
});

test('total timeout stops polling, cleans up, and never creates an account', async () => {
  let time = 0;
  const deps = fixture([{ id: 'job', status: 'running' }, {}]);
  deps.now = () => time;
  deps.timeoutMs = 100;
  deps.sleep = async () => { time = 95; };
  const result = await importTwoFA({ ...connection, input }, deps);
  assert.equal(result.status, 'timed_out');
  assert.deepEqual(deps.calls.map(call => call.method), ['POST', 'DELETE']);
});

test('hung transport is bounded even when it ignores signal', async () => {
  const started = Date.now();
  const result = await importTwoFA({ ...connection, input }, { timeoutMs: 30, fetch: () => new Promise(() => {}) });
  assert.equal(result.status, 'timed_out');
  assert.ok(Date.now() - started < 2000);
});

test('missing credentials and mismatched job ids fail closed and DELETE original job', async () => {
  const deps = fixture([{ id: 'original', status: 'running' }, { id: 'other', status: 'succeeded', credential }, {}]);
  const result = await importTwoFA({ ...connection, input }, deps);
  assert.equal(result.results[0].error, 'invalid_job');
  assert.ok(deps.calls[2].url.endsWith('/original'));
  const missing = fixture([{ id: 'job', status: 'succeeded' }, {}]);
  assert.equal((await importTwoFA({ ...connection, input }, missing)).results[0].error, 'missing_credential');
});

test('client accepts base API prefix once, rejects URL credentials/query and sanitizes HTTP/envelope failures', async () => {
  const deps = fixture([{ id: 'one', status: 'running' }, {}]);
  const client = createSub2TwoFAClient({ ...connection, baseUrl: 'http://localhost:8080/prefix/api/v1/' }, deps);
  assert.deepEqual(await client.start({ input }), { id: 'one', status: 'running' });
  await client.cancel({ id: 'one' });
  assert.ok(deps.calls[0].url.startsWith('http://localhost:8080/prefix/api/v1/admin/'));
  for (const baseUrl of ['bad password-secret', 'http://user:password-secret@localhost', 'http://localhost?token=ACCESS-SECRET', 'file:///secret']) {
    assert.throws(() => createSub2TwoFAClient({ ...connection, baseUrl }), { message: 'invalid_base_url' });
  }
  const bad = createSub2TwoFAClient(connection, { fetch: async () => ({ ok: true, json: async () => ({ code: 7, message: 'ACCESS-SECRET' }) }) });
  await assert.rejects(bad.start({ input }), { message: 'request_failed' });
  const httpFail = createSub2TwoFAClient(connection, fixture([{ httpStatus: 401 }]));
  await assert.rejects(httpFail.start({ input }), { message: 'request_failed' });
});

test('real localhost HTTP fixture exercises envelope and end-to-end wire behavior', async t => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    calls.push({ path: request.url, method: request.method, body: raw ? JSON.parse(raw) : null });
    response.setHeader('Content-Type', 'application/json');
    const data = request.method === 'DELETE' ? {} : request.url.endsWith('/accounts') ? { id: 42 } : { id: 'local-job', status: 'succeeded', credential };
    response.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await importTwoFA({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'ADMIN-SECRET', input });
  assert.equal(result.results[0].accountId, 42);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'DELETE']);
  noSecrets(result);
});
