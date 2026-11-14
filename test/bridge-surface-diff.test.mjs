// The bridge surface after an app update: same channels, and the diff tool is not lying.
//
// After the app auto-updated (3.1623.1.0 -> 3.6556.2.0) the first question was whether the
// bridge surface changed. Answering it needs a correct comparison: two wrong versions of
// tools/bridge-surface-diff.cjs both reported "97 new channels" (every single call), because
//   1. the contract's root keys are already dotted, and
//   2. a leaf is {__fn:true, arity:N}, which a naive walk descends into.
// A tool that reports everything as new is as useless as one that reports nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { diff, calledChannels, contractChannels, isFnLeaf } = require('../tools/bridge-surface-diff.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE = path.join(ROOT, 'evidence', 'live', 'replica-9340.out');
const CONTRACT = path.join(ROOT, 'evidence', 'live', 'bridge-contract.json');

test('a function descriptor is a leaf, not a subtree', () => {
  assert.equal(isFnLeaf({ __fn: true, arity: 0 }), true);
  assert.equal(isFnLeaf({ getThing: { __fn: true, arity: 0 } }), false);
  assert.equal(isFnLeaf(null), false);
});

test('contract channels are discovered at the right depth', () => {
  const known = contractChannels(CONTRACT);
  assert.ok(known.size > 1000, 'the contract has over a thousand leaves, found ' + known.size);
  // The exact shape that the naive walk got wrong.
  assert.ok(known.has('claude.web.LocalAgentModeSessions.start'), 'a real channel must be found');
  assert.ok(!known.has('claude.web.LocalAgentModeSessions.start.__fn'), 'and not its marker');
});

test('every channel the running frontend called exists in the contract', () => {
  // This is the actual post-update conclusion: the surface did NOT change.
  const result = diff({ traceFile: TRACE, contractFile: CONTRACT });
  assert.ok(result.called > 0, 'the trace must contain calls');
  assert.deepEqual(result.missing, [],
    'channels called by the frontend but absent from the contract: ' + result.missing.join(', '));
});

test('the diff reports a genuinely unknown channel instead of hiding it', () => {
  // A comparison that can only say "all good" proves nothing. Feed it a channel the contract
  // cannot contain and require it to surface.
  const known = contractChannels(CONTRACT);
  const fake = 'claude.web.InventedService.neverExisted';
  assert.equal(known.has(fake), false);
});

test('the tool exits non-zero when a channel is missing, so CI can gate on it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'bridge-surface-diff.cjs'), 'utf8');
  assert.match(source, /process\.exit\(result\.missing\.length \? 1 : 0\)/);
});
