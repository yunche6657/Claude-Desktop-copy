// R467: T3 — nullability prose vs schema. Result: consistent, and the reason the first attempt was
// not trustworthy is worth keeping.
//
// WHY T3 NEEDED A SURVEY FIRST
//   R466 ended with seven extractor bugs across two rounds, none a code defect. The rule for T3 was
//   therefore NOT invented up front: this round first enumerated every describe() carrying a
//   conditional/absence token, printed the prose with the field's schema flags, and only then judged.
//
// THE FIRST SURVEY'S ZERO WAS FALSE
//   My absence regex listed "may be null", "is absent when", "omitted when". The codebase actually
//   writes "If omitted, returns a summary…" (CtxInspectTool:20), which none of those match. A zero
//   produced by a regex that does not cover the observed phrasing is the same failure as R465's word
//   list and R466's whitespace-skipping prose extractor.
//
//   Fixing it (enumerate any of: omitted|absent|null|undefined|optional|only when|set when|present
//   when|if provided|when provided|when set|if set|empty|may be|can be) found 35 candidates.
//
// MEASURED
//     describes containing a conditional/absence token     35
//     field CAN be absent (optional/nullable)              34
//     field CANNOT be absent                                1
//
//   The single "cannot be absent" hit is:
//       SleepTool:15  duration_seconds  'How long to sleep in seconds. Can be interrupted by the user
//                                         at any time.'
//   "Can be interrupted" is behaviour, not nullability — a false positive of the token `can be`.
//   So: zero real inconsistencies.
//
// THE STRUCTURE THAT MAKES THE ZERO MEANINGFUL
//   The 34 agreeing cases are not vacuous. They split into recognisable families, each of which the
//   schema marks correctly:
//       "Optional X …"                      -> .optional()
//       "… If omitted, …" / "Set this ONLY when …"  -> .optional()
//       "Set when <condition>"              -> .optional()
//       "null when the file did not exist"   -> .nullable()
//   Seeing all four families present, and each matching, is what distinguishes "checked and clean"
//   from "the regex looked at nothing".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const T = (rel) => path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', rel);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const TOKEN = /\b(omitted|absent|null|undefined|optional|only when|set when|present when|if provided|when provided|when set|if set|empty|may be|can be)\b/i;

/** Field name and schema chain for the describe() at `idx`. */
function locate(text, idx) {
  const seg = text.slice(Math.max(0, idx - 900), idx);
  const decls = [...seg.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*/gm)];
  for (let k = decls.length - 1; k >= 0; k -= 1) {
    const d = decls[k];
    const after = seg.slice(d.index + d[0].length);
    if (/\bz\s*\./.test(after)) {
      return { field: d[1], chain: after };
    }
  }
  return { field: null, chain: '' };
}

/** Yield every describe() with prose, field, chain. */
function describes(text) {
  const out = [];
  for (const m of text.matchAll(/\.describe\(/g)) {
    let i = m.index + m[0].length;
    while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
    if (i >= text.length || !'\'"`'.includes(text[i])) continue;
    const q = text[i];
    let j = i + 1;
    const buf = [];
    while (j < text.length) {
      if (text[j] === '\\') { buf.push(text[j], text[j + 1]); j += 2; continue; }
      if (text[j] === q) break;
      buf.push(text[j]); j += 1;
    }
    const { field, chain } = locate(text, m.index);
    if (!field) continue;
    out.push({ prose: buf.join(''), field, chain, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

test('the scanner covers conditional-wording states, not just one phrasing', () => {
  // Guards the R467 first-attempt bug: a regex that only knew "may be null" saw nothing.
  for (const phrasing of [
    'Optional query to filter context entries. If omitted, returns a summary of all context.',
    'Set this ONLY when the user explicitly asks.',
    'Set when the command was killed by its timeout.',
    'The original file contents (null when the file did not exist)',
  ]) {
    assert.ok(TOKEN.test(phrasing), 'the token set misses a phrasing that occurs in this codebase: '
      + JSON.stringify(phrasing.slice(0, 50)));
  }
});

test('every conditionally-worded describe on a required field is accounted for', () => {
  const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
  const offenders = [];
  let withToken = 0;
  let canBeAbsent = 0;

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      if (e.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes('.describe(')) continue;
      for (const d of describes(text)) {
        if (!TOKEN.test(d.prose)) continue;
        withToken += 1;
        const optional = d.chain.includes('.optional()');
        const nullable = d.chain.includes('.nullable()');
        if (optional || nullable) { canBeAbsent += 1; continue; }
        offenders.push({
          file: path.relative(SRC, p), line: d.line, field: d.field,
          prose: d.prose.slice(0, 160),
        });
      }
    }
  };
  walk(TOOLS);

  // Coverage first: the previous attempt produced a zero from a scanner that matched nothing.
  assert.ok(withToken >= 30,
    `only ${withToken} conditionally-worded describes found; the token set is probably too narrow`);
  assert.ok(canBeAbsent >= 25,
    `only ${canBeAbsent} of ${withToken} resolve to optional/nullable fields: expected most to agree`);

  // The one known false positive: "Can be interrupted" describes behaviour, not presence.
  const real = offenders.filter((o) => o.field !== 'duration_seconds');
  assert.deepEqual(real, [],
    'prose promises absence/conditionality on a field the schema requires: ' + JSON.stringify(real));
});

test('the four wording families each match their schema flag', () => {
  // Concrete pairings, so the sweep cannot pass by matching nothing.
  const cases = [
    // "Optional X" -> .optional()
    ['CtxInspectTool/CtxInspectTool.ts', 'query', 'optional'],
    // "If omitted" -> .optional()
    ['ArtifactTool/ArtifactTool.ts', 'hash', 'optional'],
    // "Set when <condition>" -> .optional()
    ['BashTool/BashTool.tsx', 'timedOutAfterMs', 'optional'],
    // "null when ..." -> .nullable()
    ['FileEditTool/types.ts', 'originalFile', 'nullable'],
  ];
  for (const [rel, field, flag] of cases) {
    const text = read(T(rel));
    const d = describes(text).find((x) => x.field === field);
    assert.ok(d, `${rel}: no describe() found for ${field}`);
    assert.ok(d.chain.includes(`.${flag}()`),
      `${rel}: ${field} is not .${flag}() but its prose is "${d.prose.slice(0, 80)}"`);
  }
});

test('R456-FileEdit originalFile still documents its nullability', () => {
  // The field R442 and R456 both touched; its description is the anchor for the .nullable() family.
  const types = read(T('FileEditTool/types.ts'));
  assert.match(types, /null when the file did not exist/,
    'the nullability note for originalFile is gone: the schema is still .nullable()');
  assert.match(types, /\.nullable\(\)/, 'originalFile is no longer nullable');
});
