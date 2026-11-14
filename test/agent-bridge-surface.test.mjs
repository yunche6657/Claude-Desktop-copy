import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// readAgent and saveAgent are NOT bridge methods. Recorded so nobody implements them.
//
// Round 214 found `getAgents` in the shipped bundle and this round asked whether the two
// obvious companions exist. A naive grep says yes: `readAgent` and `saveAgent` appear in
// several bundles. They are all substrings of longer identifiers —
//
//   thread_agent_team        (contains "agent_team", not "readAgent")
//   mainThreadAgentType      (contains "AgentType")
//   readAgents()             (plural, a different object's method)
//
// Measured precisely: 13 matches, and every one has a letter or underscore immediately before
// or after the needle. A word-boundary search finds ZERO real occurrences, and a search for
// `.readAgent(` / `.saveAgent(` as calls finds nothing.
//
// At runtime the bridge confirms it:
//   getAgents: 'function', getAgents() -> []
//   readAgent: 'undefined',  saveAgent: 'undefined'
//
// So the bridge is complete here. Implementing these two would be inventing API surface the
// shipped UI never calls — the opposite failure from the ones this project usually fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = PINNED_ION_DIST + '/assets/v1';

function bundleText() {
  if (!fs.existsSync(BUNDLE_DIR)) return null;
  return fs.readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8'))
    .join('\n');
}

test('the renderer never calls readAgent or saveAgent', () => {
  // If either appears as a real method call, the bridge needs it. Word boundaries matter:
  // a plain substring search matched thread_agent_team and readAgents().
  const text = bundleText();
  assert.ok(text, 'the shipped bundle is missing: ' + BUNDLE_DIR);
  assert.equal(/\.readAgent\s*\(/.test(text), false, 'readAgent is called as a method');
  assert.equal(/\.saveAgent\s*\(/.test(text), false, 'saveAgent is called as a method');
});

test('getAgents IS called and IS implemented', () => {
  // The one real method in this family must exist on both sides.
  const text = bundleText();
  assert.ok(text.includes('getAgents'), 'the renderer no longer calls getAgents');
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(source, /define\('claude\.web_\$_LocalSessions_\$_getAgents'/,
    'getAgents is called by the UI but not implemented');
});

test('getAgents answers an array, so the caller can map it', () => {
  // The consumer does `e?.getAgents?.().catch(...) ?? []`, then maps the result.
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const start = source.indexOf("define('claude.web_$_LocalSessions_$_getAgents'");
  const block = source.slice(start, start + 2500);
  assert.match(block, /agents\.push\(/);
  assert.match(block, /return agents/);
});
