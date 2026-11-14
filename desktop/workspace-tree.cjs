// Workspace tree and file index.
//
// The Code view needs to show a project's files without walking a huge tree on
// every paint. The shipped app does this in a dedicated worker
// (`.vite/build/file-index-worker/fileIndexWorker.js`) whose config exposes
// `respectGitignore` with the note "Note: .ignore files are always respected."
// That distinction is reproduced here: `.gitignore` is opt-out, `.ignore` is not.
//
// Design choices that are this project's own:
//   * one synchronous walk with a hard cap, rather than an incremental index;
//   * ignore matching is a small glob subset (no negation, no `**` classes);
//   * symlinks are never followed, so a link cannot escape the root.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_DEPTH = 12;

// Always skipped: build output, VCS internals, dependency trees. These are noise
// in every project and walking them is the main source of a slow tree.
const ALWAYS_SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', '__pycache__', '.venv', 'venv',
  '.DS_Store', 'Thumbs.db',
]);

/** Converts one gitignore-style line into a predicate over a relative path. */
function compileRule(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const negated = trimmed.startsWith('!');
  if (negated) return null; // negation is not supported; ignored rather than misapplied
  // A pattern without a slash matches a basename at any depth; a leading slash
  // anchors it to the workspace root even when it contains no other slash.
  const anchored = trimmed.startsWith('/');
  const pattern = anchored ? trimmed.slice(1) : trimmed;
  const dirOnly = pattern.endsWith('/');
  const clean = dirOnly ? pattern.slice(0, -1) : pattern;
  if (!clean) return null;

  const matchWholePath = anchored || clean.includes('/');
  return (relativePath, isDirectory) => {
    if (dirOnly && !isDirectory) return false;
    if (!matchWholePath) {
      const base = path.posix.basename(relativePath);
      return globToRegExp(clean).test(base);
    }
    return globToRegExp(clean).test(relativePath);
  };
}

/** Small glob → RegExp supporting `*`, `?` and `**`. */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^$()[]{}|\\'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function readIgnoreFile(root, name) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(compileRule).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Lists the workspace as a flat, sorted list of entries.
 * Returns { entries, truncated, roots }.
 */
function listTree(root, {
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxDepth = DEFAULT_MAX_DEPTH,
  respectGitignore = true,
} = {}) {
  const resolvedRoot = path.resolve(root);
  // The workplace root is chosen by the user, not by the caller: neither message can be fixed
  // by a retry, so both name the one action left (ask the user to open a folder) instead of
  // leaving the caller to list the same broken root again.
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error('workspace does not exist: ' + resolvedRoot
      + '; the workspace folder has moved or been deleted — ask the user to open a folder'
      + ' again; until then no listing is possible');
  }
  const stat = fs.statSync(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error('workspace is not a directory: ' + resolvedRoot
      + '; the workspace root points at a file — ask the user to open the containing folder;'
      + ' listing a file is not possible');
  }

  const ignoreRules = [
    ...readIgnoreFile(resolvedRoot, '.ignore'), // always respected
    ...(respectGitignore ? readIgnoreFile(resolvedRoot, '.gitignore') : []),
  ];

  const entries = [];
  let truncated = false;
  let entryLimitReached = false;

  const walk = (dir, depth, relative) => {
    if (entryLimitReached) return;
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { truncated = true; return; }

    dirents.sort((a, b) => {
      // Directories first, then case-insensitive name order.
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const dirent of dirents) {
      if (entryLimitReached) return;
      if (ALWAYS_SKIP.has(dirent.name)) continue;

      const rel = relative ? `${relative}/${dirent.name}` : dirent.name;
      // Symlinks are listed but never descended into.
      const isDirectory = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();

      if (!isSymlink && ignoreRules.some(rule => rule(rel, isDirectory))) continue;

      if (entries.length >= maxEntries) { truncated = true; entryLimitReached = true; return; }

      entries.push({
        path: rel,
        name: dirent.name,
        type: isDirectory ? 'directory' : 'file',
        symlink: isSymlink,
      });

      if (isDirectory && !isSymlink && depth < maxDepth) walk(path.join(dir, dirent.name), depth + 1, rel);
      else if (isDirectory && !isSymlink) truncated = true;
    }
  };

  walk(resolvedRoot, 0, '');
  return { root: resolvedRoot, entries, truncated };
}

/** Reads one directory level, for a lazily expanded tree. */
function listDirectory(root, relative = '') {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // "escapes the workspace" states the rule but not the repair. The parameter is relative
    // to the root, so the usable fix is to drop the leading .. and pass a root-relative path.
    throw new Error('path escapes the workspace: ' + target
      + '; pass a path relative to the workspace root instead of one that climbs out of it'
      + ' (drop the leading ".." , or pass "." to list the root)');
  }
  if (!fs.existsSync(target)) {
    throw new Error('directory does not exist: ' + target
      + '; check the name with a listing of the parent directory first (List "." lists the'
      + ' workspace root), or use Glob to find the path at any depth');
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new Error('not a directory: ' + target
      + '; this path is a file — use Read to read it, or List its parent directory to find'
      + ' the folder you meant');
  }

  const ignoreRules = [
    ...readIgnoreFile(resolvedRoot, '.ignore'),
    ...readIgnoreFile(resolvedRoot, '.gitignore'),
  ];

  return fs.readdirSync(target, { withFileTypes: true })
    .filter(dirent => !ALWAYS_SKIP.has(dirent.name))
    .filter(dirent => {
      const childRel = rel ? `${rel.split(path.sep).join('/')}/${dirent.name}` : dirent.name;
      return !ignoreRules.some(rule => rule(childRel, dirent.isDirectory()));
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    })
    .map(dirent => ({
      name: dirent.name,
      type: dirent.isDirectory() ? 'directory' : 'file',
      symlink: dirent.isSymbolicLink(),
    }));
}

module.exports = {
  ALWAYS_SKIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  compileRule,
  globToRegExp,
  listTree,
  listDirectory,
};
