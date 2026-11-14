'use strict';

// Fixed 2.42304 YCr. Dependencies must be backed by the real session manager,
// preferences and feature policy before this controller is connected to Electron.
function createCodeKeepAwakeController({ sessions, preferences, powerMonitor, claims, isEnabled,
  now = () => performance.now(), idleSeconds = () => powerMonitor.getSystemIdleTime(),
  timers = globalThis, telemetry = () => {} }) {
  const active = new Map(), excluded = new Map(), manual = new Map();
  let activity = { background_task: 0, loop: 0 }, lastTurn = now();
  let heldSince, maxSessions = 0, releaseTimer, pollTimer, releaseReason = 'idle';
  let notice, maxAway, slept = false;
  const onBattery = () => { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } };
  const workingEnabled = () => preferences.get('ccKeepAwakeWhileWorking') !== false;
  const batteryAllowed = () => preferences.get('ccKeepAwakeOnBattery') !== false || !onBattery();
  const disabledReason = () => !isEnabled() ? 'disabled' : !workingEnabled() ? 'setting_off' : undefined;
  const unref = handle => { handle?.unref?.(); return handle; };
  const count = () => active.size + activity.background_task + activity.loop;
  const armed = () => activity.background_task > 0 || activity.loop > 0;
  const hasWork = time => active.size > 0 || (armed() && time - lastTurn < 7200000);
  const refreshActivity = () => {
    const value = sessions.countRunningSessionsByActivity({ includeSshSurvivors: true });
    activity = { background_task: value.background_task, loop: value.loop };
  };
  const clearRelease = () => { if (releaseTimer) timers.clearTimeout(releaseTimer); releaseTimer = undefined; };
  const startPoll = () => { if (!pollTimer) pollTimer = unref(timers.setInterval(tick, 60000)); };
  const stopPoll = () => { if (!manual.size && pollTimer) { timers.clearInterval(pollTimer); pollTimer = undefined; } };
  function sampleIdle() {
    if (heldSince === undefined) return;
    let idle;
    try { idle = idleSeconds() * 1000; } catch { return; }
    if (!Number.isFinite(idle) || idle < 0) return;
    const time = now();
    maxAway = Math.max(maxAway ?? 0, Math.min(idle, time - heldSince));
    for (const item of active.values()) item.maxAwayMs = Math.max(item.maxAwayMs, Math.min(idle, time - Math.max(item.countingSince, heldSince)));
  }
  function take() {
    heldSince = now(); maxSessions = count(); notice = undefined; maxAway = undefined;
    for (const item of active.values()) item.maxAwayMs = 0;
    claims.claim('code_turn');
    telemetry('desktop_ccd_keep_awake_held', { session_count: maxSessions, on_battery: onBattery(), reason: active.size ? 'turn' : activity.background_task > 0 ? 'background_task' : 'loop' });
    startPoll();
  }
  function release(reason) {
    clearRelease(); stopPoll();
    if (heldSince === undefined) { if (reason !== 'battery') slept = false; return; }
    sampleIdle(); const duration = Math.round(now() - heldSince); heldSince = undefined;
    claims.release('code_turn');
    const away = maxAway === undefined ? null : Math.round(maxAway);
    const candidate = (reason === 'idle' || reason === 'armed_grace') && !slept && !claims.isBlocking() ? notice : undefined;
    telemetry('desktop_ccd_keep_awake_released', { held_ms: duration, keep_awake_release: reason, on_battery: onBattery(), max_session_count: maxSessions, max_system_idle_ms: away, notice_requested: candidate !== undefined });
    maxSessions = 0;
    if (candidate) sessions.noteKeptAwake(candidate.sessionId, candidate.heldMs);
    if (reason !== 'battery') slept = false;
  }
  function reconcile(reason = 'idle') {
    const time = now();
    if (active.size) lastTurn = time;
    if (hasWork(time)) {
      clearRelease();
      if (!batteryAllowed()) { if (heldSince !== undefined) release('battery'); startPoll(); return; }
      if (heldSince === undefined) take(); else maxSessions = Math.max(maxSessions, count());
      return;
    }
    if (heldSince === undefined) { stopPoll(); slept = false; return; }
    if (!batteryAllowed()) { release('battery'); slept = false; return; }
    if (!releaseTimer) {
      releaseReason = armed() ? 'armed_grace' : reason;
      releaseTimer = unref(timers.setTimeout(() => { releaseTimer = undefined; release(releaseReason); }, 30000));
    }
  }
  function scheduleCheck(id, delay) { return unref(timers.setTimeout(() => check(id), delay)); }
  function check(id) {
    const item = active.get(id); if (!item) return;
    const time = now(), age = time - item.since, stalled = time - item.lastProgressAt;
    if (age >= 86400000) return exclude(id, item, 'max');
    if (stalled >= 3600000) {
      if (stalled < 10800000 && sessions.hasLosableBackgroundWork(id)) {
        item.check = scheduleCheck(id, Math.min(3600000, 10800000 - stalled, 86400000 - age)); return;
      }
      return exclude(id, item, 'stalled');
    }
    item.check = scheduleCheck(id, Math.min(3600000 - stalled, 86400000 - age));
  }
  function exclude(id, item, why) { active.delete(id); excluded.set(id, { why, since: item.since }); reconcile(why); }
  function start(id) {
    if (sessions.isViolinBow(id)) { excluded.delete(id); reconcile(); return; }
    const time = now(), item = active.get(id);
    if (item) { item.lastProgressAt = time; reconcile(); return; }
    const old = excluded.get(id);
    if (old?.why === 'max') { reconcile(); return; }
    const since = old?.since ?? time; excluded.delete(id);
    if (old?.slept) slept = true;
    if (notice?.sessionId === id) notice = undefined;
    if (time - since >= 86400000) { excluded.set(id, { why: 'max', since }); reconcile(); return; }
    active.set(id, { since, countingSince: time, lastProgressAt: time, maxAwayMs: 0, check: scheduleCheck(id, Math.min(3600000, 86400000 - (time - since))) });
    reconcile();
  }
  function progress(id) {
    const item = active.get(id);
    if (item) { item.lastProgressAt = now(); return; }
    if (excluded.get(id)?.why === 'stalled' && !disabledReason()) { refreshActivity(); start(id); }
  }
  function end(id, why) {
    const wasExcluded = excluded.delete(id), item = active.get(id);
    if (item) { sampleIdle(); timers.clearTimeout(item.check); active.delete(id); }
    if (item || wasExcluded) {
      const time = now(); lastTurn = time;
      if (why === 'completed' && item && heldSince !== undefined) {
        const duration = Math.round(time - Math.max(item.countingSince, heldSince));
        if (duration >= 600000 && item.maxAwayMs >= 600000) notice = { sessionId: id, heldMs: duration, awayMs: Math.round(item.maxAwayMs) };
      } else if (why === 'gone' && notice?.sessionId === id) notice = undefined;
    }
    reconcile();
  }
  function takeManual(id) {
    if (manual.get(id) !== undefined) return;
    manual.set(id, now()); claims.claim(`code_session:${id}`);
    telemetry('desktop_ccd_keep_awake_manual_held', { on_battery: onBattery(), while_working_held: heldSince !== undefined }); startPoll();
  }
  function releaseManual(id, reason, remove = true) {
    const since = manual.get(id);
    if (remove) manual.delete(id); else if (manual.has(id)) manual.set(id, undefined);
    if (since === undefined) return;
    claims.release(`code_session:${id}`);
    telemetry('desktop_ccd_keep_awake_manual_released', { held_ms: Math.round(now() - since), keep_awake_release: reason, on_battery: onBattery() });
  }
  function syncManual() { for (const id of [...manual.keys()]) isEnabled() ? takeManual(id) : releaseManual(id, 'disabled', false); }
  function clearAll(reason) {
    if (reason === 'disposed') for (const id of [...manual.keys()]) releaseManual(id, reason);
    else if (reason === 'disabled') syncManual();
    const preserve = reason === 'disabled' || reason === 'setting_off';
    for (const [id, item] of active) { timers.clearTimeout(item.check); if (preserve) excluded.set(id, { why: 'stalled', since: item.since }); }
    active.clear(); if (!preserve) excluded.clear();
    activity = { background_task: 0, loop: 0 }; release(reason);
  }
  function tick() {
    sampleIdle(); const reason = disabledReason();
    if (reason) { clearAll(reason); if (reason === 'setting_off') syncManual(); return; }
    syncManual(); refreshActivity(); reconcile();
  }
  function rememberDisabled(id, running) {
    if (running) { if (!excluded.has(id) && !sessions.isViolinBow(id)) excluded.set(id, { why: 'stalled', since: now() }); }
    else if (excluded.delete(id)) lastTurn = now();
  }
  function onEvent(event) {
    if (event.type === 'message' || event.type === 'tool_permission_resolved') { progress(event.sessionId); return; }
    const update = event.type === 'session_updated' || event.type === 'start';
    if (!update && !['close', 'error', 'stopped', 'paused', 'archived', 'deleted'].includes(event.type)) return;
    if (update) {
      if (event.session?.manualKeepAwake === true) {
        if (!sessions.isViolinBow(event.sessionId)) {
          if (!manual.has(event.sessionId)) { manual.set(event.sessionId, undefined); startPoll(); }
          if (isEnabled()) takeManual(event.sessionId);
        }
      } else if (event.session) releaseManual(event.sessionId, 'toggle_off');
    } else if (event.type === 'archived' || event.type === 'deleted') releaseManual(event.sessionId, 'archived');
    const running = update && event.session !== undefined && (event.session.turnRunning ?? event.session.isRunning);
    const reason = disabledReason();
    if (reason) { clearAll(reason); rememberDisabled(event.sessionId, running); return; }
    refreshActivity(); if (running) start(event.sessionId); else end(event.sessionId, update ? 'completed' : 'gone');
  }
  function onCompleted(id) {
    const reason = disabledReason();
    if (reason) { clearAll(reason); rememberDisabled(id, false); return; }
    refreshActivity(); end(id, 'completed');
  }
  function onSleep() { if (heldSince !== undefined || active.size) slept = true; for (const item of excluded.values()) item.slept = true; }
  sessions.on('event', onEvent); sessions.on('queryCompleted', onCompleted);
  preferences.on('ccKeepAwakeWhileWorking', tick); preferences.on('ccKeepAwakeOnBattery', tick);
  powerMonitor.on('on-battery', tick); powerMonitor.on('on-ac', tick); powerMonitor.on('suspend', onSleep); powerMonitor.on('resume', onSleep);
  tick();
  return { refresh: tick, dispose() {
    // Native YCr runs cleanup on every disposal: an already-dispatched event
    // may reacquire a claim after its listener has been removed.
    sessions.off('event', onEvent); sessions.off('queryCompleted', onCompleted);
    preferences.off('ccKeepAwakeWhileWorking', tick); preferences.off('ccKeepAwakeOnBattery', tick);
    powerMonitor.off('on-battery', tick); powerMonitor.off('on-ac', tick); powerMonitor.off('suspend', onSleep); powerMonitor.off('resume', onSleep);
    clearAll('disposed');
  } };
}
module.exports = { createCodeKeepAwakeController };
