'use strict';
// The check found no falsified claim — the closest candidate was already disclaimed by its own author, one paragraph below the
// number. That is the result: the record's numbers decay, but the record says so where it matters.
//
// THE CHECK
//   Six tools were re-run and 45 evidence lines that name a tool and a number on one line were compared against the live output.
//   Fifteen agreed outright. Thirty did not, and reading them showed the comparison itself was wrong in every case:
//
//       emit-flag-ratio-r604.md:11    `clear-asymmetry | 1 | 1` — the "0" my scan read is a different column
//       sort-census-r613.md:10        `6 组 / 32 文件` — 32 is a FILE count, not the set count
//       sort-totality-r611.md:18      `31 组` — the tie count, not the map count
//       position-index-r616.md:42     `55 里 49 是...` — 55 is the position count, not either tool's output
//
//   Proximity again: a tool name and a number near it do not make an assertion about that tool's row count. R620 reached the same
//   conclusion about function names, and this is the third round where the probe was the error.
//
// THE ONE REAL CANDIDATE, AND WHY IT IS NOT AN ERROR
//   `set-lifetimes-r591.md:5` states "38 个", while the tool now reports 41 — R596 widened the comma-declaration match and found
//   three more. That looks like a published number going stale. But line 41 of the SAME document says:
//
//       **不声称 38 是稳定的**：**计数随文件增删而变，记录是工具本身。**
//
//   The author declared the number a snapshot and named the tool as the authority, in the document that carries the number. Nothing
//   in the record is falsified — the reader is told which artefact to trust.
//
// WHAT IS STILL A GAP, PRECISELY
//   The caveat says the count moves; it does not say it HAS moved. A reader who wants the current figure must re-run the tool. That
//   is the correct division of labour for a record that cannot run code, and it is why R623's 71% is a standing property rather than
//   a debt.
//
// WHAT IS NOT CLAIMED
//   Not that every published number survives this well: one of 45 had a disclaimer, and the disclaimer was found only because the
//   number was checked. The other 44 agreeing proves they were recomputed at some point, not that their disclaimer exists.
//   Not that proximity can be rescued: three rounds have now tried, and each attempt misread a table column, a file count, or a tie
//   count as a row count.

/** The check, with the reason 30 comparisons failed. */
const CHECK = {
  toolsRerun: 6,
  linesExamined: 45,
  agreed: 15,
  disagreed: 30,
  disagreementsAreProbeErrors: 30,
  examples: [
    'emit-flag-ratio-r604.md:11 — the 0 read is a different table column',
    'sort-census-r613.md:10 — 32 is a file count, not a set count',
    'sort-totality-r611.md:18 — 31 is a tie count, not a map count',
    'position-index-r616.md:42 — 55 is a position count, not a tool output',
  ],
};

/** The candidate that looked falsified and is not. */
const DISCLAIMED = {
  where: 'evidence/set-lifetimes-r591.md:5',
  states: '38 个',
  toolNow: 41,
  why: 'R596 widened the comma-declaration match and found three more',
  disclaimerAt: 'the same document, line 41',
  disclaimerText: '不声称 38 是稳定的：计数随文件增删而变，记录是工具本身',
  verdict: 'not falsified — the author named the tool as the authority in the document carrying the number',
  residualGap: 'the caveat says the count moves, not that it HAS moved; a reader must re-run the tool for the current figure',
};

module.exports = { CHECK, DISCLAIMED };
