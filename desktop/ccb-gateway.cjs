'use strict';

const http = require('node:http');
const https = require('node:https');
const { createMessageAccumulator } = require('./stream-message.cjs');

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function upstreamTarget(baseUrl, requestUrl) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new TypeError('upstreamBaseUrl must be an HTTP(S) base URL without credentials, query or fragment');
  const incoming = new URL(requestUrl, 'http://127.0.0.1');
  if (incoming.pathname !== '/v1/messages') throw new TypeError('unsupported path');
  const prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  base.pathname = `${prefix}/v1/messages`;
  base.search = incoming.search;
  return base;
}

function rewriteMessageRequest(body, systemContextPrefix = '') {
  if (typeof systemContextPrefix !== 'string' || systemContextPrefix.length > 128) throw new TypeError('Invalid system context prefix');
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages))
    throw new TypeError('messages must be an array');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new TypeError('stream must be a boolean');
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system))
    throw new TypeError('system must be a string or array');
  const result = { ...body, stream: true, messages: [...body.messages] };
  delete result.system;
  if (result.messages[0]?.role === 'system') {
    if (body.system !== undefined) {
      const blocks = value => Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }];
      result.messages[0] = { ...result.messages[0], content: [...blocks(body.system), ...blocks(result.messages[0].content)] };
    }
  } else result.messages.unshift({ role: 'system', content: body.system ?? '' });
  if (systemContextPrefix) {
    const first = { ...result.messages[0] };
    if (typeof first.content === 'string') first.content = systemContextPrefix + first.content;
    else {
      const blocks = [...first.content];
      const index = blocks.findIndex(block => block?.type === 'text' && typeof block.text === 'string');
      if (index >= 0) blocks[index] = { ...blocks[index], text: systemContextPrefix + blocks[index].text };
      else blocks.unshift({ type: 'text', text: systemContextPrefix });
      first.content = blocks;
    }
    result.messages[0] = first;
  }
  return result;
}

/**
 * Start an opt-in adapter for gateways requiring a leading system message.
 * The returned baseUrl has no /v1 suffix: set the CCB child's ANTHROPIC_BASE_URL to it.
 * stop() aborts outstanding requests and resolves after the listener closes.
 * Only POST /v1/messages is supported. Non-streaming calls aggregate complete SSE.
 */
async function startCcbGateway({ upstreamBaseUrl, host = '127.0.0.1', port = 0, systemContextPrefix = '',
  maxBodyBytes = 64 * 1024 * 1024, maxResponseBytes = 16 * 1024 * 1024,
  maxEventBytes = 2 * 1024 * 1024, timeoutMs = 600000, capabilityProfile } = {}) {
  if (typeof systemContextPrefix !== 'string' || systemContextPrefix.length > 128) throw new TypeError('Invalid system context prefix');
  if (!['127.0.0.1', '::1'].includes(host)) throw new TypeError('host must be a loopback address');
  upstreamTarget(upstreamBaseUrl, '/v1/messages');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new TypeError('invalid body limit or timeout');
  createMessageAccumulator({ maxBytes: maxResponseBytes, maxEventBytes });
  const connections = new Set();
  const active = new Set();
  let stopped = false;
  let stopPromise;
  const server = http.createServer((req, res) => {
    let upstream;
    let upstreamResponse;
    let finished = false;
    let timer;
    const complete = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active.delete(cancel);
    };
    const cancel = () => {
      complete();
      upstream?.destroy();
      upstreamResponse?.destroy();
      if (!res.writableEnded) res.destroy();
    };
    const fail = (status, code) => {
      if (finished) return;
      complete();
      upstream?.destroy();
      upstreamResponse?.destroy();
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'gateway_adapter_error', message: code } }));
      req.resume();
    };
    active.add(cancel);
    res.once('close', () => { if (!finished) cancel(); });
    req.once('aborted', cancel);
    req.once('error', cancel);
    if (stopped) { fail(503, 'adapter_stopping'); return; }
    let target;
    try { target = upstreamTarget(upstreamBaseUrl, req.url); }
    catch { fail(404, 'unsupported_path'); return; }
    if (req.method !== 'POST') { fail(405, 'post_required'); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      fail(415, 'compressed_request_not_supported'); return;
    }
    timer = setTimeout(() => fail(504, 'upstream_timeout'), timeoutMs);
    timer.unref?.();
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) { fail(413, 'request_too_large'); return; }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (finished) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'invalid_json'); return; }
      if (capabilityProfile !== undefined) {
        try {
          const profile = typeof capabilityProfile === 'function' ? capabilityProfile() : capabilityProfile;
          body = require('./anthropic-effort-gateway.cjs').normalizeAnthropicEffort(body, profile);
        } catch { fail(400, 'invalid_or_unsupported_reasoning_effort'); return; }
      }
      let rewritten;
      try { rewritten = Buffer.from(JSON.stringify(rewriteMessageRequest(body, systemContextPrefix))); }
      catch { fail(400, 'invalid_messages'); return; }
      const headers = forwardHeaders(req.headers);
      delete headers.host;
      delete headers['content-encoding'];
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(rewritten.length);
      if (body.stream !== true) headers['accept-encoding'] = 'identity';
      // Accept-Encoding remains untouched; Node HTTP forwards compressed bytes unchanged.
      const transport = target.protocol === 'https:' ? https : http;
      upstream = transport.request(target, { method: 'POST', headers }, response => {
        upstreamResponse = response;
        if (finished) { response.destroy(); return; }
        response.once('error', () => fail(502, 'upstream_body_error'));
        response.once('aborted', () => fail(502, 'upstream_body_aborted'));
        res.once('finish', complete);
        if (body.stream === true || response.statusCode < 200 || response.statusCode >= 300) {
          res.writeHead(response.statusCode, forwardHeaders(response.headers));
          // Streaming clients and HTTP errors retain the upstream body unchanged.
          response.pipe(res);
          return;
        }
        if (String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
          fail(502, 'upstream_not_event_stream'); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          fail(502, 'compressed_upstream_not_supported'); return;
        }
        const accumulator = createMessageAccumulator({ maxBytes: maxResponseBytes, maxEventBytes });
        response.on('data', chunk => {
          if (finished) return;
          try { accumulator.push(chunk); }
          catch (error) { fail(502, error.code || 'invalid_upstream_stream'); }
        });
        response.once('end', () => {
          if (finished) return;
          let output;
          try { output = Buffer.from(JSON.stringify(accumulator.finish())); }
          catch (error) { fail(502, error.code || 'invalid_upstream_stream'); return; }
          const responseHeaders = forwardHeaders(response.headers);
          delete responseHeaders['content-encoding'];
          responseHeaders['content-type'] = 'application/json; charset=utf-8';
          responseHeaders['content-length'] = String(output.length);
          res.writeHead(response.statusCode, responseHeaders);
          res.end(output);
        });
      });
      upstream.once('error', () => { if (!finished) fail(502, 'upstream_unreachable'); });
      upstream.end(rewritten);
    });
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListen); reject(error); };
    const onListen = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host);
  });
  // Keep a listener after startup; request errors are handled on their own streams.
  server.on('error', () => {});
  const address = server.address();
  return {
    baseUrl: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const cancel of active) cancel();
        for (const socket of connections) socket.destroy();
      });
      return stopPromise;
    },
  };
}

module.exports = { startCcbGateway, rewriteMessageRequest, upstreamTarget };
