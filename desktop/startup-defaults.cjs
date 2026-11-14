'use strict';
const crypto = require('node:crypto');
const DERIVED = 'CLAUDE_REPLICA_DERIVED_DEFAULTS';
const KEYS = ['CLAUDE_VIEW', 'MODE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_AGENT_MODEL'];
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function derivedDefaults(env) {
  try {
    const raw = env[DERIVED];
    if (!raw || raw.length > 2048) return {};
    const parsed = JSON.parse(raw);
    return Object.fromEntries(KEYS.filter(key => typeof parsed?.[key] === 'string' && /^[a-f0-9]{64}$/.test(parsed[key])).map(key => [key, parsed[key]]));
  } catch { return {}; }
}
function clearStartupDefaultsForRelaunch(env = process.env) {
  for (const [key, hash] of Object.entries(derivedDefaults(env))) {
    if (env[key] !== undefined && digest(env[key]) === hash) delete env[key];
  }
  delete env[DERIVED];
}

// The executable must apply the same provider defaults as the development launcher.
// Explicit environment values stay authoritative; no credentials are bundled.
function applyStartupDefaults(env = process.env, resolve = require('./gateway-source.cjs').resolveGateway,
  resolveRuntime = require('./gateway-runtime-settings.cjs').resolveGatewayRuntimeSettings) {
  const before = Object.fromEntries(KEYS.map(key => [key, env[key]]));
  const inherited = derivedDefaults(env);
  const gateway = resolve(env);
  const sameEndpoint = (left, right) => {
    if (!left || !right) return false;
    try { return new URL(left).href.replace(/\/$/, '') === new URL(right).href.replace(/\/$/, ''); }
    catch { return false; }
  };
  const profileMatches = !env.ANTHROPIC_BASE_URL || sameEndpoint(env.ANTHROPIC_BASE_URL, gateway.baseUrl);
  env.CLAUDE_VIEW ||= 'frontend';
  env.MODE ||= 'agent';
  if (!env.ANTHROPIC_BASE_URL && gateway.baseUrl) env.ANTHROPIC_BASE_URL = gateway.baseUrl;
  if (profileMatches && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY && gateway.apiKey) env.ANTHROPIC_AUTH_TOKEN = gateway.apiKey;
  if (!env.CLAUDE_AGENT_MODEL) {
    const model = env.ANTHROPIC_MODEL || (profileMatches && gateway.model);
    if (model) env.CLAUDE_AGENT_MODEL = model;
  }
  if (!env.CLAUDE_AGENT_MODEL) {
    const runtime = resolveRuntime({ env, gateway });
    if (runtime.model) env.CLAUDE_AGENT_MODEL = runtime.model;
  }
  for (const key of KEYS) {
    if (env[key] !== undefined && before[key] !== env[key]) inherited[key] = digest(env[key]);
    else if (inherited[key] && digest(env[key]) !== inherited[key]) delete inherited[key];
  }
  if (Object.keys(inherited).length) env[DERIVED] = JSON.stringify(inherited);
  else delete env[DERIVED];
  return env;
}

module.exports = { applyStartupDefaults, clearStartupDefaultsForRelaunch };
