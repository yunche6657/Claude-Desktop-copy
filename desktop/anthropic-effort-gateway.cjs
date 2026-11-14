'use strict';
const http = require('node:http');
const https = require('node:https');
const { EFFORT_VALUES, resolveModelCapabilities, currentCapabilityProfile } = require('./model-capabilities.cjs');
function normalizeAnthropicEffort(body, profile) {
  const effort = body?.output_config?.effort;
  if (effort == null) return body;
  if (!EFFORT_VALUES.includes(effort)) throw new Error('Invalid reasoning effort');
  const { supportedEfforts } = resolveModelCapabilities(body.model, profile);
  if (supportedEfforts.length) {
    if (!supportedEfforts.includes(effort)) throw new Error('Unsupported reasoning effort for selected model');
    return body;
  }
  const output_config = { ...body.output_config }; delete output_config.effort;
  const normalized = { ...body };
  if (Object.keys(output_config).length) normalized.output_config = output_config;
  else delete normalized.output_config;
  return normalized;
}
async function startAnthropicEffortGateway({ upstreamBaseUrl, capabilityProfile = currentCapabilityProfile } = {}) {
  const base = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid upstream URL');
  const sockets = new Set(), requests = new Set();
  const server = http.createServer(async (req, res) => {
    req.setTimeout(30000, () => req.destroy());
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      let payload = Buffer.concat(chunks);
      if (/\/messages(?:\?|$)/.test(req.url) && payload.length) {
        const profile = typeof capabilityProfile === 'function' ? capabilityProfile() : capabilityProfile;
        payload = Buffer.from(JSON.stringify(normalizeAnthropicEffort(JSON.parse(payload), profile)));
      }
      const url = new URL(base);
      const prefix = base.pathname.replace(/\/+$/, '');
      const incoming = new URL(req.url, 'http://localhost');
      url.pathname = prefix.endsWith('/v1') && incoming.pathname.startsWith('/v1/') ? prefix + incoming.pathname.slice(3) : prefix + incoming.pathname;
      url.search = incoming.search;
      const headers = { ...req.headers, host: url.host, 'content-length': payload.length };
      delete headers['transfer-encoding']; delete headers.connection;
      const upstream = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers }, response => {
        response.on('error', () => res.destroy());
        response.on('aborted', () => res.destroy());
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      requests.add(upstream); upstream.on('close', () => requests.delete(upstream));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.setTimeout(120000, () => upstream.destroy()); upstream.end(payload);
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid or unsupported reasoning effort' } }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let stopped;
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, stop() {
    return stopped ||= new Promise(resolve => { for (const request of requests) request.destroy(); server.close(resolve); for (const socket of sockets) socket.destroy(); });
  } };
}
module.exports = { startAnthropicEffortGateway, normalizeAnthropicEffort };
