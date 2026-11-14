import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const caps = require('../desktop/model-capabilities.cjs');
const { withResolvedModel } = require('../desktop/bootstrap-service.cjs');
const { convertAnthropicRequest: convertRequest } = require('../desktop/openai-gateway.cjs');
const profile = { inferenceModels: [{ id: 'provider-model', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } }], inferenceModelCapabilities: { custom: { supportedEfforts: ['minimal', 'xhigh'] }, 'provider-model': { supportedEfforts: ['medium'] } } };
test('unknown names are never guessed and unknown bootstrap thinking is absent', () => {
 for (const id of ['glm5.3', 'gpt6', 'claude-opus-5-5']) assert.equal(caps.modelThinking(id, profile), undefined);
 const payload = withResolvedModel({}, 'gpt6', ['gpt6', ...profile.inferenceModels], profile);
 assert.equal(Object.hasOwn(payload.model_selector_config[0].models[0], 'thinking'), false);
});
test('provider metadata survives normalization and overrides are authoritative including empty support', () => {
 const metadata = caps.normalizeModelMetadata(profile.inferenceModels[0]);
 assert.deepEqual(metadata.capabilities, { supportedEfforts: ['low', 'high'], defaultEffort: 'high' });
 assert.deepEqual(caps.resolveModelCapabilities('provider-model', profile).supportedEfforts, ['medium']);
 assert.deepEqual(caps.resolveModelCapabilities('provider-model', { ...profile, inferenceModelCapabilities: { 'provider-model': { supportedEfforts: [] } } }).supportedEfforts, []);
 assert.equal(caps.validateModelEffort('custom', 'high', profile), undefined);
});
test('normalization only retains explicitly declared positive safe integer context windows', () => {
 for (const field of ['contextWindow', 'context_window', 'context_length']) assert.equal(caps.normalizeModelMetadata({ id: 'm', [field]: 131072, secret: 'discard' }).contextWindow, 131072);
 for (const value of [0, -1, 1.5, '131072', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(Object.hasOwn(caps.normalizeModelMetadata({ id: 'm', contextWindow: value }), 'contextWindow'), false);
 assert.equal(Object.hasOwn(caps.normalizeModelMetadata({ id: 'claude-large' }), 'contextWindow'), false);
});
test('thinking options retain every explicitly supported effort including none and minimal', () => {
 const configured = { inferenceModelCapabilities: { fixture: { supportedEfforts: ['none', 'minimal', 'high'], defaultEffort: 'minimal' } } };
 assert.deepEqual(caps.modelThinking('fixture', configured), {
  type: 'effort', effort_options: [
   { id: 'none', name: '关闭' }, { id: 'minimal', name: '最小', recommended: true }, { id: 'high', name: '高' },
  ],
 });
 assert.equal(caps.modelThinking('absent', configured), undefined);
});
test('protocol effort mapping validates exact selected model capability', () => {
 const body = { model: 'custom', messages: [], output_config: { effort: 'xhigh' } };
 assert.equal(convertRequest(body, 'openai-chat', profile).reasoning_effort, 'xhigh');
 assert.deepEqual(convertRequest(body, 'openai-responses', profile).reasoning, { effort: 'xhigh' });
 assert.throws(() => convertRequest({ ...body, model: 'provider-model' }, 'openai-chat', profile), /Unsupported reasoning effort/);
 assert.equal(convertRequest(body, 'openai-chat').reasoning_effort, undefined);
});
test('model switch clears stale effort and send filters an unsupported persisted selection', async () => {
 const old = caps.currentCapabilityProfile;
 caps.currentCapabilityProfile = () => profile;
 let sent;
 const { createSessionKernel } = require('../desktop/session-kernel.cjs');
 const kernel = createSessionKernel({ emit() {}, createAgent: () => ({ model: 'custom', tools: [], async run(_messages, options) { sent = options; return { text: '', stopReason: 'end_turn' }; } }) });
 try {
  const session = kernel.start({ model: 'custom', effortLevel: 'xhigh' });
  assert.equal(kernel.setEffort(session.sessionId, 'high'), null);
  await kernel.setModel(session.sessionId, 'unknown');
  assert.equal(kernel.getSession(session.sessionId).effortLevel, null);
  await kernel.sendMessage(session.sessionId, 'hello');
  assert.equal(sent?.effortLevel, undefined);
 } finally { caps.currentCapabilityProfile = old; kernel.dispose?.(); }
});
