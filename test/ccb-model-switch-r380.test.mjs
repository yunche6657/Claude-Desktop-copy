import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runProof, assess, MODELS } = require('../tools/proof-ccb-model-switch-r380.cjs');

function evidence() {
  return { runtime: { version: '2.8.4', entryHashMatchesManifest: true },
    controls: [MODELS[1], MODELS[2], MODELS[1]].map((model, index) => ({ request: { subtype: 'set_model', model }, requestId: String(index), response: { subtype: 'success', request_id: String(index) } })),
    requests: [MODELS[0], MODELS[1], MODELS[2], MODELS[2], MODELS[1]].map((model, index) => ({ path: '/v1/messages?beta=true', model, turn: [1, 2, 3, 3, 4][index], status: model === MODELS[2] ? 404 : 200 })),
    results: [false, false, true, false].map(isError => ({ subtype: 'success', isError })),
    activeControlBeforeFirstResult: true, actorPids: [1234], realAccount: false, realRemoteModel: false, childClosed: true };
}

test('model evidence permits actual unsupported-model retries but rejects wrong next-turn models', () => {
  const report = evidence();
  assert.ok(Object.values(assess(report)).every(Boolean));
  report.requests[1].model = MODELS[0];
  assert.equal(assess(report).requestModels, false);
});

test('model proof requires correlated native acknowledgements and successful recovery without is_error', () => {
  const report = evidence();
  report.controls[0].response.request_id = 'unrelated';
  assert.equal(assess(report).actualControlAcknowledged, false);
  report.results[3].isError = true;
  assert.equal(assess(report).recoveredAfterFailure, false);
  report.results[2].isError = false;
  assert.equal(assess(report).unsupportedAcceptedThenInferenceFailed, false);
});

test('R380 real packaged CCB switches models during a held turn and recovers after local HTTP rejection',
  { skip: process.env.CCD_REAL_MODEL_R380 !== '1', timeout: 100000 }, async t => {
    const out = process.env.CCD_MODEL_R380_OUT || path.join(os.tmpdir(), 'r380-model-' + crypto.randomUUID());
    const report = await runProof({ packageDir: process.env.CCD_MODEL_R380_PACKAGE, out });
    t.diagnostic('structured evidence: ' + path.join(out, 'report.json'));
    assert.equal(report.ok, true, JSON.stringify({ error: report.error, checks: report.checks }));
    assert.equal(report.controls.filter(row => row.request.subtype === 'set_model').length, 3);
    assert.ok(report.requests.filter(row => row.turn === 3).length >= 1);
  });
