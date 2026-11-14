import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const policy = require('../desktop/growthbook-3p-policy.cjs');
const ref = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');

test('3p main policy matches the shipped main bundle under all condition combinations', () => {
  const source = fs.readFileSync(ref, 'utf8');
  const start = source.indexOf('var t5t={');
  const end = source.indexOf('var LC=', start);
  assert.ok(start >= 0 && end > start, 'original main-process policy is present');
  // Stop before the unrelated model logic, but preserve upstream policy functions.
  const rulesEnd = source.indexOf(',r5t=new Set([])', start);
  const functionsStart = source.indexOf('function o5t(', rulesEnd);
  const snippet = source.slice(start, rulesEnd) + ';' + source.slice(functionsStart, end);
  const original = vm.runInNewContext(snippet + ';({g5t,b5t,K: (e, options) => {let r={}; for(let n of b5t) n in e && (r[n]=e[n]); return {...r,...g5t(options)} }})');
  assert.deepEqual([...policy.growthBookRemoteAllowedKeys()], Array.from(original.b5t));
  for (const builtinBrowserEnabled of [false, true]) for (const selfHostedSessions of [false, true]) {
    const options = { builtinBrowserEnabled, selfHostedSessions };
    const expected = JSON.parse(JSON.stringify(original.g5t(options)));
    assert.deepEqual(policy.hardcodedMainGrowthBookFeatures(options), expected);
    const remote = Object.create({ [[...original.b5t][0]]: { value: 'inherited' } });
    remote.notAllowed = { value: 123 };
    remote[Object.keys(expected)[0]] = { value: 'override-attempt' };
    // Reproduce Kzt inside the VM using explicit arguments.
    const merged = JSON.parse(JSON.stringify(original.K(remote, options)));
    assert.deepEqual(policy.mergeRemoteFeatures(remote, options), merged);
  }
});

test('returned values are isolated between calls', () => {
  const first = policy.hardcodedMainGrowthBookFeatures({ selfHostedSessions: true });
  first['1263782781'].value.stage.max_ms = 1;
  assert.equal(policy.hardcodedMainGrowthBookFeatures({ selfHostedSessions: true })['1263782781'].value.stage.max_ms, 600000);
});
