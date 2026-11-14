'use strict';
// Both `key` functions are PURE — no trim, no case folding. So "same callee, different arguments" cannot hide a match.
//
// WHAT R597 LEFT OPEN
//   It classified `hostPending` (`key(id)` / `key(q.id)`) and `once` (`key(state.id,state.origin)` / `key(id,origin)`) as
//   `same-callee-different-args`, and said the argument difference "depends on the caller, not on the key function". True but
//   imprecise: with a PURE key the two sides agree exactly when their arguments are equal at runtime; with a NORMALISING key
//   (trim, toLowerCase) unequal arguments could collide. That difference decides whether a row is closed or must be read.
//
// THE TWO DEFINITIONS
//       desktop/preview-access.cjs:2491   const key = (id, origin) => id + '\0' + origin;
//       desktop/mcp-stdio-relay.cjs:1194  const key = id => `${typeof id}:${String(id)}`;
//
//   Neither transforms its arguments. `String(id)` is a serialisation, not a normalisation — it preserves the distinction
//   between `1` and `'1'` on purpose, which is the opposite of folding them together.
//
// SO THE ROWS CLOSE BY THE PROTOCOL, NOT BY THE CALLER
//       hostPending   set key(id)               get key(q.id)          JSON-RPC: a response's `id` IS the request's `id`
//       once          set key(state.id,origin)  get key(id,origin)     both are the same card's fields, read in one flow
//
//   With a pure key the only failure is unequal arguments at runtime — and in both cases the protocol or a single-object origin
//   says they are equal. That is stronger than "depends on the caller", and it is checkable by reading two definitions plus two
//   call sites, which is what this round did.
//
// WHY THIS IS NOT A NEW CLASS IN THE TOOL
//   Adding "pure key function" to `map-key-reach` would require resolving the callee's body — the parser R571 withdrew for. The
//   honest place for this conclusion is a record, not a detector: it covers two rows, both read, and a future row with a
//   normalising key needs the same one-minute read rather than a rule that guesses.
//
// WHAT IS NOT CLAIMED
//   Not that every `same-callee-different-args` row in the tree is closed: these are the two in the Map population. A third one
//   added later needs the same treatment.
//   Not that `String(id)` is always safe: distinguishing `1` from `'1'` is right for JSON-RPC ids and would be wrong for a key
//   meant to treat them as one.

/** The two key definitions, and what makes each pure. */
const KEYS = [
  {
    file: 'desktop/preview-access.cjs',
    line: 2491,
    definition: "const key = (id, origin) => id + '\\0' + origin;",
    pure: 'concatenation only — no transformation of either argument',
    rows: [{ name: 'once', set: 'key(state.id,state.origin)', get: 'key(id,origin)' }],
    closesBy: 'single-object origin: both sides are the same card\'s fields, read inside one request flow',
  },
  {
    file: 'desktop/mcp-stdio-relay.cjs',
    line: 1194,
    definition: 'const key = id => `${typeof id}:${String(id)}`;',
    pure: 'a type prefix and String() — a serialisation that keeps 1 and "1" distinct',
    rows: [{ name: 'hostPending', set: 'key(id)', get: 'key(q.id)' }],
    closesBy: 'protocol: a JSON-RPC response\'s id is the request\'s id, and the module validates it with validId() first',
  },
];

/** What a normalising key would change. */
const NORMALISING_WOULD = {
  effect: 'two unequal arguments could produce one key, so a row could match for the wrong reason',
  nonePresent: true,
  why: 'both definitions inspected; neither calls trim, toLowerCase or toUpperCase',
};

module.exports = { KEYS, NORMALISING_WOULD };
