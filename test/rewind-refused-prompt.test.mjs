import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// rewindToRefusedPrompt is declared, unimplemented, and deliberately left that way.
//
// Round 229's checkpoint-audit teammate reported it as "declared but never called". That is
// true for member-call syntax, but the method IS reached through a facade:
//   let n = a?.rewindToRefusedPrompt; if (!n || e.type !== 'local') return null;
// so the question is whether the feature can ever trigger.
//
// Measured this round:
//   bridge method exists and is callable        -> returns null (fallback)
//   consumer guards: `if (!n) return null`      -> a null/missing method is handled
//   consumer guards: `s === null ? null : ...`  -> a null RESULT is handled
//   kernel references 'unwoundRefusal'          -> NO
//   kernel references 'assistantUuid'           -> NO
//   agent.cjs references 'refus*'               -> NO
//
// The last three lines are the decision: nothing in this reconstruction ever produces the
// refused-prompt state that the method exists to unwind. Implementing it would be dead code
// behind a condition that never holds — the same mistake as inventing readAgent/saveAgent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
const AGENT = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));

function mappedMethods() {
  const out = [];
  const walk = (node, prefix) => {
    if (Array.isArray(node)) { for (const e of node) if (typeof e === 'string') out.push(prefix + e); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, prefix ? prefix + k + '.' : k + '.');
  };
  walk(MAP, '');
  return out;
}

test('rewindToRefusedPrompt is declared but has no implementation', () => {
  assert.ok(mappedMethods().includes('claude.web.LocalSessions.rewindToRefusedPrompt'),
    'the channel disappeared from bridge-map');
  assert.equal(/\$_rewindToRefusedPrompt'/.test(BRIDGE), false,
    'an implementation appeared; the tests below no longer describe it');
});

test('the kernel never produces a refusal state to unwind', () => {
  // This is why the missing handler is harmless, and why implementing it would be dead code.
  assert.equal(/unwoundRefusal/.test(KERNEL), false, 'the kernel now tracks unwoundRefusal');
  assert.equal(/assistantUuid/.test(KERNEL), false, 'the kernel now records assistantUuid');
  assert.equal(/refus/i.test(AGENT), false, 'the agent now reports refusals');
});

test('the consumer tolerates a null result instead of crashing', () => {
  // Round 228's rewindV2 gap threw a TypeError because its consumer destructured. This one
  // checks the shape first, which is why it is a missing feature rather than a crash.
  const bundle = PINNED_ION_DIST + '/assets/v1/cc8941b7b-DAgMZRvX.js';
  assert.ok(fs.existsSync(bundle), 'the shipped bundle is missing: ' + bundle);
  const source = fs.readFileSync(bundle, 'utf8');
  assert.match(source, /if\(!n\|\|e\.type!=="local"\)return null/,
    'the consumer no longer guards on the method being present');
  assert.match(source, /return s===null\?null:/,
    'the consumer no longer guards on a null result');
});
