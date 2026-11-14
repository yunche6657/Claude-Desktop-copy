// R616: the cross-tool position index works and shows that a POSITION is not a SUBJECT. Five of six ambiguous positions are
// lines declaring several containers; the sixth is one comment doing two jobs.
//
// WHAT WAS BUILT
//   All eight tools emit `file` plus a line-ish field (R614). So rows join on (file, line). Measured:
//
//       distinct positions            643
//       cited by more than one tool    55
//       … one subject                  49
//       … more than one subject         6
//
// THE SIX
//       growthbook-provider.cjs:45    seenFeatureExposure | seenExperimentExposure   2 containers, one line
//       mcp-relay-host.cjs:10         5 containers, one line
//       hybrid-oidc-login.cjs:7       locks | active                                  Map + Set, one line
//       session-media-protocol.cjs:26 sessionKeys | active                           Map + Set, one line
//       session-video-protocol.cjs:25 tokens | epochs | active                       3 containers, one line
//       main.cjs:376                  one comment, both a denial and a measurement   one subject, two roles
//
//   The first five are the comma-declaration shape R596 already knows — the same shape that hid `seenExperimentExposure` until the
//   regex was widened. Here it does something else: it makes a POSITION ambiguous. Two tools can agree on `file:line` while talking
//   about different sets.
//
//   The sixth is not a declaration: `main.cjs:376` is one comment line carrying both a denial and a measurement, so `stale-comment`
//   and `denial-vs-witness` point at it for different reasons. That is ONE subject examined two ways — a different ambiguity.
//
// WHY THIS IS A RESULT AND NOT A NULL
//   The join answers a question no single tool could: where does this work concentrate. Answer: 55 of 643 positions are seen by
//   more than one tool, and `growthbook-provider.cjs:45` is seen by FOUR — the flag declaration line this whole line of work started
//   from. Four different questions converged there independently.
//
//   And it shows its own limit immediately: it cannot be a SUBJECT index. Any analysis treating `file:line` as identity will
//   silently merge `seenFeatureExposure` with `seenExperimentExposure` — precisely the pair whose difference R590 established.
//
// WHAT IS NOT CLAIMED
//   Not that a subject key exists to fix it: `name` is absent from half the tools (R610), and where present it names a set, a
//   symbol, a function, or nothing.
//   Not that 55 is a concentration finding: 49 of the 55 are one tool pair sharing a population by construction. The interesting
//   number is the four-tool line, not the 55.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JOIN, AMBIGUOUS, CONCLUSION } from '../desktop/position-index.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOLS = [
  'set-lifetimes.cjs', 'set-reset-reach.cjs', 'set-key-symmetry.cjs', 'map-key-reach.cjs',
  'clear-asymmetry.cjs', 'source-divergence.cjs', 'stale-comment.cjs', 'denial-vs-witness.cjs',
];

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

/** Build the (file, line) → [subject] map for one tool. */
const subjectsAt = (tool) => {
  const d = runJson(tool);
  const out = new Map();
  for (const row of d.rows || []) {
    if (typeof row.file !== 'string') continue;
    const subj = row.name || (row.cleared && row.cleared.name) || row.symbol
      || (row.fn ? 'fn:' + row.fn : null);
    const push = (line, s) => {
      if (typeof line !== 'number') return;
      const k = row.file + ':' + line;
      if (!out.has(k)) out.set(k, []);
      if (s) out.get(k).push(s);
    };
    if (typeof row.line === 'number') push(row.line, subj);
    if (typeof row.declaredAt === 'number') push(row.declaredAt, row.name);
    if (typeof row.coMentionLine === 'number') push(row.coMentionLine, subj);
    if (typeof row.denialLine === 'number') push(row.denialLine, 'denial:' + subj);
    if (typeof row.witnessLine === 'number') push(row.witnessLine, 'witness:' + subj);
    if (Array.isArray(row.sites)) for (const s of row.sites) push(s.line, row.name);
  }
  return out;
};

test('the four-tool convergence at growthbook-provider.cjs:45 is still there', () => {
  const targets = ['set-lifetimes.cjs', 'set-reset-reach.cjs', 'set-key-symmetry.cjs', 'clear-asymmetry.cjs'];
  const hit = [];
  for (const t of targets) {
    const m = subjectsAt(t);
    if (m.has('desktop/growthbook-provider.cjs:45')) hit.push(t.replace('.cjs', ''));
  }
  assert.equal(hit.length, 4, `only ${hit.length} of the four tools point there: ${hit.join(', ')}`);
  const row = AMBIGUOUS.find((a) => a.position === 'desktop/growthbook-provider.cjs:45');
  assert.deepEqual([...row.tools].sort(), hit.sort());
});

test('that line holds two containers and they are the two the tools name', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'growthbook-provider.cjs'), 'utf8').split('\n');
  const text = src[44];
  assert.equal((text.match(/new\s+Set\(/g) || []).length, 2, 'the line no longer declares two sets');
  for (const name of ['seenFeatureExposure', 'seenExperimentExposure']) {
    assert.ok(text.includes(name), `${name} is no longer declared on line 45`);
  }
});

test('every comma-declaration case records the container count its line really has', () => {
  for (const a of AMBIGUOUS.filter((x) => x.kind === 'comma-declaration')) {
    const [file, line] = a.position.split(':');
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const text = src[Number(line) - 1] || '';
    const n = (text.match(/new\s+Set\(/g) || []).length + (text.match(/new\s+Map\(/g) || []).length;
    assert.equal(n, a.containersOnLine, `${a.position}: recorded ${a.containersOnLine} containers, line has ${n}`);
    assert.ok(a.subjects.length >= 2, `${a.position} names fewer than two subjects`);
  }
});

test('the sixth case is one comment with two roles, not a declaration', () => {
  const row = AMBIGUOUS.find((a) => a.kind === 'one-comment-two-roles');
  assert.ok(row, 'the two-role case is gone from the record');
  assert.equal(row.containersOnLine, 0);
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8').split('\n');
  const text = src[375] || '';
  assert.ok(text.trim().startsWith('//'), 'main.cjs:376 is no longer a comment');
});

test('the totals are consistent', () => {
  assert.equal(JOIN.oneSubject + JOIN.manySubjects, JOIN.shared);
  assert.equal(AMBIGUOUS.length, JOIN.manySubjects);
  assert.equal(JOIN.shared < JOIN.positions, true);
});

test('the conclusion states both what works and what breaks', () => {
  assert.match(CONCLUSION.works, /seen by four tools/, 'the convergence is not stated');
  assert.match(CONCLUSION.breaks, /cannot serve as a SUBJECT index/, 'the limit is not stated');
  assert.match(CONCLUSION.example, /seenFeatureExposure|R590/, 'the concrete merge is not named');
});

test('the record refuses to read 55 as concentration', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'position-index.cjs'), 'utf8');
  assert.match(src, /Not that 55 is a concentration finding/, 'the caveat is missing');
  assert.match(src, /share\s+a population by construction|sharing a population by construction/,
    'the reason 49 is uninteresting is not stated');
});
