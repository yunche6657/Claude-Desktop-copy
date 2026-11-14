// The workspace-trust answer must actually persist.
//
// Symptom that exposed this: the landing page kept showing "Trust this workspace?" and the
// Send button stayed disabled. That dialog is CORRECT behaviour when the folder is untrusted,
// so the bug was not the gate -- it was that clicking "Trust workspace" did nothing.
//
// saveTrust answered { ok: false, error: "EPERM: operation not permitted, open
// 'C:\\Users\\Administrator\\.claude.json'" }: the file is writable (a plain Node process writes
// it, and the ACL grants FullControl), but Electron's main process is refused. Same
// process-level restriction that pushed the session store into the workspace.
//
// Fix: keep READING the CLI's file, write our own workspace-local overlay, and merge on read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('trust reads merge the CLI file with a workspace overlay', () => {
  assert.match(source, /trustOverlayPath/, 'an overlay must exist');
  assert.match(source, /const overlay = readJsonFile\(trustOverlayPath\(\)\)/, 'reads must consult it');
  assert.match(source, /projects\[key\] = \{ \.\.\.\(projects\[key\]/, 'overlay entries win over the base file');
});

test('trust writes go to the overlay, never to the CLI file', () => {
  // Writing ~/.claude.json fails with EPERM from the main process; a save that reports ok
  // while writing nothing is worse than one that reports failure.
  const saveStart = source.indexOf("_$_saveTrust");
  const saveBody = source.slice(saveStart, saveStart + 900);
  assert.match(saveBody, /writeTrustStore/, 'the handler must use the overlay writer');
  assert.doesNotMatch(saveBody, /fs\.writeFileSync\(claudeJsonPath\(\)/, 'it must not write the CLI file');
});

test('a failed write is reported, not swallowed', () => {
  assert.match(source, /return \{ ok: false, trusted: !wanted, error: 'trust store is not writable' \}/,
    'the caller must learn the save did not happen');
});

test('the overlay lives inside the workspace, which this process can write', () => {
  assert.match(source, /path\.join\(workspace, '\.data', 'trust-store\.json'\)/);
});

test('the live overlay contains the folder we trusted', () => {
  // Records the observable outcome of the fix on this host.
  const overlay = path.join(ROOT, '.data', 'trust-store.json');
  assert.ok(fs.existsSync(overlay), 'run the app and trust the workspace once to create it');
  const parsed = JSON.parse(fs.readFileSync(overlay, 'utf8'));
  const keys = Object.keys(parsed.projects || {});
  assert.ok(keys.some((key) => key.includes('claude-code-desktop')),
    'the trusted folder must be recorded, got: ' + keys.join(', '));
});
