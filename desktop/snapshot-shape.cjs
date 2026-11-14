'use strict';
// The version rule shared by the manifest reader and the import transaction.
//
// WHY THIS EXISTS
//   `desktop/history-import-manifest.cjs:7-11` and `desktop/history-import-transaction.cjs:43-46` each validate a
//   snapshot's `version` with the SAME four conditions, character for character:
//
//       !['string','number'].includes(typeof snapshot.version)
//       (typeof snapshot.version==='number' && !Number.isSafeInteger(snapshot.version))
//       (typeof snapshot.version==='string' && !snapshot.version)
//       typeof snapshot.isCurrent!=='function'
//
//   Only the Set field differs (`sourceSessionIds` vs `cliSessionIds`) and only the error message differs. That is
//   R551's shape again — one rule, two copies — and the two copies are the gate on whether a resumed import may
//   proceed, so a change to one and not the other would let an import through in one path and not the other.
//
// WHAT STAYS AT THE CALL SITES, AND WHY IT IS NOT UNIFIED HERE
//   The two guards differ in how they treat `isCurrent()`, and the difference is deliberate:
//
//     manifest      awaits `snapshot.isCurrent()` INSIDE the condition, so a stale snapshot throws the same error as a
//                   malformed one — "unavailable".
//     transaction   assigns `owned`/`version`/`isCurrent` first, then awaits the check separately, so it can throw
//                   "Ownership snapshot changed" — a different fact, reported differently.
//
//   The transaction's ordering looks like a defect and is not: `owned`, `version` and `isCurrent` are locals of
//   `context()`, and the throw prevents `context()` from returning, so the early assignment is unreachable from
//   outside. R555 checked this rather than "fixing" it.
//
// WHAT IS NOT CLAIMED
//   Not that the version rule itself is correct — only that it is now one function. `Number.isSafeInteger` rejects
//   `1.5`, which is intended for a monotonic counter; whether a string version may be `'0'` is a product question this
//   module does not decide (`!snapshot.version` rejects `''` but accepts `'0'`).
//
// A THIRD PLACE CHECKS `version`, MORE WEAKLY, AND THAT IS NOT THE SAME RULE
//   `desktop/session-kernel.cjs:586` has `!['string', 'number'].includes(typeof snapshot.version)` inside the guard that
//   decides whether a CLI-MCP snapshot may be used. It does NOT have the `isSafeInteger`, non-empty-string or
//   `isCurrent` clauses, and R556 measured the gap: of 13 inputs the two rules disagree on 7 — the kernel accepts `NaN`,
//   `Infinity`, `1.5`, `''`, and a snapshot whose `isCurrent` is not callable.
//
//   That looks like three implementations of one rule at two strictness levels, and it is not. `snapshot.version` is
//   never READ in session-kernel.cjs — it appears at L586 and nowhere else — so the clause there is a shape check
//   ("does this snapshot look like the kind I understand"), while this module's rule guards a value that a resumed
//   import will persist and compare. Two different questions that happen to share one line.
//
//   R556 recorded this instead of unifying them. Making the kernel check strict would reject snapshots it currently
//   accepts for no benefit, since the stricter clauses protect a value it never uses.

/** The four conditions on `version`/`isCurrent`, quoted from both call sites. */
function versionProblem(snapshot) {
  if (!['string', 'number'].includes(typeof snapshot.version)) return 'type';
  if (typeof snapshot.version === 'number' && !Number.isSafeInteger(snapshot.version)) return 'unsafe-integer';
  if (typeof snapshot.version === 'string' && !snapshot.version) return 'empty-string';
  if (typeof snapshot.isCurrent !== 'function') return 'is-current-not-callable';
  return null;
}

/**
 * The whole shape check, parameterised by the Set field name.
 *
 * @param {object} snapshot the provider's snapshot
 * @param {string} idsField which property must be a Set
 * @returns {string|null} a short reason, or null when the snapshot is usable
 */
function snapshotProblem(snapshot, idsField) {
  if (!snapshot) return 'absent';
  if (snapshot.complete !== true) return 'incomplete';
  if (!(snapshot[idsField] instanceof Set)) return 'ids-not-a-set';
  return versionProblem(snapshot);
}

module.exports = { versionProblem, snapshotProblem };
