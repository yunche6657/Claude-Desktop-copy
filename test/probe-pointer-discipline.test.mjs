// Interaction probes must use real pointer input, not element.click().
//
// This cost four rounds. Rounds 135-136 concluded the approval card was broken:
//   '.click() produced no respondToToolPermission call and the card stayed for 58s'
// and went on to derive a deep root cause (refuses always true, the lazy place-check
// chunk never requested, a feature flag never set).
//
// The card was fine. Rounds 145 re-tested with a real mouse and it closed immediately:
//   after REAL click: { stillPending: 0, card: false }, file created.
//
// The cause: that button's onClick is
//   (...t) => { let n = t[0]; return cn(n) && on(n), e(...t) }
// and cn(n) requires genuine pointer information. A synthetic click() carries none, so
// on(n) never runs. element.click() only proves a handler is BOUND, never that a user
// can press it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES = path.join(ROOT, 'tools', 'probes');

// Files allowed to keep .click(): they only switch pages or open a surface the test
// then verifies by its own state, so a synthetic click is enough to make progress.
const ALLOWED = new Set([]);

test('probes that assert a control WORKS use real pointer input', () => {
  // Scope: probes whose names say they are checking an interaction.
  const INTERACTION = /(approv|allow|deny|deny|submit|send|click|press|tap|toggle|menu|picker|button)/i;
  const offenders = [];
  for (const name of fs.readdirSync(PROBES)) {
    if (!/\.(mjs|eval\.js|cjs)$/.test(name)) continue;
    if (!INTERACTION.test(name)) continue;
    if (ALLOWED.has(name)) continue;
    const text = fs.readFileSync(path.join(PROBES, name), 'utf8');
    // A real sequence is present when the probe dispatches CDP mouse events.
    const usesRealPointer = /dispatchMouseEvent|mousePressed|mouseReleased|pointer\.mjs/.test(text);
    const usesSynthetic = /\.click\(\)/.test(text);
    if (usesSynthetic && !usesRealPointer) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'these interaction probes rely on element.click() and cannot prove a user can press the control: ' + offenders.join(', '));
});

test('the shared click helper documents why it dispatches real mouse events', () => {
  // tools/probes/click.mjs is the canonical helper; keep its rationale attached.
  const helper = path.join(PROBES, 'click.mjs');
  assert.ok(fs.existsSync(helper), 'the real-pointer click helper is missing');
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /not element\.click\(\)|mousePressed|Input\.dispatchMouseEvent/, 'the helper must dispatch CDP mouse events');
});
