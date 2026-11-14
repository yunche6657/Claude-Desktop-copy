// R429: BashOutput.gitOperation — reporting a detection that already ran and was discarded.
//
// THE SHAPE OF THIS FIX
//   BashTool.tsx already did, on every call:
//
//       trackGitOperations(input.command, result.code, result.stdout)
//
//   That call exists for analytics. `detectGitOperation`, in the same module, returns exactly the
//   structure the contract declares:
//
//       { commit?: { sha, kind }, push?: { branch },
//         branch?: { ref, action }, pr?: { number, url, action } }
//
//   So nothing new is detected — the same detection now also reaches the output. That is why this
//   was cheap, and why it was worth checking "does the data already exist" before building.
//
// WHY THE OTHER SIX BASH FIELDS WERE NOT ADDED
//   They have no source at all:
//       staleReadFileStateHint  — WRITE_COMMAND_MARKERS appears nowhere in the repo
//       ghRateLimitHint         — no gh rate-limit detection anywhere
//       backgroundCwdHint / backgroundEndsWithFinalResponse / backgroundWakesOwner — zero hits
//       timedOutAfterMs         — the timeout value exists but is not surfaced on expiry
//   A field whose value can never be produced is worse than an absent one: the model would read a
//   permanently-optional field as "no git activity", "no rate limit", etc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const BASH = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'BashTool', 'BashTool.tsx');
const TRACKING = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'shared',
  'gitOperationTracking.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const bash = () => fs.readFileSync(BASH, 'utf8');

test('the contract still declares gitOperation with four optional members', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('gitOperation?');
  assert.ok(at > 0, 'gitOperation disappeared from BashOutput');
  const seg = dts.slice(at, at + 900);
  for (const k of ['commit?', 'push?', 'branch?', 'pr?']) {
    assert.ok(seg.includes(k), 'gitOperation lost its ' + k + ' member');
  }
});

test('detectGitOperation is imported from the same module as the tracker', () => {
  const b = bash();
  assert.match(b, /import \{ detectGitOperation, trackGitOperations \} from '\.\.\/shared\/gitOperationTracking\.js'/,
    'the import no longer pulls both names from one module — re-derive what is being detected');
  // The tracker must still be there: removing it would silently drop the analytics path.
  assert.match(b, /trackGitOperations\(input\.command, result\.code, result\.stdout\)/,
    'the analytics call is gone: git activity metrics would stop being recorded');
});

test('the detection result reaches the output object', () => {
  const b = bash();
  assert.match(b, /gitOperation = detectGitOperation\(input\.command, result\.stdout\)/,
    'the detection result is not captured');
  assert.match(b,
    /\.\.\.\(gitOperation && Object\.keys\(gitOperation\)\.length > 0 \? \{ gitOperation \} : \{\}\)/,
    'gitOperation is not conditionally spread into the data object');
  // A plain `ls` must not carry an empty object.
  assert.ok(!/gitOperation:\s*\{\}/.test(b),
    'an empty gitOperation object is being emitted on every call');
});

test('the declaration sits OUTSIDE the try block', () => {
  // The first attempt placed it inside, next to `let generatorResult`, and TS2304 showed that the
  // data object — assembled after the catch — could not see it.
  const b = bash();
  const declAt = b.indexOf('let gitOperation: ReturnType<typeof detectGitOperation> | undefined');
  assert.ok(declAt > 0, 'the declaration is gone');

  const tryAt = b.indexOf('    try {\r\n      // Use the new async generator version of runShellCommand');
  const dataAt = b.indexOf('gitOperation && Object.keys(gitOperation).length > 0');

  assert.ok(tryAt > 0, 'the try-block anchor moved; re-derive the scope claim');
  assert.ok(dataAt > tryAt, 'the data assembly is no longer after the try block');
  assert.ok(declAt < tryAt,
    'the declaration is inside the try block again: the data assembly cannot see it (TS2304)');

  // And exactly one declaration: the patch once inserted it twice.
  assert.equal((b.match(/let gitOperation(:| )/g) || []).length, 1,
    'gitOperation is declared more than once (TS2451)');
});

test('the schema declares gitOperation as optional with the contract enums', () => {
  const b = bash();
  const at = b.indexOf('const outputSchema');
  assert.ok(at > 0, 'BashTool lost its outputSchema');
  const end = b.indexOf('type OutputSchema', at);
  const seg = b.slice(at, end > 0 ? end : at + 4000);

  // 6-space indent: the field sits inside z.object({ at the same level as its siblings.
  // 4-space indent, matching its siblings. The first insertion used 6, which was inconsistent and
  // also broke any reader that keyed off the schema's top-level indentation (R434 hit exactly that).
  assert.ok(/^\s{4}gitOperation: z/m.test(seg), 'the schema does not declare gitOperation');
  assert.match(seg, /gitOperation: z[\s\S]{0,1600}?\.optional\(\)/,
    'gitOperation is not optional');

  // The enum members must match the tracker's own types, not be invented here.
  for (const k of ["'committed'", "'amended'", "'cherry-picked'", "'merged'", "'rebased'"]) {
    assert.ok(seg.includes(k), 'the schema is missing the enum value ' + k);
  }
});

test('the schema enums match the tracker source rather than diverging', () => {
  // A hand-written enum can drift from the module that produces it. Compare against the source of
  // truth so a change there fails here.
  const tracking = fs.readFileSync(TRACKING, 'utf8');
  assert.match(tracking, /export type CommitKind = 'committed' \| 'amended' \| 'cherry-picked'/,
    'CommitKind changed: the Bash schema enum must follow');
  assert.match(tracking, /export type BranchAction = 'merged' \| 'rebased'/,
    'BranchAction changed: the Bash schema enum must follow');

  const b = bash();
  for (const k of ['committed', 'amended', 'cherry-picked', 'merged', 'rebased']) {
    assert.ok(b.includes("'" + k + "'"), 'the Bash schema is missing ' + k);
  }
});

test('the fields without a data source stay absent', () => {
  // Recorded so a later round does not assume they were forgotten. Each needs a mechanism, not a
  // schema line. R434 removed `timedOutAfterMs` from this list by wiring it — the timeout value
  // existed in ShellCommand and only lacked a structured carrier.
  const b = bash();
  for (const missing of ['backgroundCwdHint', 'backgroundEndsWithFinalResponse',
    'backgroundWakesOwner']) {
    assert.ok(!b.includes(missing),
      missing + ' appeared in BashTool: if a source was added, wire it and update this list');
  }
  // These two DO appear in the contract comments describing behaviour that is not implemented.
  assert.ok(!/staleReadFileStateHint:|ghRateLimitHint:/.test(b),
    'a hint field was added without its detection mechanism');

  // And the one that WAS wired keeps its field.
  assert.ok(b.includes('timedOutAfterMs'),
    'timedOutAfterMs disappeared: the R434 fix regressed');
});

test('the adopted bundle carries the new field', () => {
  const { text } = findChunk('Structured git/gh operations detected in this command');
  assert.ok(text.includes('gitOperation'),
    'gitOperation is missing from the built chunk');
});
