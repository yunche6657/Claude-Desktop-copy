// A test that cannot run must say so, and must not look like a pass.
//
// Found this round: git-info.test.mjs had four `if (!repo) return;` guards. When creating a
// temporary repository failed, the test body returned early — and the runner reported it as
// PASSED. The condition is rare here (git works on this host, so all four ran), which is
// exactly why it would go unnoticed if the environment changed.
//
// Fixed: each now calls `t.skip('git could not create a temporary repository on this host')`,
// which appears in the report as a skip with a reason instead of a silent green.
//
// The general rule this file enforces: a test body may return early ONLY if it marks itself
// skipped first. A bare `return` after an environment check is a false green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

// Files allowed to skip conditionally, each with the environment fact that justifies it.
const CONDITIONAL = new Map([
  ['git-info.test.mjs', 'needs a git binary and a writable temp dir'],
  ['installer.test.mjs', 'needs a built release directory'],
  ['skill-exec-roots.test.mjs', 'needs a python interpreter on PATH to run skill helpers'],
  ['session-search.test.mjs', 'needs a running replica (REPLICA_CDP)'],
  ['chinese-locale.test.mjs', 'locale catalogue presence is asserted, not skipped'],
  ['frontend-root.test.mjs', 'installed package presence is asserted, not skipped'],
]);

test('no test returns early without marking itself skipped', () => {
  // The defect this catches: `if (!env) return;` inside a test body reports as passed.
  const offenders = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'))) {
    const lines = fs.readFileSync(path.join(TEST_DIR, file), 'utf8').split('\n');
    // Only a guard at the TOP LEVEL of a test body is the defect. A `return` inside a
    // callback (an event handler filtering frames) is normal control flow — the first
    // version of this check flagged six of those in ccb-*.test.mjs.
    const body = lines.join('\n');
    const testBodies = [...body.matchAll(/test\([^,]+,\s*(?:\{[^}]*\},\s*)?async?\s*\(([^)]*)\)\s*=>\s*\{/g)];
    for (const match of testBodies) {
      const start = match.index + match[0].length;
      // Walk forward to the matching closing brace at the same depth.
      let depth = 1;
      let cursor = start;
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === '{') depth += 1;
        else if (body[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const testBody = body.slice(start, cursor);
      // A guard that returns before any assertion, with no skip call, is the defect.
      //
      // The guard need not be the first statement: in git-info the body starts with
      // `const { call } = makeBridge();` and the early return comes after it. Anchoring at
      // the start of the body made the first version of this check miss the very pattern it
      // was written for.
      // A bare `return;` is the defect. `return t.skip(...)` is the fix, so the pattern must
      // not match it — the first version used /return;/ which happily matched the tail of
      // `return t.skip('...')` and reported the corrected file as broken.
      const guard = testBody.match(/if \([^)]*\) return;\s*\n/);
      if (!guard) continue;
      const beforeGuard = testBody.slice(0, testBody.indexOf(guard[0]));
      // Ignore comments: git-info's guard is preceded by a comment explaining the skip, and
      // matching the word `skip` inside it made the detector blind to the real guard.
      const codeOnly = beforeGuard
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
      if (/t\.skip\(|test\.skip|\{ skip:/.test(codeOnly)) continue;
      const lineNo = body.slice(0, start).split('\n').length;
      offenders.push(file + ':' + lineNo + '  ' + guard[0].trim());
    }
  }
  assert.deepEqual(offenders, [],
    'these tests can pass without running: ' + offenders.join(' | '));
});

test('every conditional skip is declared with a reason', () => {
  // A skip nobody wrote down is indistinguishable from a test that was never finished.
  for (const [file, reason] of CONDITIONAL) {
    assert.ok(fs.existsSync(path.join(TEST_DIR, file)), file + ' no longer exists; drop its entry');
    assert.ok(reason.length > 20, file + ' is listed without a real reason');
  }
});

test('git-info marks its environment failures as skips', () => {
  // The specific fix: four silent returns became reasoned skips.
  const source = fs.readFileSync(path.join(TEST_DIR, 'git-info.test.mjs'), 'utf8');
  assert.equal((source.match(/if \(!repo\) return;/g) || []).length, 0,
    'a silent early return is back in git-info.test.mjs');
  assert.ok((source.match(/t\.skip\('git could not create/g) || []).length >= 4,
    'the reasoned skips are missing');
});
