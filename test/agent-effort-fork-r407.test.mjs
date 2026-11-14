// R407: Agent.effort must be IGNORED for subagent_type "fork".
//
// THE DEFECT THIS FIXES
//   R406 added `effort` and threaded it into both SubagentContext constructions unconditionally:
//
//       ...(effort ? { effortOverride: effort } : {}),
//
//   The official contract says the opposite, verbatim:
//
//       "Ignored for subagent_type: \"fork\": a fork runs at your own effort."
//
//   So a fork would have silently honoured a per-call effort — changing its cost and latency
//   while the contract promised it would not. R406's handoff recorded this as an open
//   uncertainty; this round resolved it against the source.
//
// WHY THE FIX SHAPE IS TRUSTWORTHY
//   The same function already applies exactly this rule to `model`:
//
//       model: isForkPath ? undefined : model,
//
//   So `effort` follows an existing, load-bearing precedent rather than an invented one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const AGENT = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'AgentTool', 'AgentTool.tsx');

const agentSrc = () => fs.readFileSync(AGENT, 'utf8');

test('the official contract says fork ignores effort', () => {
  // Pinning the rule itself: if the contract ever changes, the implementation should follow.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  assert.ok(fs.existsSync(dts), 'the official sdk-tools.d.ts is missing');
  const text = fs.readFileSync(dts, 'utf8');
  assert.match(text, /Ignored for subagent_type: "fork": a fork runs at your own effort\./,
    'the official fork-effort rule changed: re-derive the implementation');
});

test('effort is gated on !isForkPath at every SubagentContext site', () => {
  const src = agentSrc();
  // Both the async and the sync execution paths construct a SubagentContext.
  const guarded = (src.match(/!isForkPath && effort \? \{ effortOverride: effort \} : \{\}/g) || []).length;
  assert.equal(guarded, 2,
    'expected both context sites to gate effort on !isForkPath, found ' + guarded);

  // And the unguarded form must be gone: that was the R406 defect.
  const unguarded = (src.match(/\.\.\.\(effort \? \{ effortOverride: effort \} : \{\}\)/g) || []).length;
  assert.equal(unguarded, 0,
    'an unconditional effort injection came back, so a fork would honour a per-call effort');
});

test('the effort guard mirrors how model is already handled', () => {
  // The precedent that makes the fix shape correct rather than invented.
  const src = agentSrc();
  assert.match(src, /model: isForkPath \? undefined : model/,
    'the model/fork precedent is gone: re-derive whether effort should still be gated');
  // If the precedent disappears, the effort guard is no longer justified by symmetry.
  const forkOccurrences = (src.match(/isForkPath/g) || []).length;
  assert.ok(forkOccurrences >= 5,
    'isForkPath is barely referenced; the fork path may have been removed, so re-derive');
});

test('isForkPath is actually in scope where effort is injected', () => {
  // A guard that references an out-of-scope name would not compile, but the *meaning* matters:
  // isForkPath must be derived from the resolved agent type, not guessed.
  const src = agentSrc();
  const defAt = src.indexOf('const isForkPath = ');
  assert.ok(defAt > 0, 'isForkPath is no longer defined');
  assert.match(src.slice(defAt, defAt + 80), /const isForkPath = effectiveType === undefined/,
    'isForkPath no longer means "no explicit subagent_type": re-derive its meaning');

  const firstInjection = src.indexOf('!isForkPath && effort');
  assert.ok(firstInjection > defAt,
    'effort is injected before isForkPath is computed, so the guard would read stale state');
});

test('the adopted bundle carries the guard', () => {
  const { text } = findChunk('!isForkPath && effort');
  assert.ok(text.includes('!isForkPath && effort'),
    'the guarded injection is missing from the adopted bundle');
  // The model precedent must be in the same chunk: they belong to the same tool definition.
  assert.ok(text.includes('isForkPath ? undefined : model'),
    'the model precedent is in a different chunk than the effort guard, which is unexpected');
});

test('the fork build flag is still off, so this path is currently unreachable in production', () => {
  // Stated explicitly so nobody reads these assertions as "fork behaviour is exercised".
  // The code must still be correct; it just is not reached by the default build today.
  const defines = fs.readFileSync(path.join(SRC, 'scripts', 'defines.ts'), 'utf8');
  const at = defines.indexOf('DEFAULT_BUILD_FEATURES');
  const start = defines.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < defines.length; i += 1) {
    if (defines[i] === '[') depth += 1;
    else if (defines[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const block = defines.slice(start, end + 1);
  const active = block.split('\n').some((l) =>
    !l.trim().startsWith('//') && l.includes("'FORK_SUBAGENT'"));
  assert.equal(active, false,
    'FORK_SUBAGENT is now enabled: the fork path became reachable, so this needs runtime testing '
    + 'rather than static assertions alone');
});
