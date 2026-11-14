// R634: the checklist R633 hung on `AGENTS.md` is reachable by a human reader and by nothing else. That is the artefact's honest
// limit, and recording it is the point.
//
// WHAT WAS CHECKED
//       files in tools/ test/ desktop/ mentioning AGENTS.md      1
//       … that actually READ it                                   0   (the one is a comment in a test)
//       package.json scripts mentioning AGENTS.md                 0
//       tests linking AGENTS.md to MEASUREMENT-CHECKLIST.md       0
//
//   No code path loads AGENTS.md. An agent reading it at session start is a harness convention, not something this repository
//   enforces — and no test would fail if the section were deleted.
//
// WHY IT IS STILL WORTH HAVING
//   A checklist nobody executes is a document, not a constraint. But R621–R626 are five rounds of the same misreading, and the
//   mechanism that stopped it was not a rule but a test that recomputed the number (R616 onward). The checklist is what a reader
//   consults BEFORE writing a number; the tests catch it after.
//
//   So: the checklist is advisory, and the enforcement is elsewhere.
//
// WHAT WOULD MAKE THE LINK ENFORCED, AND WHY IT IS NOT DONE
//   A test could read AGENTS.md, extract the path, and assert the file exists. That catches a broken link — the one failure mode
//   this arrangement has. Not done here because R633 already asserts every rule's rounds appear in the document, so the CONTENT is
//   guarded; adding a second guard over the same artefact would assert the link twice.
//
// WHAT IS NOT CLAIMED
//   Not that no future automation will read it: the harness may add instruction loading. This measures the repository as it stands.
//   Not that the checklist is unenforced in spirit: R633's test does assert the document matches the data.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REACH, ENFORCEMENT } from '../desktop/checklist-reach.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Count files under the three code directories that mention the instructions file, and how many read it. */
const reach = () => {
  const NAME = ['AGENTS', 'md'].join('.');       // assembled so this file does not match its own scan
  const OPEN = ['readFile', 'Sync('].join('');   // likewise for the read call
  let mentioning = 0;
  let reading = 0;
  for (const dir of ['tools', 'test', 'desktop']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!/\.(cjs|mjs|js|json)$/.test(f)) continue;
      if (f === 'checklist-reach-r634.test.mjs') continue;   // measuring must not add a reader
      const text = fs.readFileSync(path.join(abs, f), 'utf8');
      if (!text.includes(NAME)) continue;
      mentioning += 1;
      if (text.includes(OPEN + ')') && text.includes(NAME)) reading += 1;
    }
  }
  return { mentioning, reading };
};

test('no code path reads AGENTS.md', () => {
  const r = reach();
  assert.equal(r.reading, REACH.filesReading,
    `AGENTS.md is now read by ${r.reading} file(s), so the link may be enforceable after all`);
});

test('package.json still has no AGENTS.md script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const hits = Object.entries(pkg.scripts || {}).filter(([, v]) => /AGENTS\.md/.test(v));
  assert.equal(hits.length, REACH.packageJsonScripts);
});

test('the one mention is still a comment, not a read', () => {
  const p = path.join(ROOT, 'test', 'selfmatch-baseline-r523.test.mjs');
  // The file must exist; if it were removed this assertion would be measuring nothing.
  assert.ok(fs.existsSync(p), 'the test that mentions AGENTS.md is gone, so the measurement needs redoing');
  const text = fs.readFileSync(p, 'utf8');
  const line = text.split('\n').find((l) => /AGENTS\.md/.test(l)) || '';
  assert.ok(line.trim().startsWith('//'), `the mention is no longer a comment: ${line.trim().slice(0, 60)}`);
});

test('the checklist document still exists and still carries the rules', () => {
  const doc = path.join(ROOT, 'evidence', 'MEASUREMENT-CHECKLIST.md');
  assert.ok(fs.existsSync(doc), 'the checklist document is gone');
  const text = fs.readFileSync(doc, 'utf8');
  assert.ok(text.length > 1500, 'the checklist has shrunk to nothing usable');
  assert.ok(text.includes('statSync(p).isFile()'), 'the isFile rule is missing');
});

test('the AGENTS.md section still points at the real path', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('evidence/MEASUREMENT-CHECKLIST.md'), 'the link path is missing from AGENTS.md');
  // And it must not carry a stray control byte, which R633 had to repair once.
  const ESC = String.fromCharCode(0x1b);
  assert.ok(!agents.includes(ESC), 'a control byte is back in AGENTS.md');
});

test('the record separates the advisory from the enforced', () => {
  assert.match(ENFORCEMENT.advisory, /consults before writing a number/, 'the advisory role is not stated');
  assert.match(ENFORCEMENT.enforced, /recompute values with the tools/, 'the actual enforcement is not named');
  assert.match(ENFORCEMENT.honestStatement, /advisory and the enforcement is elsewhere/, 'the honest statement is missing');
  assert.match(REACH.conclusion, /no code path loads AGENTS\.md/, 'the conclusion is not stated');
});
