'use strict';
// Bn6onBlX: lW, isLoopWakeupLiveAt, hasLiveLoopWakeup and resume handler.
const GRACE_MS = 960000;
const MAX_WAKE_DELAY_MS = 7200000;
const MAX_SUSPEND_MS = 259200000;
function createLoopProtection() {
  let wakeup = null;
  let lastActivityAt = 0;
  let lastCliMessageAt = 0;
  let lastSuspendedAt = null;
  let firstUnpairedSuspendAt = null;
  const validTime = value => typeof value === 'number' && Number.isFinite(value);
  function positiveSchedule(value) {
    if (!value || !validTime(value.scheduledFor) || !validTime(value.armedAt)) return false;
    wakeup = {scheduledFor: value.scheduledFor, armedAt: value.armedAt};
    return true;
  }
  function activity(value) {
    if (!value || typeof value !== 'object') return false;
    if (validTime(value.lastActivityAt)) lastActivityAt = value.lastActivityAt;
    if (validTime(value.lastCliMessageAt)) lastCliMessageAt = value.lastCliMessageAt;
    return true;
  }
  function liveAt(time) {
    return !!wakeup && (wakeup.scheduledFor + GRACE_MS > time ||
      wakeup.scheduledFor + MAX_WAKE_DELAY_MS > time &&
      time - Math.min(Math.max(lastActivityAt, lastCliMessageAt), time) < GRACE_MS);
  }
  function hasLive(time = Date.now()) {
    if (!validTime(time) || !wakeup) return false;
    return liveAt(time) || (lastSuspendedAt !== null && wakeup.armedAt <= lastSuspendedAt + GRACE_MS &&
      liveAt(firstUnpairedSuspendAt ?? lastSuspendedAt) && time - lastSuspendedAt < MAX_SUSPEND_MS);
  }
  function suspend(time = Date.now()) {
    if (!validTime(time)) return false;
    firstUnpairedSuspendAt ??= time;
    lastSuspendedAt = time;
    return true;
  }
  // Native resume adjusts only local sessions. An unmatched resume follows its
  // distinct fallback; paired resumes shift only wakeups live at first suspend.
  function resume(time = Date.now(), {local = true} = {}) {
    if (!validTime(time)) return false;
    const last = lastSuspendedAt, first = firstUnpairedSuspendAt;
    lastSuspendedAt = firstUnpairedSuspendAt = null;
    if (!wakeup || !local) return true;
    const start = last === null ? null : first ?? last;
    if (start !== null) {
      if (liveAt(start)) wakeup.scheduledFor = Math.min(wakeup.scheduledFor + time - start, time + MAX_WAKE_DELAY_MS);
    } else {
      const delay = Math.min(Math.max(wakeup.scheduledFor - wakeup.armedAt, 0), MAX_WAKE_DELAY_MS);
      wakeup.scheduledFor = Math.max(wakeup.scheduledFor, time + delay);
    }
    return true;
  }
  // Native candidate checks do not mutate; pause clears only after rechecking.
  function clearExpired(time = Date.now()) {
    if (!wakeup || hasLive(time)) return false;
    wakeup = null;
    return true;
  }
  function syncPower(context = {}) {
    if (context.lastSuspendedAt === null || validTime(context.lastSuspendedAt)) lastSuspendedAt = context.lastSuspendedAt;
    if (context.firstUnpairedSuspendAt === null || validTime(context.firstUnpairedSuspendAt)) firstUnpairedSuspendAt = context.firstUnpairedSuspendAt;
  }
  function snapshot() { return {wakeup: wakeup && {...wakeup}, lastActivityAt, lastCliMessageAt, lastSuspendedAt, firstUnpairedSuspendAt}; }
  function reset() {wakeup = null; lastActivityAt = lastCliMessageAt = 0; lastSuspendedAt = firstUnpairedSuspendAt = null;}
  return {positiveSchedule, activity, hasLive, suspend, resume, syncPower, clearExpired, snapshot, reset};
}
module.exports = {createLoopProtection, GRACE_MS, MAX_WAKE_DELAY_MS, MAX_SUSPEND_MS};
