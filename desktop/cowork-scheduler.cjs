'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { parseCron, nextCron, parseTaskFile } = require('./scheduled-tasks.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value || '');

// Host-owned dispatch: no renderer handshake is needed to start a scheduled turn.
// The durable slot/session claim precedes kernel.start; an interrupted dispatch is
// recovered by session identity instead of sending its initial message twice.
function createCoworkScheduler({ getStore, saveStore, root, kernel, emit = () => {},
  now = Date.now, pollIntervalMs = 1000, clock = { setInterval, clearInterval },
  powerMonitor = null, postWakeDelayMs = 1000, getInstructions = () => '',
  defaultCwd = () => process.env.CLAUDE_WORKSPACE || process.cwd() } = {}) {
  let timer = null, stopped = false, suspended = false, wakeUntil = 0, inFlight = null, lastError = null;
  const pendingTurns = new Set(), turnErrors = new Map();
  const tasks = () => getStore().tasks;
  const iso = () => new Date(now()).toISOString();
  const taskById = id => tasks().find(task => task.id === id);
  const active = task => task.enabled !== false && !['disabled', 'paused', 'deleted'].includes(task.status);
  const notify = (type, task, extra = {}) => { try { emit({ type, scheduledTask: listed(task), ...extra }); } catch {} };
  function commit() { if (saveStore() === false) throw new Error('Cowork task persistence failed'); }
  function normalize(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid task parameters');
    const value = { ...body };
    // Retain old reconstruction inputs while accepting the shipped bridge shape.
    if (owns(value, 'schedule')) {
      const schedule = value.schedule;
      if (typeof schedule === 'string') value.cronExpression = schedule;
      else if (schedule && typeof schedule === 'object') {
        if (owns(schedule, 'cronExpression') || owns(schedule, 'cron')) value.cronExpression = schedule.cronExpression ?? schedule.cron;
        if (owns(schedule, 'fireAt') || owns(schedule, 'at')) value.fireAt = timestamp(schedule.fireAt ?? schedule.at);
      } else if (schedule === null) { value.cronExpression = ''; value.fireAt = undefined; }
    }
    if (value.cronExpression && value.fireAt !== undefined) throw new Error('Provide cronExpression or fireAt, not both');
    if (owns(value, 'cronExpression')) {
      if (typeof value.cronExpression !== 'string') throw new Error('Invalid cronExpression');
      if (value.cronExpression) parseCron(value.cronExpression);
    }
    if (value.fireAt !== undefined && !Number.isFinite(value.fireAt)) throw new Error('Invalid fireAt');
    for (const key of ['name', 'displayName', 'description', 'prompt', 'cwd', 'model', 'permissionMode']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Invalid ${key}`);
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('Invalid enabled');
    if (value.missedRunPolicy !== undefined && !['run_once', 'skip'].includes(value.missedRunPolicy)) throw new Error('Invalid missedRunPolicy');
    if (value.place) throw new Error('Host scheduled tasks require a local cwd');
    if (value.userSelectedFolders !== undefined && (!Array.isArray(value.userSelectedFolders) || !value.userSelectedFolders.every(x => typeof x === 'string'))) throw new Error('Invalid userSelectedFolders');
    return value;
  }
  function assign(task, body) {
    for (const key of ['name','displayName','description','prompt','cwd','model','permissionMode','userSelectedFolders','userSelectedProjectUuids','spaceId','disableJitter','missedRunPolicy']) {
      if (owns(body,key)) task[key] = body[key];
    }
    if (owns(body,'schedule')) task.schedule = body.schedule;
    if (owns(body,'cronExpression')) { task.cronExpression = body.cronExpression; if (body.cronExpression) delete task.fireAt; }
    if (owns(body,'fireAt')) { if (body.fireAt === undefined) delete task.fireAt; else { task.fireAt = body.fireAt; delete task.cronExpression; } }
    if (owns(body,'enabled')) { task.enabled = body.enabled; task.status = body.enabled ? 'active' : 'disabled'; }
    if (owns(body,'status')) { task.status = body.status; task.enabled = !['disabled','paused','deleted'].includes(body.status); }
  }
  function writeBody(task) {
    const dir = path.join(root(), 'tasks'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, task.id + '.md'), temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, `---\nname: ${task.id}\ndescription: ${JSON.stringify(task.description || '')}\n---\n\n${task.prompt || ''}`, 'utf8');
      fs.renameSync(temporary, file); task.filePath = file;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function scheduleAfter(task, after) {
    if (!active(task)) return null;
    if (task.fireAt !== undefined) return task.lastScheduledFor && timestamp(task.lastScheduledFor) >= task.fireAt ? null : task.fireAt;
    return task.cronExpression ? nextCron(task.cronExpression, after) : null;
  }
  function initialize(task) {
    if (!task.cronExpression && task.fireAt === undefined && task.schedule) {
      const legacy = normalize({schedule:task.schedule});
      if (legacy.cronExpression) task.cronExpression = legacy.cronExpression;
      if (legacy.fireAt !== undefined) task.fireAt = legacy.fireAt;
    }
    if (owns(task,'nextRunAt')) return;
    const floor = Math.max(timestamp(task.createdAt) || now(), timestamp(task.lastScheduledFor) || 0, timestamp(task.missedRunScanFloor) || 0);
    task.nextRunAt = scheduleAfter(task, floor);
  }
  function listed(task) {
    initialize(task);
    const result = copy({ ...task, enabled: active(task), createdAt: timestamp(task.createdAt) || now() });
    delete result.nextRunAt;
    if (Number.isFinite(timestamp(task.nextRunAt))) result.nextRunAt = new Date(timestamp(task.nextRunAt)).toISOString();
    return result;
  }
  function createScheduledTask(input) {
    const body = normalize(input);
    if (!body.name?.trim() || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('Task name and prompt are required');
    const task = { id: randomUUID(), name: body.name, description: '', enabled: true, status:'active', createdAt:now(), updatedAt:iso(), runs:[] };
    assign(task,body); initialize(task); writeBody(task); tasks().push(task); commit(); notify('scheduled_task_created',task); return listed(task);
  }
  function updateScheduledTask(idOrInput, patch) {
    const body = normalize(typeof idOrInput === 'object' ? idOrInput : { ...patch, scheduledTaskId:idOrInput });
    const task = taskById(body.scheduledTaskId); if (!task) return null;
    const candidate = copy(task); assign(candidate,body);
    if (['schedule','cronExpression','fireAt','enabled','status'].some(key => owns(body,key))) {
      delete candidate.nextRunAt; delete candidate.dispatchClaim; candidate.missedRunScanFloor = iso();
      if (owns(body,'fireAt') || owns(body,'schedule')) delete candidate.lastScheduledFor;
      initialize(candidate);
    }
    candidate.updatedAt = iso(); writeBody(candidate); getStore().tasks = tasks().map(value => value.id === task.id ? candidate : value); commit(); notify('scheduled_task_updated',candidate); return listed(candidate);
  }
  function updateScheduledTaskStatus(id, status, removeFiles = false) {
    const task = taskById(id); if (!task || !['enabled','active','disabled','paused','deleted'].includes(status)) return false;
    if (status === 'deleted') {
      getStore().tasks = tasks().filter(value => value.id !== id); commit();
      if (removeFiles) { try { fs.unlinkSync(path.join(root(),'tasks',id+'.md')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      notify('scheduled_task_deleted',task); return true;
    }
    task.enabled = status === 'enabled' || status === 'active'; task.status = task.enabled ? 'active' : status;
    task.missedRunScanFloor = iso(); delete task.nextRunAt; initialize(task); task.updatedAt = iso(); commit(); notify('scheduled_task_updated',task); return true;
  }
  function finishRuns(task) {
    let changed = false;
    for (const run of task.runs || []) {
      if (run.status !== 'running') continue;
      const session = kernel?.getSession?.(run.sessionId);
      if (pendingTurns.has(run.sessionId) || session?.isRunning || session?.isWaitingForPermission) continue;
      const error = turnErrors.get(run.sessionId) || session?.error;
      run.status = session ? (error ? 'failed' : 'completed') : 'interrupted';
      run.finishedAt = iso(); if (error) { run.error = String(error); task.lastError = run.error; }
      turnErrors.delete(run.sessionId);
      changed = true;
    }
    if (changed) { commit(); notify('scheduled_task_updated',task); }
  }
  async function tickOnce() {
    if (stopped || suspended || now() < wakeUntil) return 0;
    let dispatched = 0;
    for (const task of [...tasks()]) {
      finishRuns(task); initialize(task);
      if (!active(task) || !kernel || (task.runs || []).some(run => run.status === 'running')) continue;
      let slot = timestamp(task.nextRunAt);
      if (!Number.isFinite(slot) || slot > now()) continue;
      const missed = now() - slot > Math.max(pollIntervalMs * 2, 60000);
      if (missed && task.missedRunPolicy === 'skip') {
        task.runs ||= []; task.runs.push({id:randomUUID(),scheduledFor:new Date(slot).toISOString(),status:'skipped',reason:'missed',finishedAt:iso()});
        task.lastScheduledFor = new Date(slot).toISOString(); task.nextRunAt = scheduleAfter(task,now()); commit(); notify('scheduled_task_updated',task); continue;
      }
      // Collapse an outage to its latest due cron slot, never replay every missed minute.
      if (missed && task.cronExpression) {
        const match = parseCron(task.cronExpression);
        for (let candidate = Math.floor(now()/60000)*60000; candidate > slot; candidate -= 60000) {
          if (match(new Date(candidate))) { slot = candidate; break; }
        }
      }
      task.runs ||= [];
      let run = task.dispatchClaim;
      if (!run) {
        run = { id:randomUUID(),sessionId:'local_'+randomUUID(),scheduledFor:new Date(slot).toISOString(),status:'dispatching',startedAt:iso(),missed };
        task.dispatchClaim = run; task.lastScheduledFor = run.scheduledFor;
        commit(); // Persist before any side effect.
      }
      try {
        let session = kernel.getSession?.(run.sessionId);
        if (!session) {
          const cwd = task.cwd || task.userSelectedFolders?.[0] || defaultCwd();
          if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Task cwd must be absolute');
          fs.mkdirSync(cwd, { recursive:true }); if (!fs.statSync(cwd).isDirectory()) throw new Error('Task cwd is not a directory');
          const instructions = await getInstructions(task);
          if (stopped || suspended || taskById(task.id) !== task || !active(task)) continue;
          const message = [instructions,`Host environment: ${os.platform()} ${os.arch()}; working directory: ${cwd}. Execute on this host using its native paths and available tools.`, task.prompt || parseTaskFile(fs.readFileSync(task.filePath,'utf8'))?.prompt].filter(Boolean).join('\n\n');
          session = await kernel.start({ sessionId:run.sessionId,scheduledTaskId:task.id,cwd,title:task.displayName || task.name,model:task.model,permissionMode:task.permissionMode,userSelectedFolders:task.userSelectedFolders,hostLoopMode:true });
          if (!session?.sessionId || session.error) throw new Error(String(session?.error || 'Kernel did not start task session'));
          kernel.update?.(session.sessionId,{hostLoopMode:true,spaceId:task.spaceId || null});
          pendingTurns.add(run.sessionId);
          Promise.resolve().then(() => kernel.sendMessage(run.sessionId,message,{messageUuid:run.id})).then(result => {
            if (result?.ok === false || result?.error) turnErrors.set(run.sessionId,String(result.error || 'Scheduled turn failed'));
          }, error => turnErrors.set(run.sessionId,String(error.message || error))).finally(() => pendingTurns.delete(run.sessionId));
        }
        run.status = 'running'; task.lastRunAt = iso(); task.lastError = null; dispatched++;
        notify('session_started',task,{sessionId:run.sessionId,...(run.missed ? {missedScheduledTime:run.scheduledFor} : {})});
      } catch (error) {
        run.status = 'failed'; run.error = String(error.message || error); run.finishedAt = iso(); task.lastError = run.error;
      }
      task.runs.push(copy(run)); task.runs = task.runs.slice(-100); delete task.dispatchClaim;
      task.nextRunAt = scheduleAfter(task,now()); if (task.fireAt !== undefined) {task.enabled=false;task.status='disabled';}
      commit(); notify('scheduled_task_updated',task,{sessionId:run.sessionId,...(run.error ? {error:run.error} : {})});
    }
    return dispatched;
  }
  function tick() {
    if (inFlight) return inFlight;
    inFlight = tickOnce().catch(error => {lastError=String(error.message || error);throw error;}).finally(() => {inFlight=null;}); return inFlight;
  }
  const noteSuspend = () => {suspended=true;};
  const noteResume = () => {suspended=false;wakeUntil=now()+postWakeDelayMs;};
  const onPower = () => {powerMonitor?.on('suspend',noteSuspend);powerMonitor?.on('resume',noteResume);};
  return {
    createScheduledTask,updateScheduledTask,updateScheduledTaskStatus,tick,noteSuspend,noteResume,
    getAllScheduledTasks: () => tasks().map(listed),
    getScheduledTaskFileContent(id) { const task=taskById(id);if(!task)return null;try{return fs.readFileSync(task.filePath,'utf8');}catch{return null;} },
    getWatcherHistory: id => copy(taskById(id)?.runs || []),
    start() {stopped=false;if(!timer){onPower();timer=clock.setInterval(()=>{tick().catch(()=>{});},pollIntervalMs);timer?.unref?.();}return true;},
    async stop() {stopped=true;if(timer){clock.clearInterval(timer);timer=null;}powerMonitor?.removeListener('suspend',noteSuspend);powerMonitor?.removeListener('resume',noteResume);if(inFlight)await inFlight;},
    diagnostics: () => ({running:timer!==null,suspended,lastError}),
    markListenerReady: () => true,
    releaseDispatchClaim(id) {const task=taskById(id);if(!task?.dispatchClaim)return false;delete task.dispatchClaim;commit();return true;},
  };
}
module.exports = { createCoworkScheduler };
