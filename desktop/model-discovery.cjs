'use strict';

const http = require('node:http');
const https = require('node:https');
const { normalizeBaseUrl } = require('./base-url.cjs');

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function modelsUrl(baseUrl) {
  const url = normalizeBaseUrl(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(?:chat\/completions|responses|messages|models)$/i, '');
  pathname = pathname.replace(/(?:\/v1)+$/i, '/v1');
  url.pathname = /\/v1$/i.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`;
  url.search = '';
  url.hash = '';
  return url;
}

// Messages compatibility prefixes need not expose a Models API. Keep discovery
// on the configured origin, and never change the saved inference URL/protocol.
function modelEndpoints(options = {}) {
  const primary = modelsUrl(options?.baseUrl);
  const anthropic = String(options?.apiType || '').toLowerCase().includes('anthropic');
  if (!anthropic) return [{ url: primary, bearer: true }];
  const match = primary.pathname.match(/^(.*)\/anthropic\/v1\/models$/i);
  if (!match) return [{ url: primary, bearer: false }];
  const sibling = new URL(primary);
  sibling.pathname = `${match[1]}/models`;
  const versioned = new URL(primary);
  versioned.pathname = `${match[1]}/v1/models`;
  const fallback = [{ url: sibling, bearer: true }, { url: versioned, bearer: true }];
  // DeepSeek documents /anthropic for Messages and /models for discovery.
  if (primary.hostname === 'api.deepseek.com' && match[1] === '') return fallback;
  return [{ url: primary, bearer: false }, ...fallback];
}

const failure = error => ({ ok: false, models: [], error });

async function discoverModels(options = {}) {
  let endpoints;
  try { endpoints = modelEndpoints(options); }
  catch { return discoverModelsAt(options); }
  let result;
  for (const endpoint of endpoints) {
    result = await discoverModelsAt(options, endpoint);
    // Only a missing/unsupported route warrants trying the sibling Models API.
    // Authentication, rate limits, redirects and server failures stay explicit.
    if (result.ok || !/HTTP (404|405)\b/.test(result.error || '')) return result;
  }
  return result;
}

/** Query only the supplied provider; no settings, cache, logs or credentials are persisted. */
async function discoverModelsAt(options = {}, endpoint) {
  let url;
  let apiKey;
  let anthropic;
  try {
    url = endpoint?.url || modelsUrl(options?.baseUrl);
    apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
    if (apiKey.startsWith('__sealed__:')) return failure('此凭据是其他应用加密保存的封装，请在复刻版中重新填写原始 API 密钥。');
    anthropic = String(options?.apiType || '').toLowerCase().includes('anthropic');
    if (/[\r\n]/.test(apiKey)) return failure('API key contains invalid characters.');
  } catch {
    return failure('服务 URL 无效：请填写主机与端口（例如 http://127.0.0.1:7863），且不要包含用户名或密码。');
  }
  const headers = { accept: 'application/json' };
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
    if (endpoint?.bearer && apiKey) headers.authorization = `Bearer ${apiKey}`;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return new Promise(resolve => {
    let settled = false;
    let request;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      finish(failure('Model discovery timed out after 10 seconds.'));
      request?.destroy();
    }, TIMEOUT_MS);
    try {
      request = (url.protocol === 'https:' ? https : http).get(url, { headers }, response => {
        // Do not follow redirects with the user's authentication headers.
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = response.statusCode === 401
            ? '认证失败（HTTP 401）：当前服务未接受此 API 密钥，请检查 URL 与密钥是否属于同一服务，以及凭据是否已失效。'
            : response.statusCode === 403
              ? '访问被禁止（HTTP 403）：当前密钥没有此服务的模型列表权限。'
              : `获取模型失败（HTTP ${response.statusCode}）。`;
          finish(failure(error));
          response.destroy();
          return;
        }
        if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
          finish(failure('Model discovery response exceeds the 2 MB limit.'));
          response.destroy();
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(failure('Model discovery response exceeds the 2 MB limit.'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(failure('Model discovery connection failed.')));
        response.on('aborted', () => finish(failure('Model discovery connection was interrupted.')));
        response.on('end', () => {
          if (settled) return;
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(failure('Model discovery returned invalid JSON.')); return; }
          const rows = Array.isArray(payload?.data) ? payload.data : payload?.models;
          if (!Array.isArray(rows)) {
            finish(failure('Model discovery response has no data or models array.'));
            return;
          }
          const models = [];
          const seen = new Set();
          const redact = value => apiKey ? value.split(apiKey).join('[redacted]') : value;
          for (const row of rows) {
            if (!row || typeof row.id !== 'string' || !row.id.trim()) continue;
            const id = redact(row.id.trim());
            if (seen.has(id)) continue;
            seen.add(id);
            const name = [row.name, row.display_name].find(value => typeof value === 'string' && value.trim());
            const metadata = require('./model-capabilities.cjs').normalizeModelMetadata(row);
            models.push({ ...metadata, id, name: name ? redact(name.trim()) : id });
          }
          finish(models.length ? { ok: true, models, error: null } : failure('No available models were returned by this provider.'));
        });
      });
      request.on('error', () => finish(failure('Model discovery connection failed.')));
    } catch {
      finish(failure('Model discovery request failed.'));
      request?.destroy();
    }
  });
}

module.exports = { discoverModels, modelsUrl, modelEndpoints, TIMEOUT_MS, MAX_RESPONSE_BYTES };
