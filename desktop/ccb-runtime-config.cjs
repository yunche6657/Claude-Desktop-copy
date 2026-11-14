'use strict';

// CCB speaks Anthropic messages. OpenAI profiles require a child-local adapter;
// Anthropic gateways retain the existing opt-in system-first adaptation.
async function prepareCcbRuntime({ env = process.env,
  gateway, appRoot, resourcesPath,
  startGateway = (...args) => require('./ccb-gateway.cjs').startCcbGateway(...args),
  startOpenAIGateway = (...args) => require('./openai-gateway.cjs').startOpenAIGateway(...args) } = {}) {
  const { resolveGateway, normaliseProfile } = require('./gateway-source.cjs');
  const { resolveGatewayRuntimeSettings, normalizeBaseUrl } = require('./gateway-runtime-settings.cjs');
  gateway ??= resolveGateway({ env });
  const sameBase = !env.ANTHROPIC_BASE_URL || (gateway.baseUrl &&
    normalizeBaseUrl(env.ANTHROPIC_BASE_URL) === normalizeBaseUrl(gateway.baseUrl));
  // An explicit different endpoint is a separate provider: do not leak the old
  // profile's protocol, credential, or model into it.
  const selectedGateway = sameBase ? gateway : {};
  const apiType = normaliseProfile({ inferenceApiType: env.ANTHROPIC_API_TYPE || selectedGateway.apiType }).apiType;
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || selectedGateway.apiKey || '';
  const childEnv = { ...env };
  // The adapter is bound to selectedGateway for its whole lifetime. Capture only
  // model/window pairs at actor launch, never the gateway credentials themselves.
  function result(adapter, source, stop) {
    const boundEnv = { base: childEnv.ANTHROPIC_BASE_URL, token: childEnv.ANTHROPIC_AUTH_TOKEN,
      key: childEnv.ANTHROPIC_API_KEY, apiType: childEnv.ANTHROPIC_API_TYPE };
    return { env: childEnv, adapter, source, stop, contextWindows(actorEnv) {
      if (!selectedGateway.baseUrl || !settings.upstreamBaseUrl ||
          apiType !== normaliseProfile({ inferenceApiType: selectedGateway.apiType }).apiType ||
          (gateway.apiKey && apiKey !== gateway.apiKey) ||
          actorEnv.ANTHROPIC_BASE_URL !== boundEnv.base || actorEnv.ANTHROPIC_AUTH_TOKEN !== boundEnv.token ||
          actorEnv.ANTHROPIC_API_KEY !== boundEnv.key || actorEnv.ANTHROPIC_API_TYPE !== boundEnv.apiType) return [];
      const profile = require('./model-capabilities.cjs').currentCapabilityProfile(selectedGateway);
      return profile.inferenceModels.map(row => {
        const id = typeof row === 'string' ? row : row?.id ?? row?.model ?? row?.name;
        const window = [row?.contextWindow, row?.context_window, row?.context_length]
          .find(value => Number.isSafeInteger(value) && value > 0);
        return typeof id === 'string' && id && window ? { model: id, contextWindow: window } : null;
      }).filter(Boolean);
    } };
  }
  const settings = resolveGatewayRuntimeSettings({ env, gateway: selectedGateway, appRoot, resourcesPath });
  if (settings.upstreamBaseUrl) childEnv.ANTHROPIC_BASE_URL = settings.upstreamBaseUrl;
  if (apiKey && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) childEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
  if (settings.model && !env.CLAUDE_AGENT_MODEL && !env.ANTHROPIC_MODEL) childEnv.CLAUDE_AGENT_MODEL = settings.model;
  const openai = apiType !== 'anthropic' && !Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CCB_GATEWAY_ADAPTER');
  if (!openai && settings.adapter === 'none') {
    if (!settings.upstreamBaseUrl || apiType !== 'anthropic') return result(settings.adapter, settings.source, async () => {});
    const server = await require('./anthropic-effort-gateway.cjs').startAnthropicEffortGateway({
      upstreamBaseUrl: settings.upstreamBaseUrl,
      capabilityProfile: () => require('./model-capabilities.cjs').currentCapabilityProfile(selectedGateway),
    });
    childEnv.ANTHROPIC_BASE_URL = server.baseUrl;
    return result('anthropic-effort', settings.source, () => server.stop());
  }
  const server = openai
    ? await startOpenAIGateway({ upstreamBaseUrl: settings.upstreamBaseUrl, apiKey, protocol: apiType,
      capabilityProfile: () => require('./model-capabilities.cjs').currentCapabilityProfile(selectedGateway) })
    : await startGateway({ upstreamBaseUrl: settings.upstreamBaseUrl,
      capabilityProfile: () => require('./model-capabilities.cjs').currentCapabilityProfile(selectedGateway),
      ...(settings.systemContextPrefix !== undefined ? { systemContextPrefix: settings.systemContextPrefix } : {}) });
  childEnv.ANTHROPIC_BASE_URL = server.baseUrl;
  if (openai) childEnv.ANTHROPIC_AUTH_TOKEN = server.authToken ?? apiKey;
  return result(openai ? apiType : settings.adapter,
    openai ? (env.ANTHROPIC_API_TYPE || !sameBase ? 'environment' : gateway.source || 'profile') : settings.source,
    () => server.stop());
}

module.exports = { prepareCcbRuntime };
