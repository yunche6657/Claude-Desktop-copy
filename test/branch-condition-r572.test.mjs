// R572: the rule that drifted three times now has fixed cases, so a fourth edit cannot quietly break a shape again.
//
// WHAT DRIFTED
//   R571 asked "is the name a branch decides on produced elsewhere in the file?" and got it wrong three times, each fix a
//   local patch:
//
//     1. exclude the branch's own line      → `const denied = gate(row,false); if (denied) return denied;` defines and
//                                             uses the name on ONE line, so it read as unused
//     2. count that line, require uses > 1  → `denied` occurs three times on that line and nowhere else; LINE count is 1
//     3. require `const NAME =`             → `catch (error) { … }` binds `error`; 356 of 3346 branches flagged
//
//   R571 withdrew the detector rather than patch it a fourth time. What it could not do was preserve the knowledge — so
//   this round separates the two questions and pins them with cases:
//
//       conditionOf(line)     where the condition starts and ends      (walk parens)
//       isBound(name, text)   is the name introduced anywhere          (five binding forms)
//
//   `live-branch-audit.cjs` still does not ask the second question; R571's withdrawal stands. But a future round that
//   wants to try again starts from cases, not from scratch — and the three shapes that broke are named.
//
// THE PAREN WALK, AND WHY FOUR REGEXES FAILED
//       `\((.+)\)\s*\{?\s*$`     no match for `if (error instanceof AgentError) throw error;` (no trailing brace)
//       `\((.+?)\)\s*(\{|;|$)`   lazy: `if (!apiKey) throw new AgentError('…')` captured `!apiKey`, then the tail
//                                ` throw new …` failed the end test
//       `\((.+)\)\s*(\{|;|$)`    greedy: the LAST `)` closes `new AgentError(…)`
//       `if \((.+)`              multiline conditions unreachable entirely
//
//   The condition's closing paren and the body's parens are the same character; only depth separates them.
//
// THE FIVE BINDING FORMS, EACH A CASE BELOW
//       declaration (incl. object and array destructuring) · assignment · catch clause · parameter (function, method
//       shorthand, arrow with and without parens) · iteration binding
//
//   One of them bit during this round too: making `function` optional in the parameter pattern made `if (x) {` look like a
//   parameter list, and the method-shorthand pattern needed a negative lookahead against `if|for|while|switch|catch`.
//   Both are recorded where they are fixed.
//
// WHAT IS NOT CLAIMED
//   Not that `isBound` is complete: a name bound by `with`, by a label, or by an eval'd string is invisible, and the
//   parameter patterns accept up to 300 characters of parameter list.
//   Not that `isBound` is now used to decide liveness — R571's withdrawal stands. It answers "is this name introduced",
//   which is a smaller question than "is this branch reachable".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conditionOf, conditionNames, isBound } from '../tools/branch-condition.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the condition is found for every shape that defeated a regex', () => {
  const cases = [
    ['    if (error instanceof AgentError) throw error;', 'error instanceof AgentError', 'blockless body'],
    ["    if (!apiKey) throw new AgentError('missing-key', 'x');", '!apiKey', 'parens in the body'],
    ['  if (a === 1) {', 'a === 1', 'ordinary block'],
    ['    if (/searchSessions$/i.test(frag)) return [];', '/searchSessions$/i.test(frag)', 'regex literal in the condition'],
    ['  const denied = gate(row,false); if (denied) return denied;', 'denied', 'branch not at line start'],
  ];
  for (const [line, expected, why] of cases) {
    const r = conditionOf(line);
    assert.ok(r, `no condition found for: ${why}`);
    assert.equal(r.condition, expected, `wrong condition for: ${why}`);
  }
});

test('a string containing a paren does not end the condition', () => {
  const r = conditionOf(`  if (x === ')') {`);
  assert.equal(r.condition, "x === ')'", 'a paren inside a string literal closed the condition');
});

test('an unbalanced condition yields null rather than a truncated one', () => {
  assert.equal(conditionOf('  if (a && b {'), null, 'an unterminated condition produced a result');
  assert.equal(conditionOf('  while (a) {'), null, 'a non-if statement was parsed as a branch');
});

test('every binding form the repository uses is recognised', () => {
  const bound = [
    ["const denied = gate(row,false); if (denied) return denied;", 'denied', 'same-line declaration'],
    ['catch (error) { if (error instanceof Error) throw error; }', 'error', 'catch clause'],
    ['function probeCcb({ env, root }) { }', 'env', 'destructured parameter'],
    ['const f = (a, signal) => a + signal;', 'signal', 'arrow parameter'],
    ['for (const g of GUARDS) { }', 'g', 'iteration binding'],
    ['let kernelSelection = null;', 'kernelSelection', 'let declaration'],
    ['x = compute();', 'x', 'plain assignment'],
    ['const { a, b } = obj;', 'b', 'destructuring from an object'],
    ['const [first, second] = arr;', 'second', 'array destructuring'],
  ];
  for (const [text, name, why] of bound) {
    assert.equal(isBound(name, text), true, `${why}: ${name} not recognised as bound`);
  }
});

test('a name that is only COMPARED is not bound', () => {
  const unbound = [
    ['if (neverDefinedAnywhere) { }', 'neverDefinedAnywhere', 'nothing binds it'],
    ['if (x === 1) { }', 'x', 'only compared'],
    ["if (frag.endsWith('x')) { }", 'endsWith', 'a method name'],
    ['if (a == b) { }', 'a', 'comparison is not assignment'],
  ];
  for (const [text, name, why] of unbound) {
    assert.equal(isBound(name, text), false, `${why}: ${name} was reported as bound`);
  }
});

test('`if (` is not a method-shorthand parameter list', () => {
  // The bug this round hit: `if` is identifier-shaped, so `name(...) {` matched it.
  assert.equal(isBound('neverDefinedAnywhere', 'if (neverDefinedAnywhere) { }'), false);
  // But a real method shorthand still works.
  assert.equal(isBound('cb', 'register(cb) {'), true, 'a method-shorthand parameter is no longer found');
});

test('the two real files that motivated the cases are classified correctly', () => {
  const agent = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  assert.equal(isBound('error', agent), true, '`error` is bound by a catch clause in agent.cjs');
  const auth = fs.readFileSync(path.join(ROOT, 'desktop', 'mcp-session-auth.cjs'), 'utf8');
  assert.equal(isBound('denied', auth), true, '`denied` is declared on the same line as its branch');
});

test('the condition names exclude keywords AND string literals, but keep property names', () => {
  assert.deepEqual(conditionNames('typeof value === "string"'), ['value'],
    'the word inside the quotes is a compared value, not a name the branch decides on');
  assert.deepEqual(conditionNames('error instanceof AgentError'), ['error', 'AgentError']);
  // A property name is kept: a branch on a property is still a decision about it. The string it is compared against is
  // NOT kept — `'ENOENT'` is a value, not a variable.
  assert.deepEqual(conditionNames('error.code === "ENOENT"'), ['error', 'code']);
});

test('the module records that it is NOT used to decide liveness', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-condition.cjs'), 'utf8');
  assert.match(src, /R571 withdrew it/, 'the withdrawal is not recorded at the module');
  assert.match(src, /a complete answer needs a\s*\n?\/\/\s*parser|needs a parser/i,
    'the reason liveness was withdrawn is not recorded');
});
