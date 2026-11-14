'use strict';

// The shipped preview-version hook calls workingDir.replace() on session load.
// Normalize only the public projection; persisted folderless values stay intact.
function projectSessionPaths(session, root = process.env.CLAUDE_WORKSPACE || process.cwd()) {
  const isPath = value => typeof value === 'string' && value.trim().length > 0;
  const cwd = isPath(session.cwd) ? session.cwd : root;
  return {
    ...session,
    cwd,
    workingDir: isPath(session.workingDir) ? session.workingDir : cwd,
    originCwd: isPath(session.originCwd) ? session.originCwd : cwd,
    ...(!isPath(session.cwd) ? { folderless: true } : {}),
  };
}

module.exports = { projectSessionPaths };
