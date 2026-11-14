'use strict';

const { matchesCliServer, isToolDisabled } = require('./mcp-session-policy.cjs');

// Pure classification only. The caller must supply a current, authoritative
// session/policy/config snapshot and revalidate it across every asynchronous
// operation. These booleans are evaluations of the fixed build's predicates,
// not values inferred from a replica's persisted `local` flag.
function rowsFromElsewhere(source) {
  if (!source || !['local', 'wsl'].includes(source.backendKind) ||
      typeof source.remoteRows !== 'boolean' || typeof source.remoteControl !== 'boolean' ||
      typeof source.foreignImport !== 'boolean' || typeof source.hasImport !== 'boolean' ||
      typeof source.resumeConfirmed !== 'boolean') return true;
  return source.remoteRows || source.remoteControl || source.foreignImport ||
    (source.hasImport && !source.resumeConfirmed);
}

function decideLocalMcp({ source, session, server, tool, operation, reserved, globalToolDisabled } = {}) {
  if (!session || typeof server !== 'string' || !server ||
      !['listResources', 'readResource', 'callTool'].includes(operation) ||
      !(session.cliMcpAppServerNames instanceof Set || Array.isArray(session.cliMcpAppServerNames))) return 'deny';
  const cli = matchesCliServer(session.cliMcpAppServerNames, server);
  if (cli) return operation === 'readResource' ? 'cli-read' : 'deny';
  if (rowsFromElsewhere(source) || typeof reserved !== 'boolean' || reserved) return 'deny';
  if (operation === 'callTool') {
    if (typeof tool !== 'string' || !tool || typeof globalToolDisabled !== 'boolean' || globalToolDisabled ||
        isToolDisabled(session, server, tool)) return 'deny';
  }
  return 'local';
}
module.exports = { rowsFromElsewhere, decideLocalMcp };

// Literal fixed 2.42304 KV projection; this function assumes an authentic
// native-shaped record. It is not proof that a replica record has that origin.
function nativeRowsFromElsewhere(session) {
  if (session === undefined) return true;
  const backend = session.backend;
  return backend.kind !== 'local' && backend.kind !== 'wsl' ||
    (backend.remoteTarget === undefined && (session._startedThroughHostCliLauncher === true ||
      session._everStartedThroughHostCliLauncher === true || session.launcherMarked === true)) ||
    (typeof session.importedFrom === 'string' &&
      (session.importedFrom.startsWith('local-1p-') || session.importedFrom.endsWith('-elsewhere'))) ||
    !!session.importedFrom && !session.resumeConfirmed;
}
module.exports.nativeRowsFromElsewhere = nativeRowsFromElsewhere;
