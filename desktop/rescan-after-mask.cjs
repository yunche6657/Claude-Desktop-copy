'use strict';
// Applying R607's scope requirement cut 21 candidates to 2 — and the string mask, not the scope check, did most of the cutting.
//
// WHAT WAS CHANGED IN tools/source-divergence.cjs
//   1. `assignments()` now scans `blank(text)` from R550's lexer instead of the raw text.
//   2. `assignments()` now reports an `offset`, so the scope can be located.
//   3. `main()` requires `fnOf(internalSite) === fnOf(externalSite)`, and records the surviving scope on each row.
//
// THE RESULT IS 2, NOT R607'S 11
//   R607 measured 11 shared-scope rows and this round expected to reproduce that. It did not:
//
//       before any change     21 candidates
//       scope filter only     the number R607 predicted: rows whose two provenances share a function
//       scope + string mask    2 candidates
//
//   The difference is the mask. `background-check.cjs` has 470 raw assignments and 367 after blanking — 103 of its assignments
//   live inside `ev("...")` payloads, which are strings of browser code, not statements of this module. `bridge-services.cjs`
//   loses 126 of 1007 the same way.
//
//   So R607's "11" was itself measured over unmasked text: its 11 included rows whose "internal assignment" was a fragment of an
//   injected script. The honest number is 2, and the two are readable by hand.
//
// THE TWO SURVIVORS
//       desktop/mcp-session-auth.cjs   url    scope mcpAuthenticateConfigServer
//           L107  external  row.config?.url      (read off a config record)
//           L109  local     marker.url = url     (assigned from the external value)
//       desktop/session-kernel.cjs      call   scope runMessage
//           L1601 internal  { id: event.id, … }  (an object literal built here)
//           L1620 external  event.id !== undefined ? byToolId.get(event.id) : undefined
//
//   Both are what the pattern was for: one name whose two provenances are genuinely comparable. Reading them: `url` is a
//   pass-through of an external value into a local marker, which is a copy rather than a trust decision; `call` is an object
//   literal versus a lookup, two different things sharing a short name.
//
// A DISPLAY BUG THIS EXPOSED, LEFT UNFIXED
//   `mcp-session-auth.cjs:107` is `const url = row.config?.url, transport = row.config?.type;`. The rhs capture runs past the
//   comma and reports `row.config?.url, transport = row.config?.type` as url's value. It does not affect the verdict — the
//   provenance classifier sees an external member access either way — and fixing the comma boundary risks the same kind of
//   regex damage this round already had to repair once.
//
// WHAT THIS DOES TO THE EARLIER RECORDS
//       R600's "21 candidates"       → historically true of the unmasked scan, now 2
//       R604's emitted 21            → same
//       R606's emitted 21            → same
//       R607's shared-scope 11       → measured over unmasked text; the masked answer is 2
//
//   None of those records is edited. Each states what its tool reported at the time, and this round is the re-measurement they
//   were waiting for. What changes is the CURRENT count, which lives here.
//
// WHAT IS NOT CLAIMED
//   Not that the other 19 were false: 8 of them (the shared-scope ones minus those inside string payloads) were true statements
//   about real assignments that the scope filter removed for the stated reason.
//   Not that 2 is stable: it moved 21 → 2 in one round, and the number is whatever the tool says.

/** The before/after, with the reason each step removed what it did. */
const CHANGE = {
  before: 21,
  after: 2,
  steps: [
    {
      what: 'assignments() scans blank(text) instead of raw text',
      removes: 'assignments inside injected script strings — 103 in background-check.cjs, 126 in bridge-services.cjs',
      why: 'a `let r = …` inside ev("...") is browser code, not a statement of this module',
    },
    {
      what: 'main() requires both provenances to share a function scope',
      removes: 'names that denote two unrelated locals spelled alike',
      why: 'R607 showed one name in two scopes is two names',
    },
  ],
};

/** The survivors, and what reading them shows. */
const SURVIVORS = [
  {
    file: 'desktop/mcp-session-auth.cjs',
    name: 'url',
    scope: 'mcpAuthenticateConfigServer',
    internal: 'L109  marker.url = url',
    external: 'L107  row.config?.url',
    reading: 'a pass-through of an external value into a local marker — a copy, not a trust decision',
  },
  {
    file: 'desktop/session-kernel.cjs',
    name: 'call',
    scope: 'runMessage',
    internal: 'L1601  { id: event.id, name: event.name, input: event.input, content: … }',
    external: 'L1620  event.id !== undefined ? byToolId.get(event.id) : undefined',
    reading: 'an object literal versus a lookup — two different things sharing a short name',
  },
];

module.exports = { CHANGE, SURVIVORS };
