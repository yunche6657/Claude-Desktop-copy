// The model this build calls must come from the configured gateway, not a hard-coded name.
//
// Three places disagreed about the model, and each one alone was enough to break sending:
//   1. tools/launch-replica.cjs defaulted CLAUDE_AGENT_MODEL to 'claude-sonnet-5-5', overriding
//      the provider profile;
//   2. ClaudeCode.resolveLocalSettings read only the environment (same default);
//   3. the bootstrap's model_selector_config advertised the full Claude catalogue.
//
// With a gateway that serves other models (deepseek-v4-pro / glm-5.3 / gemini-3.5-flash), the
// composer held a model the gateway did not have and the Send button stayed disabled with no
// error anywhere. These tests pin all three to one source of truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the launcher takes the model from the profile, not a hard-coded default', () => {
  const source = read('tools/launch-replica.cjs');
  assert.match(source, /applyStartupDefaults\(env\)/, 'the launcher must share executable startup configuration');
  assert.doesNotMatch(source, /claude-sonnet-5-5/, 'the launcher must not invent a model');
});

test('resolveLocalSettings reads the resolved gateway model', () => {
  const source = read('desktop/bridge-services.cjs');
  // The handler grew (it now also fetches the gateway catalogue), so anchor on the define
  // and take a window large enough to reach the resolver call without swallowing the file.
  const at = source.indexOf("resolveLocalSettings', async");
  assert.ok(at > 0, 'the resolveLocalSettings handler is missing');
  const section = source.slice(at, at + 4000);
  assert.match(section, /resolveGateway\(\)/, 'it must use the same resolver as the agent');
  assert.match(section, /gateway\.model/, 'and read the model from it');
});

test('the bootstrap selector offers the gateway model', () => {
  // First version asserted /withResolvedModel/ against the whole file, which stayed green when
  // the definition was renamed: the export list on the last line still matched. Anchor on the
  // call site and on the resolver read instead.
  const source = read('desktop/bootstrap-service.cjs');
  assert.match(source, /function withResolvedModel\(payload, resolvedModel, extraModels\)/,
    'the rewrite helper is missing');
  const callAt = source.indexOf('return withResolvedModel({');
  assert.ok(callAt > 0, 'the helper is never applied to the payload');
  assert.match(source, /applyStartupDefaults\(\{ \.\.\.env \}, resolveGateway\)/,
    'the selector must share explicit env/profile/runtime model selection');
  assert.match(source, /return selected\.CLAUDE_AGENT_MODEL \|\| '';/,
    'the selected startup model must reach the payload');
});

test('the settings handler reads the same resolver the agent uses', () => {
  // The second place that disagreed. Anchor inside the handler rather than hoping a bare
  // /resolveGateway\(\)/ elsewhere in the file is the right one.
  const source = read('desktop/bridge-services.cjs');
  const at = source.indexOf("resolveLocalSettings', async");
  assert.ok(at > 0, 'the handler is missing');
  const section = source.slice(at, at + 4000);
  assert.match(section, /resolveGateway\(\)/, 'the handler does not call the resolver');
  assert.match(section, /gateway\.model/, 'the handler does not read the resolved model');
});
