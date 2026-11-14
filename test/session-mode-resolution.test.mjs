// A session must record a mode the approval gate can act on.
//
// The composer sends 'default' when the folder has no explicit override — it means
// 'follow the account default'. This build has no account default source, so decide()
// resolved 'default' to ask, and every Write/Edit prompted even though the composer's
// own label could read 自动. Measured on the live replica:
//
//   prewarmLocal payload: {"permissionMode":"default", ...}
//   the session created from it: permissionMode 'default'
//   a Write in that session:     approval card, 'the account default resolves to ask here'
//
// Meanwhile the composer's folder preference stayed 'default' no matter which mode the
// user picked from the menu (measured: clicked 手动, pref still 'default'; clicked 自动,
// trigger label showed 手动). So the record and the label were allowed to disagree.
//
// Recording the resolved mode keeps the session self-consistent: whatever the record
// says is exactly what the gate acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
const { decide, ACTIONS, VALID_MODES } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));

const makeKernel = () => createSessionKernel({
  emit: () => {},
  createAgent: () => ({ model: 'stub', tools: [], run: async () => ({ text: 'ok' }) }),
  log: () => {},
});

test('a session never records a mode the gate cannot act on', () => {
  const kernel = makeKernel();
  for (const requested of [undefined, 'default', 'auto', 'ask', 'plan', 'acceptEdits']) {
    const s = kernel.start({ cwd: process.cwd(), ...(requested ? { permissionMode: requested } : {}) });
    assert.ok(VALID_MODES.has(s.permissionMode), 'recorded an invalid mode for ' + String(requested));
    assert.notEqual(s.permissionMode, 'default', 'default must be resolved before it is recorded');
  }
});

test('an explicit mode survives unchanged', () => {
  const kernel = makeKernel();
  for (const mode of ['auto', 'ask', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk']) {
    assert.equal(kernel.start({ cwd: process.cwd(), permissionMode: mode }).permissionMode, mode, mode + ' was rewritten');
  }
});

test('a session started without a mode still gets a usable one', () => {
  // The drop-in path: some callers omit permissionMode entirely.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  assert.ok(VALID_MODES.has(s.permissionMode));
  assert.doesNotThrow(() => decide(s.permissionMode, ACTIONS.EDIT));
});

test('the recorded mode decides whether an edit prompts', () => {
  // The point of resolving 'default': an edit in a freshly started session must have a
  // definite answer, not an ask fallback the user never chose.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  const decision = decide(s.permissionMode, ACTIONS.EDIT);
  assert.equal(typeof decision.prompt, 'boolean');
  // acceptEdits is the resolved default, and it must not prompt for an edit.
  assert.equal(decision.prompt, false, 'the resolved default should apply edits without a prompt');
});
