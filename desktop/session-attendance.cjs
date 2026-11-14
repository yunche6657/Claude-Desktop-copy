'use strict';

// Session attendance is inherited along the dispatch chain. Keep absence
// semantics identical to the desktop reference: only undefined is absent.
function classifyAttendance(sessionId, getHeld) {
  let hasRoutine = false;
  let continued = false;
  let currentId = sessionId;
  for (let depth = 0; depth <= 16; depth++) {
    const session = getHeld(currentId);
    if (!session) return depth === 0 || hasRoutine ? 'unresolvable' : 'dispatchedHere';
    if (session.scheduledTaskId !== undefined) {
      hasRoutine = true;
      continued ||= session.scheduledRunContinued === true;
    }
    if (session.dispatchParentOrigin === 'remote') return 'remoteDispatched';
    if (session.dispatchParentId === undefined) {
      if (session.dispatchParentOrigin === undefined)
        return hasRoutine ? (continued ? 'routineContinued' : 'routine') : 'plain';
      return hasRoutine ? 'unresolvable' : 'orphan';
    }
    currentId = session.dispatchParentId;
  }
  return 'unresolvable';
}

// The warm-lifecycle call site explicitly treats an omitted session ID as false.
function warmUnattended(sessionId, getHeld) {
  if (sessionId === undefined) return false;
  const kind = classifyAttendance(sessionId, getHeld);
  return kind !== 'plain' && kind !== 'dispatchedHere';
}

module.exports = { classifyAttendance, warmUnattended };
