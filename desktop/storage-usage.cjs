'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CACHE_NAMES = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache']);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const active = s => !!(s.isRunning || s.isActive || s.pendingToolPermissions?.length || ['running', 'starting', 'needs_input'].includes(s.status));
const sessionId = s => s.sessionId || s.id || s.uuid;
const timestamp = s => { const value = s.lastActivityAt ?? s.updatedAt ?? s.lastUpdatedAt ?? s.createdAt; return typeof value === 'number' ? value : Date.parse(value); };
const validId = id => typeof id === 'string' && /^[\w-]+$/.test(id);

/** Logical file bytes, each physical file once. No content inspection except the app's own session metadata. */
function createStorageUsage(options = {}) {
  const home = options.home || os.homedir();
  const workspace = path.resolve(options.workspace || process.env.CLAUDE_WORKSPACE || process.cwd());
  const dataDir = path.resolve(options.dataDir || path.join(workspace, '.data'));
  const claudeRoot = path.resolve(options.claudeRoot || path.join(home, '.claude'));
  const userData = options.userDataDir && path.resolve(options.userDataDir);
  const coworkRoot = options.coworkRoot && path.resolve(options.coworkRoot);
  const now = options.now || Date.now;
  const storePath = options.storePath && path.resolve(options.storePath);
  const runtimeRoots = (options.runtimeRoots || []).filter(Boolean).map(p => path.resolve(p));
  const plans = new Map();
  let operation = null;

  function sessions() { return typeof options.getSessions === 'function' ? options.getSessions() || [] : []; }
  function coworkIds() { return new Set(options.getCoworkSessionIds?.() || []); }
  function attachmentFiles() {
    const result = new Map(); const ids = coworkIds();
    for (const session of sessions()) {
      const visited = new Set();
      function visit(value, context = '') {
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) { for (const item of value) visit(item, context); return; }
        if (/attachment|artifact|file|document|image/i.test(context + ' ' + String(value.type || ''))) {
          for (const key of ['path', 'filePath', 'localPath', 'sourcePath']) if (typeof value[key] === 'string') {
            const file = path.resolve(session.cwd || workspace, value[key]);
            try { if (fs.lstatSync(file).isFile()) result.set(file, ids.has(sessionId(session)) ? 'cowork' : 'attachments'); } catch { /* unavailable attachment */ }
          }
        }
        for (const [key, child] of Object.entries(value)) visit(child, key);
      }
      visit(session); visit(options.getTranscript?.(sessionId(session)));
    }
    return result;
  }
  function roots() {
    const entries = [];
    const add = (root, type) => { if (root) entries.push({ root: path.resolve(root), type }); };
    // Inspect only declared Claude data directories, never credentials/settings contents.
    for (const name of ['projects', 'file-history', 'shell-snapshots', 'backups', 'plans', 'tasks', 'todos', 'session-env', 'debug']) add(path.join(claudeRoot, name), 'claude');
    add(dataDir, 'data'); add(userData, 'userData'); add(coworkRoot, 'cowork');
    add(storePath, 'store');
    for (const root of runtimeRoots) add(root, 'runtime');
    return entries;
  }
  function cacheRoot(file) {
    if (!userData || !inside(userData, file)) return null;
    const parts = path.relative(userData, file).split(path.sep);
    const base = parts[0] === 'sessionData' ? 1 : 0;
    const offset = parts[base] === 'Partitions' && parts.length > base + 2 ? base + 2 : base;
    if (CACHE_NAMES.has(parts[offset])) return path.join(userData, ...parts.slice(0, offset + 1));
    if (parts[0] === 'cache') return path.join(userData, 'cache');
    return null;
  }
  function classify(file) {
    if (runtimeRoots.some(root => inside(root, file))) return 'runtime';
    if (storePath === file) return 'records';
    if (inside(path.join(claudeRoot, 'projects'), file)) {
      if (file.split(path.sep).includes('worktrees')) return 'worktrees';
      return /\.jsonl$/i.test(file) ? 'transcripts' : 'unknown';
    }
    if (inside(path.join(claudeRoot, 'file-history'), file)) return 'history';
    if (inside(path.join(claudeRoot, 'shell-snapshots'), file)) return 'scratch';
    if (coworkRoot && inside(coworkRoot, file)) {
      if (inside(path.join(coworkRoot, '.cowork'), file) || inside(path.join(coworkRoot, 'attachments'), file)) return 'cowork';
      return 'unknown';
    }
    if (cacheRoot(file)) return 'webCache';
    if (userData && (inside(path.join(userData, 'Partitions'), file) || inside(path.join(userData, 'sessionData', 'Partitions'), file))) return 'browserPanes';
    if (inside(path.join(dataDir, 'logs'), file) || (userData && inside(path.join(userData, 'logs'), file)) || inside(path.join(claudeRoot, 'debug'), file)) return 'logs';
    if (inside(path.join(dataDir, 'attachments'), file)) return 'attachments';
    if (inside(path.join(dataDir, 'sessions'), file) && /\.jsonl$/i.test(file)) return 'transcripts';
    return 'unknown';
  }
  function scan() {
    const files = []; const seenPaths = new Set(); const seenFiles = new Set(); const errors = [];
    const attachments = attachmentFiles();
    function walk(file) {
      const key = process.platform === 'win32' ? file.toLowerCase() : file;
      if (seenPaths.has(key)) return; seenPaths.add(key);
      let st;
      try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') errors.push({ path: file, code: e.code }); return; }
      // No junctions, symlinks, device files or out-of-tree traversal.
      if (st.isSymbolicLink()) { errors.push({ path: file, code: 'SYMLINK_SKIPPED' }); return; }
      try {
        const real = fs.realpathSync(file);
        if ((process.platform === 'win32' ? real.toLowerCase() !== file.toLowerCase() : real !== file)) { errors.push({ path: file, code: 'SYMLINK_ANCESTOR_SKIPPED' }); return; }
      } catch (e) { errors.push({ path: file, code: e.code }); return; }
      if (st.isDirectory()) {
        let children;
        try { children = fs.readdirSync(file); } catch (e) { errors.push({ path: file, code: e.code }); return; }
        for (const child of children) walk(path.join(file, child));
      } else if (st.isFile()) {
        const identity = st.ino ? `${st.dev}:${st.ino}` : key;
        if (seenFiles.has(identity)) return; seenFiles.add(identity);
        files.push({ path: file, bytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev, category: attachments.get(file) || classify(file) });
      }
    }
    // More specific declared ownership wins when roots alias or overlap.
    for (const file of attachments.keys()) walk(file);
    for (const entry of roots().sort((a, b) => b.root.length - a.root.length)) walk(entry.root);
    return { files, errors };
  }
  function snapshot() {
    const measured = scan(); const sums = {};
    for (const f of measured.files) sums[f.category] = (sums[f.category] || 0) + f.bytes;
    const local = sessions(); const cowork = coworkIds();
    const codeIds = new Set(local.filter(s => !cowork.has(sessionId(s))).map(sessionId).filter(Boolean));
    for (const file of measured.files) {
      if (inside(path.join(claudeRoot, 'projects'), file.path) && !file.path.split(path.sep).includes('subagents') && /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(path.basename(file.path))) codeIds.add(path.basename(file.path, '.jsonl'));
    }
    const coworkCount = local.filter(s => cowork.has(sessionId(s))).length;
    const sum = key => sums[key] || 0;
    const deviceBytes = measured.files.filter(f => f.category !== 'cowork').reduce((n, f) => n + f.bytes, 0);
    const unknownBytes = sum('unknown') + sum('attachments');
    const common = {
      code: { recordsBytes: sum('records'), transcriptsBytes: sum('transcripts'), worktrees: { bytes: sum('worktrees'), count: 0 }, scratchBytes: sum('scratch'), otherHistoryBytes: sum('history'), sessionCount: codeIds.size },
      runtime: { claudeCodeBytes: sum('runtime'), claudeCodeVersionCount: 0 },
      app: { webCacheBytes: sum('webCache'), browserPanesBytes: sum('browserPanes'), logsBytes: sum('logs'), otherCachesBytes: 0 },
      workspace: { totalBytes: 0, systemImageBytes: 0, sessionDiskBytes: 0, pendingUpdateBytes: 0, leftoverBytes: 0, otherBytes: 0 },
    };
    const coverage = { complete: measured.errors.length === 0, errors: measured.errors, byteBasis: 'logical-file-size', unknownBytes, sharedSessionStoreBytes: sum('records'), attachmentBytes: sum('attachments'), runtimeKnown: runtimeRoots.length > 0, runtimeVersionCountKnown: false, worktreeCountKnown: false, externalAttachments: 'explicit-file-references-only', unclassified: measured.files.filter(f => ['unknown', 'attachments'].includes(f.category)).map(f => ({ path: f.path, bytes: f.bytes })) };
    return {
      device: { ...common, totalBytes: deviceBytes, conversations: { count: codeIds.size, chatCount: codeIds.size, stale: [] }, unknownBytes, coverage },
      cowork: { ...common, totalBytes: sum('cowork'), conversations: { count: coworkCount, chatCount: coworkCount, stale: [] }, code: { ...common.code, recordsBytes: 0, transcriptsBytes: 0, scratchBytes: 0, otherHistoryBytes: 0, worktrees: { bytes: 0, count: 0 }, sessionCount: 0 }, runtime: { claudeCodeBytes: 0, claudeCodeVersionCount: 0 }, app: { webCacheBytes: 0, browserPanesBytes: 0, logsBytes: 0, otherCachesBytes: 0 }, unknownBytes: 0, coverage: { ...coverage, sharedSessionStoreBytes: sum('records'), sharedSessionStoreOwner: 'device', unknownBytes: 0, unclassified: [] } },
      measured,
    };
  }
  function getUsage(scope = 'device') { return snapshot()[scope === 'cowork' ? 'cowork' : 'device']; }
  function previewCleanup(scope, request = 30) {
    const days = Number(typeof request === 'object' ? request?.inactivityDays ?? request?.days : request);
    if (!Number.isFinite(days) || days < 0) return { errorCode: 'bad-selection' };
    const threshold = now() - days * 86400000; const ids = coworkIds();
    const candidates = sessions().filter(s => (scope === 'cowork') === ids.has(sessionId(s)) && validId(sessionId(s)) && !active(s) && Number.isFinite(timestamp(s)) && timestamp(s) <= threshold).map(s => ({ id: sessionId(s), updatedAt: timestamp(s) }));
    const token = crypto.randomUUID();
    plans.set(token, { scope, candidates, threshold, expires: now() + 5 * 60000 });
    while (plans.size > 64) plans.delete(plans.keys().next().value);
    // Shared aggregate JSON has no stable per-session byte attribution. Never invent it.
    return { preview: { token, count: scope === 'cowork' ? candidates.length : 0, sessionCount: candidates.length, bytes: 0, chatCount: scope === 'cowork' ? candidates.length : 0, uncommittedCount: 0, uncommittedBytes: 0, withCloudCopyCount: 0, unverifiedCount: 0, examples: [], rows: [], unlistedCleanCount: 0, unlistedUncommittedCount: 0, unknownBytes: true, worktreesUnsupported: true } };
  }
  async function runCleanup(scope, token, choices = {}) {
    const result = { removedCount: 0, deletedCount: 0, skippedCount: 0, failedCount: 0, failedInUseCount: 0, cancelled: false, freedBytes: 0 };
    const plan = plans.get(token); plans.delete(token);
    if (!plan || plan.scope !== scope || plan.expires < now()) return { ...result, errorCode: 'expired' };
    if (operation) return { ...result, errorCode: 'busy' };
    if (scope === 'device' && choices.deleteSessions !== true) return result;
    if (typeof options.removeSession !== 'function') return { ...result, errorCode: 'disabled' };
    const job = operation = { scope, cancelled: false };
    try {
      for (let i = 0; i < plan.candidates.length; i++) {
        await new Promise(resolve => setImmediate(resolve));
        if (job.cancelled) { result.cancelled = true; break; }
        const candidate = plan.candidates[i]; const current = sessions().find(s => sessionId(s) === candidate.id);
        const isCowork = coworkIds().has(candidate.id);
        if (!current || active(current) || (scope === 'cowork') !== isCowork || timestamp(current) !== candidate.updatedAt || timestamp(current) > plan.threshold) result.skippedCount++;
        else {
          try { const answer = await options.removeSession(candidate.id); if (answer === false || answer?.ok === false) result.failedCount++; else result.deletedCount++; }
          catch { result.failedCount++; }
        }
        options.onProgress?.(scope, i + 1, plan.candidates.length);
      }
    } finally { if (operation === job) operation = null; }
    return result;
  }
  function cancelCleanup(scope) { if (operation?.scope === scope) operation.cancelled = true; return { ok: true }; }
  function clearCache() {
    const result = { ok: true, deletedCount: 0, freedBytes: 0, skippedCount: 0, failedCount: 0 };
    for (const file of scan().files) {
      if (file.category !== 'webCache' || !cacheRoot(file.path) || runtimeRoots.some(root => inside(root, file.path))) continue;
      try {
        // Revalidate every ancestor immediately before deletion; do not traverse a replaced junction.
        let ancestor = file.path;
        while (inside(userData, ancestor)) { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('link changed'); if (ancestor === userData) break; ancestor = path.dirname(ancestor); }
        const current = fs.lstatSync(file.path);
        if (!current.isFile() || current.size !== file.bytes || current.mtimeMs !== file.mtimeMs || current.ino !== file.ino || current.dev !== file.dev) { result.skippedCount++; continue; }
        fs.unlinkSync(file.path); result.deletedCount++; result.freedBytes += file.bytes;
      } catch { result.failedCount++; }
    }
    result.ok = result.failedCount === 0;
    return result;
  }
  return { getUsage, snapshot, previewCleanup, runCleanup, cancelCleanup, clearCache };
}
module.exports = { createStorageUsage, CACHE_NAMES };
