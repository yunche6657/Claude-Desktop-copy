'use strict';
// The import identity: what makes one account's history import distinct from another's.
//
// THREE COPIES, FOUND BY RANKING FOR CONCENTRATION
//   `['accountId','orgId','generation']` appears in three files of one family (`desktop/history-import-*`). Unlike the
//   fixture-name collisions that dominate a flat file-count ranking, this group is concentrated — one subject, three
//   files — which is where a shared rule lives. All three do the same two things:
//
//       guard:  !['accountId','orgId','generation'].every(k => typeof identity[k] === 'string' && identity[k])
//       key:    JSON.stringify([identity.accountId, identity.orgId, identity.generation])
//
//   The guard was byte-identical in `flow` and `transaction`; `fixture-host` adds `!path.isAbsolute(root) ||` in front,
//   which is that function's own precondition, not part of the rule. The key derivation was byte-identical in all three.
//
//   The key matters more than the guard: it is what two imports are compared BY. If one file ordered the array
//   differently — `[orgId, accountId, generation]` — imports from the same account would be treated as different
//   accounts, and the guard would still pass. Three hand-written copies of a composite key is exactly the shape where
//   that happens silently.
//
// WHAT IS NOT CLAIMED
//   Not that the three files should share more than this. They have different jobs (a fixture host, a flow, a
//   transaction) and each keeps its own error message and its own preconditions.
//   Not that the guard is complete: it requires three non-empty strings, and whether `generation` may legitimately be
//   absent is a product question this module does not decide.

/** The three identity fields, in key order. */
const IDENTITY_FIELDS = ['accountId', 'orgId', 'generation'];

/**
 * Is this a usable identity?
 *
 * @param {object} identity
 * @returns {boolean}
 */
function isIdentity(identity) {
  if (!identity) return false;
  return IDENTITY_FIELDS.every((k) => typeof identity[k] === 'string' && identity[k]);
}

/**
 * The comparison key for an identity.
 *
 * Field order is fixed here rather than at each call site, because the key's only purpose is to be compared with
 * another key produced elsewhere — an order that differed between two files would make equal identities unequal.
 */
function identityKey(identity) {
  return JSON.stringify(IDENTITY_FIELDS.map((k) => identity[k]));
}

module.exports = { IDENTITY_FIELDS, isIdentity, identityKey };
