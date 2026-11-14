'use strict';
// Local CCD scheduler. Recovered contracts: index.chunk-lzaSYO3Q.js
// task/create/update schema @1905271/1907935/1909024; bridge @6208635.
// A dispatch event is a request to the renderer, never proof that a session started.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = value => JSON.parse(JSON.stringify(value));
const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };

function cronField(source, min, max, sunday = false) {
  const values = new Set();
  if (!source || !/^[\d*,/\-]+$/.test(source)) throw new Error('Invalid cron expression');
  for (const item of source.split(',')) {
    const parts = item.split('/');
    if (parts.length > 2 || parts.some(x => !x)) throw new Error('Invalid cron expression');
    const step = parts.length === 2 ? Number(parts[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error('Invalid cron step');
    let a, b;
    if (parts[0] === '*') { a = min; b = max; }
    else {
      const range = parts[0].split('-');
      if (range.length > 2 || range.some(x => !/^\d+$/.test(x))) throw new Error('Invalid cron range');
      a = Number(range[0]); b = range.length === 2 ? Number(range[1]) : (parts.length === 2 ? max : a);
    }
    if (a < min || b > max || a > b) throw new Error('Invalid cron range');
    for (let i = a; i <= b; i += step) values.add(sunday && i === 7 ? 0 : i);
  }
  return { values, wildcard: source.startsWith('*') };
}
function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('Invalid cron expression');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Expected a five-field cron expression');
  const [minute, hour, day, month, weekday] = fields.map((s, i) => cronField(s, [0,0,1,1,0][i], [59,23,31,12,7][i], i === 4));
  return date => {
    const dom = day.values.has(date.getDate()), dow = weekday.values.has(date.getDay());
    const dayMatch = day.wildcard || weekday.wildcard ? dom && dow : dom || dow;
    return minute.values.has(date.getMinutes()) && hour.values.has(date.getHours()) && month.values.has(date.getMonth() + 1) && dayMatch;
  };
}
function nextCron(expression, after) {
  const matches = parseCron(expression);
  // Five years includes a leap day and bounds malformed/impossible schedules.
  let time = Math.floor(after / 60000) * 60000 + 60000;
  const deadline = time + 5 * 366 * 86400000;
  for (; time < deadline; time += 60000) if (matches(new Date(time))) return time;
  return null;
}
const wallMinute = time => { const d = new Date(time); return [d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes()].join('-'); };
// Native Tra/Mra @56763xx/@56778xx: inspect the next hour, then hash the ID.
function jitterSeconds(task, time, maxMinutes = 10) {
  if (!task || task.disableJitter || !task.cronExpression || maxMinutes <= 0) return 0;
  const matches = parseCron(task.cronExpression);
  let first = null, firstKey, interval = null;
  let cursor = Math.floor(time / 60000) * 60000 + 60000;
  for (let i = 0; i < 60; i++, cursor += 60000) {
    if (!matches(new Date(cursor))) continue;
    const key = wallMinute(cursor);
    if (first === null) { first = cursor; firstKey = key; }
    else if (key !== firstKey) { interval = Math.round((cursor - first) / 60000); break; }
  }
  const boundMinutes = interval === null ? maxMinutes : Math.min(maxMinutes, interval - 1);
  return boundMinutes <= 0 ? 0 : createHash('sha256').update(task.id).digest().readUInt32BE(0) % (boundMinutes * 60);
}
const pacificClock = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',hour:'numeric',hourCycle:'h23',weekday:'short'});
// Native Ora @5676572: this is information, not a gate that postpones executions.
function duringPeakHours(expression, time, window = [5,11]) {
  if (!expression || !window || window[0] >= window[1]) return false;
  const matches = parseCron(expression);
  let cursor = Math.floor(time / 60000) * 60000;
  for (let i = 0; i < 10080; i++, cursor += 60000) {
    if (!matches(new Date(cursor))) continue;
    const parts = pacificClock.formatToParts(new Date(cursor));
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = Number(parts.find(p => p.type === 'hour')?.value);
    if (['Mon','Tue','Wed','Thu','Fri'].includes(weekday) && hour >= window[0] && hour < window[1]) return true;
  }
  return false;
}
// Native wra/UTa/WTa @56758xx/@6207260: actual roster timestamps exclude
// completed starts, jitter shifts the advertised times, and outages form gaps.
function missedRunsFor(task, runTimes, time, jitter, skips = []) {
  if (!task.cronExpression) return [];
  const matches = parseCron(task.cronExpression);
  const offset = jitter * 1000;
  const starts = runTimes.filter(Number.isFinite);
  const unshifted = starts.map(t => t - offset);
  const usedWalls = new Set(unshifted.map(wallMinute));
  const seenWalls = new Set();
  const lastSlot = Date.parse(task.lastScheduledFor || '');
  const lastRun = Date.parse(task.lastRunAt || '');
  const scanFloor = Number.isFinite(lastSlot) && (!Number.isFinite(lastRun) || lastSlot > lastRun) ? Math.max(task.createdAt,lastSlot) : task.createdAt;
  const floor = Math.max(scanFloor, time - 7 * 86400000);
  let cursor = Math.floor(time / 60000) * 60000 - 60000;
  const gaps = [];
  for (; cursor > floor; cursor -= 60000) {
    if (!matches(new Date(cursor))) continue;
    const key = wallMinute(cursor);
    if (seenWalls.has(key) || usedWalls.has(key) || unshifted.some(t => Math.abs(t-cursor) <= 120000)) continue;
    seenWalls.add(key);
    const skip = skips.find(s => Math.abs(s.at - cursor) <= 120000);
    const shifted = cursor + offset;
    if (shifted <= time) gaps.push({time:new Date(shifted).toISOString(),...(skip ? {reason:skip.reason,...(skip.detail !== undefined ? {detail:skip.detail} : {})} : {})});
  }
  if (gaps.length <= 1) return gaps;
  const collapsed = [gaps[0]];
  let newer = Date.parse(gaps[0].time);
  for (let i = 1; i < gaps.length; i++) {
    const older = Date.parse(gaps[i].time);
    if (starts.some(t => t > older && t < newer)) { collapsed.push(gaps[i]); newer = older; }
  }
  return collapsed;
}
function slug(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Task name is required');
  const id = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 120).replace(/[-_]+$/, '');
  if (!id || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new Error('Task name cannot form a file name');
  return id;
}
function parseTaskFile(text) {
  const match = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!match) return null;
  const name = match[1].match(/^name: (.+)$/m), description = match[1].match(/^description: ?(.*)$/m);
  if (!name || !description) return null;
  const unquote = x => { try { return x.startsWith('"') ? JSON.parse(x) : x; } catch { return x; } };
  return { name: unquote(name[1]), description: unquote(description[1]), prompt: match[2].trimEnd() };
}
function taskText(id, description, prompt) {
  return `---\nname: ${id}\ndescription: ${JSON.stringify(description.replace(/[\r\n\u2028\u2029]+/g, ' ').trim())}\n---\n\n${prompt}`;
}

function createScheduledTasks({ root, emit = () => {}, now = Date.now, isReadyToDispatch = () => true,
  pollIntervalMs = 1000, dispatchLeaseMs = 15 * 60000, jitterMaxMinutes = 10, peakHoursWindowPst = [5,11],
  getSessionsForScheduledTask = null, hasCompleteSessionRoster = () => getSessionsForScheduledTask !== null,
  countActiveSessionsForTask = null, perTaskLimit = 0, globalLimit = 0,
  powerMonitor = null, isOnline = null, offlineGateEnabled = true, postWakeDelayMs = 60000,
  silentWakesEnabled = () => false, dispatchThrottle = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Scheduler root must be an absolute path');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || !Number.isSafeInteger(dispatchLeaseMs) || dispatchLeaseMs < 1) throw new Error('Invalid scheduler timing');
  if (!Number.isInteger(jitterMaxMinutes) || jitterMaxMinutes < 0 || jitterMaxMinutes > 14) throw new Error('Invalid jitter maximum');
  if (![perTaskLimit,globalLimit].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('Invalid scheduled task concurrency limit');
  if (peakHoursWindowPst !== null && (!Array.isArray(peakHoursWindowPst) || peakHoursWindowPst.length!==2 || !peakHoursWindowPst.every(n=>Number.isInteger(n)&&n>=0&&n<=23))) throw new Error('Invalid peak hours window');
  if (!Number.isSafeInteger(postWakeDelayMs) || postWakeDelayMs < 0) throw new Error('Invalid post-wake delay');
  if (typeof offlineGateEnabled !== 'boolean' || (isOnline !== null && typeof isOnline !== 'function') || typeof silentWakesEnabled !== 'function' || (dispatchThrottle !== null && typeof dispatchThrottle !== 'function')) throw new Error('Invalid scheduler gate source');
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Scheduler root must not be a link');
  root = fs.realpathSync(root);
  const tasksRoot = path.join(root, 'scheduled-tasks');
  const storePath = path.join(root, 'scheduled-tasks.json');
  let tasks = new Map(), claims = new Map(), recordedSkips = new Map(), ready = false, ackSupported = false, timer = null, stopped = false, inFlight = null;
  const announced = new Set();
  const peakCache = new Map();
  // Native wake globals and governor deferral maps are process-lifetime state,
  // not persisted. Dispatch claims remain durable; gates never consume slots.
  const throttleDeferredSince = new Map();
  let suspendedAt = null, lastResumedAt = 0, powerSource = null, detachPower = null, expectedTimerAt = null;
  let lastGate = null, lastOnline = undefined;
  let persistenceError = null;
  function noteSuspend() { suspendedAt = now(); }
  function noteResume() { suspendedAt = null; lastResumedAt = now(); }
  function postWakeRemaining(time = now()) {
    if (suspendedAt === null && lastResumedAt === 0) return 0;
    if (suspendedAt !== null && time-suspendedAt < postWakeDelayMs) return postWakeDelayMs-(time-suspendedAt);
    return Math.max(0,postWakeDelayMs-(time-lastResumedAt));
  }
  function observeTimerFire(expectedAt, actualAt = now()) {
    if (!Number.isFinite(expectedAt) || !Number.isFinite(actualAt)) throw new Error('Invalid timer timestamps');
    const silent=silentWakesEnabled();if(typeof silent!=='boolean')throw new Error('Silent wake source must return a boolean');
    if (actualAt-expectedAt > 90000 && lastResumedAt < expectedAt && !silent) {
      suspendedAt = null;lastResumedAt = actualAt;return true;
    }
    return false;
  }
  function attachPowerMonitor(source) {
    if (source !== null && (typeof source.on !== 'function' || typeof source.removeListener !== 'function')) throw new Error('Invalid power monitor source');
    detachPower?.();detachPower=null;powerSource=source;
    if (source) {
      source.on('suspend',noteSuspend);source.on('resume',noteResume);
      let attached=true;
      detachPower=()=>{if(!attached)return;attached=false;source.removeListener('suspend',noteSuspend);source.removeListener('resume',noteResume);};
    }
    return source !== null;
  }
  function blockedByEnvironment() {
    const remaining = postWakeRemaining();
    if (remaining > 0) {lastGate={reason:'post_wake',remainingMs:remaining};return true;}
    lastOnline = isOnline ? isOnline() : undefined;
    if (lastOnline !== undefined && typeof lastOnline !== 'boolean') throw new Error('Online source must return a boolean or undefined');
    if (offlineGateEnabled && lastOnline === false) {lastGate={reason:'offline'};return true;}
    lastGate=null;return false;
  }
  function throttle(trigger, options) {
    if (!dispatchThrottle) return null;
    const reason = dispatchThrottle(trigger,options);
    if (reason !== null && reason !== undefined && typeof reason !== 'string') throw new Error('Dispatch throttle must return a reason string or null');
    return reason || null;
  }
  function deferredFor(id) { const since=throttleDeferredSince.get(id);return since===undefined?0:Math.max(0,now()-since); }
  function deferTick(id, reason) {
    if (!reason || deferredFor(id)>=900000) return false;
    if (!throttleDeferredSince.has(id)) throttleDeferredSince.set(id,now());
    lastGate={reason:'dispatch_throttle',detail:reason,taskId:id};return true;
  }
  function throttleDue(id) {
    if (!dispatchThrottle) return null;
    const elapsed=deferredFor(id);
    if (elapsed>=900000) {throttle('due_fire',{deferredForMs:elapsed});return null;}
    const reason=throttle('due_fire');
    if (reason&&!throttleDeferredSince.has(id)) throttleDeferredSince.set(id,now());
    if (reason) lastGate={reason:'dispatch_throttle',detail:reason,taskId:id};
    return reason;
  }
  function safePath(file, missing = false) {
    if (!inside(root, path.resolve(file))) throw new Error('Task path escapes scheduler root');
    let cursor = root;
    for (const name of path.relative(root, file).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, name);
      try { const st = fs.lstatSync(cursor); if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) throw new Error('Task path contains a link'); }
      catch (error) { if (missing && error.code === 'ENOENT') return file; throw error; }
    }
    if (!inside(root, fs.realpathSync(file))) throw new Error('Task path escapes scheduler root');
    return file;
  }
  function atomicWrite(file, text) {
    safePath(path.dirname(file)); safePath(file, true);
    const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
    try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); safePath(path.dirname(file)); safePath(file, true); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function persist() {
    try {
      atomicWrite(storePath, JSON.stringify({ scheduledTasks: [...tasks.values()], dispatchClaims: [...claims.values()], recordedSkips: Object.fromEntries(recordedSkips) }, null, 2));
      persistenceError = null;
    } catch (error) { persistenceError = String(error.message || error); throw error; }
  }
  function validId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 140 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..'; }
  function fileFor(id) { if (!validId(id)) throw new Error('Invalid scheduled task id'); return path.join(tasksRoot, id, 'SKILL.md'); }
  try {
    safePath(storePath);
    const st = fs.statSync(storePath);
    if (st.size > MAX_FILE_BYTES) throw new Error('Scheduled task store too large');
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!Array.isArray(data.scheduledTasks)) throw new Error('Invalid scheduled task store');
    for (const task of data.scheduledTasks) {
      if (!task || !validId(task.id) || typeof task.enabled !== 'boolean' || typeof task.createdAt !== 'number' || task.filePath !== fileFor(task.id)) throw new Error('Invalid scheduled task entry');
      tasks.set(task.id, task);
    }
    for (const [id,rows] of Object.entries(data.recordedSkips || {})) if (tasks.has(id) && Array.isArray(rows)) recordedSkips.set(id,rows.filter(r=>r&&Number.isFinite(r.at)&&typeof r.reason==='string'));
    for (const claim of data.dispatchClaims || []) if (claim && tasks.has(claim.taskId) && typeof claim.sessionId === 'string' && Number.isFinite(claim.scheduledFor) && Number.isFinite(claim.dispatchedAt)) claims.set(claim.taskId, claim);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function notify(type, task, extra = {}) { try { return emit({ type, scheduledTask: listed(task), ...extra }); } catch { return false; } }
  function readContent(id) {
    const task = tasks.get(id);
    if (!task) return null;
    try { safePath(task.filePath); const st = fs.statSync(task.filePath); return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(task.filePath, 'utf8') : null; }
    catch { return null; }
  }
  function listed(task) {
    const content = readContent(task.id), parsed = content === null ? null : parseTaskFile(content);
    const time = now(), jitter = jitterSeconds(task,time,jitterMaxMinutes);
    let nextRunAt;
    if (task.enabled) nextRunAt = task.fireAt !== undefined ? task.fireAt : task.cronExpression ? nextCron(task.cronExpression,time) : undefined;
    if (task.cronExpression && nextRunAt != null) nextRunAt += jitter * 1000;
    const peakKey = `${task.cronExpression}|${Math.floor(time/60000)}|${peakHoursWindowPst}`;
    let peak = peakCache.get(peakKey);
    if (peak === undefined) { peak = duringPeakHours(task.cronExpression,time,peakHoursWindowPst); if(peakCache.size>128)peakCache.clear();peakCache.set(peakKey,peak); }
    const sessions = getSessionsForScheduledTask?.(task.id);
    const runTimes = Array.isArray(sessions) ? sessions.map(s=>s?.createdAt).filter(Number.isFinite) : [];
    const missed = hasCompleteSessionRoster() ? missedRunsFor(task,runTimes,time,jitter,recordedSkips.get(task.id)) : undefined;
    return clone({ ...task, ...(parsed || { fileReadError: 'unreadable' }), jitterSeconds:jitter,
      ...(nextRunAt !== undefined && nextRunAt !== null ? { nextRunAt: new Date(nextRunAt).toISOString() } : {}),
      isScheduledDuringPeakHours:peak,...(peakHoursWindowPst ? {peakHoursWindowPst} : {}),...(missed !== undefined ? {missedRuns:missed} : {}) });
  }
  const stringFields = ['displayName','model','cwd','sourceBranch','spaceId','permissionMode','chromePermissionMode'];
  function validate(params, update = false) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid scheduled task parameters');
    if (params.place !== undefined || params.watcher !== undefined || params.watcherDescription !== undefined || params.watcherMcpTools !== undefined || params.migratedFromRemote || params.migratedFromSpaceId !== undefined || params.spaceId) throw new Error('Remote, Cowork, spaces and watcher scheduled tasks are not supported');
    if (!update && (typeof params.prompt !== 'string' || typeof params.description !== 'string')) throw new Error('Task prompt and description are required');
    for (const key of ['prompt','description',...stringFields]) if (params[key] !== undefined && typeof params[key] !== 'string') throw new Error(`Invalid ${key}`);
    for (const key of ['useWorktree','disableJitter']) if (params[key] !== undefined && typeof params[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    for (const key of ['userSelectedFolders','userSelectedProjectUuids']) if (params[key] !== undefined && (!Array.isArray(params[key]) || !params[key].every(v => typeof v === 'string'))) throw new Error(`Invalid ${key}`);
    if (params.cronExpression && params.fireAt) throw new Error('Provide either cronExpression or fireAt, not both.');
    if (params.cronExpression !== undefined && typeof params.cronExpression !== 'string') throw new Error('Invalid cronExpression');
    if (params.cronExpression) parseCron(params.cronExpression);
    if (params.fireAt !== undefined && (!Number.isFinite(params.fireAt) || params.fireAt < now())) throw new Error('fireAt must be in the future.');
    if (params.cwd !== undefined && (!path.isAbsolute(params.cwd) || params.cwd.includes('\0'))) throw new Error('Scheduled task cwd must be absolute');
    if (params.prompt && Buffer.byteLength(params.prompt) > MAX_FILE_BYTES - 4096) throw new Error('Task prompt too large');
  }
  function mutate(fn) {
    const previousTasks = clone([...tasks]), previousClaims = clone([...claims]), previousSkips = clone([...recordedSkips]);
    try { const result = fn(); persist(); return result; }
    catch (error) { tasks = new Map(previousTasks); claims = new Map(previousClaims); recordedSkips = new Map(previousSkips); throw error; }
  }
  async function createScheduledTask(params) {
    validate(params);
    const id = slug(params.name);
    if (tasks.has(id)) throw new Error(`A scheduled task named ${id} already exists`);
    safePath(tasksRoot, true); fs.mkdirSync(tasksRoot, { recursive: true }); safePath(tasksRoot);
    const taskDir = path.dirname(fileFor(id));
    fs.mkdirSync(taskDir); safePath(taskDir);
    const task = { id, filePath: fileFor(id), createdAt: now(), enabled: true, ...(params.disableJitter !== undefined ? {disableJitter:params.disableJitter} : {}) };
    for (const key of [...stringFields,'cronExpression','fireAt','userSelectedFolders','userSelectedProjectUuids','useWorktree']) if (params[key] !== undefined) task[key] = clone(params[key]);
    try {
      atomicWrite(task.filePath, taskText(id, params.description, params.prompt));
      mutate(() => tasks.set(id, task));
    } catch (error) { try { safePath(task.filePath); fs.unlinkSync(task.filePath); } catch {} try { fs.rmdirSync(taskDir); } catch {} throw error; }
    notify('scheduled_task_created', task);
    return listed(task);
  }
  async function updateScheduledTask(params) {
    validate(params, true);
    const old = tasks.get(params.scheduledTaskId);
    if (!old) return null;
    const previousContent = readContent(old.id);
    const parsed = previousContent === null ? null : parseTaskFile(previousContent);
    if (!parsed) throw new Error('Could not parse scheduled task file');
    const task = clone(old);
    for (const key of [...stringFields,'userSelectedFolders','userSelectedProjectUuids','useWorktree','disableJitter']) if (own(params,key)) task[key] = params[key];
    if (own(params,'cronExpression')) { task.cronExpression = params.cronExpression || undefined; task.enabled = !!params.cronExpression; if (params.cronExpression) {delete task.fireAt;task.missedRunScanFloor=new Date(now()).toISOString();} }
    if (own(params,'fireAt')) { task.fireAt = params.fireAt; task.enabled = params.fireAt !== undefined; if (params.fireAt !== undefined) { delete task.cronExpression; delete task.lastRunAt; delete task.lastScheduledFor; } }
    if (own(params,'prompt') || own(params,'description')) atomicWrite(task.filePath, taskText(task.id, params.description ?? parsed.description, params.prompt ?? parsed.prompt));
    try { mutate(() => { tasks.set(task.id, task); claims.delete(task.id); }); }
    catch (error) { if (previousContent !== null) atomicWrite(task.filePath, previousContent); throw error; }
    announced.delete(task.id);throttleDeferredSince.delete(task.id); notify('scheduled_task_updated', task); return listed(task);
  }
  async function updateScheduledTaskStatus(id, status, removeFiles = false) {
    const task = tasks.get(id); if (!task || !['enabled','disabled','deleted'].includes(status)) return false;
    let stagedRemoval;
    if (status === 'deleted' && removeFiles) {
      safePath(task.filePath);
      stagedRemoval = path.join(path.dirname(task.filePath), '.SKILL.' + randomUUID() + '.deleted');
      fs.renameSync(task.filePath, stagedRemoval);
    }
    const updated = { ...task, enabled: status === 'enabled', ...(status === 'enabled' && task.cronExpression ? {missedRunScanFloor:new Date(now()).toISOString()} : {}) };
    try { mutate(() => { status === 'deleted' ? tasks.delete(id) : tasks.set(id, updated); claims.delete(id); }); }
    catch (error) { if (stagedRemoval) fs.renameSync(stagedRemoval, task.filePath); throw error; }
    if (stagedRemoval) {
      fs.unlinkSync(stagedRemoval);
      try { fs.rmdirSync(path.dirname(task.filePath)); } catch (error) { if(error.code !== 'ENOTEMPTY') throw error; }
    }
    announced.delete(id);throttleDeferredSince.delete(id); notify(status === 'deleted' ? 'scheduled_task_deleted' : 'scheduled_task_updated', updated); return true;
  }
  function overlapBlocked(id, excludeOwnPending = false) {
    const counts = countActiveSessionsForTask?.(id);
    if (!counts) return false;
    if (![counts.thisTask,counts.totalScheduled].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('Invalid active session counts');
    const total = counts.totalScheduled + claims.size - (excludeOwnPending && claims.has(id) ? 1 : 0);
    const reason = perTaskLimit > 0 && counts.thisTask >= perTaskLimit ? 'per_task_limit' : globalLimit > 0 && total >= globalLimit ? 'global_limit' : null;
    if (!reason) return false;
    const time = now(), floor = Math.floor(time/60000)*60000;
    const rows = (recordedSkips.get(id)||[]).filter(s=>s.at >= time-7*86400000);
    if (!rows.some(s=>s.reason===reason&&s.at>=floor)) mutate(()=>recordedSkips.set(id,[...rows,{at:time,reason}]));
    return true;
  }
  async function tick() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (stopped || blockedByEnvironment() || !ready || !await isReadyToDispatch() || stopped || !ready || blockedByEnvironment()) return 0;
      const tickThrottle = [...tasks.values()].some(t=>t.enabled&&(t.cronExpression||t.fireAt!==undefined)) ? throttle('tick') : null;
      if (!tickThrottle) throttleDeferredSince.clear();
      let count = 0;
      const time = now();
      for (const task of [...tasks.values()]) {
        if (!task.enabled || task.place || task.watcher || !task.cwd || !parseTaskFile(readContent(task.id) || '')) continue;
        let claim = claims.get(task.id);
        if (!claim) {
          let slot = task.fireAt ?? null;
          if (task.fireAt === undefined && task.cronExpression) {
            const matches = parseCron(task.cronExpression);
            const current = Math.floor(time / 60000) * 60000;
            const previous = Date.parse(task.lastScheduledFor || task.lastRunAt || '');
            const wallKey = date => [date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes()].join('-');
            const floor = Math.max(Number.isFinite(previous) ? previous : task.createdAt, time - 7 * 86400000,
              Date.parse(task.missedRunScanFloor || '') || -Infinity);
            if (matches(new Date(current)) && (!Number.isFinite(previous) || previous < current)
                && (!Number.isFinite(previous) || wallKey(new Date(previous)) !== wallKey(new Date(current)))) slot = current;
            else for (let candidate = current - 60000; candidate > floor; candidate -= 60000) {
              if (matches(new Date(candidate)) && (!Number.isFinite(previous) || wallKey(new Date(previous)) !== wallKey(new Date(candidate)))) {slot=candidate;break;}
            }
          }
          const due = slot !== null && slot <= time && (!task.lastScheduledFor || slot > Date.parse(task.lastScheduledFor));
          if (!due || deferTick(task.id,tickThrottle) || overlapBlocked(task.id)) continue;
          const missed = !!task.cronExpression && slot < Math.floor(time/60000)*60000;
          const jitter = missed || task.fireAt !== undefined ? 0 : jitterSeconds(task,time,jitterMaxMinutes);
          claim = { taskId: task.id, scheduledFor: slot, dispatchedAt: time, sessionId: 'local_' + randomUUID(), ackId: randomUUID(), readyAt:time+jitter*1000, jitterSeconds:jitter, missed };
          mutate(() => claims.set(task.id, claim));
        } else if (announced.has(task.id) && time - claim.dispatchedAt < dispatchLeaseMs) continue;
        if (!tasks.has(task.id) || !tasks.get(task.id).enabled || time < (claim.readyAt ?? 0) || overlapBlocked(task.id,true)) continue;
        if (blockedByEnvironment()) break;
        if (throttleDue(task.id)) {mutate(()=>claims.delete(task.id));announced.delete(task.id);continue;}
        const event = { type:'session_started', scheduledTask:listed(task), sessionId:claim.sessionId,
          ccdSessionStart:{sessionId:claim.sessionId,cwd:task.cwd,...Object.fromEntries(['model','useWorktree','sourceBranch','permissionMode'].filter(k=>task[k]!==undefined).map(k=>[k,task[k]]))},
          ...(ackSupported ? {ackId:claim.ackId} : {}),
          ...(task.cronExpression && (claim.missed ?? claim.scheduledFor < Math.floor(time / 60000) * 60000) ? {missedScheduledTime:new Date(claim.scheduledFor).toISOString()} : {}) };
        const sent = await emit(event);
        if (sent !== false) { announced.add(task.id); claim.dispatchedAt = time; persist(); count++; }
      }
      return count;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  async function confirmTaskRun(id, sessionId) {
    const task = tasks.get(id), claim = claims.get(id);
    if (!task || !claim || typeof sessionId !== 'string' || sessionId !== claim.sessionId) return false;
    const updated = { ...task, lastRunAt: new Date(now()).toISOString(), lastScheduledFor: new Date(claim.scheduledFor).toISOString(),
      ...(task.fireAt !== undefined && task.fireAt <= now() ? {enabled:false} : {}) };
    mutate(() => {tasks.set(id, updated);claims.delete(id);}); announced.delete(id);throttleDeferredSince.delete(id); notify('scheduled_task_updated', updated); return true;
  }
  if (powerMonitor) attachPowerMonitor(powerMonitor);
  return {
    async getAllScheduledTasks() { return [...tasks.values()].map(listed); },
    async getScheduledTaskFileContent(id) { return readContent(id); },
    createScheduledTask, updateScheduledTask, updateScheduledTaskStatus, tick, confirmTaskRun,
    attachPowerMonitor, noteSuspend, noteResume, observeTimerFire,
    setDispatchThrottle(fn) {if(fn!==null&&typeof fn!=='function')throw new Error('Invalid dispatch throttle');dispatchThrottle=fn;throttleDeferredSince.clear();},
    getJitterSecondsForTask(id) {return jitterSeconds(tasks.get(id),now(),jitterMaxMinutes);},
    setActiveSessionCounter(fn) {if(fn!==null&&typeof fn!=='function')throw new Error('Invalid session counter');countActiveSessionsForTask=fn;},
    setSessionRosterSource(fn, complete = true) {if(fn!==null&&typeof fn!=='function')throw new Error('Invalid session roster');getSessionsForScheduledTask=fn;hasCompleteSessionRoster=()=>complete&&fn!==null;},
    markListenerReady() { ready = true; announced.clear(); return true; },
    setEventAckSupported() { ackSupported = true; return true; },
    ackEvent(ackId) { const claim = [...claims.values()].find(c => c.ackId === ackId); if (!claim) return false; mutate(() => {claim.ackedAt = now();}); return true; },
    releaseDispatchClaim(id) { if (!claims.has(id)) return false; mutate(() => claims.delete(id)); announced.delete(id); return true; },
    setHostRunsSupported() { return false; },
    getWatcherHistory() { return []; },
    async removeApprovedPermission(id, toolName, ruleContent) {
      const task=tasks.get(id);if(!task)return false;
      const permissions=task.approvedPermissions||[];
      const filtered=permissions.filter(p=>p.toolName!==toolName || (ruleContent!==undefined&&p.ruleContent!==ruleContent));
      if(filtered.length===permissions.length)return false;
      const updated={...task,approvedPermissions:filtered};mutate(()=>tasks.set(id,updated));notify('scheduled_task_updated',updated);return true;
    },
    start() { stopped=false; if(powerSource&&!detachPower)attachPowerMonitor(powerSource);if(!timer){expectedTimerAt=now()+pollIntervalMs;timer=setInterval(()=>{try {const time=now();observeTimerFire(expectedTimerAt,time);expectedTimerAt=time+pollIntervalMs;tick().catch(error=>{persistenceError=String(error.message||error);});}catch(error){persistenceError=String(error.message||error);}},pollIntervalMs);timer.unref?.();} return true; },
    async stop() { stopped=true;ready=false;if(timer){clearInterval(timer);timer=null;}detachPower?.();detachPower=null;expectedTimerAt=null; if(inFlight)await inFlight; },
    diagnostics() { return {ready,running:timer!==null,pending:clone([...claims.values()]),persistenceError,taskCount:tasks.size,gates:{lastGate,online:lastOnline,powerEventsAttached:detachPower!==null,onlineSourceAttached:isOnline!==null,dispatchThrottleAttached:dispatchThrottle!==null,postWakeRemainingMs:postWakeRemaining(),throttleDeferredSince:Object.fromEntries(throttleDeferredSince)}}; },
  };
}
module.exports = { createScheduledTasks, parseCron, nextCron, parseTaskFile, jitterSeconds, duringPeakHours, missedRunsFor };
