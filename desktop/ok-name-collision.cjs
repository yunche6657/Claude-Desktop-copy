'use strict';
// `ok` has eleven truthy reads in one file and they are TWO DIFFERENT FIELDS. This is the case that invalidated a scan.
//
// THE READ THAT SETTLED R574's QUESTION
//   R574 keyed "strict producer, truthy consumer" by FIELD NAME and produced `ok` as the top row — 11 truthy reads, a
//   `Boolean(updated)` producer in the same file. Reading the eleven showed the key was wrong:
//
//       bridge-services.cjs:2582,2587,2913   return { ok: Boolean(updated) };      a PROJECT object
//       bridge-services.cjs:4015             if (!response.ok) {                   Response.ok, an HTTP status
//       bridge-services.cjs:4111             if (!response.ok) return fallback;    same
//       bridge-services.cjs:5064             if (!response.ok) throw new Error(…); same
//       bridge-services.cjs:5361             if (!result.ok) return result;        a project object, different producer
//
//   `response.ok` is a property the PLATFORM defines; it is not this project's contract and no project-side strict
//   producer says anything about it. `result.ok` is a project value, and five of its six reads are
//   `cancelled: Boolean(result && result.ok)` — already strict.
//
// WHAT THAT FORCED
//   Pairing by receiver: `response.ok` and `result.ok` are different subjects. And a read inside `Boolean(…)` is a strict
//   read, not a lax one — stripping those removed the five sites that were never in question.
//
//   After both corrections `ok` left the top of the list entirely. The detector now reports 110 lax reads instead of 117,
//   and the six that disappeared were the ones that would have wasted a reader's attention.
//
// WHY THIS IS THE ROUND'S FINDING RATHER THAN A DETOUR
//   A detector whose top row is a false positive does not get read a second time, and this project has produced several:
//   R557 measured a detector that flagged 31 of 31 groups, R571 withdrew a liveness rule after three wrong versions. The
//   pattern is the same each time — the KEY was wrong, not the idea. Here the key was a field name; the fix was the object
//   it belongs to.
//
// WHAT REMAINS UNANSWERABLE
//   Pairing by receiver still cannot prove a receiver's type. `result.ok` is a name; whether `result` holds the object
//   `{ ok: Boolean(updated) }` returned is beyond a text scan. What the pairing buys is that each remaining row is about
//   ONE expression, so a reader answers it by following that expression — which is how the eleven `ok` sites were answered.
//
//   It also still miscounts: `b.isCurrent` appears with 3 reads, and reading them showed the receiver `b` is unrelated — the
//   pattern captured `if (!b)` style tests and attributed a neighbouring property. That row is a false positive of the new
//   key, recorded rather than patched, because patching the pattern a fourth time is what R571 did.

/** The two fields that share the name `ok`, and the read that distinguishes them. */
const OK_FIELDS = [
  {
    subject: 'response.ok',
    kind: 'platform',
    reader: 'desktop/bridge-services.cjs',
    lines: [4015, 4111, 5064],
    note: 'a Response property; boolean by the platform\'s definition. No project producer applies, so a "strict producer"'
      + ' found elsewhere under the same name is a coincidence of naming.',
  },
  {
    subject: 'result.ok',
    kind: 'project',
    reader: 'desktop/bridge-services.cjs',
    lines: [2539, 2544, 2551, 2556, 2948, 5361],
    note: 'five of the six reads are `cancelled: Boolean(result && result.ok)` — already strict — and the sixth is'
      + ' `if (!result.ok) return result;`. Not a lax contract.',
  },
  {
    subject: 'project `ok` producer',
    kind: 'producer',
    reader: 'desktop/bridge-services.cjs',
    lines: [2582, 2587, 2913],
    note: '`return { ok: Boolean(updated) }` — the field the name-keyed scan matched against `response.ok`.',
  },
];

module.exports = { OK_FIELDS };
