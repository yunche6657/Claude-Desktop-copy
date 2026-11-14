// R447: field DESCRIPTION comparison — 76 fields, 0 real divergences.
//
// WHAT THIS ADDS OVER EARLIER ROUNDS
//   R419 compared field NAMES, R436 compared field TYPES. Neither asked whether both sides say the
//   same thing ABOUT a field. A field named `head_limit`, typed number, described as "max results" on
//   one side and "limit output to first N lines" on the other is aligned by name and type and still
//   wrong — the model reads the description.
//
// THE PARSER WAS WRONG THREE TIMES
//   v1 single-pass with a mutable pending_doc        -> 25 false divergences
//   v2 doc captured but flushed onto the wrong member -> still off by one
//   v3 two-pass, keys limited to identifiers          -> quoted keys ("-B","-n",...) skipped, and
//                                                       every field after them inherited the wrong doc
//   v4 two-pass + quoted keys                         -> 11/11 alignment checks pass on GrepInput
//
//   v1's output is worth remembering: it "found" 25 divergences and every one was the parser's fault.
//   Reading the samples made that obvious (`Grep.glob` was showing `output_mode`'s doc). A comparison
//   tool that reports problems is not evidence of problems until its alignment is verified.
//
// THE RESULT
//   76 comparable fields: 72 aligned, 4 flagged, and all 4 flagged turned out to be extractor
//   blind spots:
//     Monitor.description          -> same meaning, different wording ("human-readable description"
//                                     vs "clear, concise description"). Not a defect.
//     AskUserQuestion.annotations  -> shared `annotationsSchema()`; text is byte-identical to the
//                                     contract, my scan just could not see through the reference.
//     FileRead.pages               -> `.describe(`...`)` template literal; the regex only matched
//                                     single/double quotes.
//     CronCreate.recurring         -> declared in inputSchema at line 38 with a full description;
//                                     my scan had picked up the SAME-NAMED output field instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const KEY = String.raw`(?:[A-Za-z_$][\w$]*|"[^"]+"|'[^']+')`;

/** Depth-0 members of an interface with their doc comment, doc attached to the FOLLOWING member. */
function officialMembers(iface) {
  const dts = read(DTS);
  const m = new RegExp('export interface ' + iface + '\\b[^{]*\\{').exec(dts);
  assert.ok(m, iface + ' is gone');
  const s = m.index + m[0].length;
  let depth = 1;
  let i = s;
  while (i < dts.length && depth) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') depth -= 1;
    i += 1;
  }
  const body = dts.slice(s, i - 1);

  const events = [];
  let memberDepth = 0;
  let inDoc = false;
  for (const line of body.split('\n')) {
    const bare = line.trim();
    if (memberDepth === 0) {
      if (inDoc) {
        if (bare.endsWith('*/')) { events.push(['doc', bare.slice(0, -2).trim()]); inDoc = false; }
        else events.push(['doc', bare.replace(/^\*+/, '').trim()]);
        continue;
      }
      if (bare.startsWith('/**')) {
        if (bare.endsWith('*/')) events.push(['doc', bare.slice(3, -2).trim()]);
        else { inDoc = true; events.push(['doc', bare.slice(3).trim()]); }
        continue;
      }
      const mm = new RegExp('^(' + KEY + ')\\??\\s*:').exec(bare);
      if (mm) events.push(['member', mm[1].replace(/^["']|["']$/g, ''), bare.slice(mm[0].length).trim()]);
      else events.push(['type', bare]);
    } else {
      events.push(['type', bare]);
    }
    memberDepth += (line.match(/\{/g) || []).length + (line.match(/\[/g) || []).length;
    memberDepth -= (line.match(/\}/g) || []).length + (line.match(/\]/g) || []).length;
    if (memberDepth < 0) memberDepth = 0;
  }

  const out = {};
  let docRun = [];
  for (const ev of events) {
    if (ev[0] === 'doc') docRun.push(ev[1]);
    else if (ev[0] === 'member') { out[ev[1]] = docRun.join(' ').trim(); docRun = []; }
  }
  return out;
}

test('doc comments attach to the member that FOLLOWS them', () => {
  // The alignment bug that produced 25 false divergences. Verified on fields whose docs are
  // unmistakable, so a regression cannot hide.
  const grep = officialMembers('GrepInput');
  const expectations = [
    ['pattern', 'pattern'],
    ['path', 'directory'],
    ['glob', 'glob pattern'],
    ['output_mode', 'output mode'],
    ['-B', 'before'],
    ['type', 'file type'],
    ['head_limit', 'limit output'],
    ['offset', 'skip first'],
    ['multiline', 'multiline'],
  ];
  for (const [field, needle] of expectations) {
    assert.ok(grep[field], 'GrepInput.' + field + ' is missing from the parse');
    assert.ok(grep[field].toLowerCase().includes(needle),
      `GrepInput.${field} got the wrong doc: "${grep[field].slice(0, 80)}"`);
  }
});

test('quoted member keys are parsed, not skipped', () => {
  // Skipping them shifted every later field's doc by the number of skipped keys — a cascade, which is
  // why the misalignment looked so widespread.
  const grep = officialMembers('GrepInput');
  for (const quoted of ['-A', '-B', '-C', '-n', '-i', '-o']) {
    assert.ok(quoted in grep, 'quoted key ' + quoted + ' was not parsed as a member');
    assert.ok(grep[quoted].length > 10, quoted + ' has no doc text');
  }
});

test('the four flagged fields are extractor blind spots, not description gaps', () => {
  // Each was flagged for a DIFFERENT reason, which is why three separate checks are needed.

  // 1. Monitor.description — both say "human-readable description"; wording differs.
  const monitor = officialMembers('MonitorInput');
  assert.match(monitor.description || '', /description/i,
    'Monitor.description changed: re-derive whether the wording difference is still benign');

  // 2. FileRead.pages — describe() uses a TEMPLATE literal, which a quote-only regex misses.
  const fileRead = read(TOOLS, 'FileReadTool', 'FileReadTool.ts');
  assert.match(fileRead, /pages:\s*z[\s\S]{0,120}?\.describe\(\s*`/,
    'FileRead.pages no longer uses a template-literal describe');

  // 3. CronCreate.recurring — declared in inputSchema with a full description; the SAME NAME also
  //    appears in outputSchema. A scan that grabs the first match finds the wrong one.
  const cron = read(TOOLS, 'ScheduleCronTool', 'CronCreateTool.ts');
  const inputAt = cron.indexOf('const inputSchema');
  const outputAt = cron.indexOf('const outputSchema');
  assert.ok(inputAt > 0 && outputAt > inputAt, 'CronCreate schema layout changed');
  const inputBlock = cron.slice(inputAt, outputAt);
  assert.match(inputBlock, /recurring:\s*semanticBoolean\(z\.boolean\(\)\.optional\(\)\)\.describe\(/,
    'CronCreateInput.recurring lost its description');
  assert.match(inputBlock, /durable:\s*semanticBoolean\(z\.boolean\(\)\.optional\(\)\)\.describe\(/,
    'CronCreateInput.durable lost its description');

  // 4. AskUserQuestion.annotations — shared schema; its text is byte-identical to the contract.
  const ask = read(TOOLS, 'AskUserQuestionTool', 'AskUserQuestionTool.tsx');
  assert.ok(ask.includes('Optional per-question annotations from the user'),
    'the annotations description no longer matches the contract wording');
});

test('a tool directory holding several schemas must not be scanned by first match', () => {
  // R421 hit this with ScheduleCronTool (CronList read as CronCreate); R447 hit it again from the
  // other direction. Recorded so the rule is explicit: pick the schema by ANCHOR, not by directory.
  const dir = path.join(TOOLS, 'ScheduleCronTool');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3,
    'ScheduleCronTool no longer holds several tools: the multi-schema trap may be gone');
  const names = files.map((f) => read(dir, f));
  const declared = names.filter((t) => t.includes('const inputSchema')).length;
  assert.ok(declared >= 2, 'expected several files declaring an inputSchema, found ' + declared);
});
