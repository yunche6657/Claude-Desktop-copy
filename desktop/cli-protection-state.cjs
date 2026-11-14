'use strict';

// One instance belongs to one actor. Epoch tokens are supplied by the owner and
// stale frames are ignored. Native ledger values and observability are separate.
const {createCronLedger} = require('./cli-cron-protection.cjs');
const {createLoopProtection} = require('./cli-loop-protection.cjs');
const {matchCron, nextCronTime} = require('./session-cron-time.cjs');
// Query.readMessages consumes these transport-only frames without yielding them.
function isQueryMessage(frame) {
  return !!frame && typeof frame.type === 'string' &&
    !['control_response','control_request','control_cancel_request','keep_alive','transcript_mirror'].includes(frame.type) &&
    !(frame.type === 'system' && frame.subtype === 'session_state_changed' && frame.sdk_host_only === true);
}
function isWorkFrame(frame) {
  if (['assistant','user','result','stream_event','tool_progress','tool_use_summary'].includes(frame.type)) return true;
  if (frame.type !== 'system') return false;
  if (['task_started','task_notification'].includes(frame.subtype)) return !frame.ambient && !frame.skip_transcript;
  return ['task_progress','task_updated'].includes(frame.subtype);
}
function createProtectionState({now = Date.now} = {}) {
  let epoch;
  let state;
  const fresh = () => ({background: new Map(), backgroundSnapshot: false, backgroundMalformed: false, tasks: new Map(),
    cron: createCronLedger(), cronInitialized: false, cronRevision: 0, cronDetails: new Map(), pendingTools: new Map(), loop: createLoopProtection(), power: {}, pendingCycle: false,
    query: false, boundaryHint: undefined, boundaryComplete: false, held: false,
    remote: false, lanyard: false, stopping: false,
    coverage: {background: false, cron: false, loop: false, agentRun: false, remote: false, lanyard: false}});
  const current = token => state && token === epoch;
  function beginEpoch(token) { if (token === undefined || token === null) throw new TypeError('epoch required'); epoch = token; state = fresh(); state.loop.activity({lastActivityAt: now()}); }
  function reset(token) { if (current(token)) { state = undefined; epoch = undefined; return true; } return false; }
  // Caller-owned signals are explicit, never inferred from event absence.
  function update(token, signals) {
    if (!current(token) || !signals || typeof signals !== 'object') return false;
    for (const key of ['pendingCycle','query','boundaryComplete','held','remote','lanyard','stopping'])
      if (typeof signals[key] === 'boolean') state[key] = signals[key];
    if (typeof signals.boundaryHint === 'boolean' || signals.boundaryHint === null)
      state.boundaryHint = signals.boundaryHint === null ? undefined : signals.boundaryHint;
    if (signals.coverage && typeof signals.coverage === 'object')
      for (const key of Object.keys(state.coverage)) if (typeof signals.coverage[key] === 'boolean') state.coverage[key] = signals.coverage[key];
    return true;
  }
  function syncPower(token, context) {
    if (!current(token)) return false;
    state.power = {...context}; state.loop.syncPower(context); return true;
  }
  function powerEvent(token, event) {
    if (!current(token)) return false;
    if (event.kind === 'suspend') state.loop.suspend(event.at);
    if (event.kind === 'resume') state.loop.resume(event.at);
    return syncPower(token, event.context);
  }
  function noteActivity(token, at = now()) {
    if (!current(token)) return false;
    state.loop.activity({lastActivityAt: at}); return true;
  }
  function observeFrame(token, frame) {
    if (!current(token) || !frame || typeof frame !== 'object') return false;
    if (isQueryMessage(frame)) {
      const at = now();
      if (frame.type !== 'stream_event') state.cronInitialized = true;
      state.loop.activity({lastCliMessageAt: at, ...(isWorkFrame(frame) ? {lastActivityAt: at} : {})});
    }
    if (frame.type === 'system' && frame.subtype === 'background_tasks_changed') {
      if (!Array.isArray(frame.tasks)) { state.backgroundMalformed = true; return false; }
      // Native parsing skips malformed entries while retaining the rest of the snapshot.
      if (frame.tasks.some(task => !task || typeof task !== 'object' || typeof task.task_id !== 'string')) state.backgroundMalformed = true;
      const next = new Map();
      for (const task of frame.tasks) {
        if (!task || typeof task !== 'object' || typeof task.task_id !== 'string') continue;
        const type = typeof task.task_type === 'string' ? task.task_type : 'unknown';
        if (task.ambient === true || type === 'dream') continue;
        next.set(task.task_id, type);
      }
      // Native applyBackgroundTasksLevel compares IDs, not task types.
      if (next.size !== state.background.size || [...next.keys()].some(id => !state.background.has(id))) state.background = next;
      state.backgroundSnapshot = true;
      return true;
    }
    if (frame.type === 'system' && frame.subtype === 'task_started' && typeof frame.task_id === 'string' && frame.task_id) {
      state.tasks.set(frame.task_id, {status: 'observed', type: typeof frame.task_type === 'string' ? frame.task_type : 'unknown'});
      return true;
    }
    if (frame.type === 'system' && frame.subtype === 'task_notification' && typeof frame.task_id === 'string' && state.tasks.has(frame.task_id) && ['completed','failed','stopped'].includes(frame.status)) {
      state.tasks.delete(frame.task_id); return true;
    }
    const content = frame.message && Array.isArray(frame.message.content) ? frame.message.content : [];
    if (frame.type === 'assistant') for (const block of content) {
      if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (block.name === 'CronCreate' || block.name === 'ScheduleWakeup') {
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const delay = typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds) ? Math.min(3600, Math.max(60, input.delaySeconds)) : undefined;
        state.pendingTools.set(block.id, {name: block.name, delaySeconds: delay, cron: typeof input.cron === 'string' ? input.cron : undefined, durable: typeof input.durable === 'boolean' ? input.durable : undefined, prompt: typeof input.prompt === 'string' ? input.prompt : undefined});
      } else if (block.name === 'CronDelete' && typeof block.input?.id === 'string') {
        state.cron.delete(block.input.id); state.cronDetails.delete(block.input.id); state.cronRevision++;
      }
    }
    if (frame.type === 'user') for (const block of content) {
      if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const tool = state.pendingTools.get(block.tool_use_id);
      if (!tool) continue;
      state.pendingTools.delete(block.tool_use_id);
      if (block.is_error) continue;
      const result = frame.tool_use_result;
      if (tool.name === 'CronCreate' && result && typeof result.id === 'string') {
        state.cron.set(result.id, {createdAt: now(), cron: tool.cron, durable: tool.durable, recurring: typeof result.recurring === 'boolean' ? result.recurring : undefined});
        // Renderer-only metadata shares the actor lifetime, never the protection snapshot.
        state.cronDetails.set(result.id, {prompt: tool.prompt, humanSchedule: typeof result.humanSchedule === 'string' ? result.humanSchedule : undefined});
        state.cronRevision++;
      }
      if (tool.name === 'ScheduleWakeup') {
        const time = now();
        const structured = typeof result?.clampedDelaySeconds === 'number' && Number.isFinite(result.clampedDelaySeconds) ? result.clampedDelaySeconds : undefined;
        if (!(result?.scheduledFor === 0 && structured !== undefined)) {
          const delay = structured ?? tool.delaySeconds;
          let at = delay !== undefined ? time + delay * 1000 : result?.scheduledFor;
          if (typeof at === 'number' && Number.isFinite(at)) {
            at = Math.min(at, time + 7200000);
            if (at > time) state.loop.positiveSchedule({scheduledFor: at, armedAt: time});
          }
        }
      }
    }
    // A result alone cannot settle pending cycles, held steering or interrupts.
    return true;
  }
  function pruneCron(token, at = now()) {
    if (!current(token)) return [];
    const removed = state.cron.prune(at, state.power);
    for (const id of removed) state.cronDetails.delete(id);
    if (removed.length) state.cronRevision++;
    return removed;
  }
  function collectSessionLoops(token) {
    if (!current(token) || !state.cronInitialized) return undefined;
    const at = now(); pruneCron(token, at);
    return state.cron.snapshot().map(job => {
      if (job.cron && (job.nextRunAt === undefined || job.recurring !== false && at >= job.nextRunAt)) {
        let next;
        try { next = job.recurring === false && matchCron(job.cron, new Date(at)) ? at - at % 60000 : nextCronTime(job.cron, new Date(at)).getTime(); }
        catch { next = undefined; }
        if (job.nextRunAt !== next) state.cronRevision++;
        state.cron.setNextRunAt(job.id, next); job.nextRunAt = next;
      }
      const detail = state.cronDetails.get(job.id) || {};
      return {id: job.id, prompt: detail.prompt, cron: job.cron, humanSchedule: detail.humanSchedule,
        createdAt: job.createdAt, nextRunAt: job.nextRunAt, recurring: job.recurring};
    });
  }
  function getCronRevision(token) { return current(token) ? state.cronRevision : null; }
  function snapshot(token) {
    if (!current(token)) return null;
    const agentRun = state.query ? (state.boundaryHint === undefined ? state.pendingCycle || state.held : !state.boundaryComplete) : state.pendingCycle;
    const at = now(); pruneCron(token, at);
    const cronLive = state.cron.snapshot().length > 0;
    return { flags: {agentRun, stopping: state.stopping, cron: cronLive,
      backgroundTasks: [...state.background.values()].some(type => type !== 'remote_agent'),
      loopWakeup: state.loop.hasLive(at), remoteControl: state.remote, lanyard: state.lanyard,
      otherProtection: false, otherProtection2: false},
      coverage: {...state.coverage, backgroundSnapshot: state.backgroundSnapshot, backgroundMalformed: state.backgroundMalformed},
      observedTasks: state.tasks.size, cronCount: state.cron.snapshot().length, loop: state.loop.snapshot().wakeup, activity: state.loop.snapshot(), power: {...state.power} };
  }
  return {beginEpoch, observeFrame, update, snapshot, reset, syncPower, powerEvent, noteActivity, collectSessionLoops, getCronRevision, pruneCron};
}
module.exports = {createProtectionState, isQueryMessage, isWorkFrame};
