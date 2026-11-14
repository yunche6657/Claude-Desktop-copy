'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CONFIG_BYTES = 65536;
const MAX_PREFIX_BYTES = 128;
const MAX_RULES = 128;

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw new Error('Invalid gateway runtime baseURL');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid gateway runtime baseURL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new Error('Invalid gateway runtime baseURL');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function validateMode(mode) {
  if (mode !== 'none' && mode !== 'system-first') throw new Error('Unsupported CLAUDE_CCB_GATEWAY_ADAPTER');
  return mode;
}

function validatePrefix(value) {
  if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PREFIX_BYTES || value.includes('\0'))) {
    throw new Error('Invalid gateway runtime systemContextPrefix');
  }
  return value;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['version', 'rules'].includes(k)) || config.version !== 1 || !Array.isArray(config.rules) || config.rules.length > MAX_RULES) {
    throw new Error('Invalid gateway runtime configuration');
  }
  const seen = new Set();
  return config.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(k => !['baseURL', 'model', 'adapter', 'systemContextPrefix'].includes(k))) throw new Error('Invalid gateway runtime rule');
    const baseURL = normalizeBaseUrl(rule.baseURL);
    if (rule.model !== undefined && (typeof rule.model !== 'string' || !rule.model || rule.model !== rule.model.trim() || rule.model.length > 512)) throw new Error('Invalid gateway runtime model');
    const adapter = validateMode(rule.adapter);
    const systemContextPrefix = validatePrefix(rule.systemContextPrefix);
    const key = JSON.stringify([baseURL, rule.model ?? null]);
    if (seen.has(key)) throw new Error('Duplicate gateway runtime rule');
    seen.add(key);
    return { baseURL, model: rule.model, adapter, systemContextPrefix };
  });
}

function readRules(file) {
  let data;
  try { data = fs.readFileSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read gateway runtime configuration', { cause: error });
  }
  if (data.length > MAX_CONFIG_BYTES) throw new Error('Gateway runtime configuration exceeds size limit');
  let parsed;
  try { parsed = JSON.parse(data.toString('utf8')); } catch (error) { throw new Error('Invalid gateway runtime configuration JSON', { cause: error }); }
  return validateConfig(parsed);
}

function isPackagedApp(appRoot, resourcesPath) {
  if (typeof appRoot !== 'string' || typeof resourcesPath !== 'string' || !appRoot || !resourcesPath) return false;
  const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const root = comparable(appRoot);
  return root === comparable(path.join(resourcesPath, 'app.asar')) || root === comparable(path.join(resourcesPath, 'app'));
}

function resolveGatewayRuntimeSettings({ env = process.env, gateway = {}, appRoot = path.resolve(__dirname, '..'), resourcesPath = process.resourcesPath } = {}) {
  const upstreamBaseUrl = env.ANTHROPIC_BASE_URL || gateway.baseUrl || '';
  let gatewayModel;
  if (gateway.model && (!env.ANTHROPIC_BASE_URL || (gateway.baseUrl && normalizeBaseUrl(env.ANTHROPIC_BASE_URL) === normalizeBaseUrl(gateway.baseUrl)))) gatewayModel = gateway.model;
  const model = env.CLAUDE_AGENT_MODEL || env.ANTHROPIC_MODEL || gatewayModel || undefined;
  if (Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CCB_GATEWAY_ADAPTER')) {
    const adapter = validateMode(env.CLAUDE_CCB_GATEWAY_ADAPTER);
    const systemContextPrefix = validatePrefix(env.CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX);
    if (adapter !== 'none' && !upstreamBaseUrl) throw new Error('CCB gateway adapter requires ANTHROPIC_BASE_URL');
    if (adapter !== 'none') normalizeBaseUrl(upstreamBaseUrl);
    return { adapter, systemContextPrefix, model, source: 'environment', upstreamBaseUrl };
  }
  const file = path.join(env.CLAUDE_WORKSPACE || process.cwd(), '.data', 'gateway-runtime.json');
  let rules = readRules(file), ruleSource = 'workspace';
  if (rules === null && isPackagedApp(appRoot, resourcesPath)) {
    rules = readRules(path.join(resourcesPath, 'gateway-runtime.json'));
    ruleSource = 'deployment';
  }
  rules ||= [];
  if (!upstreamBaseUrl) return { adapter: 'none', systemContextPrefix: undefined, model, source: 'default', upstreamBaseUrl };
  const normalized = normalizeBaseUrl(upstreamBaseUrl);
  const matches = rules.filter(rule => rule.baseURL === normalized && (model ? rule.model === model : true));
  if (matches.length > 1) throw new Error('Ambiguous gateway runtime rules for gateway without model');
  if (!matches.length) return { adapter: 'none', systemContextPrefix: undefined, model, source: 'default', upstreamBaseUrl };
  const rule = matches[0];
  const prefixOverride = Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX');
  return { adapter: rule.adapter, systemContextPrefix: prefixOverride ? validatePrefix(env.CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX) : rule.systemContextPrefix, model: model || rule.model, source: prefixOverride ? 'environment' : ruleSource, upstreamBaseUrl };
}

module.exports = { resolveGatewayRuntimeSettings, validateGatewayRuntimeConfig: validateConfig, normalizeBaseUrl, MAX_PREFIX_BYTES };
