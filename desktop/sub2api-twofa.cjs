'use strict';

// Main-process only. Do not forward this client's job/credential objects to a renderer.
// Wire contract: ranxi2001/sub2api production frontend/src/api/admin/accountTokenGuard.ts.
const MAX_BATCH = 100;
const MAX_TOTAL_MS = 300_000;
const MAX_REQUEST_MS = 10_000;
const LOGIN_PATH = '/admin/account-ops/token-guard/two-fa-login';

function fault(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseTwoFALoginText(input) {
  if (typeof input !== 'string') throw fault('invalid_batch');
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_BATCH) throw fault('invalid_batch');
  const seen = new Set();
  return lines.map(line => {
    const parts = (line.includes('----') ? line.split('----') : line.split(',')).map(part => part.trim());
    const [email = '', password = '', mfa_secret = ''] = parts;
    const normalized = email.toLowerCase();
    if (parts.length !== 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || !mfa_secret || seen.has(normalized)) {
      throw fault('invalid_batch');
    }
    seen.add(normalized);
    return { email: normalized, password, mfa_secret };
  });
}

function apiBase(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('invalid_base_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('invalid_base_url');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/api\/v1$/.test(path) ? path : `${path}/api/v1`;
  return url.toString().replace(/\/$/, '');
}

// Race as well as abort: injected transports/sleeps must not defeat the deadline.
async function bounded(task, { signal, timeoutMs = MAX_REQUEST_MS } = {}) {
  if (signal?.aborted) throw fault('canceled');
  const controller = new AbortController();
  let timer, onAbort;
  const stop = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(fault('canceled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(fault('timed_out')); }, Math.max(0, timeoutMs));
  });
  try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

function validId(id) {
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x20\x7f]/.test(id)) throw fault('invalid_job');
  return encodeURIComponent(id);
}

function jobResult(body) {
  if (!body || typeof body !== 'object') throw fault('invalid_job');
  validId(body.id);
  if (!['running', 'succeeded', 'failed'].includes(body.status)) throw fault('invalid_job');
  const result = { id: body.id, status: body.status };
  if (body.status === 'succeeded' && body.credential && typeof body.credential === 'object' && !Array.isArray(body.credential)) result.credential = body.credential;
  return result;
}

function createSub2TwoFAClient({ baseUrl, adminToken }, deps = {}) {
  const base = apiBase(baseUrl);
  if (typeof adminToken !== 'string' || !adminToken.trim() || /[\r\n]/.test(adminToken)) throw fault('invalid_admin_token');
  const fetchImpl = deps.fetch || globalThis.fetch;
  async function request(path, method, body, options = {}) {
    try {
      return await bounded(async signal => {
        const response = await fetchImpl(`${base}${path}`, {
          method, signal, redirect: 'error',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw fault('request_failed');
        if (method === 'DELETE') return;
        const value = await response.json();
        if (value && typeof value === 'object' && Object.hasOwn(value, 'code')) {
          if (value.code !== 0) throw fault('request_failed');
          return value.data;
        }
        return value;
      }, { signal: options.signal, timeoutMs: Math.min(MAX_REQUEST_MS, options.timeoutMs ?? MAX_REQUEST_MS) });
    } catch (error) {
      // Never include a URL, upstream body, transport message, password or token.
      throw fault(['canceled', 'timed_out'].includes(error?.code) ? error.code : 'request_failed');
    }
  }
  return Object.freeze({
    async start({ input, ...options }) {
      const entries = parseTwoFALoginText(input);
      if (entries.length !== 1) throw fault('invalid_batch');
      return jobResult(await request(LOGIN_PATH, 'POST', { ...entries[0], credential_target: 'operations' }, options));
    },
    async poll({ id, ...options }) { return jobResult(await request(`${LOGIN_PATH}/${validId(id)}`, 'GET', undefined, options)); },
    async cancel({ id, ...options }) { await request(`${LOGIN_PATH}/${validId(id)}`, 'DELETE', undefined, options); },
    async createAccount({ email, credential, ...options }) {
      const account = await request('/admin/accounts', 'POST', {
        name: email, platform: 'openai', type: 'oauth', credentials: credential, concurrency: 1, priority: 50,
      }, options);
      const id = account?.id;
      if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw fault('invalid_account');
      return id;
    },
  });
}

function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(fault('canceled')); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Invoked only by an explicit import action. This function itself has no IPC/UI hook.
async function importTwoFA({ baseUrl, adminToken, input, signal: inputSignal }, deps = {}) {
  const entries = parseTwoFALoginText(input);
  const client = createSub2TwoFAClient({ baseUrl, adminToken }, deps);
  const signal = deps.signal || inputSignal;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || defaultSleep;
  const totalMs = Math.min(MAX_TOTAL_MS, Math.max(1, Number(deps.timeoutMs) || MAX_TOTAL_MS));
  const deadline = now() + totalMs;
  // Reserve bounded cleanup time inside the five-minute total budget.
  const activeDeadline = deadline - Math.min(MAX_REQUEST_MS, totalMs / 10);
  const results = [];
  let stopped;
  const options = () => {
    if (signal?.aborted) throw fault('canceled');
    const remaining = activeDeadline - now();
    if (remaining <= 0) throw fault('timed_out');
    return { signal, timeoutMs: Math.min(MAX_REQUEST_MS, remaining) };
  };
  try {
    for (const entry of entries) {
      const row = { email: entry.email, status: stopped || 'failed', accountId: null };
      results.push(row);
      if (stopped) continue;
      let job;
      try {
        job = await client.start({ input: `${entry.email}----${entry.password}----${entry.mfa_secret}`, ...options() });
        while (job.status === 'running') {
          const waitOptions = options();
          await bounded(s => sleep(Math.min(1000, waitOptions.timeoutMs), { signal: s }), waitOptions);
          const next = await client.poll({ id: job.id, ...options() });
          if (next.id !== job.id) throw fault('invalid_job');
          job = next;
        }
        if (job.status === 'failed') throw fault('login_failed');
        if (!job.credential || !Object.keys(job.credential).length) throw fault('missing_credential');
        row.accountId = await client.createAccount({ email: entry.email, credential: job.credential, ...options() });
        row.status = 'succeeded';
      } catch (error) {
        const code = ['canceled', 'timed_out', 'login_failed', 'missing_credential', 'invalid_job', 'invalid_account'].includes(error?.code) ? error.code : 'request_failed';
        row.status = ['canceled', 'timed_out'].includes(code) ? code : 'failed';
        row.error = code;
        if (row.status !== 'failed') stopped = row.status;
      } finally {
        // Independent signal: user cancellation must still delete the server job.
        if (job?.id) {
          try { await client.cancel({ id: job.id, timeoutMs: Math.max(0, Math.min(MAX_REQUEST_MS, deadline - now())) }); }
          catch { row.cleanupError = 'cleanup_failed'; }
          delete job.credential;
        }
        entry.password = '';
        entry.mfa_secret = '';
      }
    }
    return { status: stopped || (results.every(row => row.status === 'succeeded') ? 'succeeded' : 'failed'), results };
  } finally {
    for (const entry of entries) { entry.password = ''; entry.mfa_secret = ''; }
  }
}

module.exports = { parseTwoFALoginText, createSub2TwoFAClient, importTwoFA };
