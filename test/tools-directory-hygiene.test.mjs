// One-off debug scripts must not accumulate in tools/.
//
// Measured: 236 files named `_*.cjs` had piled up since 10-21 — each a throwaway probe used
// once and abandoned. They were 340 KB of dead code that made `tools/` impossible to scan and
// would eventually break the Glob count assertions (a lesson from round 210).
//
// After cleanup: 1 file remains, `_cmd-cr.cjs`, because test/shell-enter.test.mjs references it.
//
// The rule: a `_`-prefixed script in tools/ is allowed only while something else still uses
// it. Otherwise it belongs in the round that needed it, not in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');

// Scripts that are still referenced by tests or documentation.
const REFERENCED = new Map([
  ['_cmd-cr.cjs', 'test/shell-enter.test.mjs uses it to reproduce a carriage-return case'],
]);

test('no unreferenced one-off script is left in tools/', () => {
  const strays = fs.readdirSync(TOOLS).filter((f) => f.startsWith('_') && f.endsWith('.cjs'));
  const unreferenced = strays.filter((f) => !REFERENCED.has(f));
  assert.deepEqual(unreferenced, [],
    'these one-off scripts are no longer used by anything: ' + unreferenced.join(', '));
});

test('every referenced script still exists', () => {
  // A stale allow-list entry would let a future script of the same name slip through.
  for (const [name, reason] of REFERENCED) {
    assert.ok(fs.existsSync(path.join(TOOLS, name)), name + ' is gone; drop its entry');
    assert.ok(reason.length > 20, name + ' is allowed without a real reason');
  }
});

test('the referenced script is actually referenced', () => {
  // The allow-list must reflect reality, not a decision made once and forgotten.
  const tests = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'test', f), 'utf8'))
    .join('\n');
  for (const name of REFERENCED.keys()) {
    assert.ok(tests.includes(name), name + ' is not mentioned by any test');
  }
});
