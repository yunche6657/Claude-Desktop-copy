// Every script that spawns Electron AND drives a conversation must configure a model.
//
// WHY. Three rounds hit the same shape: a value one entry point exports and another forgets.
//
//   328  session-kernel hard-coded a model instead of reading CLAUDE_AGENT_MODEL
//   336  getConfiguredServices ignored the project's launch.json
//   339  tools/packaged-proof.cjs spawned Electron directly, so the model env the launcher
//        normally exports was absent -> kernel resolved an EMPTY model -> the gateway answered
//        502 'upstream authentication failed', which reads as a provider outage
//
// The 339 fix derives the model inside packaged-proof.cjs. This file makes sure the NEXT such
// script cannot repeat it: any spawner that actually drives a turn must either set the env or
// delegate to the launcher, and any spawner that does not drive a turn is explicitly exempt.
//
// MEASURED when written: 4 scripts spawn Electron without the model (probe-flags,
// probe-integrity, probe-token, run-fg) and all four only LAUNCH things — none calls
// sendMessage or sets CLAUDE_CHECK_PHASE — so none needs a model. They are listed as exempt
// below with the reason, so the exemption is a decision rather than an oversight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scripts that launch Electron only to check it starts; they never drive a turn. */
const LAUNCH_ONLY = new Set([
  'tools/probe-flags.cjs',
  'tools/probe-integrity.cjs',
  'tools/probe-token.cjs',
  'tools/run-fg.cjs',
]);

/** Every script under tools/, tools/probes and build that spawns a child process. */
function spawners() {
  const found = [];
  for (const dir of ['tools', 'tools/probes', 'build']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(cjs|mjs)$/.test(name)) continue;
      const rel = dir + '/' + name;
      const source = fs.readFileSync(path.join(abs, name), 'utf8');
      if (!/spawn\(|spawnSync\(|execFile\(/.test(source)) continue;
      found.push({ rel, source });
    }
  }
  return found;
}

test('a script that drives a turn always configures the model or uses the launcher', () => {
  const offenders = [];
  for (const { rel, source } of spawners()) {
    const drivesTurn = /sendMessage|CLAUDE_CHECK_PHASE|startFromConfig/.test(source);
    if (!drivesTurn) continue;
    // The Git proof selects a phase that explicitly never calls the model.
    if (rel === 'tools/hidden-git-proof.cjs') continue;
    // Match the ASSIGNMENT, not the word: a comment mentioning the variable must not count.
    // MEASURED: with a plain /CLAUDE_AGENT_MODEL/ the mutation that deleted the assignment
    // stayed green because one comment still named it.
    const configured = /(?:env|process\.env)\.CLAUDE_AGENT_MODEL\s*=/.test(source)
      || /launch-replica/.test(source)
      || /require\(['"]\.\.\/desktop\/startup-defaults\.cjs['"]\)\.applyStartupDefaults\(env\)/.test(source);
    if (!configured) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    'these scripts drive a turn but never set a model: ' + offenders.join(', '));
});

test('the Git-only runner cannot silently grow a model conversation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'hidden-git-proof.cjs'), 'utf8');
  assert.match(source, /CLAUDE_CHECK_PHASE:'git'/);
  assert.doesNotMatch(source, /sendMessage|startFromConfig/);
});

test('the launch-only exemption list is accurate and justified', () => {
  // A stale entry would silently exempt a script that has since grown the ability to drive a
  // turn, which is exactly the regression this file exists to catch.
  const byRel = new Map(spawners().map((s) => [s.rel, s.source]));
  for (const rel of LAUNCH_ONLY) {
    assert.ok(byRel.has(rel), rel + ' is listed as launch-only but no longer spawns anything');
    const source = byRel.get(rel);
    assert.equal(
      /sendMessage|CLAUDE_CHECK_PHASE|startFromConfig/.test(source),
      false,
      rel + ' now drives a turn; it must configure a model instead of being exempt'
    );
  }
});

test('the packaged proof runner is the model-configured case this rule protects', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'packaged-proof.cjs'), 'utf8');
  assert.match(source, /env\.CLAUDE_AGENT_MODEL\s*=/, 'the runner that drives a turn lost its model assignment');
});
