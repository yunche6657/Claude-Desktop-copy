'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMAT = 'claude-desktop-local-backup-v1';
const LIMITS = Object.freeze({ bytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, files: 2000, sessions: 500 });
const secretKey = /(?:^(?:env|environment|headers|auth|cookie|cookies)$|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key)/i;
const secretFile = /(?:^|[\\/])(?:\.env(?:\..*)?|\.credentials[^\\/]*|auth\.json|credentials[^\\/]*|id_rsa|id_ed25519|[^\\/]*\.(?:pem|key|p12|pfx))$/i;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function clean(value, depth = 0) {
  if (depth > 80) fail('INVALID_BACKUP');
  if (typeof value === 'string') return value.replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{16,}/g, '[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !secretKey.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k)).map(([k, v]) => [k, clean(v, depth + 1)]));
}
function secureDir(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) { const s = fs.lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink()) fail('UNSAFE_PATH'); }
    else fs.mkdirSync(current, { mode: 0o700 });
  }
  return absolute;
}
function ordinaryFile(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH');
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) fail('UNSAFE_PATH');
  return stat;
}
function atomicWrite(file, bytes) {
  secureDir(path.dirname(file));
  const temporary = file + '.tmp-' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function mapStrings(value, replace) {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, replace));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, replace)]));
  return value;
}
function createLocalBackup({ kernel, root, getStore, storeFile, setStore, managedRoots = [] } = {}) {
  function collect({ kind = 'all', id } = {}) {
    if (!['all', 'task', 'project'].includes(kind)) fail('INVALID_KIND');
    const store = getStore();
    const space = kind === 'project' ? store.spaces.find(s => s.id === id || s.uuid === id) : null;
    if (kind === 'project' && !space) fail('NOT_FOUND');
    const spaceIds = space ? [space.id, space.uuid] : [];
    const sessions = kernel.getAll().filter(s => kind === 'all' || kind === 'task' && (s.sessionId === id || s.scheduledTaskId === id) || kind === 'project' && spaceIds.includes(store.sessionSpaces[s.sessionId]));
    if (sessions.length > LIMITS.sessions) fail('BACKUP_TOO_LARGE');
    const ids = new Set(sessions.map(s => s.sessionId));
    const tasks = store.tasks.filter(t => kind === 'all' || kind === 'task' && t.id === id || kind === 'project' && spaceIds.includes(t.spaceId) || sessions.some(s => s.scheduledTaskId === t.id));
    if (kind === 'task' && !sessions.length && !tasks.length) fail('NOT_FOUND');
    const metadata = clean({ spaces: kind === 'all' ? store.spaces : space ? [space] : [], tasks,
      sessionSpaces: Object.fromEntries(Object.entries(store.sessionSpaces).filter(([sid]) => ids.has(sid))),
      artifacts: Object.fromEntries(Object.entries(store.artifacts).filter(([sid, v]) => ids.has(sid) || ids.has(v?.sessionId))) });
    // Definitions are data, not pointers to source-machine task/config files.
    for (const task of metadata.tasks) { delete task.filePath; delete task.cwd; delete task.workingDir; }
    for (const space of metadata.spaces) { delete space.folderPath; delete space.path; delete space.cwd; }
    const files = [], rows = [];
    let total = 0;
    for (const session of sessions) {
      const row = clean({ session, transcript: kernel.getTranscript(session.sessionId) });
      const replacements = new Map();
      // Only explicit attachment/artifact/file descriptors are eligible. Never walk cwd.
      function visit(value, context = '') {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const v of value) visit(v, context); return; }
        const ownContext = context + ' ' + String(value.type || '') + (value.type === 'tool_use' && /^(?:Write|Edit|NotebookEdit)$/i.test(value.name || '') ? ' artifact' : '');
        const eligible = /attachment|artifact|file|document|image/i.test(ownContext);
        if (eligible) for (const key of ['path', 'filePath', 'file_path', 'localPath', 'sourcePath']) {
          const ref = value[key];
          if (typeof ref !== 'string' || !ref || /^(?:https?:|data:)/i.test(ref)) continue;
          const source = path.resolve(session.cwd || root, ref);
          const relative = path.relative(path.resolve(session.cwd || root), source);
          // Descriptor paths must belong to this session root or a managed staging root.
          const insideManaged = [root, ...managedRoots].some(base => {
            const rel = path.relative(path.resolve(base), source);
            return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
          });
          if ((relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) && !insideManaged) fail('UNSAFE_PATH');
          if (secretFile.test(source)) { value[key] = null; continue; }
          if (replacements.has(ref)) continue;
          const stat = ordinaryFile(source);
          if (stat.size > LIMITS.fileBytes || total + stat.size > LIMITS.bytes || files.length >= LIMITS.files) fail('BACKUP_TOO_LARGE');
          const bytes = fs.readFileSync(source);
          if (bytes.length !== stat.size) fail('FILE_CHANGED');
          total += bytes.length;
          const name = 'files/' + String(files.length).padStart(5, '0') + '/' + path.basename(source).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[^a-zA-Z0-9_]/, '_');
          files.push({ name, sessionId: session.sessionId, size: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') });
          replacements.set(ref, name); replacements.set(source, name);
        }
        for (const [key, child] of Object.entries(value)) visit(child, eligible ? ownContext + ' ' + key : key);
      }
      visit(row);
      const ownedArtifacts = Object.entries(metadata.artifacts).filter(([key, value]) => key === session.sessionId || value?.sessionId === session.sessionId);
      for (const [, artifact] of ownedArtifacts) visit(artifact, 'artifact');
      const replace = text => { for (const [before, after] of [...replacements].sort((a,b) => b[0].length-a[0].length)) text = text.split(before).join(after); return text; };
      rows.push(mapStrings(row, replace));
      for (const [key, artifact] of ownedArtifacts) metadata.artifacts[key] = mapStrings(artifact, replace);
    }
    return { kind, exportedAt: new Date().toISOString(), sessions: rows, metadata, files };
  }
  function encode(payload) {
    const text = JSON.stringify(payload);
    const bytes = Buffer.from(JSON.stringify({ format: FORMAT, sha256: hash(text), payload }));
    if (bytes.length > LIMITS.bytes) fail('BACKUP_TOO_LARGE');
    return bytes;
  }
  function decode(file) {
    const stat = ordinaryFile(file);
    if (stat.size > LIMITS.bytes) fail('BACKUP_TOO_LARGE');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.format !== FORMAT || hash(JSON.stringify(data.payload)) !== data.sha256) fail('CHECKSUM_MISMATCH');
    const p = data.payload;
    if (!Array.isArray(p?.sessions) || p.sessions.length > LIMITS.sessions || !Array.isArray(p.files) || p.files.length > LIMITS.files || !p.metadata || !Array.isArray(p.metadata.spaces) || !Array.isArray(p.metadata.tasks)) fail('INVALID_BACKUP');
    const ids = new Set();
    for (const row of p.sessions) { const id = row?.session?.sessionId; if (typeof id !== 'string' || !id || id.length > 200 || ids.has(id) || !Array.isArray(row.transcript)) fail('INVALID_BACKUP'); ids.add(id); }
    let total = 0; const names = new Set();
    for (const f of p.files) {
      if (!/^files\/\d{5}\/[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(f.name) || names.has(f.name) || !ids.has(f.sessionId) || secretFile.test(f.name) || typeof f.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) fail('INVALID_BACKUP');
      names.add(f.name); const b = Buffer.from(f.data, 'base64'); total += b.length;
      if (b.length !== f.size || b.length > LIMITS.fileBytes || total > LIMITS.bytes || hash(b) !== f.sha256) fail('CHECKSUM_MISMATCH');
    }
    // Imported file descriptors may only refer to digest-verified entries owned
    // by their session; arbitrary absolute paths never regain file access.
    const validateRefs = (value, sessionId, context = '') => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) validateRefs(v, sessionId, context); return; }
      const ownContext = context + ' ' + String(value.type || '') + (value.type === 'tool_use' && /^(?:Write|Edit|NotebookEdit)$/i.test(value.name || '') ? ' artifact' : '');
      const eligible = /attachment|artifact|file|document|image/i.test(ownContext);
      if (eligible) {
        for (const key of ['path', 'filePath', 'file_path', 'localPath', 'sourcePath']) {
          const ref = value[key];
          if (ref == null || typeof ref === 'string' && /^(?:https?:|data:)/i.test(ref)) continue;
          if (typeof ref !== 'string' || !p.files.some(f => f.name === ref && f.sessionId === sessionId)) fail('INVALID_BACKUP');
        }
      }
      for (const [key, v] of Object.entries(value)) validateRefs(v, sessionId, eligible ? ownContext + ' ' + key : key);
    };
    for (const row of p.sessions) validateRefs(row, row.session.sessionId);
    for (const [id, artifact] of Object.entries(p.metadata.artifacts || {})) {
      const owner = ids.has(id) ? id : artifact?.sessionId;
      if (owner && ids.has(owner)) validateRefs(artifact, owner, 'artifact');
      else if (artifact && (artifact.path || artifact.filePath || artifact.sourcePath || artifact.localPath)) fail('INVALID_BACKUP');
    }
    return p;
  }
  function inspect(file) {
    const p = decode(file);
    return { ok: true, count: p.sessions.length, files: p.files.length, conflicts: p.sessions.filter(r => kernel.getSession(r.session.sessionId)).map(r => ({ sessionId: r.session.sessionId, running: kernel.getSession(r.session.sessionId).isRunning === true })) };
  }
  function restore(file, { conflict = 'error' } = {}) {
    if (!['error', 'skip', 'overwrite'].includes(conflict)) fail('INVALID_CONFLICT_MODE');
    if (typeof kernel.importBackupSessions !== 'function') fail('IMPORT_UNAVAILABLE');
    const p = decode(file), skipped = [];
    const rows = p.sessions.filter(r => { if (conflict === 'skip' && kernel.getSession(r.session.sessionId)) { skipped.push(r.session.sessionId); return false; } return true; });
    for (const row of rows) { const existing = kernel.getSession(row.session.sessionId); if (existing && conflict !== 'overwrite') fail('CONFLICT'); if (existing?.isRunning) fail('SESSION_RUNNING'); }
    const destination = path.join(secureDir(path.join(root, 'restored')), crypto.randomUUID());
    const stage = destination + '.stage'; secureDir(stage);
    const selected = new Set(rows.map(r => r.session.sessionId));
    const directories = new Map(rows.map((r, i) => [r.session.sessionId, 'session-' + i]));
    let published = false, storePublished = false;
    const oldStore = structuredClone(getStore());
    const oldStoreBytes = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null;
    try {
      for (const f of p.files.filter(f => selected.has(f.sessionId))) {
        const target = path.join(stage, directories.get(f.sessionId), ...f.name.split('/'));
        secureDir(path.dirname(target)); fs.writeFileSync(target, Buffer.from(f.data, 'base64'), { flag: 'wx', mode: 0o600 });
      }
      const imported = rows.map(row => {
        const cwd = path.join(destination, directories.get(row.session.sessionId));
        secureDir(path.join(stage, directories.get(row.session.sessionId)));
        // Relative references remain relative to the restored session's managed cwd.
        const session = { ...clean(row.session), cwd, workingDir: cwd, originCwd: cwd, homePath: cwd, userSelectedFolders: [cwd], cliSessionId: crypto.randomUUID(), kernelBackend: null };
        for (const key of ['ccbResume', 'stagedTranscriptPath', 'homeDir', 'mountedProjects', 'enabledMcpTools', 'cliMcpAppServerNames', 'sendsHeldAfterError', 'queuedMessages']) delete session[key];
        return { session, transcript: clean(row.transcript) };
      });
      const next = structuredClone(oldStore);
      for (const key of ['spaces', 'tasks']) for (const item of clean(p.metadata[key])) {
        if (!item || typeof item.id !== 'string' || !item.id) fail('INVALID_BACKUP');
        for (const field of ['filePath', 'folderPath', 'path', 'cwd', 'workingDir']) delete item[field];
        const index = next[key].findIndex(x => x.id === item.id || item.uuid && x.uuid === item.uuid);
        if (index >= 0 && conflict === 'error') fail('CONFLICT');
        if (index < 0) next[key].push(item); else if (conflict === 'overwrite') next[key][index] = item;
      }
      for (const key of ['artifacts', 'sessionSpaces']) for (const [id, value] of Object.entries(clean(p.metadata[key] || {}))) {
        if (skipped.includes(id) || key === 'artifacts' && skipped.includes(value?.sessionId)) continue;
        if (Object.hasOwn(next[key], id) && conflict === 'error') fail('CONFLICT');
        if (!Object.hasOwn(next[key], id) || conflict === 'overwrite') next[key][id] = value;
      }
      const result = kernel.importBackupSessions(imported, { overwrite: conflict === 'overwrite',
        commit() { fs.renameSync(stage, destination); published = true; atomicWrite(storeFile, JSON.stringify(next)); storePublished = true; setStore(next); },
        rollback() { if (storePublished) { if (oldStoreBytes) atomicWrite(storeFile, oldStoreBytes); else if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile); setStore(oldStore); } }
      });
      return { ok: true, ...result, skipped: skipped.length, files: p.files.filter(f => selected.has(f.sessionId)).length };
    } finally {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      // Only remove our unique restored directory when kernel publication failed.
      if (published && !rows.every(r => kernel.getSession(r.session.sessionId)?.cwd === path.join(destination, directories.get(r.session.sessionId)))) fs.rmSync(destination, { recursive: true, force: true });
    }
  }
  return {
    preview(options) { const p = collect(options); return { ok: true, count: p.sessions.length, files: p.files.length, sizeBytes: encode(p).length }; },
    export(options) { const p = collect(options), bytes = encode(p); const destination = path.join(secureDir(path.join(root, 'exports')), 'backup-' + crypto.randomUUID() + '.json'); atomicWrite(destination, bytes); return { ok: true, path: destination, count: p.sessions.length, files: p.files.length, sizeBytes: bytes.length }; },
    inspect, restore,
  };
}
module.exports = { createLocalBackup, LIMITS, FORMAT };
