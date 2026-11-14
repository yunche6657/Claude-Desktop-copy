'use strict';
// The reverse test: do the FUNCTION-NAME citations in the evidence ever point at a name that is not there? Answer: no. All 19
// candidates were artifacts of the check, and the reason is instructive.
//
// THE METHOD, AND WHY IT OVER-REPORTED
//   Step one counted every call-shaped token in evidence/ against the set of names defined anywhere in desktop/ tools/ test/.
//   That produced 755 "undefined" names, and the top of the list was `join`, `catch`, `require`, `readFileSync`, `deepEqual`,
//   `spawn` — language and library methods. Named functions are a small minority of what a technical document writes.
//
//   Step two narrowed it: only check a name when the SAME LINE also cites a repo file, on the theory that the identifier is then a
//   claim about that file. That produced 45 checks and 19 failures. Reading the 19 by hand, none is a wrong citation:
//
//       `blank` in `contract-union-r552.md`      defined in tools/lexer.cjs:39; the sentence cites a file that IMPORTS it
//       `blank` in `shared-lexer-r550.md`        the sentence is ABOUT two copies of blank(); naming the files is the subject
//       `isCurrent` in `snapshot-shape-r555.md`  defined at history-import-manifest.cjs:17 — the extractor missed it
//       `contractTools` in STATUS.md:30178       the sentence discusses contractTools, not a claim about the cited file
//       `handlers.get(` in `stale-comment-r601.md`  it is QUOTED TEXT being explained, not an assertion
//       `get`, `set`, `json`, `page`, `bridge`   ordinary words that happen to be in-repo names
//
//   So the 19 measure the check, not the record.
//
// WHAT THE CHECK WOULD HAVE TO DO TO BE WORTH RUNNING
//   A name mention is a claim only when the sentence says "X does Y" about a named file. Detecting that needs the sentence's
//   grammar, not a proximity heuristic — and a grammar is exactly what this round does not have. Proximity joins a citation to
//   whatever identifier shares its line, and technical prose puts them on one line constantly.
//
// WHAT THIS ADDS TO R619
//   R619 concluded that naming a function is the only form that survives. This round tried to falsify that by finding a name that
//   does not resolve, and could not: every candidate was an artifact. That is weaker evidence than a clean measurement would be —
//   it shows the check cannot find a wrong name, not that no wrong name exists — and it is stated as such.
//
// WHAT IS NOT CLAIMED
//   Not that every name in the evidence resolves: the check found 45 lines where a name and a file co-occur, out of 3711
//   call-shaped mentions. The other 3666 were never examined, and most are library methods.
//   Not that `blank` is defined once: R550's whole point was that two copies existed. The citation is right about the copies AND
//   the definition lives in lexer.cjs — both facts hold, which is why proximity misreads it.

/** The check, in both stages. */
const CHECK = {
  stage1: {
    method: 'every call-shaped token in evidence/ vs every name defined in the repo',
    mentions: 3711,
    distinctUndefined: 755,
    verdict: 'useless — the head of the list is join, catch, require, readFileSync, deepEqual, spawn',
  },
  stage2: {
    method: 'only names that DO exist somewhere, on a line that also cites a file',
    checks: 45,
    failures: 19,
    verdict: 'all 19 are artifacts; see WHY_EACH_FAILURE_IS_AN_ARTIFACT',
  },
};

/** Each failure, with what it really was. */
const ARTIFACTS = [
  { name: 'blank', doc: 'contract-union-r552.md', why: 'defined in tools/lexer.cjs:39; the cited file imports it' },
  { name: 'blank', doc: 'shared-lexer-r550.md', why: 'the sentence is ABOUT two copies of blank(); naming the files is the subject' },
  { name: 'isCurrent', doc: 'snapshot-shape-r555.md', why: 'defined at history-import-manifest.cjs:17 — the extractor missed it' },
  { name: 'contractTools', doc: 'STATUS.md:30178', why: 'the sentence discusses contractTools, not a claim about the cited file' },
  { name: 'handlers.get', doc: 'stale-comment-r601.md', why: 'quoted text being explained, not an assertion' },
  { name: 'get/set/json/page/bridge/tokens/engine', doc: 'various', why: 'ordinary words that happen to be in-repo names' },
];

/** Why a proximity rule cannot work here. */
const LIMIT = {
  rule: 'a name mention is a claim only when the sentence says "X does Y" about a named file',
  needs: 'the sentence grammar, which this round does not have',
  failsBecause: 'proximity joins a citation to whatever identifier shares its line, and technical prose puts them on one line constantly',
  soWhat: 'the 19 measure the check, not the record',
};

module.exports = { CHECK, ARTIFACTS, LIMIT };
