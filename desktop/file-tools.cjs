// File tools.
//
// The three operations the Code view performs on a workspace: read a file, write
// a file, and replace an exact string inside a file. Each is gated by a path
// policy (the file must sit inside an approved root) and each write path returns
// a diff so the user approves the actual change rather than a description of it.
//
// Failure modes are deliberately explicit. A `str_replace` that would match more
// than once is refused instead of guessing which occurrence was meant, because
// guessing is how an edit silently damages an unrelated function.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { diffText } = require('./diff.cjs');

const MAX_READ_BYTES = 2 * 1024 * 1024;

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new ToolError(code, message); };

/** Resolves and confines a path to the approved roots. */
function resolveInsideRoots(requested, allowedRoots) {
  if (typeof requested !== 'string' || !requested.trim()) {
    // A bare requirement statement leaves a caller that already sent the key stuck (an empty
    // string, a null, a number), so name the argument, its expected form and a value to try.
    fail('invalid-path', 'a file path is required: pass "path" as a non-empty string'
      + ' (relative to the workspace, or absolute inside it), e.g. {path: "src/index.js"}');
  }
  const resolved = path.resolve(requested);
  if (!allowedRoots || !allowedRoots.length) {
    // "select a folder first" is advice for a HUMAN. The model has no folder picker, so say
    // what it can do: every path is checked against the roots, so a different path cannot
    // help, and the one tool that does not need a root is the skill catalogue.
    fail('no-root', 'no workspace root is approved, so no file can be read or written by path;'
      + ' a different path cannot help because every path is checked against the approved roots.'
      + ' Ask the user to open a folder; the Skill tool still works (call it with no argument to list skills)');
  }
  const inside = allowedRoots.some(root => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!inside) {
    // Name a next step: the model cannot widen the roots, but it can list the workspace.
    fail('outside-root', 'path is outside the approved roots: ' + resolved
      + '; use a path inside the workspace, or List the workspace to see what is available');
  }
  return resolved;
}

function readFile(filePath, { allowedRoots } = {}) {
  const resolved = resolveInsideRoots(filePath, allowedRoots);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch { fail('not-found', 'file does not exist: ' + resolved
      + '; List its directory to check the name, or Glob for the pattern'); }
  if (!stat.isFile()) fail('not-a-file', 'not a regular file: ' + resolved
      + '; this path is a directory — use List to read its contents');
  if (stat.size > MAX_READ_BYTES) {
    // A bare size comparison leaves the caller stuck: it cannot shrink the file and has no
    // other tool for reading inside one. Name the alternatives it does have.
    fail('too-large', 'file is ' + stat.size + ' bytes; the read limit is ' + MAX_READ_BYTES
      + '; this file cannot be read whole — use Glob to find a smaller file, or List to see'
      + ' what is in its directory');
  }
  const content = fs.readFileSync(resolved, 'utf8');
  return {
    path: resolved,
    size: stat.size,
    content,
    lines: content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0),
  };
}

/** Computes the diff a write would produce, without writing it. */
function previewWrite(filePath, content, { allowedRoots } = {}) {
  const resolved = resolveInsideRoots(filePath, allowedRoots);
  if (typeof content !== 'string') {
    // Every caller stringifies before reaching here, so the only way to arrive is a caller
    // that passed the wrong key or a non-string value — say which, and what shape is right.
    fail('invalid-content', 'content must be a string: pass "content" with the complete file text'
      + ' (an empty string is allowed for an empty file), not a number, null, object or array');
  }
  let previous = '';
  let existed = false;
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) fail('not-a-file', 'not a regular file: ' + resolved
      + '; this path is a directory — use List to read its contents');
    // A bare size, and no next step. The way out is NOT Read/Edit/Write: all
    // three go through this same 2 MB read, so recommending one of them would send the caller
    // in a circle. The tool that can still touch such a file is Bash, which spawns a program
    // instead of loading the file into this process.
    if (stat.size > MAX_READ_BYTES) {
      fail('too-large', 'file is ' + stat.size + ' bytes; the diff limit is ' + MAX_READ_BYTES
        + '; this file is too large to read-and-rewrite whole (Read and Edit refuse it for the'
        + ' same reason) — patch it with a command instead: use Bash with an allowlisted'
        + ' program such as node, or use Glob to pick a smaller file');
    }
    previous = fs.readFileSync(resolved, 'utf8');
    existed = true;
  }
  return { path: resolved, existed, diff: diffText(previous, content), previous };
}

/** Writes atomically: a temp file plus rename, so a crash cannot truncate. */
function writeFile(filePath, content, { allowedRoots } = {}) {
  const preview = previewWrite(filePath, content, { allowedRoots });
  if (!preview.diff.hunks.length && preview.existed) {
    return { ...preview, written: false, reason: 'no-change' };
  }
  const dir = path.dirname(preview.path);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(preview.path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, preview.path);
  } finally {
    if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
  }
  return { ...preview, written: true };
}

/**
 * Replaces an exact string. `oldText` must occur exactly once; zero matches and
 * multiple matches are both refused so the caller has to be more specific.
 */
function replaceInFile(filePath, oldText, newText, { allowedRoots } = {}) {
  // The messages name the parameters the CALLER uses (`old_string` / `new_string`), not the
  // internal ones (`oldText` / `newText`). Measured: a failed Edit reported
  // "oldText was not found in the file", which tells the model nothing about the argument it
  // actually passed — it has no `oldText` field to correct.
  if (typeof oldText !== 'string' || oldText === '') {
    fail('invalid-match', 'old_string must be a non-empty string');
  }
  if (typeof newText !== 'string') fail('invalid-content', 'new_string must be a string');
  const current = readFile(filePath, { allowedRoots });

  const occurrences = current.content.split(oldText).length - 1;
  if (occurrences === 0) {
    fail('no-match', 'old_string was not found in the file; read the file first and copy the text exactly');
  }
  if (occurrences > 1) {
    fail('ambiguous-match', 'old_string occurs ' + occurrences
      + ' times; include more surrounding context to make it unique');
  }

  const next = current.content.replace(oldText, newText);
  return writeFile(current.path, next, { allowedRoots });
}

module.exports = {
  ToolError,
  MAX_READ_BYTES,
  resolveInsideRoots,
  readFile,
  previewWrite,
  writeFile,
  replaceInFile,
};
