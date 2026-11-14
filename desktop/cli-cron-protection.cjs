'use strict';

// Mirrors the native manager's in-memory cron protection checks. No prompts
// are retained; nextRunAt is only set when a caller has actually computed it.
const MAX_AGE_MS = 2592e5;
const MANAGER_GRACE_MS = 960000;

function isOneShotWithinLifetime(job) {
  return job.recurring === false && job.nextRunAt !== undefined && job.nextRunAt <= job.createdAt + MAX_AGE_MS;
}
function isExpired(job, now, { lastSuspendedAt = null, lastSystemWakeAt } = {}) {
  if (lastSuspendedAt !== null && now - lastSuspendedAt < MAX_AGE_MS && isOneShotWithinLifetime(job)) return false;
  return isOneShotWithinLifetime(job)
    ? now >= Math.max(job.nextRunAt, lastSystemWakeAt ?? 0) + MANAGER_GRACE_MS
    : now > job.createdAt + MAX_AGE_MS;
}
function createCronLedger() {
  const jobs = new Map();
  return {
    set(id, job) {
      jobs.set(id, { createdAt: job.createdAt, cron: job.cron, durable: job.durable, recurring: job.recurring, nextRunAt: job.nextRunAt });
    },
    delete(id) { return jobs.delete(id); },
    clear() { jobs.clear(); },
    setNextRunAt(id, nextRunAt) {
      const job = jobs.get(id);
      if (!job) return false;
      job.nextRunAt = nextRunAt;
      return true;
    },
    prune(now = Date.now(), context = {}) {
      const removed = [];
      for (const [id, job] of jobs) if (isExpired(job, now, context)) { jobs.delete(id); removed.push(id); }
      return removed;
    },
    hasLive(now = Date.now(), context = {}) { this.prune(now, context); return jobs.size > 0; },
    snapshot() { return [...jobs].map(([id, job]) => ({ id, ...job })); },
  };
}
module.exports = { createCronLedger, isExpired, isOneShotWithinLifetime, MAX_AGE_MS, MANAGER_GRACE_MS };
