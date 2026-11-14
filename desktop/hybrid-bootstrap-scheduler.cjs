'use strict';
// Scheduling subset of scheduleBootstrapRepolls/armBootstrapPoll. Other
// application hooks, boot retry policy and OS event plumbing are injected.
function createHybridBootstrapScheduler({ intervalMinutes, isConfigured, wantsQuickConfirm, refresh,
  rereadConfig = () => {}, expediteBootRetry = () => {}, subscribe = () => () => {},
  now = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, pollOverrideMs }) {
  let poll, wake, away, quick = false, stopped = false, started = false, inflight;
  const detach = [];
  const run = () => {
    if (!inflight) inflight = Promise.resolve().then(refresh).catch(() => {}).finally(() => { inflight = undefined; });
    return inflight;
  };
  function arm() {
    if (stopped) return;
    if (poll !== undefined) clearTimer(poll);
    const interval = pollOverrideMs ?? intervalMinutes() * 60000;
    quick = wantsQuickConfirm();
    const delay = quick ? Math.min(30000, interval) : pollOverrideMs === undefined ? Math.round(interval * (.9 + random() * .2)) : interval;
    poll = setTimer(() => { poll = undefined; rereadConfig(); (isConfigured() ? run() : Promise.resolve()).finally(arm); }, delay);
    poll?.unref?.();
  }
  function confirm() { rereadConfig(); if (poll !== undefined && !quick && wantsQuickConfirm()) arm(); }
  function wakeAttempt(index) {
    if (stopped || wake !== undefined) return;
    const delays = [10000, 30000, 120000];
    wake = setTimer(() => { wake = undefined; if (away === undefined || stopped) return;
      run().then(() => { if (away !== undefined && !stopped) { if (index + 1 < delays.length) wakeAttempt(index + 1); else away = undefined; } });
    }, delays[index]);
    wake?.unref?.();
  }
  function markAway() { away ??= now(); }
  function restore(fallback) {
    const since = away ?? fallback;
    if (since === undefined || now() - since < 300000) { away = undefined; return; }
    away = since; wakeAttempt(0);
  }
  function start() {
    if (stopped || started) return;
    started = true;
    const listen = (event, fn) => { const off = subscribe(event, fn); if (typeof off === 'function') detach.push(off); };
    const configuredAtStart = isConfigured();
    listen('resume', () => { confirm(); if (configuredAtStart) { expediteBootRetry('resume'); restore(0); } });
    listen('unlock', () => { confirm(); if (configuredAtStart) { expediteBootRetry('unlock'); restore(); } });
    listen('session', () => { if (configuredAtStart) expediteBootRetry('session'); });
    listen('focus', () => { if (configuredAtStart) expediteBootRetry('focus'); });
    listen('suspend', () => { if (configuredAtStart) markAway(); });
    listen('lock', () => { if (configuredAtStart) markAway(); });
    arm();
  }
  function dispose() { stopped = true; if (poll !== undefined) clearTimer(poll); if (wake !== undefined) clearTimer(wake); poll = wake = undefined; for (const off of detach.splice(0)) off(); }
  return { start, arm, confirm, markOnline: () => { away = undefined; }, dispose };
}
module.exports = { createHybridBootstrapScheduler };
