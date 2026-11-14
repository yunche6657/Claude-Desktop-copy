'use strict';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
class SubscriptionError extends Error {}

function httpUrl(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw new SubscriptionError('请输入有效的 HTTP/HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SubscriptionError('URL 仅支持 HTTP/HTTPS，且应使用查询参数传递订阅标识');
  }
  url.hash = '';
  return url;
}

function normalizeModels(value, { desktop = false } = {}) {
  let entries = value;
  if (object(entries)) entries = Object.entries(entries).map(([id, model]) => object(model) ? { ...model, id } : { id, name: model });
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1000) throw new SubscriptionError('订阅需要包含 1 至 1000 个模型');
  const ids = new Set();
  return entries.map(entry => {
    const model = typeof entry === 'string' ? { id: entry } : entry;
    if (!object(model)) throw new SubscriptionError('订阅模型格式有误');
    const id = text(model.id) || (desktop ? text(model.model) || text(model.name) : '');
    if (!id || ids.has(id)) throw new SubscriptionError('订阅模型 ID 为空或重复');
    ids.add(id);
    // Only transfer model metadata understood by configuration consumers.
    const result = { id };
    const capability = require('./model-capabilities.cjs').explicitCapability(model);
    if (capability) result.capabilities = capability;
    for (const field of ['name', 'displayName']) if (text(model[field])) result[field] = text(model[field]);
    for (const field of ['contextWindow', 'maxTokens']) {
      if (model[field] !== undefined) {
        if (!Number.isSafeInteger(model[field]) || model[field] <= 0) throw new SubscriptionError('订阅模型容量格式有误');
        result[field] = model[field];
      }
    }
    return result;
  });
}

function normalizeEntry(entry, fallbackName) {
  if (!object(entry)) throw new SubscriptionError('订阅配置应为对象');
  const source = object(entry.config) ? entry.config : entry;
  const baseUrl = source.inferenceGatewayBaseUrl ?? source.baseURL ?? source.baseUrl ?? source.base_url;
  const endpoint = httpUrl(baseUrl).href.replace(/\/$/, '');
  const apiKey = text(source.inferenceGatewayApiKey ?? source.inferenceGatewayAPIKey ?? source.apiKey ?? source.api_key);
  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) throw new SubscriptionError('订阅配置缺少有效 API Key；apiKeyEnv 引用需先由订阅服务解析');
  const name = text(entry.name) || text(source.displayName) || text(source.deploymentDisplayName) || fallbackName || '模型订阅';
  const aliases = { 'openai-completions': 'openai-chat', 'openai-chat-completions': 'openai-chat', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic' };
  const suppliedType = source.inferenceApiType ?? source.apiType ?? source.api ?? 'anthropic';
  const apiType = aliases[suppliedType] || suppliedType;
  if (!['anthropic', 'openai-chat', 'openai-responses'].includes(apiType)) throw new SubscriptionError('订阅接口类型不受支持');
  const config = {
    inferenceApiType: apiType,
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: endpoint,
    inferenceGatewayApiKey: apiKey,
    inferenceModels: normalizeModels(source.inferenceModels ?? source.models, { desktop: source.inferenceModels != null }),
    deploymentDisplayName: name,
  };
  const selectedModel = text(source.model) || text(source.defaultModel);
  if (selectedModel) {
    const index = config.inferenceModels.findIndex(model => model.id === selectedModel);
    if (index < 0) throw new SubscriptionError('订阅默认模型未包含在模型列表中');
    config.model = selectedModel;
    if (index > 0) config.inferenceModels.unshift(...config.inferenceModels.splice(index, 1));
  }
  if (object(source.inferenceModelCapabilities)) {
    const overrides = config.inferenceModels.flatMap(model => {
      if (!Object.hasOwn(source.inferenceModelCapabilities, model.id)) return [];
      const capability = require('./model-capabilities.cjs').explicitCapability(source.inferenceModelCapabilities[model.id]);
      return capability ? [[model.id, capability]] : [];
    });
    if (overrides.length) config.inferenceModelCapabilities = Object.fromEntries(overrides);
  }
  return { name, config };
}

/** DSH pi-ai uses a providers dictionary (baseURL, apiKeyEnv, models).
 * URL publishers must resolve credential references to inline apiKey values.
 * Native desktop profiles and named configs envelopes are also accepted.
 */
function parseModelSubscription(document) {
  let entries;
  if (Array.isArray(document)) entries = document.map(entry => [undefined, entry]);
  else if (object(document)) {
    const providers = document.providers ?? (object(document.config) ? document.config.providers : undefined);
    if (providers !== undefined) {
      if (!object(providers)) throw new SubscriptionError('订阅 providers 应为按路由命名的对象');
      entries = Object.entries(providers);
    } else if (Array.isArray(document.configs)) entries = document.configs.map(entry => [undefined, entry]);
    else entries = [[undefined, document]];
  } else throw new SubscriptionError('订阅 JSON 应为配置对象或数组');
  if (entries.length === 0 || entries.length > 100) throw new SubscriptionError('订阅需要包含 1 至 100 个配置');
  return entries.map(([name, entry]) => normalizeEntry(entry, name));
}

/** Fetch and preview only. Never writes config files or changes the active profile. */
async function importModelSubscription({ url } = {}, { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, fetchImpl = globalThis.fetch } = {}) {
  let reader;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let current = httpUrl(url);
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(current.href, { signal: controller.signal, redirect: 'manual', headers: { accept: 'application/json' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 5) throw new SubscriptionError('订阅重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new SubscriptionError('订阅重定向缺少目标');
      // Validate every redirect before a network request, including protocol and userinfo.
      let next;
      try { next = new URL(location, current).href; } catch { throw new SubscriptionError('订阅重定向格式有误'); }
      current = httpUrl(next);
    }
    if (!response.ok) { await response.body?.cancel(); throw new SubscriptionError(`订阅请求失败（HTTP ${response.status}）`); }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new SubscriptionError('订阅响应超过大小限制'); }
    if (!response.body) throw new SubscriptionError('订阅响应为空');
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new SubscriptionError('订阅响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
    let document;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      document = JSON.parse(decoded);
    } catch { throw new SubscriptionError('订阅响应应为有效的 UTF-8 JSON'); }
    return { ok: true, configs: parseModelSubscription(document) };
  } catch (error) {
    // Never expose transport exception text, response bodies, or URLs: query strings may contain keys.
    const known = error instanceof SubscriptionError;
    return { ok: false, configs: [], error: timedOut ? '订阅请求超时' : known ? error.message : '订阅请求失败，请检查地址与网络' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { await reader?.cancel(); } catch {}
  }
}

module.exports = { importModelSubscription, parseModelSubscription, MAX_BYTES, TIMEOUT_MS };
