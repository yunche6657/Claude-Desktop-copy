// R469: prompt text numbers — surveyed, classified, and the boundary documented.
//
// THE PREDICTION THIS ROUND TESTED
//   R468 ended by predicting that prompt numbers are mostly behavioural and that the right outcome
//   would be to document the boundary rather than force a detector. Measured: 138 numeric sentences
//   across 45 prompt.ts files, of which only 3 are phrased as limits, and those 3 are 2 distinct
//   claims. Everything else is model guidance ("3-5 words", "under 70 characters"), behaviour
//   ("fires up to 10% of its period late"), or protocol/data values (HTTP 429, UTF-8).
//
// THE TWO DISTINCT LIMITS, RESOLVED DIFFERENTLY
//
//   1. FileReadTool  "Maximum 20 pages per request."   ENFORCED, and cannot drift
//        src/constants/apiLimits.ts:77   export const PDF_MAX_PAGES_PER_READ = 20
//        FileReadTool.ts:242             `… Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`
//        FileReadTool.ts:443             if (rangeSize > PDF_MAX_PAGES_PER_READ) { …reject… }
//      The prompt INTERPOLATES the constant, so prompt and validator are the same value by
//      construction. Nothing to check.
//
//   2. WebFetchTool  "Enforce a strict 125-character maximum for quotes…"   ADVISORY
//      The string 125 occurs exactly once in the whole tool — in prompt.ts:31. There is no quote-length
//      validation, no MAX_QUOTE constant, no .length comparison on quotes. It is an instruction to the
//      model, like "be concise".
//
// WHY NEITHER IS A DEFECT, AND WHY THAT IS THE INTERESTING PART
//   Case 1: coupling is structural — the description cannot disagree with the code.
//   Case 2: there is no code to disagree with — nothing implements the 125.
//   A detector demanding a backing constant for case 2 would report a "finding" that is not a defect.
//   That is exactly the category error R468 warned about before this survey began, and it is why the
//   survey ran first.
//
// THE ONLY REAL DEFECT SHAPE HERE
//   A prompt that states a number AND a validator that uses a DIFFERENT hardcoded number. Neither of
//   the two cases above has that shape (one interpolates, the other has no validator). The test below
//   pins the shape so a future drift — replacing the interpolation with a literal — is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const T = (rel) => path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', rel);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the PDF page limit is interpolated from its constant, not hardcoded in prose', () => {
  const limits = read(SRC, 'src', 'constants', 'apiLimits.ts');
  assert.match(limits, /export const PDF_MAX_PAGES_PER_READ = 20\b/,
    'the constant moved or changed value: the prompt and validator both read it');

  const tool = read(T('FileReadTool/FileReadTool.ts'));
  // The prompt interpolates it.
  assert.match(tool, /Maximum \$\{PDF_MAX_PAGES_PER_READ\} pages per request\./,
    'the prompt no longer interpolates the constant — a literal here could drift from the validator');
  // And a validator rejects over-limit ranges with the same constant.
  assert.match(tool, /if \(rangeSize > PDF_MAX_PAGES_PER_READ\)/,
    'the page-range validator is gone: the prompt would state a limit nothing enforces');

  // No bare "Maximum 20 pages" literal anywhere in the tool.
  assert.ok(!/Maximum 20 pages/.test(tool),
    'the number was hardcoded into prose: prompt and validator can now drift independently');
});

test('the WebFetch quote limit is advisory — no code implements it', () => {
  const dir = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'WebFetchTool');
  let occurrences = 0;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      const body = fs.readFileSync(p, 'utf8');
      const n = (body.match(/\b125\b/g) || []).length;
      if (n > 0) { occurrences += n; files.push([path.relative(dir, p), n]); }
    }
  };
  walk(dir);

  // The claim is that 125 lives only in the prompt. If a validator appears, this test should fail so
  // the classification is revisited.
  assert.equal(occurrences, 1,
    `125 appears ${occurrences} time(s) in WebFetchTool at ${JSON.stringify(files)}; expected exactly `
    + 'once (the prompt). A second occurrence would mean code enforces it, making the claim checkable '
    + 'rather than advisory');
  assert.deepEqual(files, [['prompt.ts', 1]],
    'the single 125 is no longer in prompt.ts');

  // And nothing validates quote length.
  const tool = read(T('WebFetchTool/WebFetchTool.ts'));
  assert.ok(!/MAX_QUOTE/.test(tool), 'a quote-length constant appeared: re-classify the 125 as enforced');
});

test('the survey total is stable, so the "only 3 limits" claim can be re-derived', () => {
  // Counting numeric sentences is fuzzy; counting the files is not. Pin the file count so a new
  // prompt.ts (which could carry new limits) is noticed.
  const tools = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
  let prompts = 0;
  for (const e of fs.readdirSync(tools, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(tools, e.name, 'prompt.ts'))) prompts += 1;
  }
  assert.equal(prompts, 45,
    `prompt.ts file count changed to ${prompts}: re-run the numeric survey before trusting the `
    + '"only 3 limit-phrased claims" conclusion');
});

test('prompt guidance numbers are style rules, not implementable limits', () => {
  // Representative examples, asserted as prose so a future round does not mistake them for defects.
  const bash = read(T('BashTool/prompt.ts'));
  assert.match(bash, /Keep the PR title short \(under 70 characters\)/,
    'the PR-title guidance changed');
  assert.ok(!/MAX_PR_TITLE|PR_TITLE_LIMIT/.test(bash),
    'a PR-title constant appeared: the 70 is now enforced and should be checked against the prose');

  const agent = read(T('AgentTool/prompt.ts'));
  assert.match(agent, /short description \(3-5 words\)/,
    'the agent description guidance changed');
  assert.ok(!/DESCRIPTION_WORD|lintDescription|validateDescription/.test(agent),
    'a description linter appeared: the 3-5 word rule would now be enforced and checkable');
});
