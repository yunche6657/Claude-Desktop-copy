// R435: no schema member may sit at a different indent from its same-depth siblings.
//
// WHY THIS TEST EXISTS
//   R434 found `gitOperation` written at 6 spaces in a schema whose other members were at 4.
//   TypeScript does not care, so nothing failed — but every reader that finds top-level schema
//   members by indentation skips the odd one out. The R420 census did exactly that, reported
//   `gitOperation` as missing, and the false gap survived five rounds because nobody re-ran it.
//
//   The same mistake happened three rounds running: R429 (gitOperation), R430 (searchCount),
//   R431 (old_source). Each was an insertion script copying an indent that did not match its
//   neighbours.
//
// METHOD — why depth-aware
//   A first attempt compared each member against the object's modal indent and reported 96
//   "problems", nearly all legitimate nesting (`sha` inside `commit`, `file` inside an object
//   literal). Nesting and misindentation look identical to that heuristic.
//
//   This version tracks brace depth and compares only members at the SAME depth, so nesting is
//   accounted for by construction. A member at depth N whose peers at depth N agree on an indent
//   but it does not, is a real defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

const MEMBER = /^( +)([A-Za-z_$][\w$]*)\??: /;
const SCHEMA_START = /z\.(?:object|strictObject)\(\{/g;

/** Same-depth members whose indent disagrees with their peers. */
function auditFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const found = [];

  for (const m of text.matchAll(SCHEMA_START)) {
    const startLine = text.slice(0, m.index).split('\n').length - 1;

    // Find the closing brace of this object.
    let depth = 0;
    let endLine = -1;
    for (let i = startLine; i < lines.length; i += 1) {
      depth += (lines[i].match(/\{/g) || []).length;
      depth -= (lines[i].match(/\}/g) || []).length;
      if (depth <= 0) { endLine = i; break; }
    }
    if (endLine < 0 || endLine - startLine < 3) continue;

    // Group members by the brace depth they sit at.
    const byDepth = new Map();
    depth = 0;
    for (let i = startLine; i <= endLine; i += 1) {
      const line = lines[i];
      const bare = line.trim();
      const isComment = bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*');
      if (!isComment) {
        const mm = MEMBER.exec(line);
        if (mm) {
          if (!byDepth.has(depth)) byDepth.set(depth, []);
          byDepth.get(depth).push({ indent: mm[1].length, key: mm[2], line: i + 1 });
        }
      }
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
    }

    for (const [d, members] of byDepth) {
      if (members.length < 3) continue;
      const counts = new Map();
      for (const mem of members) counts.set(mem.indent, (counts.get(mem.indent) || 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [modal, modalCount] = sorted[0];
      // Report only when a clear majority exists, so a mixed block is not guessed at.
      if (modalCount < members.length - 1) continue;
      for (const mem of members) {
        if (mem.indent !== modal) {
          found.push({
            file: path.relative(SRC, file),
            depth: d,
            key: mem.key,
            line: mem.line,
            indent: mem.indent,
            expected: modal,
          });
        }
      }
    }
  }
  return found;
}

test('every schema member is indented like its same-depth siblings', () => {
  const roots = [
    path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools'),
    path.join(SRC, 'src'),
  ];

  const offenders = [];
  for (const root of roots) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        offenders.push(...auditFile(full));
      }
    };
    walk(root);
  }

  // The failure message must be actionable: a misindented member is invisible to text readers, so
  // the fix is to match the sibling indent, not to reformat the file.
  const detail = offenders
    .map((o) => `${o.file}:${o.line} \`${o.key}\` at ${o.indent} spaces, siblings at ${o.expected}`)
    .join('\n  ');
  assert.deepEqual(offenders, [],
    'schema members whose indent differs from their same-depth siblings — these are skipped by any '
    + 'reader that identifies members by indentation:\n  ' + detail);
});

test('the three members fixed in R429/R430/R431/R435 stay at the sibling indent', () => {
  // Named individually so a regression is obvious even if the general audit is ever loosened.
  const cases = [
    ['packages/builtin-tools/src/tools/BashTool/BashTool.tsx', 'gitOperation', 4],
    ['packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts', 'searchCount', 4],
    ['packages/builtin-tools/src/tools/NotebookEditTool/NotebookEditTool.ts', 'old_source', 4],
  ];
  for (const [rel, key, expected] of cases) {
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const re = new RegExp('^( +)' + key + ': z', 'm');
    const m = re.exec(text);
    assert.ok(m, `${key} is missing from ${rel}`);
    assert.equal(m[1].length, expected,
      `${key} is at ${m[1].length} spaces; its siblings use ${expected}`);
  }
});

test('the audit itself can detect a misindented member', () => {
  // A guard that always passes is worthless. Feed it a synthetic schema with one bad member and
  // require it to complain.
  const tmp = path.join(SRC, '..', '.tmp-audit-fixture.ts');
  fs.writeFileSync(tmp, [
    'const schema = z.object({',
    '    alpha: z.string(),',
    '    beta: z.string(),',
    '      gamma: z.string(),',
    '    delta: z.string(),',
    '})',
  ].join('\n'));
  try {
    const found = auditFile(tmp);
    assert.equal(found.length, 1, 'the audit missed a deliberately misindented member');
    assert.equal(found[0].key, 'gamma');
    assert.equal(found[0].indent, 6);
    assert.equal(found[0].expected, 4);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
