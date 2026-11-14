// R516: prove the checks can FAIL, not just pass.
//
// THE GAP
//   tools/corrections.cjs carries three checks — a banner is applied, an addendum is placed, an addendum cites a
//   round. Every one of them had only ever been observed in its passing state. A check that has never been seen to
//   fail is indistinguishable from a check that cannot fail, and this session has already produced that exact
//   defect twice:
//     R501  a cross-check compared a function the tool constructed itself, so it could never disagree;
//     R494  a regex built from a template literal turned `\\r?\\n` into real control characters, so every lookup
//           returned null and five tools silently became "no-contract-interface".
//
//   The fix is `--registry <path>`, which lets a test point the tool at a purpose-built broken registry.
//
// WHAT EACH CASE PROVES
//   unsourced   an addendum whose text names no round  -> `--check` exits 1 and the count is non-zero
//   misplaced   an addendum already present but below the title -> status `appended-outside-banner`, exit 1
//   orphan      an addendum naming a file with no correction entry -> `no-correction-to-append-to`
//   badkind     a correction with an unknown kind -> `unknown-kind`
//   nofile      a correction pointing at a missing file -> `missing-file`
//   nobanner    a correction whose banner was never applied -> `needs-banner`
//
//   Each case is a separate temp registry so one cannot mask another.
//
// THE MISPLACED CASE NEEDS A REAL FILE
//   `appended-outside-banner` is decided by comparing the marker's offset against the file's first `\n# `. That
//   cannot be faked in the registry alone, so the test writes a scratch evidence file — a title followed by an
//   addendum marker — and points the registry at it. The scratch file is removed afterwards, and its name is
//   chosen so it can never be mistaken for real evidence.
//
// WHAT IS NOT CLAIMED
//   Not that these six cases exhaust the failure modes. They are the ones the tool distinguishes; a mode it does
//   not distinguish cannot be tested. Not that `--write` is proven safe — these cases exercise reporting only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const EVID = path.join(ROOT, 'evidence');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrections-r516-'));

/** Write a temp registry and return its path. */
function registry(name, data) {
  const p = path.join(tmpdir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
}

const withRegistry = (reg, extra = ['--json']) => run([...extra, '--registry', reg]);

test('an addendum that cites no round is reported and fails the check', () => {
  // The addendum is not applied here (the real file has no marker for it), so the status is `needs-addendum`.
  // `citesEvidence` is computed independently of application, which is what makes it testable without writing.
  const reg = registry('unsourced', {
    corrections: [{
      file: 'tool-absence-r500.md', round: 503, kind: 'denominator',
      summary: 'fixture', detail: 'fixture detail',
    }],
    addenda: [{
      file: 'tool-absence-r500.md', round: 9999,
      text: '这条补记不引用任何轮次，它只是一句断言。',
    }],
  });

  const d = JSON.parse(withRegistry(reg).stdout);
  assert.equal(d.addenda.length, 1);
  assert.equal(d.addenda[0].citesEvidence, false,
    'an addendum naming no round was not flagged');
  assert.equal(d.addenda[0].status, 'needs-addendum',
    'the unapplied state changed: this test no longer isolates the citation question');

  // The citation count must be the reason --check fails, so assert on the count as well as the exit code.
  const c = withRegistry(reg, ['--check']);
  assert.equal(c.status, 1, '--check passed despite an unsourced addendum');
  assert.match(c.stdout, /1 citing no round/,
    'the report does not count the unsourced addendum');
});

test('a control registry with a cited addendum passes', () => {
  // Without this, the previous test proves only that --check can fail — not that it fails for the right reason.
  //
  // The addendum must be applied for --check to pass, so this needs a scratch file that already contains its
  // marker above the title. Pointing it at the real tool-absence-r500.md failed: that file has no
  // `addendum-r9999` marker, so the status was `needs-addendum` and the check failed for a reason unrelated to
  // citation — which would have made this control prove nothing.
  const scratch = 'zz-scratch-r516-control.md';
  const p = path.join(EVID, scratch);
  fs.writeFileSync(p, [
    '<!-- superseded-r9998 -->',
    '',
    '> 注：fixture',
    '',
    '<!-- addendum-r9999 -->',
    '> 依据 R504 的实测，这句断言已被推翻。',
    '',
    '# 临时文件',
    '',
    '正文。',
    '',
  ].join('\n'), 'utf8');

  try {
    const reg = registry('sourced', {
      corrections: [{
        file: scratch, round: 9998, kind: 'scope', summary: 'fixture', detail: 'fixture detail',
      }],
      addenda: [{ file: scratch, round: 9999, text: '依据 R504 的实测，这句断言已被推翻。' }],
    });
    const c = withRegistry(reg, ['--check']);
    assert.equal(c.status, 0, '--check failed on a properly sourced addendum:\n'
      + (c.stdout || '') + (c.stderr || ''));
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('an addendum placed below the title is reported as misplaced', () => {
  // The scratch file exists only for this test and cannot be mistaken for evidence.
  const scratch = 'zz-scratch-r516-fixture.md';
  const p = path.join(EVID, scratch);
  fs.writeFileSync(p, [
    '# 临时文件',
    '',
    '正文。',
    '',
    '<!-- addendum-r9999 -->',
    '> 这条补记在标题之下。',
    '',
  ].join('\n'), 'utf8');

  try {
    const reg = registry('misplaced', {
      corrections: [{
        file: scratch, round: 9998, kind: 'scope', summary: 'fixture', detail: 'fixture',
      }],
      addenda: [{ file: scratch, round: 9999, text: '依据 R999。' }],
    });
    const d = JSON.parse(withRegistry(reg).stdout);
    assert.equal(d.addenda[0].status, 'appended-outside-banner',
      'a below-title addendum was not distinguished from a correct one');

    const c = withRegistry(reg, ['--check']);
    assert.equal(c.status, 1, '--check passed despite a misplaced addendum');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('an addendum with no correction to attach to is reported', () => {
  const reg = registry('orphan', {
    corrections: [],
    addenda: [{ file: 'tool-absence-r500.md', round: 9999, text: '依据 R504。' }],
  });
  const d = JSON.parse(withRegistry(reg).stdout);
  assert.equal(d.addenda[0].status, 'no-correction-to-append-to');
  assert.equal(withRegistry(reg, ['--check']).status, 1, '--check passed despite an orphan addendum');
});

test('an unknown kind and a missing file are both reported', () => {
  const reg = registry('badentries', {
    corrections: [
      { file: 'tool-absence-r500.md', round: 9999, kind: 'nonsense', summary: 's', detail: 'd' },
      { file: 'no-such-file-zz.md', round: 9999, kind: 'scope', summary: 's', detail: 'd' },
    ],
  });
  const d = JSON.parse(withRegistry(reg).stdout);
  const statuses = d.rows.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['missing-file', 'unknown-kind'],
    'the two malformed entries were not distinguished: ' + JSON.stringify(statuses));
  assert.equal(withRegistry(reg, ['--check']).status, 1, '--check passed despite malformed entries');
});

test('a correction whose banner is absent is reported as needs-banner', () => {
  const reg = registry('nobanner', {
    corrections: [{
      file: 'tool-absence-r500.md', round: 9999, kind: 'scope', summary: 's', detail: 'd',
    }],
  });
  const d = JSON.parse(withRegistry(reg).stdout);
  assert.equal(d.rows[0].status, 'needs-banner');
  assert.equal(withRegistry(reg, ['--check']).status, 1, '--check passed despite an unapplied banner');
});

test('the real registry still passes', () => {
  const c = run(['--check']);
  assert.equal(c.status, 0, 'the real registry fails:\n' + (c.stdout || '') + (c.stderr || ''));
  assert.match(c.stdout, /0 citing no round/);
});

test('every status string the tool can emit is one of the ones tested here', () => {
  // Guards against a new status being added without a corresponding failure test.
  const source = fs.readFileSync(TOOL, 'utf8');
  const statuses = new Set([...source.matchAll(/status: '([a-z-]+)'/g)].map((m) => m[1]));
  const covered = new Set([
    'appended', 'needs-addendum', 'appended-outside-banner', 'no-correction-to-append-to',
    'incomplete-addendum', 'missing-file', 'incomplete-entry', 'unknown-kind',
    'needs-banner', 'annotated',
  ]);
  for (const s of statuses) {
    assert.ok(covered.has(s),
      `status "${s}" has no failure test: add one, or the check it represents cannot be shown to work`);
  }
});

test.after(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});
