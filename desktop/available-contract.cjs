'use strict';
// The `available` boolean: every producer, every consumer, and why the shape is now consistent.
//
// THE DEFECT R569 FOUND, AND WHAT R574 CHECKED AROUND IT
//   `kernel-fallback.cjs` decided `reprobe.available` for truthiness. `normaliseProbe` guarantees a boolean:
//
//       kernel-select.cjs:31   const available = Boolean(probe && probe.available);
//       kernel-select.cjs:34   available,
//
//   so a caller passing `{ available: 'yes' }` — bypassing the normaliser — made the fallback decide to PROPAGATE. R569
//   fixed it to `=== true`.
//
//   R574 then scanned for the same shape everywhere and found 117 truthy reads of strictly-produced fields. Almost all
//   were noise: `ok`, `pending`, `model`, `code` are ordinary names that happen to be assigned a `Boolean(...)` somewhere
//   else. The scan could not tell "this field IS a boolean" from "this name is a boolean in one place and a string in
//   another", because that needs types.
//
//   But one group was worth reading, and reading it settled the question: `kernel-select.cjs` itself reads
//   `probe.available` truthily at lines 78, 85 and 99 — and those reads are CORRECT, because every value they touch came
//   through `normaliseProbe`:
//
//       kernel-select.cjs:65   const normalised = [];
//       kernel-select.cjs:73   const byId = new Map(normalised.map((probe) => [probe.id, probe]));
//       kernel-select.cjs:78   if (probe && probe.available) {      // probe came from byId
//
//   So the shape is: strict producer → strict consumer everywhere INSIDE kernel-select, and the one place that once read a
//   RAW probe was kernel-fallback, which is fixed. The contract is now consistent, and the consistency is the thing worth
//   pinning: a future edit that reads a raw probe truthily would be the regression.
//
// WHY NOT TIGHTEN THE OTHER 117
//   Because a truthy read of a boolean is not a bug. `if (x.available)` and `if (x.available === true)` differ only for
//   non-boolean input, and for input the producer guarantees to be boolean they are identical. Adding `=== true` to
//   seventeen places that cannot receive a non-boolean would be churn that makes the one place that CAN receive one
//   harder to spot.
//
// WHAT IS PINNED HERE
//   The producer is strict, the in-module consumers are strict-by-construction, and the one consumer that reads a raw
//   probe is the one R569 fixed.

/** The strict producer, and the guarantee it makes. */
const PRODUCER = {
  file: 'desktop/kernel-select.cjs',
  line: 31,
  expression: 'Boolean(probe && probe.available)',
  guarantee: 'the normalised `available` is a boolean, and `normaliseProbe` is the only way probes enter selectKernel',
};

/**
 * Consumers that read `available` truthily and are CORRECT, because the value came through the normaliser.
 */
const STRICT_BY_CONSTRUCTION = [
  { file: 'desktop/kernel-select.cjs', line: 78, reads: 'probe.available', source: 'byId, built from normalised' },
  { file: 'desktop/kernel-select.cjs', line: 85, reads: 'fallback.available', source: 'byId, built from normalised' },
  { file: 'desktop/kernel-select.cjs', line: 99, reads: 'probe.available', source: 'byId, built from normalised' },
];

/**
 * The one consumer that reads a RAW probe, and therefore must compare strictly.
 */
const STRICT_REQUIRED = {
  file: 'desktop/kernel-fallback.cjs',
  line: 43,
  expression: "reprobe.available === true ? 'propagate' : 'fallback'",
  why: 'the caller can pass anything; treating the string "false" as agreement would propagate a failure that should '
    + 'have fallen back. The line number moved from 24 to 43 when the module grew a comment block — a reminder that these '
    + 'coordinates are checked by a test, not trusted.',
};

module.exports = { PRODUCER, STRICT_BY_CONSTRUCTION, STRICT_REQUIRED };
