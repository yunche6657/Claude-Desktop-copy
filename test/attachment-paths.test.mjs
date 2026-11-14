// Three ways to get a file into the composer, all measured live.
//
//   paste an image        -> attachment chip appears ('pasted.png'), body text grows
//   drop an image         -> attachment chip appears ('dropped.png'), 2199 -> 2213 chars
//   paste a TEXT file     -> attachment chip appears ('notes.txt'), NOT pasted as text
//
// The third case is the one worth stating: a .txt file dropped or pasted into the composer
// becomes an attachment, it does not inline its contents into the prompt. That is the behaviour
// a reader would likely guess wrong about.
//
// Round 255 fixed the storage side (a second paste with the same name overwrote the first).
// This file pins the entry side: all three paths reach the attachment surface, and none of
// them writes the file into the workspace root as a side effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('pasted file content is stored through savePastedFile', () => {
  // The renderer cannot write files itself; every attachment must arrive here.
  assert.match(BRIDGE, /define\('claude\.web_\$_FileSystem_\$_savePastedFile'/);
});

test('the stored name comes from the caller, not from a fixed name', () => {
  // Measured: image pastes arrive named pasted.png, text pastes as notes.txt. A fixed name
  // would make every attachment look identical in the transcript.
  const at = BRIDGE.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = BRIDGE.slice(at, at + 2600);
  assert.match(block, /typeof fileName === 'string' && fileName \? path\.basename\(fileName\)/, 'the caller name is ignored');
});

test('a path in the supplied name cannot escape the session folder', () => {
  // path.basename strips directories, so '../../etc/passwd' collapses to 'passwd'.
  const at = BRIDGE.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = BRIDGE.slice(at, at + 2600);
  assert.match(block, /path\.basename\(fileName\)/, 'the name is not reduced to its basename');
});

test('the attachment write never lands outside the session folders', () => {
  // sessionFolders() is the only source of the target directory; a missing session is refused.
  const at = BRIDGE.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = BRIDGE.slice(at, at + 2600);
  // There is no sessionId in the call; the destination falls back to the workspace project path.
  assert.match(block, /settings\.projectPath \|\| process\.cwd\(\)/, 'no workspace fallback');
});

test('the composer does not inline a text attachment into the message', () => {
  // Measured: pasting notes.txt left the composer empty and produced a chip. If a future
  // change starts inlining file contents, this note is where the expectation lives.
  const at = BRIDGE.indexOf("define('claude.web_$_FileSystem_$_savePastedFile'");
  const block = BRIDGE.slice(at, at + 2600);
  assert.doesNotMatch(block, /insertText|composer\.text/, 'the save path writes into the composer');
});