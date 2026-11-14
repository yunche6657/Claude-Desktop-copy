import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inventory } = require('../tools/bridge-inventory.cjs');

test('the inventory accounts for the real registered surface without duplicate methods', () => {
  const report = inventory();
  const extensions = ['importSubscription', 'importModelSubscription', 'importSub2TwoFA', 'discoverModels'];
  for (const method of extensions) assert.ok(report.methods.some(row => row.service === 'Custom3pSetup' && row.method === method));
  assert.equal(report.total, 1333 + extensions.length);
  assert.equal(report.methods.length, report.total);
  assert.equal(Object.values(report.counts).reduce((a,b)=>a+b,0), report.total);
  assert.equal(new Set(report.methods.map(m=>[m.domain,m.service,m.method].join('.'))).size, report.total);
});

test('dynamically registered session handlers are distinguished from generic fallbacks', () => {
  const report = inventory();
  const find = method => report.methods.find(m=>m.domain==='claude.web'&&m.service==='LocalSessions'&&m.method===method);
  assert.equal(find('respondToToolPermission').kind, 'handler');
  assert.equal(find('getSession').kind, 'handler');
  assert.equal(find('rewindFiles').kind, 'fallback');
  assert.equal(find('onOnEvent').kind, 'event');
});
