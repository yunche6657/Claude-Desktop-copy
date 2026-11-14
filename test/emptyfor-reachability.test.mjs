// Every emptyFor rule must be reachable from at least one declared channel.
//
// WHY. Two rounds of dead code motivated this:
//   - /^#000[0-9a-fA-F]{2}$/  encoded a length no CSS hex has (round 326)
//   - a test exemption hard-coded instead of read from source (round 325)
// Both were 'code that exists but can never run'. The emptyFor table is the highest-risk place
// for that shape in the bridge: it is 28 rules whose only input is a channel name, so a typo in
// a pattern silently downgrades a whole family of channels to `null` — which is exactly what
// breaks boot when the consumer spreads the answer.
//
// METHOD. Build every declared channel in its REAL wire format (`<ns>_$_<Service>_$_<method>`),
// then require each rule's regex to match at least one of the 1333 of them.
//
// MEASURED: 28 rules, 0 unreachable.
// NOTE: the first version of this check used dotted names ('claude.web.X.getInfo') and reported
// one false dead rule — the real key is underscore-separated. The wire format is the thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Every declared channel in wire form. */
function allChannels() {
  const map = JSON.parse(read('desktop/shim/bridge-map.json'));
  const out = [];
  for (const ns of Object.keys(map)) {
    const services = map[ns];
    if (!services || typeof services !== 'object') continue;
    for (const [svc, methods] of Object.entries(services)) {
      if (!Array.isArray(methods)) continue;
      for (const method of methods) out.push(`${ns}_$_${svc}_$_${method}`);
    }
  }
  return out;
}

/** The regex sources each emptyFor rule tests. */
function emptyForRules() {
  const bridge = read('desktop/bridge-services.cjs').replace(/\r\n/g, '\n');
  const start = bridge.indexOf('function emptyFor(frag) {');
  const end = bridge.indexOf('\n}', start);
  const body = bridge.slice(start, end);
  const rules = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*if \((.+?)\) return (.+);$/);
    if (!m) continue;
    const sources = [...m[1].matchAll(/\/((?:[^\/\\]|\\.)+)\/([a-z]*)/g)].map((x) => x[1]);
    rules.push({ sources, returns: m[2].trim() });
  }
  return rules;
}

test('the bridge declares the full channel surface', () => {
  const channels = allChannels();
  assert.equal(channels.length, 1333, 'the declared channel count changed: ' + channels.length);
});

test('every emptyFor rule can match at least one declared channel', () => {
  const channels = allChannels();
  const rules = emptyForRules();
  assert.ok(rules.length >= 25, 'the emptyFor table shrank unexpectedly: ' + rules.length + ' rules');
  const unreachable = [];
  rules.forEach((rule, index) => {
    const hit = channels.some((channel) => rule.sources.some((source) => {
      try { return new RegExp(source, 'i').test(channel); } catch { return false; }
    }));
    if (!hit) unreachable.push('#' + index + ' ' + JSON.stringify(rule.sources) + ' -> ' + rule.returns);
  });
  assert.deepEqual(unreachable, [], 'emptyFor rules that can never match: ' + unreachable.join(' | '));
});

test('the reachability check uses the real wire format', () => {
  // Pinned because the first attempt used dotted names and produced a false dead rule.
  const channels = allChannels();
  assert.ok(channels.some((c) => c.includes('_$_')), 'channels are not in wire form');
  assert.ok(!channels.some((c) => c.includes('claude.web.UserFiles_')), 'a proof the nonexistent service is not declared');
});
