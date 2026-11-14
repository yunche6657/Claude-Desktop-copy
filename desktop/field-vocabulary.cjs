'use strict';
// The field-name survey came back the wrong way round: `file` is perfectly uniform, and the five "line" names are not five
// spellings of one concept — four of them are already the same name, and the other three are three different things.
//
// THE MEASUREMENT
//       file-path field names      1   `file`, used by all eight tools
//       line-number field names    5   declaredAt, coMentionLine, line, denialLine, witnessLine
//
//   The naive reading is "five names for line numbers, so the vocabulary is fragmented". Reading what the values MEAN refutes it:
//
//       declaredAt       178   the line where the SET is declared          used by FOUR tools, same name and same meaning
//       coMentionLine     45   the line where two names appear together    a co-occurrence, not a declaration
//       line              10   the comment line being examined             the subject itself
//       denialLine       275   the denying comment's line                  subject, first of a pair
//       witnessLine      728   the observing comment's line                subject, second of a pair
//
//   So FOUR tools already agree on `declaredAt`; they did so before this round looked. The three remaining names are three
//   distinct meanings, and merging them would be the mistake: `denialLine` and `witnessLine` are two ends of a comparison and
//   calling both `line` would destroy the only thing the row says.
//
// WHY THE SURVEY WAS STILL WORTH DOING
//   Because the hypothesis was cheap and the answer is now a fact instead of an assumption. "Do the tools share a vocabulary"
//   is the kind of question that is answered wrongly by glancing at two outputs: `map-key-reach` shows `declaredAt` and
//   `stale-comment` shows `line`, which reads like divergence, and is not.
//
// THE ONE REAL ASYMMETRY
//   `file` is uniform but `path` is absent, so no tool ever emits a bare path — every subject is `file` + a line-ish field. That
//   is a coherent convention and it is stated nowhere. A reader writing cross-tool code would discover it by trying.
//
// WHAT IS NOT CLAIMED
//   Not that a shared vocabulary is desirable: `denialLine`/`witnessLine` earn their names. The finding is that no unification is
//   needed, which is a different result from "the names are inconsistent" and a more useful one.
//   Not that the survey is complete: it looked at numeric fields named like lines and string fields named like files. A `col`,
//   `offset`, or `range` field would not be found — and none of the eight tools emits one.

/** The two field families, measured. */
const VOCABULARY = {
  file: { names: ['file'], tools: 8, uniform: true, note: 'every subject is a file plus a line-ish field; no bare `path`' },
  line: {
    names: ['declaredAt', 'coMentionLine', 'line', 'denialLine', 'witnessLine'],
    count: 5,
    uniform: false,
    alreadyShared: { name: 'declaredAt', tools: ['set-lifetimes', 'set-reset-reach', 'set-key-symmetry', 'map-key-reach'] },
  },
};

/** Each distinct meaning, so a reader can see the five names are not one concept. */
const MEANINGS = [
  { field: 'declaredAt', example: 178, meaning: 'the line where the set is declared', kind: 'declaration position' },
  { field: 'coMentionLine', example: 45, meaning: 'the line where two names appear together', kind: 'co-occurrence' },
  { field: 'line', example: 10, meaning: 'the comment line being examined', kind: 'subject' },
  { field: 'denialLine', example: 275, meaning: "the denying comment's line", kind: 'subject, first of a pair' },
  { field: 'witnessLine', example: 728, meaning: "the observing comment's line", kind: 'subject, second of a pair' },
];

/** The conclusion, which is the opposite of the hypothesis. */
const CONCLUSION = {
  hypothesis: 'five names for line numbers means the vocabulary is fragmented',
  refuted: 'four tools share `declaredAt` with one meaning; the other three names are three different meanings',
  mergingWouldBreak: 'denialLine and witnessLine are two ends of one comparison — calling both `line` destroys what the row says',
  realAsymmetry: '`file` is uniform and `path` is absent, a coherent convention stated nowhere',
};

module.exports = { VOCABULARY, MEANINGS, CONCLUSION };
