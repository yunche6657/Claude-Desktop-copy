'use strict';
// A checklist for the next session: every rule here was paid for by a specific failure in R621–R632, and each one names the round
// so a reader can go read the cost.
//
// The theme of those twelve rounds is not the codebase. It is the measurement of the codebase — and the recurring finding is that
// the instruments were right and the readings were wrong.
//
// HOW TO USE THIS
//   Before writing a number into evidence, find the row whose symptom matches. If none matches, the number is probably fine and
//   this list has a gap worth recording.
//
// WHAT THIS IS NOT
//   Not a style guide: every row is a MEASURED failure, not a preference.
//   Not exhaustive of all practice: only R621–R632 were mined. Earlier rounds' lessons are in their own documents.

/** Each rule: what not to do, why, the round that proved it, and what it cost. */
const RULES = [
  {
    rule: 'Do not infer ownership from proximity',
    symptom: 'a tool name and a number on one line, or a comment and a symbol in one function',
    why: 'a name near a number does not make the number a claim about that tool',
    rounds: ['R621', 'R622', 'R624', 'R625', 'R626'],
    cost: 'two false DRIFTs, ten false evidence rows, thirty false mismatches, five false file claims — all my reading, none the data',
  },
  {
    rule: 'Count `if (` only after excluding `else if`',
    symptom: 'a branch count that does not close when added up',
    why: '`else if (` also matches `if (`; 322 total means 315 plain plus 7 else-if',
    rounds: ['R625', 'R626'],
    cost: 'my hand count gave 360 and a claim looked wrong; the tool\'s 352 closed exactly',
  },
  {
    rule: 'Exclude `.catch(` when counting catch branches',
    symptom: 'a catch count higher than the tool reports',
    why: 'a promise method call is not a branch statement',
    rounds: ['R626'],
    cost: 'my 32 versus the tool\'s 24 — the 8 difference is method calls',
  },
  {
    rule: 'Use `statSync(p).isFile()`, not `existsSync(p)`',
    symptom: 'EISDIR: illegal operation on a directory, read',
    why: 'existsSync is true for a directory too, and the throw escapes the loop',
    rounds: ['R628'],
    cost: 'a tool threw on every run for an unknown number of rounds, invisible because its test read its source instead of running it',
  },
  {
    rule: 'Do not treat a mention in a generated index as coverage',
    symptom: '"all N tools are mentioned" where the mention is in SCRIPT-INDEX or TOPIC-INDEX',
    why: 'an index that enumerates tools cannot fail to mention them — the property holds by construction',
    rounds: ['R630', 'R631'],
    cost: '189/189 was true and uninformative; the real answer was 129 in tests plus 10 cited plus 41 cited nowhere',
  },
  {
    rule: 'Read the unit before comparing a number',
    symptom: '"FILE has N" where N is added lines, branches, or top-level tests rather than file length',
    why: 'a line count comparison calls all five such claims wrong',
    rounds: ['R625'],
    cost: 'five claims looked false and all five were right',
  },
  {
    rule: 'A derived number must be asserted as a relation, not a snapshot',
    symptom: '`assert.equal(total, 24)` over a population that grows every round',
    why: 'a snapshot of an append-only population goes stale by construction',
    rounds: ['R620', 'R621'],
    cost: 'three consecutive rounds of false failures before the counters were rewritten as `>=` and `sum === total`',
  },
  {
    rule: 'Report a negative result as a negative result',
    symptom: 'a sweep that finds nothing, reported as "nothing found"',
    why: 'a complete negative closes a question; "nothing found" leaves it open',
    rounds: ['R629', 'R630'],
    cost: 'without it, "is any tool invisible" would be re-asked instead of answered',
  },
];

/** The single sentence the twelve rounds reduce to. */
const SUMMARY = {
  claim: 'the instruments were right and the readings were wrong',
  evidence: 'R621, R622, R624, R625, R626 are all one misreading each; R626 in particular had the tool correct on both counts',
  howToApply: 'before writing a number, find the matching symptom above; if none matches, the number is probably fine and the gap is worth recording',
  notA: 'not a style guide — every row is a measured failure, not a preference',
};

module.exports = { RULES, SUMMARY };
