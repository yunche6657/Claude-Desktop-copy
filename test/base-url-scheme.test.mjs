// Reported from the settings page: entering `127.0.0.1:7863` in 服务 URL produced
// "Enter a valid HTTP or HTTPS base URL without embedded credentials." — a wrong cause
// (there were no credentials) in the wrong language, for a plain missing scheme.
//
// Two separate defects, both covered here:
//   1. A scheme-less host:port was rejected outright. `new URL('127.0.0.1:7863')` throws,
//      and `localhost:7863` is worse: it parses as scheme "localhost:" with an empty host,
//      so it fails later and looks like a completely different problem.
//   2. The failure text named "embedded credentials" regardless of the real reason, and
//      was English in an otherwise Chinese dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeBaseUrl } = require('../desktop/base-url.cjs');
const { modelsUrl } = require('../desktop/model-discovery.cjs');
const { providerConfigIssues } = require('../desktop/provider-config-contract.cjs');

test('a scheme-less host and port is accepted and defaulted to http', () => {
  for (const input of ['127.0.0.1:7863', 'localhost:8080', '192.168.1.5:3000', '//127.0.0.1:7863']) {
    const url = normalizeBaseUrl(input);
    assert.equal(url.protocol, 'http:', input);
    assert.ok(url.hostname, input);
  }
  assert.equal(normalizeBaseUrl('127.0.0.1:7863').href, 'http://127.0.0.1:7863/');
});

test('an explicit https scheme is never downgraded', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1').href, 'https://api.example.com/v1');
});

test('a path below the port survives normalization', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:3000/v1').pathname, '/v1');
});

test('embedded credentials and non-http schemes stay rejected', () => {
  assert.throws(() => normalizeBaseUrl('http://user:pass@host:1'), /http_url_required/);
  assert.throws(() => normalizeBaseUrl('ftp://host:1'), /http_url_required/);
  assert.throws(() => normalizeBaseUrl('mailto:someone@example.com'), /unsupported_protocol/);
  assert.throws(() => normalizeBaseUrl(''), /base_url_required/);
  assert.throws(() => normalizeBaseUrl('   '), /base_url_required/);
});

test('model discovery reaches the same endpoint for a scheme-less address', () => {
  // The reported case: discovery is what the user pressed when the error appeared.
  assert.equal(modelsUrl('127.0.0.1:7863').href, 'http://127.0.0.1:7863/v1/models');
  assert.equal(modelsUrl('http://127.0.0.1:7863').href, 'http://127.0.0.1:7863/v1/models');
});

test('saving the config accepts a scheme-less gateway address', () => {
  const issues = providerConfigIssues({
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: '127.0.0.1:7863',
    inferenceGatewayApiKey: 'fixture-key',
    inferenceModels: ['glm-5.3'],
    model: 'glm-5.3',
  });
  assert.deepEqual(issues, []);
});

test('the rejection message names the real cause instead of blaming credentials', async () => {
  const { discoverModels } = require('../desktop/model-discovery.cjs');
  const result = await discoverModels({ baseUrl: 'http://user:pass@host:1', apiKey: 'fixture' });
  assert.equal(result.ok, false);
  assert.match(result.error, /服务 URL 无效/);
  assert.match(result.error, /不要包含用户名或密码/);
  assert.doesNotMatch(result.error, /^Enter a valid/);
});
