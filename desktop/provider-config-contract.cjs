'use strict';

const { normalizeBaseUrl } = require('./base-url.cjs');

// Contract of the shipped 3p editor: inferenceModels accepts strings or objects
// with a required `name`, not the reconstruction's historical `{id}` shape.
// Keep credential values opaque: validation issues contain paths and codes only.
function normalizeProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = { ...value };
  if (Array.isArray(value.inferenceModels)) {
    config.inferenceModels = value.inferenceModels.map(entry => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      // Discovery rows carry a display name separately; the shipped `name` is the model ID.
      const name = [entry.id, entry.model, entry.name].find(item => typeof item === 'string' && item.trim());
      if (!name) return { ...entry };
      const normalized = { ...entry, name: name.trim() };
      delete normalized.id;
      delete normalized.model;
      return normalized;
    });
  }
  return config;
}

function providerConfigIssues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path: '', code: 'object_required' }];
  const issues = [];
  if (value.inferenceModels !== undefined) {
    if (!Array.isArray(value.inferenceModels) || value.inferenceModels.length === 0) {
      issues.push({ path: 'inferenceModels', code: 'nonempty_array_required' });
    } else {
      value.inferenceModels.forEach((entry, index) => {
        const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.name : null;
        if (typeof name !== 'string' || !name.trim()) issues.push({ path: `inferenceModels.${index}.name`, code: 'model_name_required' });
      });
    }
  }
  if (value.inferenceProvider === 'gateway') {
    const pickText = (...values) => values.find(item => typeof item === 'string' && item.trim())?.trim() || '';
    const apiType = pickText(value.inferenceApiType, value.apiType, value.credentials?.apiType);
    const baseUrl = pickText(value.inferenceGatewayBaseUrl, value.baseUrl, value.credentials?.baseUrl);
    if (apiType && !['anthropic', 'openai-chat', 'openai-responses'].includes(apiType)) {
      issues.push({ path: 'inferenceApiType', code: 'unsupported_api_type' });
    }
    try {
      normalizeBaseUrl(baseUrl);
    } catch { issues.push({ path: 'inferenceGatewayBaseUrl', code: 'http_url_required' }); }
    // Match gateway-source's accepted credential locations, including imported
    // OAuth profiles, without copying tokens into additional config fields.
    const credential = [value.inferenceGatewayApiKey, value.apiKey, value.credentials?.apiKey, value.credentials?.accessToken]
      .find(item => typeof item === 'string' && item.trim());
    const kind = value.inferenceCredentialKind || (credential ? 'static' : value.inferenceCredentialHelper ? 'helper-script' : value.inferenceGatewayAuthScheme === 'sso' ? 'interactive' : null);
    if (!kind) issues.push({ path: 'inferenceCredentialKind', code: 'credential_required' });
    else if (!['static', 'helper-script', 'interactive'].includes(kind)) issues.push({ path: 'inferenceCredentialKind', code: 'unsupported_credential_kind' });
    else if (kind === 'helper-script' && (typeof value.inferenceCredentialHelper !== 'string' || !value.inferenceCredentialHelper.trim())) issues.push({ path: 'inferenceCredentialHelper', code: 'helper_required' });
    else if (kind === 'static' && !credential) {
      issues.push({ path: 'inferenceGatewayApiKey', code: 'credential_required' });
    }
    if (value.inferenceGatewayAuthScheme !== undefined && !['bearer', 'x-api-key', 'sso'].includes(value.inferenceGatewayAuthScheme)) {
      issues.push({ path: 'inferenceGatewayAuthScheme', code: 'unsupported_auth_scheme' });
    }
  }
  return issues;
}

module.exports = { normalizeProviderConfig, providerConfigIssues };
