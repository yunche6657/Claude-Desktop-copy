'use strict';
// Two tools sort with a comparator that is not a total order. The output is stable in practice, and nothing guarantees it.
//
// THE COMPARATORS
//       tools/map-key-reach.cjs     score(b) - score(a) || a.file.localeCompare(b.file)
//       tools/set-reset-reach.cjs   order[a.tier] - order[b.tier] || a.file.localeCompare(b.file)
//
//   Both use TWO keys: a rank, then the file. Two rows with the same rank in the SAME FILE compare equal, so the comparator
//   returns 0 and the order between them is whatever the sort's stability preserves — the input order.
//
// MEASURED: HOW OFTEN THAT HAPPENS
//       map-key-reach    31 groups hold more than one set at one score in one file
//       the worst        session-kernel.cjs at score 0 — 18 sets in one group
//       set-reset-reach  see the run output; the tier+file grouping is the same shape
//
//   So in `map-key-reach` the intra-group order of 31 groups, one of them 18 sets wide, is decided by input order alone. A reader
//   who reads "the first row" of such a group is reading the filesystem's opinion.
//
// WHY IT IS STABLE ANYWAY, AND WHY THAT IS NOT A GUARANTEE
//   Two independent facts make the output identical run to run today:
//
//       V8's Array.prototype.sort is stable, so equal rows keep input order
//       readdirSync returns the same order on the same directory of the same filesystem
//
//   Measured: three consecutive runs of each of four tools produce byte-identical output, and two readdirSync calls in one
//   process agree. Both facts are environmental, not contractual. A different Node version's sort, a different filesystem (a
//   network share, a case-insensitive volume), or a copied tree can reorder the ties, and the tools have no test that would
//   notice — because no test asserts an order at all.
//
// THE FIX IS ONE TERM
//   Adding `|| a.name.localeCompare(b.name)` makes both comparators total: score, then file, then set name. Every tie becomes
//   decidable, the output stops depending on filesystem enumeration, and an order assertion becomes possible to write.
//
//   This round does NOT apply it, for the reason R608 gave about its own deferred fix: changing the order changes every
//   recorded position, and three rounds quote rows by index or by "the first one". Applying it belongs in a round that also
//   re-reads those.
//
// WHAT IS NOT CLAIMED
//   Not that the current output is wrong: it is deterministic here and now, and every consumer reads all rows rather than
//   relying on which comes first.
//   Not that a third key is always wanted: for `set-reset-reach` the name is arguably meaningless within a tier, and grouping by
//   file is the intent. The point is that the ORDER WITHIN A FILE is currently unowned, not that name order is better.
//   Not that only these two sort: `stale-comment` and `source-divergence` build rows in scan order and never sort, so their order
//   is filesystem order plus declaration order — the same implicit dependency without even a comparator to inspect.

/** The two comparators, their keys, and what the missing key leaves undefined. */
const COMPARATORS = [
  {
    tool: 'tools/map-key-reach.cjs',
    comparator: 'score(b) - score(a) || a.file.localeCompare(b.file)',
    keys: ['score', 'file'],
    missing: 'name',
    groupsWithTies: 31,
    worst: { file: 'desktop/session-kernel.cjs', score: 0, sets: 18 },
  },
  {
    tool: 'tools/set-reset-reach.cjs',
    comparator: 'order[a.tier] - order[b.tier] || a.file.localeCompare(b.file)',
    keys: ['tier', 'file'],
    missing: 'name',
    groupsWithTies: null,
    worst: null,
  },
];

/** Why the output is identical today, and why that is environmental. */
const STABILITY = {
  today: 'three consecutive runs of four tools produce byte-identical output; two readdirSync calls in one process agree',
  dependsOn: ['V8 Array.prototype.sort being stable', 'readdirSync returning a fixed order on one filesystem'],
  wouldChangeWith: ['a different Node version', 'a network or case-insensitive volume', 'a copied tree'],
  unaudited: 'no test asserts row order at all, so a reorder would pass silently',
};

/** The one-term fix, and why it is deferred. */
const FIX = {
  term: '|| a.name.localeCompare(b.name)',
  effect: 'makes both comparators total, so every tie is decidable and an order assertion becomes writable',
  deferredBecause: 'changing the order moves every recorded position, and three rounds quote rows by index or by "the first one"',
};

module.exports = { COMPARATORS, STABILITY, FIX };
