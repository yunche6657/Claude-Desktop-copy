'use strict';

// The general lifecycle bounds positive timers at the platform timer maximum.
// Configuration-specific lower bounds belong to the caller that reads config.
const RECHECK_MS = 900000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function createWarmIdleLifecycle({
  isQueryActive,
  onDisconnect,
  getTimeoutMs = () => 0,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onState = () => {},
  armOnTurnComplete = 'when-hidden',
  timeoutOnHidden = true,
} = {}) {
  if (typeof isQueryActive !== 'function' || typeof onDisconnect !== 'function') {
    throw new TypeError('isQueryActive and onDisconnect are required');
  }
  const sessions = new Map();
  const snapshot = s => ({
    sessionId: s.sessionId, isTabVisible: s.isTabVisible,
    visibilityKnown: s.visibilityKnown, hasPendingResult: s.hasPendingResult,
    lastMessageSentTime: s.lastMessageSentTime, lastResultTime: s.lastResultTime,
    lastHiddenTime: s.lastHiddenTime, idleArmedAt: s.idleArmedAt,
    idleArmedTimeoutMs: s.idleArmedTimeoutMs, idleUnarmedSince: s.idleUnarmedSince,
    idleArmed: s.idleTimeoutId != null, idleRecheckPending: s.idleRecheckId != null,
    consecutiveDeclinedPauses: s.consecutiveDeclinedPauses,
  });
  const emit = s => { if (sessions.get(s.sessionId) === s) onState(s.sessionId, snapshot(s)); };
  const knownVisible = s => s.visibilityKnown && s.isTabVisible;
  function clearArmed(s) {
    if (s.idleTimeoutId != null) {
      clearTimer(s.idleTimeoutId); s.idleTimeoutId = null; s.idleArmedAt = null;
    }
  }
  function clearUnarmed(s) {
    s.idleUnarmedSince = null;
    if (s.idleRecheckId != null) { clearTimer(s.idleRecheckId); s.idleRecheckId = null; }
  }
  function startIdleTimeout(id) {
    const s = sessions.get(id);
    if (!s) return;
    const value = getTimeoutMs(id);
    const timeout = value > 0 ? Math.min(value, MAX_TIMEOUT_MS) : 0;
    if (!(timeout > 0)) {
      clearArmed(s);
      if (!isQueryActive(id)) { clearUnarmed(s); emit(s); return; }
      s.idleUnarmedSince ??= now();
      if (s.idleRecheckId != null) clearTimer(s.idleRecheckId);
      s.idleRecheckId = setTimer(() => {
        s.idleRecheckId = null;
        if (sessions.has(id) && s.idleUnarmedSince != null) startIdleTimeout(id);
      }, RECHECK_MS);
      emit(s); return;
    }
    clearArmed(s); clearUnarmed(s);
    s.idleArmedTimeoutMs = timeout;
    s.idleArmedAt = now();
    s.idleTimeoutId = setTimer(async () => {
      s.idleTimeoutId = null;
      if (armOnTurnComplete === 'when-hidden' && knownVisible(s)) { emit(s); return; }
      if (!isQueryActive(id)) { s.consecutiveDeclinedPauses = 0; emit(s); return; }
      emit(s);
      try { await onDisconnect(id); } catch (_) { /* original retries while query remains */ }
      if (sessions.get(id) !== s) return;
      if (isQueryActive(id)) {
        s.consecutiveDeclinedPauses += 1;
        startIdleTimeout(id); return;
      }
      s.hasPendingResult = false; s.consecutiveDeclinedPauses = 0; emit(s);
    }, timeout);
    emit(s);
  }
  function register(id) {
    if (sessions.has(id)) return;
    const s = { sessionId: id, isTabVisible: true, visibilityKnown: false,
      hasPendingResult: false, lastMessageSentTime: null, lastResultTime: null,
      lastHiddenTime: null, idleTimeoutId: null, idleArmedAt: null,
      idleArmedTimeoutMs: null, idleUnarmedSince: null, idleRecheckId: null,
      consecutiveDeclinedPauses: 0 };
    sessions.set(id, s); emit(s);
  }
  function unregister(id) {
    const s = sessions.get(id); if (!s) return;
    clearArmed(s); clearUnarmed(s); sessions.delete(id);
    onState(id, null);
  }
  function onTurnComplete(id) {
    const s = sessions.get(id); if (!s) return;
    s.hasPendingResult = true; s.lastResultTime = now();
    if (armOnTurnComplete === 'always' || !knownVisible(s)) startIdleTimeout(id);
    else emit(s);
  }
  function onQueryInstalled(id) {
    const s = sessions.get(id); if (s && !knownVisible(s)) startIdleTimeout(id);
  }
  function onMessageSent(id) {
    const s = sessions.get(id); if (!s) return;
    clearArmed(s); s.hasPendingResult = false; clearUnarmed(s);
    s.lastResultTime = null; s.lastMessageSentTime = now();
    s.consecutiveDeclinedPauses = 0; emit(s);
  }
  function onVisibilityChange(id, visible) {
    const s = sessions.get(id); if (!s) return;
    const previous = s.isTabVisible;
    s.isTabVisible = visible; s.visibilityKnown = true;
    if (visible && !previous) { clearArmed(s); clearUnarmed(s); }
    else if (!visible && previous) {
      s.lastHiddenTime = now();
      if (s.hasPendingResult || timeoutOnHidden) { startIdleTimeout(id); return; }
    }
    emit(s);
  }
  function markDisconnected(id) {
    const s = sessions.get(id); if (!s) return;
    clearArmed(s); s.hasPendingResult = false; clearUnarmed(s);
    s.consecutiveDeclinedPauses = 0; emit(s);
  }
  function getState(id) { const s = sessions.get(id); return s ? snapshot(s) : undefined; }
  function destroy() { for (const id of [...sessions.keys()]) unregister(id); }
  return { register, unregister, onTurnComplete, onQueryInstalled, onMessageSent,
    onVisibilityChange, markDisconnected, getState, destroy };
}
module.exports = { createWarmIdleLifecycle, RECHECK_MS, MAX_TIMEOUT_MS };
