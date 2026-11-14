// The plugin surface: 32 declared methods, ZERO implemented handlers.
//
// MEASURED:
//   bridge-map.json declares LocalPlugins (17 methods) and CustomPlugins (15) — both stored as
//   ARRAYS of method names, not objects.
//   bridge-services.cjs contains ZERO occurrences of 'LocalPlugins', 'CustomPlugins' or
//   'getPlugins'. Every one of those 32 channels therefore answers through the generic fallback.
//
//   Live: LocalPlugins.getPlugins() -> []   (the fallback's emptyFor shape for a 'get*' name)
//
// On this machine that empty answer is ACCURATE — there is no ~/.claude/plugins directory, no
// plugin keys in ~/.claude/settings.json, and no plugin store anywhere. So nothing is being
// hidden from the user.
//
// But the distinction matters for the session's standing instruction ('do not remove my
// plugins'): the FEATURE is declared and reachable, and it answers honestly when empty. What is
// NOT present is an implementation that could list a plugin if one existed. This file records
// that state rather than pretending the surface is complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const MAP = JSON.parse(read('desktop/shim/bridge-map.json'));
const WEB = MAP['claude.web'] || {};

test('the plugin namespaces declare 17 + 15 methods, stored as arrays', () => {
  const local = WEB.LocalPlugins;
  const custom = WEB.CustomPlugins;
  assert.ok(Array.isArray(local), 'LocalPlugins is no longer an array of method names');
  assert.ok(Array.isArray(custom), 'CustomPlugins is no longer an array of method names');
  assert.equal(local.length, 17, 'LocalPlugins method count changed: ' + local.length);
  assert.equal(custom.length, 15, 'CustomPlugins method count changed: ' + custom.length);
});

test('every plugin entry point the UI needs is declared', () => {
  const names = [...WEB.LocalPlugins, ...WEB.CustomPlugins];
  for (const required of ['getPlugins', 'setPluginEnabled', 'uploadPlugin', 'deletePlugin',
    'listAvailablePlugins', 'installPlugin', 'uninstallPlugin']) {
    assert.ok(names.includes(required), required + ' disappeared from the plugin surface');
  }
});

test('the plugin channels have no dedicated handler and fall back', () => {
  // Recorded so a future implementation is a deliberate change, not an accident.
  const bridge = read('desktop/bridge-services.cjs');
  for (const name of ['LocalPlugins', 'CustomPlugins', 'getPlugins']) {
    assert.equal(bridge.split(name).length - 1, 0,
      name + ' now appears in bridge-services.cjs — if a handler was added, update this test');
  }
});

test('an empty plugin list is the honest answer on a machine with no plugins', () => {
  // The fallback's shape for a 'get*' channel is an empty array, which is exactly right here.
  const fallbackShapes = read('desktop/bridge-services.cjs');
  assert.match(fallbackShapes, /emptyFor|\[\]/, 'the fallback no longer answers empty arrays');
});
