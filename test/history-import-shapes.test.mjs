// A channel whose null answer is not survivable must answer its real shape.
//
// claude.settings.HistoryImport had fifteen methods and no handler, so every call fell
// through to the generic fallback and answered null. One caller does not guard:
//
//   D?.getImportHistory?.().then(e => h(e)).catch(() => h([]))     // h(null)
//   ... m.length ...                                              // TypeError
//
// Measured on the live replica:
//   [frontend:error] [BOOTSTRAP] Fatal error boundary triggered
//   {"errorCode":"0TA57KU","route":"/new", ... }
//
// So opening the app could blank the whole surface behind an error boundary. The
// lesson generalises: 'the fallback answers null' is only safe when every consumer
// guards, and any one that does not turns a missing feature into a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));

/** Every method the contract declares for one service. */
function contractMethods(service) {
  const out = [];
  for (const domain of Object.keys(map)) {
    const services = map[domain];
    if (!services || !services[service]) continue;
    for (const method of services[service]) out.push(domain + '_$_' + service + '_$_' + method);
  }
  return out;
}

test('every HistoryImport method has a handler', () => {
  const declared = contractMethods('HistoryImport');
  assert.ok(declared.length > 0, 'the contract must declare this service');
  const missing = declared.filter((channel) => !bridge.includes("define('" + channel + "'"));
  assert.deepEqual(missing, [], 'unhandled (the fallback answers null): ' + missing.join(', '));
});

test('getImportHistory answers an array so .length cannot throw', () => {
  // This is the exact crash: h(null) then m.length.
  const start = bridge.indexOf("define('claude.settings_$_HistoryImport_$_getImportHistory'");
  assert.ok(start > 0, 'the handler must exist');
  const line = bridge.slice(start, bridge.indexOf('\n', start));
  assert.match(line, /=>\s*importHistory\.slice\(\)/, 'it must answer a fresh array');
});

test('the container answers are collections, not null', () => {
  // Each of these is read as a list by some consumer.
  const arrayAnswers = [
    'enumerateSessionSources',
    'listSourceExtras',
    'listInstructionTexts',
  ];
  for (const method of arrayAnswers) {
    const needle = "define('claude.settings_$_HistoryImport_$_" + method + "'";
    const start = bridge.indexOf(needle);
    assert.ok(start > 0, method + ' must be handled');
    const line = bridge.slice(start, bridge.indexOf('\n', start));
    assert.match(line, /=>\s*\[\]/, method + ' must answer an empty array');
  }
});

test('the object answers declare their fields', () => {
  // A bare {} would satisfy 'not null' but leave every read undefined; name the fields.
  const expectations = {
    getImportCapabilities: ['canImport', 'canExport', 'canAutoImport'],
    getAutoImportStatus: ['enabled', 'running', 'lastRunAt'],
    scanSessionSource: ['sessions', 'count'],
    importSessionSources: ['imported', 'count'],
    getRemovePreview: ['sessions', 'count'],
  };
  for (const [method, fields] of Object.entries(expectations)) {
    const needle = "define('claude.settings_$_HistoryImport_$_" + method + "'";
    const start = bridge.indexOf(needle);
    assert.ok(start > 0, method + ' must be handled');
    const end = bridge.indexOf('}));', start);
    assert.ok(end > start, method + ' must answer an object literal');
    const body = bridge.slice(start, end);
    for (const field of fields) {
      assert.ok(body.includes(field), method + ' must declare ' + field);
    }
  }
});

test('nothing in this block pretends an import succeeded', () => {
  // An honest empty state: capabilities say no, counts say zero.
  assert.match(bridge, /canImport:\s*false/, 'capabilities must not claim import works');
  assert.match(bridge, /imported:\s*0/, 'counts must be zero');
});

test('subscription channels return an unsubscribe function', () => {
  // The frontend stores the result and calls it on unmount; returning undefined throws.
  for (const method of ['onOnImportProgress', 'onOnAutoImportStatus']) {
    const needle = "define('claude.settings_$_HistoryImport_$_" + method + "'";
    const start = bridge.indexOf(needle);
    assert.ok(start > 0, method + ' must be handled');
    const line = bridge.slice(start, bridge.indexOf('\n', start));
    assert.match(line, /=>\s*\(\)\s*=>\s*\{\}/, method + ' must answer a function');
  }
});
