// R468: the R465-R467 detectors applied to src/ — 505 more describe() calls, none defective.
//
// WHY src/ WAS WORTH SWEEPING
//   R465-R467 covered packages/builtin-tools (386 calls). src/ holds 505 — more than the tree already
//   checked — and no round had looked. Reusing detectors that were mutually validated by self-test is
//   the right way to extend coverage; inventing a fresh one per question is what produced eight
//   extractor bugs across three rounds.
//
// COVERAGE (measured, so a zero is not mistaken for a pass)
//     files with .describe(   12
//     .describe( calls       505
//     prose extracted        502   (99.4%)
//     field resolved         493
//     scalar / array         346 / 84
//     default claims           4
//     conditional-wording     29
//
// RESULTS
//     shape          0
//     count          0
//     default        0 real   (4 candidates, all resolved to a backing constant)
//     nullability    0 real   (5 candidates, all false positives of the token set)
//
// THE FOUR DEFAULT CLAIMS, RESOLVED
//     cleanupPeriodDays      "default: 30"     src/utils/cleanup.ts:23 DEFAULT_CLEANUP_PERIOD_DAYS = 30
//     sshPort                "default: 22"     settings fixture + consumer
//     webFetchHttpTimeoutMs  "Defaults to 60000" web-tools.tsx:203 `s.webFetchHttpTimeoutMs ?? 60000`
//     cacheThreshold         "Default: 70"     src/utils/cacheWarning.ts:33 DEFAULT_CACHE_THRESHOLD = 70
//
//   Three of the four are implemented OUTSIDE the schema file that documents them — in cleanup.ts,
//   web-tools.tsx and cacheWarning.ts. A detector that only searched the declaring file would have
//   reported "no implementation" for all four, which is exactly what the first pass did before the
//   values were chased.
//
// THE FIVE NULLABILITY FALSE POSITIVES, AND WHAT THEY TEACH
//   coreSchemas.ts  type        "When set, takes precedence…"   — input semantics, not presence
//   coreSchemas.ts  session_id  "…error_status is null for…"    — the null belongs to a SIBLING field;
//                                                                 my locator attached the union's
//                                                                 describe to the last member
//   keybindings     bindings    "Set to null to unbind…"        — z.null() is a legal VALUE in a union,
//                                                                 not an absent field
//   keybindings     bindings    "…or null to unbind"
//   plugins         package     "anything that can be passed…"  — `can be` = capability
//
//   The sibling-field case is the important one: a describe() on a wrapping z.object() can discuss a
//   member field, and attributing it to the last-declared member is a locator error, not a doc error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the four src/ default claims each have a backing constant', () => {
  // Each pairing is asserted at its real implementation site, not at the schema file that documents it.
  const cases = [
    ['src/utils/cleanup.ts', /const DEFAULT_CLEANUP_PERIOD_DAYS = 30\b/, 'cleanupPeriodDays'],
    ['src/utils/cacheWarning.ts', /const DEFAULT_CACHE_THRESHOLD = 70\b/, 'cacheThreshold'],
    ['src/commands/web-tools/web-tools.tsx', /webFetchHttpTimeoutMs \?\? 60000/, 'webFetchHttpTimeoutMs'],
  ];
  for (const [rel, re, field] of cases) {
    const body = read(SRC, ...rel.split('/'));
    assert.match(body, re,
      `${field}'s documented default has no backing constant in ${rel}: the description would be `
      + 'unsupported');
  }

  // sshPort is documented as 22 and is only supplied by consumers; assert the doc still says 22 so a
  // silent change is caught.
  const types = read(SRC, 'src', 'utils', 'settings', 'types.ts');
  assert.match(types, /SSH port \(default: 22\)/, 'the sshPort description changed');
  assert.match(types, /Number of days to retain chat transcripts \(default: 30\)/,
    'the cleanupPeriodDays description changed');
  assert.match(types, /HTTP timeout in milliseconds[^']*Defaults to 60000/,
    'the webFetchHttpTimeoutMs description changed');
  assert.match(types, /Default: 70\./, 'the cacheThreshold description changed');
});

test('src/ has no collection-prose-on-scalar mismatch', () => {
  // The rule validated in R465, applied to the tree it has not seen.
  const PLURALITY = /^\s*(?:(?:Every|All|Each|Any)\s+[A-Za-z]+|The\s+(?:list|array|set|collection)\s+of|(?:A|An)\s+(?:list|array|set|collection)\s+of|(?:List|Array)\s+of)/i;
  const SCALAR = ['number(', 'boolean(', 'string('];

  const hits = [];
  let calls = 0;
  let extracted = 0;

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      if (e.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/\.describe\(/g)) {
        calls += 1;
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
        extracted += 1;
        const prose = buf.join('');
        const seg = text.slice(Math.max(0, m.index - 900), m.index);
        const decls = [...seg.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*/gm)];
        let field = null;
        let chain = '';
        for (let k = decls.length - 1; k >= 0; k -= 1) {
          const after = seg.slice(decls[k].index + decls[k][0].length);
          if (/\bz\s*\./.test(after)) { field = decls[k][1]; chain = after; break; }
        }
        if (!field) continue;
        const isArray = /z\s*\.\s*array\(/.test(chain) || /\.array\(/.test(chain);
        const isScalar = SCALAR.some((s) => chain.includes(s)) && !isArray;
        if (isScalar && PLURALITY.test(prose)) {
          hits.push({ file: path.relative(SRC, p), field, prose: prose.slice(0, 120) });
        }
      }
    }
  };
  walk(path.join(SRC, 'src'));

  // Coverage gate first: src/ genuinely holds ~505 calls, so anything far below means the walk broke.
  assert.ok(calls > 450, `only ${calls} describe() calls found in src/; expected ~505`);
  assert.ok(extracted / calls > 0.98,
    `only ${(100 * extracted / calls).toFixed(1)}% of src/ describes yielded prose`);
  assert.deepEqual(hits, [],
    'collection-phrased description on a scalar field in src/: ' + JSON.stringify(hits.slice(0, 5)));
});

test('the nullability false positives are recorded as false positives', () => {
  // Each of these was flagged by the token rule and cleared by reading. Pinned so the next sweep does
  // not re-report them as findings.
  const core = read(SRC, 'src', 'entrypoints', 'sdk', 'coreSchemas.ts');
  // "When set" describes input semantics on a union, not presence.
  assert.match(core, /When set, takes precedence over the deprecated maxThinkingTokens/,
    'the thinking-option description changed: re-derive whether "when set" is still about semantics');

  // "error_status is null" belongs to a sibling field inside the same object describe.
  assert.match(core, /error_status: z\.number\(\)\.nullable\(\)/,
    'error_status is no longer nullable, so the sentence about it being null would be wrong');
  assert.match(core, /error_status is null for connection errors/,
    'the sentence attributing null to error_status changed');

  const kb = read(SRC, 'src', 'keybindings', 'schema.ts');
  // z.null() is a legal VALUE meaning "unbind", not an absent field.
  assert.match(kb, /z\.null\(\)\.describe\('Set to null to unbind a default shortcut'\)/,
    'the null-unbind sentinel changed: re-derive whether null still means unbind');

  const plugins = read(SRC, 'src', 'utils', 'plugins', 'schemas.ts');
  assert.match(plugins, /anything else that can be passed to `npm`/,
    'the npm package description changed');
});

test('src/ schemas are documented for humans, so optionality is often unstated', () => {
  // Context for future sweeps: many src/ fields are .optional() with no absence wording at all, which
  // is why the nullability rule yields almost nothing here compared with builtin-tools.
  const types = read(SRC, 'src', 'utils', 'settings', 'types.ts');
  const optionalCount = (types.match(/\.optional\(\)/g) || []).length;
  const absenceWords = (types.match(/\b(omitted|absent|null|undefined)\b/gi) || []).length;
  assert.ok(optionalCount > 50, `settings/types.ts has only ${optionalCount} .optional() fields`);
  assert.ok(absenceWords < optionalCount,
    'every optional field now explains its absence: the nullability rule would become worth rerunning '
    + 'here with a tighter token set');
});
