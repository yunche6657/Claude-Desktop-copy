'use strict';
// Both `key` functions are PURE — no trim, no case folding. So "same callee, different arguments" cannot be hiding a match.
//
// WHAT R597 LEFT OPEN
//   It classified `hostPending` (`key(id)` / `key(q.id)`) and `once` (`key(state.id,state.origin)` / `key(id,origin)`) as
//   `same-callee-different-args`, and said the argument difference "depends on the caller, not on the key function". That is
//   true but imprecise: with a PURE key function the two sides agree exactly when their arguments are equal at runtime, and a
//   normalising key (trim, toLowerCase) would let unequal arguments collide. The distinction decides whether the row is closed
//   or has to be read.
//
// THE TWO DEFINITIONS
//       desktop/preview-access.cjs:2491   const key = (id, origin) => id + '\0' + origin;
//       desktop/mcp-stdio-relay.cjs:1194  const key = id => `${typeof id}:${String(id)}`;
//
//   Neither transforms its arguments. `String(id)` is a serialisation, not a normalisation: it preserves the difference between
//   `1` and `'1'` deliberately, which is the opposite of folding them together.
//
// SO THE ROWS ARE CLOSED BY THE PROTOCOL, NOT BY THE CALLER
//       hostPending   set key(id)               get key(q.id)              JSON-RPC: a response's `id` IS the request's `id`
//       once          set key(state.id,origin)  get key(id,origin)         both are the same card's fields, read in one flow
//
//   With a pure key, the only way these can fail is if the two arguments differ at runtime — and in both cases a protocol or a
//   single-object origin says they do not. That is a stronger statement than "depends on the caller", and it is checkable by
//   reading two definitions plus two call sites, which is what this round did.
//
// WHY THIS IS NOT A NEW CLASS IN THE TOOL
//   Adding "pure key function" to `map-key-reach` would require resolving the callee's body — the parser R571 withdrew for. The
//   honest place for this conclusion is a record, not a detector: it applies to two rows, both read, and a future row with a
//   normalising key would need the same one-minute read rather than a rule that guesses.
//
// WHAT IS NOT CLAIMED
//   Not that every `same-callee-different-args` row in the tree is closed: this round read the two that exist in the Map
//   population. A third one added later would need the same treatment.
//   Not that `String(id)` is always safe: it distinguishes `1` from `'1'`, which is right here (JSON-RPC ids are typed) and
//   would be wrong for a key meant to treat them as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, NORMALISING_WOULD } from '../desktop/pure-key-closure.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The `key` definition in a module, as source text. */
function keyDef(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = /const key\s*=\s*[^;]{0,120};/.exec(src);
  assert.ok(m, `no key definition found in ${file}`);
  return m[0];
}

test('preview-access key is pure concatenation', () => {
  const def = keyDef('desktop/preview-access.cjs');
  // The source is minified: `const key=(id,origin)=>id+'\\0'+origin;` — no spaces around the arrows or operators.
  assert.ok(/id\s*\+\s*'\\0'\s*\+\s*origin/.test(def), 'the key is no longer a plain concatenation');
  assert.ok(!/trim|toLowerCase|toUpperCase|normalize/.test(def), 'the key now normalises an argument');
});

test('mcp-stdio-relay key serialises without folding', () => {
  const def = keyDef('desktop/mcp-stdio-relay.cjs');
  assert.match(def, /typeof id/, 'the key no longer prefixes the type');
  assert.match(def, /String\(id\)/, 'the key no longer stringifies the value');
  assert.ok(!/trim|toLowerCase|toUpperCase|normalize/.test(def), 'the key now folds case or whitespace');
});

test('hostPending is keyed by a JSON-RPC id on both sides', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'mcp-stdio-relay.cjs'), 'utf8');
  assert.match(src, /hostPending\.set\(key\(id\)/, 'the write no longer keys by the request id');
  assert.match(src, /hostPending\.get\(key\(q\.id\)\)/, 'the read no longer keys by the response id');
  // The protocol fact the argument rests on: this module validates the id shape before using it.
  assert.match(src, /validId\(q\.id\)/, 'the response id is no longer validated');
});

test('once is keyed by one card\'s own fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'preview-access.cjs'), 'utf8');
  assert.match(src, /once\.set\(key\(state\.id,state\.origin\)/, 'the write no longer uses state fields');
  assert.match(src, /once\.get\(key\(id,origin\)\)/, 'the read no longer uses the handler arguments');
});

test('a normalising key would be the case that needs a read, and none exists here', () => {
  // The point of the round: pureness is what closes these rows. Assert no key in the population normalises.
  const files = ['desktop/preview-access.cjs', 'desktop/mcp-stdio-relay.cjs'];
  for (const f of files) {
    const def = keyDef(f);
    assert.ok(!/\.trim\(\)|toLowerCase|toUpperCase/.test(def),
      `${f} now normalises, so its same-callee rows have to be re-read`);
  }
});

test('the record distinguishes protocol closure from caller closure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'pure-key-closure.cjs'), 'utf8');
  assert.ok(/PROTOCOL, NOT BY THE CALLER/.test(src), 'the closure reason is not stated');
  assert.ok(/PURE/.test(src), 'pureness is not named as the deciding property');
});

test('each key records why it is pure and what closes its rows', () => {
  assert.equal(KEYS.length, 2);
  for (const k of KEYS) {
    assert.ok(k.pure.length > 20, `${k.file} does not say why it is pure`);
    assert.ok(k.closesBy.length > 20, `${k.file} does not say what closes its rows`);
    assert.ok(k.rows.length >= 1, `${k.file} records no rows`);
  }
  assert.equal(NORMALISING_WOULD.nonePresent, true);
});
