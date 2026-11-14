'use strict';

// Capability claims come from explicit provider metadata or a user's per-model
// override. Model names are identifiers, never evidence of reasoning support.
const EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LABELS = { none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
function effortList(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(item => typeof item === 'string' ? item : item?.id).filter(item => EFFORT_VALUES.includes(item)))];
}
function explicitCapability(value) {
  if (!value || typeof value !== 'object') return null;
  const containers = [value, value.capabilities, value.metadata, value.reasoning, value.capabilities?.reasoning, value.metadata?.reasoning, value.thinking].filter(Boolean);
  for (const entry of containers) {
    for (const key of ['supportedEfforts', 'supported_efforts', 'supported_reasoning_efforts', 'reasoning_efforts', 'reasoning_effort', 'effort_options']) {
      const supportedEfforts = effortList(entry[key]);
      if (supportedEfforts !== null) {
        const selected = entry.defaultEffort ?? entry.default_effort ?? entry.default_reasoning_effort;
        const recommended = Array.isArray(entry[key]) ? entry[key].find(item => item?.recommended)?.id : undefined;
        return { supportedEfforts, ...(supportedEfforts.includes(selected ?? recommended) ? { defaultEffort: selected ?? recommended } : {}) };
      }
    }
  }
  return null;
}
function modelId(row) { return typeof row === 'string' ? row : row?.id ?? row?.model ?? row?.name; }
function resolveModelCapabilities(model, profile = {}) {
  const config = profile?.raw ?? profile ?? {};
  const overrides = config.inferenceModelCapabilities;
  if (overrides && Object.hasOwn(overrides, model)) {
    const override = explicitCapability(overrides[model]);
    if (override) return { ...override, source: 'config' };
  }
  const row = (Array.isArray(config.inferenceModels) ? config.inferenceModels : []).find(row => modelId(row) === model);
  const metadata = explicitCapability(row);
  return metadata ? { ...metadata, source: 'provider' } : { supportedEfforts: [], source: 'unknown' };
}
function validateModelEffort(model, effort, profile = {}) {
  return resolveModelCapabilities(model, profile).supportedEfforts.includes(effort) ? effort : undefined;
}
function currentCapabilityProfile(gateway = require('./gateway-source.cjs').resolveGateway()) {
  const profile = gateway.raw || {};
  const discovered = require('./bridge-services.cjs').knownGatewayModels(gateway);
  const configured = Array.isArray(profile.inferenceModels) ? profile.inferenceModels : [];
  const merged = new Map(discovered.map(row => [modelId(row), row]));
  for (const row of configured) {
    const id = modelId(row);
    merged.set(id, typeof row === 'string' ? (merged.get(id) || row) : { ...(merged.get(id) || {}), ...row });
  }
  return { ...profile, inferenceModels: [...merged.values()] };
}
function modelThinking(model, profile = {}) {
  const capabilities = resolveModelCapabilities(model, profile);
  if (!capabilities.supportedEfforts.length) return undefined;
  return { type: 'effort', effort_options: capabilities.supportedEfforts.map(id => ({ id, name: LABELS[id], ...(id === capabilities.defaultEffort ? { recommended: true } : {}) })) };
}
// Copy only public identity and capability metadata; never retain arbitrary
// /models fields (which may echo provider credentials).
function normalizeModelMetadata(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()) return null;
  const id = row.id.trim();
  const name = [row.name, row.display_name].find(value => typeof value === 'string' && value.trim());
  const capability = explicitCapability(row);
  const contextWindow = [row.contextWindow, row.context_window, row.context_length].find(value => Number.isSafeInteger(value) && value > 0);
  return { id, name: name?.trim() || id, ...(capability ? { capabilities: capability } : {}), ...(contextWindow === undefined ? {} : { contextWindow }) };
}
module.exports = { EFFORT_VALUES, explicitCapability, resolveModelCapabilities, validateModelEffort, modelThinking, normalizeModelMetadata, currentCapabilityProfile };
