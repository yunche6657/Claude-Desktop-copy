'use strict';
// The helper-module blind spot R578 left open: measured, and it is EMPTY.
//
// THE QUESTION
//   R578 widened `group-provenance`'s reading rule to cover a bundle path declared once and joined later, which raised the
//   recognised count from 36 of 69 executing test files to 52. It closed by noting the remaining gap:
//
//       a test could import a helper module that does the reading, in which case neither spelling appears in the test
//       file at all, and the rule cannot see it
//
//   That is answerable rather than merely noted. A test is blind to the rule only if BOTH hold:
//
//       the test file executes a slice   (vm.runInNewContext / new Function / eval)
//       the test file does NOT read official material itself
//       at least one module it imports DOES read official material
//
// MEASURED
//       test files importing a project module            306
//       ... whose own text reads official material         62
//       ... importing at least one module that does        89
//       EXEC + official reads only via an import            0
//
//   Zero. The gap is closed, and it is closed by the code's shape rather than by luck: every test that runs a slice also
//   reads the bundle in its own file. The two activities are not factored apart anywhere in this repository.
//
// WHY THE ZERO IS WORTH RECORDING RATHER THAN JUST NOTING
//   A gap that turns out to be empty is a fact about the codebase, and it changes what the next round should do: there is no
//   import-graph tool to build. Writing it down stops the same question from being re-opened in five rounds because someone
//   read R578's paragraph and assumed the worse case was live.
//
// A SECOND MEASUREMENT THAT DID NOT HOLD UP
//   Counting "project modules that read official material" gave 16, and reading them showed most are false: the pattern
//   matched through an English possessive in comment prose — `'s own renderer/ served over loopback`, `'s init frame`.
//   A quote followed by prose containing `ion-dist` or `asar` is not a path. That count is therefore NOT recorded as a fact
//   here; only the blind-spot measure, which requires a `readFileSync` AND an exec in the same file, is.
//
// WHAT IS NOT CLAIMED
//   Not that no test reads official material through a helper — the zero says no test does it while ALSO executing a slice
//   without reading itself. A helper-only read with no exec in the test is a different question with a different answer.
//   Not that the 89 figure is sound: it inherits the same possessive problem, so it is an upper bound on "imports a module
//   that reads official material", not a count of such modules.

/** The three conditions, as data, so a future check can reuse them instead of re-deriving. */
const BLIND_SPOT = {
  executing: 'vm.runInNewContext | new Function( | eval(',
  officialPath: 'ccd-ref | asar/.vite | .vite/build | ion-dist | pinned-ion | agent-core/claude-code/dist',
  reading: 'readFileSync(',
  requiresAll: ['executing', 'not-reading-self', 'imports-a-reader'],
};

/** The measurement, with what makes it a measurement rather than an impression. */
const MEASUREMENT = {
  testsImportingProjectModule: 306,
  readingOfficialInOwnText: 62,
  importingAModuleThatReads: 89,
  blindSpot: 0,
  note: 'the 89 is an upper bound: the module-side check matched through English possessives in comment prose, so some of '
    + 'the "reads official material" modules are not. The blind-spot figure does not depend on that check going the other '
    + 'way, because zero is reached by finding no test that satisfies all three conditions.',
};

module.exports = { BLIND_SPOT, MEASUREMENT };
