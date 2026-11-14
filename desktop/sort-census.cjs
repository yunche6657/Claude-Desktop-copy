'use strict';
// R611 said two tools sort with a non-total comparator. There are four. Correcting the census, and adding the one with the
// weakest order of all.
//
// THE CORRECTION
//   R611 read two comparators and concluded "two tools". A full scan of the same eight tools finds FIVE that sort:
//
//       tools/source-divergence.cjs   a.file || a.name                              TOTAL      0 tied groups
//       tools/set-lifetimes.cjs       a.file                                        ONE KEY    6 groups
//       tools/set-key-symmetry.cjs    rank || a.file                                TWO KEYS   2 groups
//       tools/set-reset-reach.cjs     tier || a.file                                TWO KEYS   6 groups
//       tools/map-key-reach.cjs       score || a.file                               TWO KEYS  31 groups
//
//   So four of five comparators leave ties undecided, not two. R611's `map-key-reach` figure of 31 was right and is the
//   largest; what it missed was that three more tools have the same shape at smaller scale.
//
// THE WORST ONE IS THE ONE R611 DID NOT LOOK AT
//   `set-lifetimes` sorts by FILE ALONE. Every set declared in one file is a tie, so the output order within a file is entirely
//   input order — no rank, no secondary key, nothing. Six of its 32 files hold more than one set, and THREE of them tie at
//   three sets each: `comment-selfmatch.cjs` (`seen`, `usedThen`, `matchedNow`), `unhandled-called.cjs` and
//   `unhandled-null.cjs` (both `literal`, `looped`, `declared`). They tie on COUNT, not on content — and which of the three
//   files prints first is, again, undecided: the disorder reaching even the identification of the worst case.
//
//   That is a weaker order than `map-key-reach`'s, whose 31 groups at least have a score to sort by first. The tool with the most
//   ties and the tool with the least ordering are different tools, and R611 named only the first.
//
// `source-divergence` IS THE MODEL
//   It already has three keys (`file`, then `name`), and it produces zero tied groups — a total order. That is the shape the other
//   four would take with one added term, and it is the argument for the fix rather than an abstract preference: one tool in this
//   set already does it.
//
// WHY THIS IS STILL NOT APPLIED
//   Same reason R608 and R611 gave, now with a larger blast radius: four outputs would reorder, and rounds R593, R594, R591 and
//   R611 quote rows by position or by "the first one". Applying it needs a round that re-reads all four.
//
// WHAT IS NOT CLAIMED
//   Not that tied groups are a defect count: `set-key-symmetry`'s 2 groups are two files holding two sets each at the same rank,
//   which is ordinary. The number measures how much order is left to chance, not how wrong anything is.
//   Not that a total order is always better: `set-lifetimes` sorting only by file may be deliberate — the file IS the grouping.
//   The finding is that the intra-file order is unowned, not that name order would mean something.

/** Every tool that sorts, with its keys and its measured ties. */
const SORTING = [
  {
    tool: 'tools/source-divergence.cjs',
    keys: ['file', 'name'],
    total: true,
    tiedGroups: 0,
    note: 'the model — already a total order',
  },
  {
    tool: 'tools/set-lifetimes.cjs',
    keys: ['file'],
    total: false,
    tiedGroups: 6,
    ofFiles: 32,
    note: 'one key only: every set in a file ties, so intra-file order is pure input order',
    // THREE files tie at the widest COUNT — and which of them the sort emits first is itself undecided. They do not hold
    // the same sets: the first is (seen, usedThen, matchedNow), the other two are (literal, looped, declared).
    worst: [
      { file: 'tools/comment-selfmatch.cjs', sets: ['seen', 'usedThen', 'matchedNow'] },
      { file: 'tools/unhandled-called.cjs', sets: ['literal', 'looped', 'declared'] },
      { file: 'tools/unhandled-null.cjs', sets: ['literal', 'looped', 'declared'] },
    ],
    worstCount: 3,
  },
  {
    tool: 'tools/set-key-symmetry.cjs',
    keys: ['rank', 'file'],
    total: false,
    tiedGroups: 2,
    note: 'rank is `deletes > 0 && !agrees`; two files hold two sets each at the same rank',
  },
  {
    tool: 'tools/set-reset-reach.cjs',
    keys: ['tier', 'file'],
    total: false,
    tiedGroups: 6,
  },
  {
    tool: 'tools/map-key-reach.cjs',
    keys: ['score', 'file'],
    total: false,
    tiedGroups: 31,
    note: 'the largest tie count; widest group is session-kernel.cjs at score 0 with 18 sets',
  },
];

/** What R611 said, and the correction. */
const CORRECTION = {
  r611Said: 'two tools sort with a non-total comparator',
  actual: 'five tools sort; four of them leave ties undecided',
  missed: ['set-lifetimes.cjs (one key)', 'set-key-symmetry.cjs (two keys)', 'source-divergence.cjs (total, so correctly absent from the problem set)'],
  why: 'R611 read two comparators and generalised from them without enumerating the rest',
  worst: 'set-lifetimes sorts by file alone — the weakest order in the set, and R611 did not look at it',
};

module.exports = { SORTING, CORRECTION };
