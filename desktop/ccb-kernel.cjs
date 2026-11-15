// CcbKernel: claude-code-best driven as a child process over its stream-json
// protocol, behind the AgentKernelBackend contract (desktop/kernel-backend.cjs).
//
// Everything below was measured on this host against claude-code-best 2.8.4
// (%TEMP%\cc-best-ref). Facts, not guesses:
//
//   - The Node build is broken: dist/cli-node.js dies on import.meta.require.
//     The kernel must be started with the Bun binary and dist/cli-bun.js.
//     bun.cmd swallows arguments, so the .exe is spawned directly.
//   - --print requires --verbose when --output-format stream-json, otherwise it
//     exits before emitting a frame.
//   - One child process serves many turns: a second user frame on the same pipe
//     produces a second result frame and the process stays alive.
//   - Handshake: {"type":"control_request","request_id":"...","request":{"subtype":"initialize"}}
//     answers with control_response.response.response = { commands, agents,
//     models, account, output_style, available_output_styles, pid }.
//   - A native queue drain may merge inputs in a tool round or produce multiple
//     top-level results before it reports idle.
//   - interrupt: src/cli/print.ts aborts the current turn and answers
//     control_response; measured, the kernel then emits
//     result/error_during_execution (is_error:true, stop_reason:null) within a
//     few ms and stays usable for the next turn.
//
// Event vocabulary. The backend speaks the SAME event names our own loop
// (desktop/agent.cjs) speaks — text / tool_request / tool_result / tool_error /
// error / turn / done — because session-kernel.cjs and the renderer are written
// against that vocabulary. Two names from the renderer's world are deliberately
// NOT emitted here: `message` (a stream-json transcript entry) and
// `turn_finished`. session-kernel.cjs constructs those itself after the turn;
// a backend that also emitted them would append every row twice. The full raw
// frames stay available as `raw` events for callers that want them.
//
// Session model: one child process per session. The CLI's unit of conversation
// is a process, so sharing one across sessions would interleave two
// conversations into one context.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { userContent } = require('./session-images.cjs');
const { createKernelEventHub, normaliseTurnResult, assertKernelBackend } = require('./kernel-backend.cjs');
const { buildKernelEnv, defaultScratchDir } = require('./kernel-env.cjs');

const KERNEL_ID = 'ccb';
const ENTRY_RELATIVE = path.join('dist', 'cli-bun.js');
const BASE_FLAGS = Object.freeze(['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json']);
const DEFAULT_PERMISSION_MODE = 'default';
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
const CLI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defaults are IN THE REPOSITORY, not in %TEMP%.
//
// The bundle (bun runtime + the claude-code dist) ships with the app under
// agent-core/, pinned by a manifest, so a launch works on a machine that never
// had the reference checkout. %TEMP%\cc-best-ref was where the protocol was
// first measured; it is history, not the install location, and must not be a
// default — the app cannot depend on a directory a reboot may clear.
//
// These two paths are the same ones desktop/kernel-select.cjs probes; the
// selector and this kernel have to agree or selection can say "available" and
// then fail at spawn.
const AGENT_CORE_DIR = 'agent-core';
const BUN_RELATIVE = path.join(AGENT_CORE_DIR, 'bun', 'bun.exe');
const KERNEL_RELATIVE = path.join(AGENT_CORE_DIR, 'claude-code');

/** Repository root: this file lives in <root>/desktop/. */
function defaultProjectRoot() {
  return require('./ccb-runtime-paths.cjs').resolveAgentRoot();
}

/** Where the bundled bun runtime lives: <root>/agent-core/bun/bun.exe */
function defaultBunPath(projectRoot = defaultProjectRoot()) {
  return path.join(projectRoot, BUN_RELATIVE);
}

/** Where the bundled kernel lives: <root>/agent-core/claude-code */
function defaultKernelRoot(projectRoot = defaultProjectRoot()) {
  return path.join(projectRoot, KERNEL_RELATIVE);
}

/** The historical reference checkout, still useful for probes. Never a default. */
function referenceKernelRoot(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, 'cc-best-ref');
}

/**
 * Resolve the three paths the kernel needs.
 *
 * Precedence: explicit argument > environment (CCB_BUN / CCB_ROOT / CCB_ENTRY) >
 * the bundled agent-core/ paths. Missing files throw here, at construction, so a
 * missing kernel is a startup error the app can fall back from — not a crash
 * inside a turn.
 */
function resolveCcbPaths({
  bunPath = null,
  kernelRoot = null,
  entryPath = null,
  env = process.env,
  fsImpl = fs,
  projectRoot = defaultProjectRoot(),
} = {}) {
  const root = kernelRoot || env.CCB_ROOT || defaultKernelRoot(projectRoot);
  const bun = bunPath || env.CCB_BUN || defaultBunPath(projectRoot);
  const entry = entryPath || env.CCB_ENTRY || path.join(root, ENTRY_RELATIVE);

  if (!fsImpl.existsSync(bun)) {
    throw new Error(`CCB kernel: bun executable not found at ${bun} (set CCB_BUN)`);
  }
  if (!fsImpl.existsSync(entry)) {
    throw new Error(`CCB kernel: entry script not found at ${entry} (set CCB_ROOT or CCB_ENTRY)`);
  }
  return { bunPath: bun, kernelRoot: root, entryPath: entry };
}

/** One JSON line for the child's stdin. Never throws on a dead pipe. */
function writeFrame(child, frame) {
  const line = `${JSON.stringify(frame)}\n`;
  try {
    child.stdin.write(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flatten the content of an assistant/user frame into text.
 *
 * tool_result content can be a string, an array of blocks, or an object. The
 * transcript view wants a string; JSON is the honest fallback for a shape we do
 * not recognise, because dropping it would silently lose tool output.
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block.text === 'string') return block.text;
      if (block && block.type === 'image') return '[image]';
      return '';
    }).join('');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    return JSON.stringify(content);
  }
  return '';
}

/**
 * @param {{
 *   bunPath?: string, kernelRoot?: string, entryPath?: string,
 *   cwd?: string, permissionMode?: string|null, permissionPromptTool?: string|null,
 *   env?: object, log?: (msg: string) => void,
 *   extraArgs?: string[],
 *   spawnImpl?: Function, fsImpl?: object, platform?: string,
 *   startupTimeoutMs?: number, turnTimeoutMs?: number, interruptGraceMs?: number,
 *   disposeTimeoutMs?: number, nativeCycleEvents?: boolean,
 * }} [options]
 */
function createCcbKernel(options = {}) {
  const paths = resolveCcbPaths(options && options.projectRoot ? { ...options, projectRoot: options.projectRoot } : options);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;
  const permissionMode = options.permissionMode === undefined ? DEFAULT_PERMISSION_MODE : options.permissionMode;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  // A turn can legitimately spend more than ten minutes using tools. A total
  // wall-clock limit interrupts healthy work and the CLI labels that abort as
  // "user interrupted". Only enforce a deadline when the caller requests one;
  // startup deadlines, explicit cancellation and child-exit handling stay active.
  const turnTimeoutMs = options.turnTimeoutMs ?? 0;
  const interruptGraceMs = options.interruptGraceMs ?? 15_000;
  const disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000;
  const protectionNow = options.protectionNow || Date.now;
  const protectionClock = options.protectionClock || require('./cli-protection-clock.cjs').createProtectionClock({now: protectionNow});

  const hub = createKernelEventHub({ onListenerError: (error) => log(`event listener threw: ${error && error.message}`) });

  /** sessionId -> state (one child process each). */
  const sessions = new Map();
  const detachProtectionClock = protectionClock.onEvent(event => {
    for (const state of sessions.values()) {
      if (!state.child || state.exited) continue;
      state.protection?.powerEvent(state.actorToken, event);
      state.protectionVersion = (state.protectionVersion || 0) + 1;
    }
  });
  // Every live child, tracked independently of sessions.
  //
  // This exists because of a measured failure: when a test failed before its
  // dispose() ran, the child stayed alive and node --test never exited — the
  // whole suite hung on a leaked process. A backend whose contract already says
  // "never leave a bun.exe orphaned" cannot depend on its owner remembering to
  // call dispose. So the children are tracked here and killed if the host
  // process exits without disposing.
  const liveChildren = new Set();
  const childStates = new WeakMap();
  const reapOnExit = () => {
    for (const child of [...liveChildren]) {
      try { forceKill(child); } catch { /* nothing left to do while exiting */ }
    }
    liveChildren.clear();
  };
  process.once('exit', reapOnExit);
  /** request_id -> resolver for control requests we sent. */
  const awaitingControl = new Map();
  let disposed = false;
  let disposePromise = null;
  let disposeComplete = false;
  let requestSeq = 0;

  const newRequestId = (prefix) => `${prefix}-${++requestSeq}`;

  function sameDirectory(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const normalise = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normalise(left) === normalise(right);
  }

  /** Confirm a native transcript, never just a random UUID in a desktop record.
   * CCB's sanitizer uses Bun.hash for cwd >200 chars. Finding its exact filename
   * inside projects avoids replacing that with Node's different hash algorithm.
   */
  function findCliTranscript(state, hintedPath = null) {
    const cliId = state.cliSessionId;
    const homeDir = state.envReport?.applied?.homeDir || state.homeDir;
    if (!CLI_SESSION_ID.test(cliId || '') || !homeDir) return null;
    const projects = path.join(homeDir, 'projects');
    let projectRoot;
    try { projectRoot = fs.realpathSync(projects); } catch { return null; }
    const encoded = state.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dirs = encoded.length <= 200 ? [encoded] : (() => {
      try { return fs.readdirSync(projects).filter((name) => name.startsWith(`${encoded.slice(0, 200)}-`)); }
      catch { return []; }
    })();
    const candidates = [...(hintedPath ? [hintedPath] : []), ...dirs.map(dir => path.join(projects, dir, `${cliId}.jsonl`))];
    for (const file of candidates) {
      let fd;
      try {
        const realFile = fs.realpathSync(file);
        const relative = path.relative(projectRoot, realFile);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
        if (path.basename(realFile).toLowerCase() !== `${cliId}.jsonl`.toLowerCase()) continue;
        const stat = fs.statSync(realFile);
        if (!stat.isFile() || stat.size === 0) continue;
        fd = fs.openSync(realFile, 'r');
        const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
        if (bytes < stat.size) lines.pop();
        for (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.sessionId === cliId && sameDirectory(row.cwd, state.cwd)
            && ['user', 'assistant'].includes(row.type) && row.message) return realFile;
        }
      } catch { /* A missing, inaccessible or malformed transcript is not resumable. */ }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    }
    return null;
  }

  function configureSession(state, input = {}) {
    // Permission selection belongs to the session, not the backend factory. A warm
    // actor can change modes between turns; applyPermissionMode synchronizes it.
    if (input.permissionMode !== undefined) {
      if (!PERMISSION_MODES.has(input.permissionMode)) throw new Error('Invalid CCB permissionMode');
      state.permissionMode = input.permissionMode;
    }
    if (state.child) return; // Live processes already own their launch context.
    if (input.cwd) state.cwd = path.resolve(input.cwd);
    if (input.env) state.env = input.env;
    if (input.scratchDir) state.scratchDir = input.scratchDir;
    if (typeof input.model === 'string' && input.model.trim()) state.model = input.model.trim();
    const saved = input.ccbResume;
    if (saved && saved.cwd && !sameDirectory(saved.cwd, state.cwd)) {
      throw new Error('CCB session cannot be resumed: the saved working directory differs from the session working directory');
    }
    if (saved?.homeDir) state.homeDir = path.resolve(saved.homeDir);
    if (saved?.scratchDir) state.scratchDir = path.resolve(saved.scratchDir);
    const requestedId = saved?.cliSessionId || input.cliSessionId || state.cliSessionId;
    if (!CLI_SESSION_ID.test(requestedId || '')) {
      if (input.resume) throw new Error('CCB session cannot be resumed: no valid native CLI session UUID was persisted');
      state.cliSessionId = randomUUID();
    } else state.cliSessionId = requestedId.toLowerCase();
    state.resume = input.resume === undefined ? state.resume : input.resume === true;
    state.transcriptHint = saved?.transcriptPath || null;
  }

  function buildArgs(state) {
    const args = [paths.entryPath, ...BASE_FLAGS];
    // Explicit opt-in until support has been verified for the selected CLI.
    if (options.replayUserMessages === true || options.nativeCycleEvents) args.push('--replay-user-messages');
    if (state.resume) {
      const transcript = findCliTranscript(state, state.transcriptHint);
      if (!transcript) throw new Error(`CCB session cannot be resumed: no verified CLI transcript for ${state.cliSessionId} in the saved home and working directory`);
      state.transcriptHint = transcript;
      state.identityConfirmed = true;
      args.push('--resume', state.cliSessionId);
    } else {
      if (findCliTranscript(state)) throw new Error('CCB session UUID already has a transcript; refusing to start a new conversation over it');
      args.push('--session-id', state.cliSessionId);
    }
    const settingsFile = state && writeGatewaySettings(state);
    if (settingsFile) args.push('--settings', settingsFile);
    // The kernel picks its model from --model / ANTHROPIC_MODEL, and its own catalogue is the
    // Claude one. With a gateway that serves different ids (deepseek-v4-pro, glm-5.3, ...) it
    // kept requesting claude-sonnet-4-6 and every turn retried an upstream error. Passing the
    // resolved model explicitly is what makes the kernel call the model the gateway has.
    const model = state.model || options.model || options.env?.CLAUDE_AGENT_MODEL || null;
    if (model) args.push('--model', model);
    args.push('--permission-mode', state.permissionMode);
    // Advertise switch capability without enabling it. Only an explicit session
    // selection changes the active mode (including on an already-warm actor).
    args.push('--allow-dangerously-skip-permissions');
    if (options.permissionPromptTool) args.push('--permission-prompt-tool', options.permissionPromptTool);
    if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs);
    // A trailing model flag supplied by the caller overrides our selection.
    const overridesModel = Array.isArray(options.extraArgs) && options.extraArgs.some(arg => arg === '--model' || String(arg).startsWith('--model='));
    return { args, launchModel: overridesModel ? null : model };
  }

  /**
   * The environment a child runs with.
   *
   * The host environment is inherited — the kernel resolves its own provider
   * credentials from it — but two settings are NOT ambient, because on this host
   * they are wrong in a way that looks like a tool bug:
   *
   *   - TEMP/TMP/TMPDIR must point at a writable scratch directory, or the
   *     kernel's mkdir under %TEMP%\claude\... fails and its Bash tool reports
   *     "EPERM: operation not permitted, mkdir ...";
   *   - PATH must reach a real bash.exe, not the bash.cmd shim, or the Bash tool
   *     reports "Exit code 126 [Request interrupted by user for tool use]".
   *
   * Both come from desktop/kernel-env.cjs, which measured them. A caller that
   * passed an explicit env still has it applied ON TOP, so nothing the caller
   * asked for is dropped; the caller can also override with scratchDir or
   * options.kernelEnv.
   */
  /**
   * Write a settings file carrying the gateway, and return its path.
   *
   * Why this is needed: the kernel merges ~/.claude/settings.json env into process.env, and a
   * settings value WINS over the inherited environment. On this host that file pins
   * ANTHROPIC_BASE_URL to a different gateway, so passing ANTHROPIC_BASE_URL to the child had
   * no effect at all — every request went to the old endpoint and retried on 503, while the
   * init frame reported the model we asked for (so the model looked correct and the endpoint
   * did not). --settings is the documented way to inject env at higher precedence.
   */
  function writeGatewaySettings(state) {
    const base = { ...process.env, ...(options.env || {}), ...(state.env || {}) };
    const baseUrl = base.ANTHROPIC_BASE_URL;
    const token = base.ANTHROPIC_AUTH_TOKEN || base.ANTHROPIC_API_KEY;
    if (!baseUrl || !token) return null;
    const dir = state.scratchDir || options.scratchDir || defaultScratchDir(state.cwd);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `kernel-settings-${state.sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ...((state.model || base.CLAUDE_AGENT_MODEL) ? { ANTHROPIC_MODEL: state.model || base.CLAUDE_AGENT_MODEL } : {}),
        },
      }, null, 2), 'utf8');
      return file;
    } catch (error) {
      log(`[ccb ${state.sessionId}] could not write gateway settings: ${error && error.message}`);
      return null;
    }
  }

  function childEnv(state) {
    const scratchDir = state.scratchDir || options.scratchDir || defaultScratchDir(state.cwd);
    const base = { ...process.env, ...(options.env || {}), ...(state.env || {}) };
    // The kernel reads ANTHROPIC_MODEL for its own model selection; keep it in step with the
    // --model flag so a log line and the actual request cannot disagree.
    const model = state.model || options.model || base.CLAUDE_AGENT_MODEL;
    if (model) base.ANTHROPIC_MODEL = model;
    const built = buildKernelEnv({
      base,
      scratchDir,
      homeDir: state.homeDir || options.homeDir || path.join(scratchDir, 'ccb-home'),
      ...(options.kernelEnv || {}),
      ...(state.resume ? {
        homeDir: state.homeDir || options.homeDir || path.join(scratchDir, 'ccb-home'),
        scratchDir,
      } : {}),
    });
    if (options.nativeCycleEvents) built.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
    // Keep the report; start()/getInfo() hand it to the caller rather than
    // swallowing it. A warning nobody sees is the same as no warning.
    state.envReport = {
      applied: built.applied,
      warnings: [...built.warnings],
      notes: [...built.notes],
    };
    for (const warning of built.warnings) log(`[ccb ${state.sessionId}] env: ${warning}`);
    return built.env;
  }

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (state) return state;
    const cwd = (options.cwd && path.resolve(options.cwd)) || paths.kernelRoot;
    state = {
      sessionId,
      cwd,
      scratchDir: null,
      envReport: null,
      env: null,
      model: null,
      permissionMode: PERMISSION_MODES.has(permissionMode) ? permissionMode : DEFAULT_PERMISSION_MODE,
      appliedPermissionMode: null,
      modelKnown: true,
      confirmedModel: null,
      modelConfirmedOnReady: false,
      actorToken: null,
      modelSequence: 0,
      hasModelSelection: false,
      operationTail: Promise.resolve(),
      turnQueued: false,
      operationsPending: 0,
      pendingApprovals: 0,
      starting: false,
      handshakePending: false,
      stopping: false,
      lastActivityAt: Date.now(),
      recoverable: false,
      hasUserFrame: false,
      cliSessionId: randomUUID(),
      homeDir: null,
      resume: false,
      identityConfirmed: false,
      transcriptHint: null,
      child: null,
      ready: null,
      buffer: '',
      stderr: [],
      initInfo: null,
      turn: null,
      interrupted: false,
      exited: null,
      closed: false,
    };
    sessions.set(sessionId, state);
    return state;
  }

  /** Spawn the child for a session, once. Returns a promise that resolves when
   *  stdin is writable (the 'spawn' event), not when the handshake completes. */
  function ensureProcess(state, { reason = 'user', signal } = {}) {
    if (state.ready) return state.ready;
    if (disposed) throw new Error('kernel backend has been disposed');
    state.starting = true;
    const ready = (async () => {
      let admission;
      try {
        if (signal?.aborted) throw new Error('CCB startup was cancelled');
        admission = options.acquireSlot ? await options.acquireSlot({ sessionId: state.sessionId, reason, signal }) : null;
        if (admission?.yielded) { const error = new Error('CCB startup yielded by governor'); error.code = 'CCB_ADMISSION_YIELDED'; throw error; }
        if (signal?.aborted) throw new Error('CCB startup was cancelled');
        if (disposed) throw new Error('kernel backend has been disposed');
        assertOwned(state);
        return await spawnProcess(state);
      } finally {
        if (typeof admission?.release === 'function') admission.release();
        state.starting = false;
      }
    })();
    state.ready = ready;
    ready.catch(() => { if (state.ready === ready && !state.child) state.ready = null; });
    return ready;
  }

  function spawnProcess(state) {
    // Resolve HOME before validating the resume log or building argv.
    const env = childEnv(state);
    const { args, launchModel } = buildArgs(state);
    const packaged = options.isPackaged ?? !!(process.resourcesPath && path.resolve(options.projectRoot || defaultProjectRoot()) === path.resolve(process.resourcesPath));
    const useDevCache = platform === 'win32' && !packaged && !options.bunPath && !(options.env || process.env).CCB_BUN;
    const launchBun = useDevCache
      ? require('./ccb-dev-bun-cache.cjs').prepareDevBun(paths.bunPath, options.projectRoot || defaultProjectRoot(), options.bunCacheRoot)
      : paths.bunPath;
    // Keep only launch metadata, never argv/env values, prompts or child output.
    state.launchDiagnostics = {
      entryPath: paths.entryPath, bunPath: launchBun, cwd: state.cwd,
      cliSessionId: state.cliSessionId, startedAt: Date.now(),
      stdoutBytes: 0, stderrBytes: 0, protocolFrames: 0, initialized: false,
      environment: Object.fromEntries(['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'CLAUDE_CODE_FORCE_INTERACTIVE',
        'CLAUDE_CODE_REMOTE', 'BUN_OPTIONS'].map(key => [key, !!env[key]])),
    };
    const child = spawnImpl(launchBun, args, {
      cwd: state.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.child = child;
    childStates.set(child, state);
    state.actorToken = randomUUID();
    // This snapshot belongs to this exact child, not to the mutable UI profile.
    // A caller-provided settings flag can replace the transport behind our back.
    state.contextWindows = new Map();
    const settingsOverride = Array.isArray(options.extraArgs) && options.extraArgs.some(arg => arg === '--settings' || String(arg).startsWith('--settings='));
    if (!settingsOverride && typeof options.contextWindows === 'function') {
      try {
        const rows = options.contextWindows(env);
        const ambiguous = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (typeof row?.model !== 'string' || !row.model || !Number.isSafeInteger(row.contextWindow) || row.contextWindow <= 0) continue;
          if (state.contextWindows.has(row.model)) ambiguous.add(row.model);
          else state.contextWindows.set(row.model, row.contextWindow);
        }
        for (const model of ambiguous) state.contextWindows.delete(model);
      } catch { /* unavailable metadata is unknown */ }
    }
    state.appliedPermissionMode = state.permissionMode;
    if (options.nativeCycleEvents) {
      state.completedResultIds = new Set();
      state.writtenInputIds = new Set();
    }
    state.replayInputs = new Map();
    state.processGoneReason = undefined;
    state.protection = require('./cli-protection-state.cjs').createProtectionState({now: protectionNow});
    state.protection.beginEpoch(state.actorToken);
    state.protection.syncPower(state.actorToken, protectionClock.snapshot());
    state.protection.update(state.actorToken, { query: true });
    state.protectionVersion = 0;
    // Imported sessions can have no model in their record but still launch with
    // an explicit backend default. Retain that selection for a refused switch.
    state.confirmedModel = launchModel;
    state.modelConfirmedOnReady = false;
    state.childFullyClosed = false;
    child.once('close', (code, signal) => {
      liveChildren.delete(child);
      if (state.child !== child) return;
      state.childFullyClosed = true;
      // exit can precede the final stdout/stderr data. Diagnose only after drain.
      onExit(state, code, signal);
    });
    liveChildren.add(child);

    const initRequestId = newRequestId('init');
    state.handshakePending = true;
    state.initRequestId = initRequestId;
    state.pendingControl ||= new Map();
    state.initReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingControl.delete(initRequestId);
        reject(new Error('CCB initialize handshake timed out'));
      }, startupTimeoutMs);
      timer.unref?.();
      state.pendingControl.set(initRequestId, {
        resolve: value => { clearTimeout(timer); resolve(value); if (sessions.get(state.sessionId) === state && !state.exited) hub.emit({sessionId: state.sessionId, type: 'query_installed', actorToken: state.actorToken}); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
    state.initReady.catch(() => {});
    const spawned = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        forceKill(child);
        reject(new Error(`CCB kernel did not start within ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const onSpawn = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.modelConfirmedOnReady = true;
        resolve(child);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CCB kernel failed to start: ${error && error.message}`));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);

      // The handshake goes out as soon as the pipe exists. Measured: the kernel
      // accepts a user frame written immediately after initialize, so the two
      // are not sequenced — but the initialize answer is what carries the
      // command/agent/model inventory, so it is requested here.
      child.stdin.write(`${JSON.stringify({
        type: 'control_request',
        request_id: initRequestId,
        request: { subtype: 'initialize' },
      })}\n`);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (state.child === child) {
      state.lastActivityAt = Date.now();
      state.launchDiagnostics.stdoutBytes += Buffer.byteLength(chunk);
      onStdout(state, chunk);
    } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (state.child !== child) return;
      state.lastActivityAt = Date.now();
      const text = String(chunk);
      state.launchDiagnostics.stderrBytes += Buffer.byteLength(text);
      state.stderr.push(text);
      if (state.stderr.length > 50) state.stderr.shift();
      log(`[ccb ${state.sessionId}] stderr: ${text.trim().slice(0, 400)}`);
    });
    // A dead pipe must not raise an unhandled error and take the main process
    // down with it.
    child.stdin.on('error', (error) => log(`[ccb ${state.sessionId}] stdin: ${error && error.message}`));
    child.on('exit', (code, signal) => {
      if (state.child !== child) return;
      state.exited = { code, signal };
      // Leave protocol dispatch open until close so buffered terminal frames drain.
    });
    child.on('error', (error) => {
      if (state.child !== child) return;
      log(`[ccb ${state.sessionId}] spawn error: ${error && error.message}`);
      fail(state, new Error(`CCB kernel process error: ${error && error.message}`));
    });
    hub.emit({sessionId: state.sessionId, type: 'loops_changed', actorToken: state.actorToken});
    return spawned;
  }

  function onExit(state, code, signal) {
    state.replayInputs?.clear();
    state.exited = { code, signal };
    state.closed = true;
    state.protection?.reset(state.actorToken);
    hub.emit({sessionId: state.sessionId, type: 'loops_changed', actorToken: null});
    hub.emit({sessionId: state.sessionId, type: 'query_closed', actorToken: null});
    if (state.child) liveChildren.delete(state.child);
    const diagnostic = state.launchDiagnostics && {
      ...state.launchDiagnostics, elapsedMs: Date.now() - state.launchDiagnostics.startedAt,
      code, signal, stage: state.launchDiagnostics.initialized ? 'turn' : 'initialize',
    };
    const empty = diagnostic && diagnostic.stdoutBytes === 0 && diagnostic.stderrBytes === 0;
    const unexpected = sessions.get(state.sessionId) === state && !state.stopping && !disposed
      && (!diagnostic?.initialized || !!state.turn);
    const exitError = new Error(`CCB kernel exited (code ${code}, signal ${signal}) ${diagnostic?.initialized ? 'before the turn finished' : 'before initialize handshake'}${empty ? '; stdout/stderr both empty' : ''}`);
    exitError.code = empty && !diagnostic.initialized ? 'CCB_EMPTY_STARTUP_EXIT' : 'CCB_PROCESS_EXIT';
    exitError.diagnostics = diagnostic;
    if (unexpected) {
      state.exitError = exitError;
      log(`[ccb ${state.sessionId}] unexpected exit: ${JSON.stringify(diagnostic)}`);
      if (!state.turn) hub.emit({ sessionId: state.sessionId, type: 'error', code: exitError.code,
        message: exitError.message, diagnostics: diagnostic });
    }
    for (const [requestId, pending] of state.pendingControl || []) {
      const error = unexpected ? exitError : new Error(`CCB kernel exited before answering ${requestId}`);
      if (!unexpected) error.code = 'CCB_CONTROL_EXIT';
      pending.reject(error);
    }
    if (state.pendingControl) state.pendingControl.clear();
    if (state.turn) rejectTurn(state, exitError);
  }

  /** Settle the turn in flight with a failure and report it. */
  function rejectTurn(state, error) {
    const turn = state.turn;
    if (!turn) return;
    state.turn = null;
    turn.steers?.dispose();
    state.protection?.update(state.actorToken, { pendingCycle: false });
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    hub.emit({ sessionId: state.sessionId, type: 'error', message: String(error && error.message),
      ...(error?.diagnostics ? { code: error.code, diagnostics: error.diagnostics } : {}) });
    turn.reject(error);
  }

  function settleTurn(state, result) {
    const turn = state.turn;
    if (!turn) {
      // A result with no turn in flight. Measured on interrupt: the kernel
      // answers the interrupt and then emits error_during_execution. If we
      // already settled from the cancel path, this frame is simply stale.
      log(`[ccb ${state.sessionId}] result frame with no turn in flight (subtype ${result.subtype})`);
      return;
    }
    state.turn = null;
    turn.steers?.dispose();
    state.protection?.update(state.actorToken, { pendingCycle: false });
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    turn.resolve(result);
  }

  /** Split a stdout chunk into frames and dispatch each. */
  function onStdout(state, chunk) {
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).replace(/\r$/, '');
      state.buffer = state.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        // Non-protocol output (a stray warning printed to stdout) must not end
        // the turn. It is kept for diagnostics only.
        log(`[ccb ${state.sessionId}] non-JSON stdout: ${line.slice(0, 300)}`);
        continue;
      }
      try {
        handleFrame(state, frame);
      } catch (error) {
        log(`[ccb ${state.sessionId}] frame handling failed: ${error && error.message}`);
      }
    }
  }

  function handleFrame(state, frame) {
    if (!frame || typeof frame !== 'object' || sessions.get(state.sessionId) !== state) return;
    if (state.launchDiagnostics) state.launchDiagnostics.protocolFrames++;
    const turn = state.turn;
    // The pinned CLI emits running on entry to runHeadlessStreaming's queue
    // drain and idle after the final result (also after a held background result).
    // A single drain may contain multiple ask() calls or one merged tool cycle.
    if (options.nativeCycleEvents && frame.type === 'system' && frame.subtype === 'session_state_changed') {
      if (!turn || state.closed || turn.actorToken !== state.actorToken || frame.session_id !== state.cliSessionId) return;
      if (frame.state === 'running' && !turn.cycleOpen) {
        turn.cycleOpen = true;
        turn.hasTerminal = false;
      }
      if (frame.state === 'idle' && turn.cycleOpen) {
        turn.cycleOpen = false;
        turn.steers.atBoundary();
        finishIdleCycle(state,turn);
      }
      return;
    }
    if (options.nativeCycleEvents && frame.type === 'result') {
      if (!turn || state.closed || frame.parent_tool_use_id != null) return;
      if (!turn.cycleOpen || turn.actorToken !== state.actorToken || frame.session_id !== state.cliSessionId) return;
      if (frame.uuid && state.completedResultIds.has(frame.uuid)) return;
      turn.hasTerminal = true;
      if (frame.uuid) {
        state.completedResultIds.add(frame.uuid);
        if (state.completedResultIds.size > 1024) state.completedResultIds.delete(state.completedResultIds.values().next().value);
      }
    }
    const cronBefore = state.protection?.getCronRevision(state.actorToken);
    state.protection?.observeFrame(state.actorToken, frame);
    state.protection?.pruneCron(state.actorToken);
    state.protectionVersion = (state.protectionVersion || 0) + 1;
    const sessionId = state.sessionId;
    // Replay is an input-observation signal, not a transcript row or a turn
    // result. Match only UUIDs written to this actor, and emit at most once.
    if (frame.type === 'user' && frame.isReplay === true) {
      if (turn?.cycleOpen && frame.session_id===state.cliSessionId) turn.steers?.observe(frame.uuid);
      if (options.replayUserMessages === true && typeof frame.uuid === 'string' && state.replayInputs?.get(frame.uuid) === false) {
        state.replayInputs.set(frame.uuid, true);
        hub.emit({ sessionId, type: 'user_input_observed', messageUuid: frame.uuid, actorToken: state.actorToken });
      }
      return;
    }
    // Every frame is available raw for callers that need the original shape.
    // Context responses can include workspace paths, tool names and other private
    // details. Also suppress late responses after timeout/removal, when no pending
    // resolver remains, by using the internally generated request-id namespace.
    const privateContextResponse = frame.type === 'control_response' &&
      typeof frame.response?.request_id === 'string' && frame.response.request_id.startsWith('get_context_usage-');
    if (!privateContextResponse) hub.emit({ sessionId, type: 'raw', frame,
      ...(options.nativeCycleEvents && frame.type === 'result' ? { primaryForNativeCycle: !turn.primaryResult } : {}) });
    if (sessions.get(sessionId) === state && state.protection?.getCronRevision(state.actorToken) !== cronBefore) {
      hub.emit({sessionId, type: 'loops_changed', actorToken: state.actorToken});
    }

    switch (frame.type) {
      case 'control_response': {
        const response = frame.response || {};
        const requestId = response.request_id;
        if (requestId === state.initRequestId) {
          state.handshakePending = false;
          if (state.launchDiagnostics && response.subtype === 'success') state.launchDiagnostics.initialized = true;
        }
        // The initialize answer carries the kernel's own inventory: the slash commands, the
        // agent presets, and the model list with their effort/effort-level capabilities. That
        // is exactly what a model picker needs, and it was previously read and thrown away —
        // the bridge then had to invent a one-entry list, which is why the picker had nothing
        // real to show. Keep it on the state and expose it through getInfo().
        const body = response.response;
        if (!privateContextResponse && body && typeof body === 'object' && Array.isArray(body.models)) {
          state.initInfo = {
            ...(state.initInfo || {}),
            commands: Array.isArray(body.commands) ? body.commands : [],
            agents: Array.isArray(body.agents) ? body.agents : [],
            models: body.models,
            account: body.account || null,
            outputStyle: typeof body.output_style === 'string' ? body.output_style : null,
            availableOutputStyles: Array.isArray(body.available_output_styles) ? body.available_output_styles : [],
            pid: typeof body.pid === 'number' ? body.pid : null,
          };
          hub.emit({ sessionId, type: 'capabilities', sessionId, ...state.initInfo });
        }
        const pending = requestId ? awaitingControl.get(requestId) || state.pendingControl?.get(requestId) : null;
        if (pending) {
          (state.pendingControl || awaitingControl).delete(requestId);
          if (response.subtype === 'success') pending.resolve(response.response);
          else {
            const error = new Error(response.error || `control request failed: ${response.subtype || 'invalid response'}`);
            error.code = response.subtype === 'error' ? 'CCB_CONTROL_REJECTED' : 'CCB_CONTROL_INVALID';
            pending.reject(error);
          }
        }
        return;
      }
      case 'control_request': {
        handleControlRequest(state, frame);
        return;
      }
      case 'system': {
        if (turn?.steers && frame.subtype==='status' && frame.session_id===state.cliSessionId) turn.compacting=frame.status==='compacting';
        if (frame.subtype === 'init') {
          if (CLI_SESSION_ID.test(frame.session_id || '')) {
            if (frame.session_id !== state.cliSessionId) {
              const error = new Error('CCB initialized a different CLI session UUID than the requested conversation');
              state.identityError = error;
              rejectTurn(state, error);
              forceKill(state.child);
              return;
            }
            state.identityConfirmed = true;
          }
          state.initInfo = {
            sessionId: frame.session_id,
            model: frame.model,
            cwd: frame.cwd,
            permissionMode: frame.permissionMode,
            tools: Array.isArray(frame.tools) ? frame.tools : [],
            apiKeySource: frame.apiKeySource,
            version: frame.claude_code_version,
          };
          hub.emit({ sessionId, type: 'init', info: state.initInfo });
          return;
        }
        // api_retry is a SUBTYPE OF system, not a top-level frame type. Putting this branch at
        // the top level (the first attempt) made it dead code: the frames arrived, nothing was
        // recorded, and a 503 outage surfaced only as "turn timed out" — pointing at the kernel
        // instead of at the upstream that was down.
        if (frame.subtype === 'api_retry') {
          state.lastApiRetry = {
            attempt: frame.attempt,
            maxRetries: frame.max_retries,
            errorStatus: frame.error_status,
            error: frame.error,
            retryDelayMs: frame.retry_delay_ms,
            at: Date.now(),
          };
          hub.emit({
            sessionId,
            type: 'upstream_retry',
            attempt: frame.attempt,
            errorStatus: frame.error_status,
            retryDelayMs: frame.retry_delay_ms,
          });
        }
        return;
      }
      case 'assistant': {
        const blocks = (frame.message && Array.isArray(frame.message.content)) ? frame.message.content : [];
        if (turn?.steers && frame.session_id===state.cliSessionId && !frame.parent_tool_use_id) {
          turn.firstOutputAt ??= Date.now();
          for (const block of blocks) if (block?.type==='tool_use' && block.id) turn.tools.add(block.id);
          if (turn.tools.size) turn.steers.flush();
        }
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            hub.emit({ sessionId, type: 'text', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            // Carried, not rendered by the current transcript view.
            hub.emit({ sessionId, type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            hub.emit({ sessionId, type: 'tool_request', id: block.id, name: block.name, input: block.input || {} });
          }
        }
        return;
      }
      case 'user': {
        const blocks = (frame.message && Array.isArray(frame.message.content)) ? frame.message.content : [];
        if (turn?.tools && frame.session_id===state.cliSessionId && !frame.parent_tool_use_id) {
          for (const block of blocks) if (block?.type==='tool_result') turn.tools.delete(block.tool_use_id);
        }
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            const content = flattenContent(block.content);
            const isError = block.is_error === true;
            hub.emit({
              sessionId,
              type: isError ? 'tool_result' : 'tool_result',
              id: block.tool_use_id,
              content,
              isError,
            });
          }
        }
        return;
      }
      case 'result': {
        if (!turn || frame.parent_tool_use_id != null) return;
        const interrupted = state.interrupted;
        state.interrupted = false;
        const isError = frame.is_error === true || frame.subtype === 'error_during_execution';
        const stopReason = interrupted ? 'cancelled'
          : isError ? 'error'
            : (typeof frame.stop_reason === 'string' && frame.stop_reason ? frame.stop_reason : 'end_turn');
        const text = typeof frame.result === 'string' ? frame.result : '';
        const result = { text, stopReason, isError, raw: frame };
        if (options.nativeCycleEvents) {
          turn.primaryResult ??= result;
        }
        else finishTurn(state, turn, result);
        return;
      }
      case 'error': {
        hub.emit({ sessionId, type: 'error', message: String(frame.message || frame.error || 'kernel error') });
        return;
      }
      default:
        return;
    }
  }

  function finishTurn(state, turn, result) {
    if (state.turn !== turn || sessions.get(state.sessionId) !== state) return;
    settleTurn(state, result);
    hub.emit({sessionId: state.sessionId, type: 'done', text: result.text, stopReason: result.stopReason,
      isError: result.isError, durationMs: result.raw.duration_ms, costUsd: result.raw.total_cost_usd});
  }

  function finishIdleCycle(state,turn) {
    if (!turn.cycleOpen && turn.hasTerminal && !turn.steers.busy) finishTurn(state,turn,turn.primaryResult);
  }

  function acceptSteer(sessionId,message,opts) {
    const state=sessions.get(sessionId), turn=state?.turn;
    if (!turn?.steers || !turn.cycleOpen || turn.hasTerminal || turn.primaryResult || turn.interrupted) return false;
    const uuid=turn.inputIds.has(opts.messageUuid) ? randomUUID() : opts.messageUuid;
    const immediate=opts.priority==='now' && !turn.steers.busy && !turn.steers.escalating &&
      !turn.command && !turn.compacting && !/^\s*[/!]/u.test(message) &&
      (!turn.firstOutputAt || Date.now()-turn.startedAt<5000);
    const priority=immediate?'now':'next';
    const frame={type:'user',uuid,session_id:sessionId,parent_tool_use_id:null,priority,timestamp:new Date().toISOString(),
      client_platform:'desktop_app',message:{role:'user',content:userContent(message,opts.images)}};
    const hold=!immediate && !turn.tools.size && !/^\s*[/!]/u.test(message);
    if (!turn.steers.accept(frame,hold)) return false;
    turn.inputIds.add(uuid);
    return true;
  }

  /**
   * An inbound control request.
   *
   * can_use_tool is the permission round trip. It is answered ALWAYS — an
   * unanswered control request stalls the kernel forever, and the turn would
   * then hang with no frame to explain it. When no approval hook is wired the
   * answer is deny, which is the safe direction.
   */
  function handleControlRequest(state, frame) {
    const requestId = frame.request_id;
    const request = frame.request || {};
    if (request.subtype === 'can_use_tool') {
      const approval = {
        toolName: request.tool_name,
        input: request.input || {},
        toolUseId: request.tool_use_id,
        suggestions: request.permission_suggestions,
      };
      // Who owns the "a card is needed" event?
      //
      // The per-turn hook does: it is session-kernel's requestApproval, which mints its own
      // `perm_N` id, records the entry on the session, emits the card event, and waits for
      // respondToToolPermission. If this backend ALSO emitted its own tool_permission_request
      // (the previous behaviour), the renderer saw two events: the first carrying the kernel's
      // own request_id — an id session-kernel knows nothing about — so answering it returned
      // "no such request" and the tool was denied after the user had approved it.
      //
      // Without a hook there is nobody to own it, so say so on the channel: a deny is about to
      // happen and the reason should be visible rather than silent.
      // Never infer bypass from a missing hook or a child init-frame default.
      // Both desired and acknowledged actor mode must reflect the user selection.
      const bypass = state.permissionMode === 'bypassPermissions'
        && state.appliedPermissionMode === 'bypassPermissions';
      const hook = bypass ? () => 'allow' : state.requestApproval || options.canUseTool;
      if (typeof hook !== 'function') {
        hub.emit({
          sessionId: state.sessionId,
          type: 'tool_permission_request',
          request: {
            requestId,
            sessionId: state.sessionId,
            toolName: request.tool_name,
            input: request.input || {},
            toolUseId: request.tool_use_id,
            unavailableReason: 'no approval hook is wired',
          },
        });
      }

      const approvalChild = state.child;
      state.pendingApprovals++;
      let answered = false;
      const answer = (decision, message) => {
        if (answered) return;
        answered = true;
        state.pendingApprovals--;
        state.lastActivityAt = Date.now();
        if (state.child !== approvalChild) return;
        state.protection?.noteActivity(state.actorToken);
        state.protectionVersion = (state.protectionVersion || 0) + 1;
        const response = decision === 'allow'
          ? { behavior: 'allow', updatedInput: request.input || {} }
          : { behavior: 'deny', message: message || 'The user declined this tool call.' };
        writeFrame(state.child, {
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response },
        });
        // Observable resolution, mirroring session-kernel's own approval event.
        hub.emit({ sessionId: state.sessionId, type: 'tool_permission_resolved', requestId, decision });
      };

      if (typeof hook !== 'function') {
        answer('deny', 'No approval hook is wired for this kernel.');
        return;
      }
      Promise.resolve()
        .then(() => hook(approval))
        .then((decision) => {
          if (decision === 'allow' || decision === 'deny') return answer(decision);
          return answer('deny', 'No approval answer was given.');
        })
        .catch((error) => {
          log(`[ccb ${state.sessionId}] approval hook failed: ${error && error.message}`);
          answer('deny', String(error && error.message));
        });
      return;
    }
    // Any other subtype is acknowledged so the kernel never waits on us. The
    // response body is empty because we do not implement those capabilities.
    writeFrame(state.child, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    });
  }

  /** Write a control request and resolve with its response body. */
  function sendControl(state, subtype, request = {}, timeoutMs = 10_000) {
    const requestId = newRequestId(subtype);
    if (!state.pendingControl) state.pendingControl = new Map();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingControl.delete(requestId);
        const error = new Error(`CCB kernel did not answer ${subtype} within ${timeoutMs}ms`);
        error.code = 'CCB_CONTROL_TIMEOUT';
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      state.pendingControl.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const ok = writeFrame(state.child, {
        type: 'control_request',
        request_id: requestId,
        request: { subtype, ...request },
      });
      if (!ok) {
        state.pendingControl.delete(requestId);
        clearTimeout(timer);
        reject(new Error('CCB kernel stdin is not writable'));
      }
    });
  }

  /**
   * Run one turn.
   *
   * Live children retain their own history. After a host restart, the native
   * transcript is resumed with --resume before sending the next user frame;
   * passing history in opts.messages alone does not restore a CLI process.
   */
  function assertOwned(state) {
    if (sessions.get(state.sessionId) !== state) {
      const error = new Error('CCB session was removed');
      error.code = 'CCB_SESSION_REMOVED';
      throw error;
    }
  }

  function enqueue(state, operation) {
    state.operationsPending++;
    const result = state.operationTail.then(() => { assertOwned(state); return operation(); });
    state.operationTail = result.catch(() => {});
    return result.finally(() => { state.operationsPending--; state.lastActivityAt = Date.now(); });
  }

  async function recoverActor(state) {
    if (!state.recoverable) return;
    const old = state.child;
    if (old && !state.childFullyClosed) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CCB previous process did not terminate; recovery refused')), 5000);
        old.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    const transcript = findCliTranscript(state, state.transcriptHint);
    if ((state.hasUserFrame || state.resume) && !transcript) {
      throw new Error('CCB cannot recover the session: no verified native transcript');
    }
    state.homeDir = state.envReport?.applied?.homeDir || state.homeDir;
    state.scratchDir = state.envReport?.applied?.scratchDir || state.scratchDir;
    state.resume = !!transcript;
    state.transcriptHint = transcript;
    state.child = null;
    state.stopping = false;
    state.handshakePending = false;
    state.actorToken = null;
    state.confirmedModel = null;
    state.modelConfirmedOnReady = false;
    state.ready = null;
    state.exited = null;
    state.closed = false;
    state.recoverable = false;
    state.modelKnown = true;
    state.buffer = '';
    state.initInfo = null;
    state.identityError = null;
    state.exitError = null;
  }

  async function applyPermissionMode(state) {
    if (state.appliedPermissionMode === state.permissionMode) return;
    await state.initReady;
    assertOwned(state);
    const actor = state.actorToken;
    const mode = state.permissionMode;
    // A rejected/expired control must stop the turn, not silently run under the
    // previous (potentially broader) permission selection.
    await sendControl(state, 'set_permission_mode', { mode }, options.permissionControlTimeoutMs ?? 10_000);
    assertOwned(state);
    if (actor !== state.actorToken) throw new Error('CCB actor changed while applying permissionMode');
    state.appliedPermissionMode = mode;
  }

  async function applyModel(state, model, sequence = state.modelSequence) {
    if (typeof model !== 'string' || !model.trim()) throw new Error('CCB model must be a non-empty string');
    model = model.trim();
    await recoverActor(state);
    assertOwned(state);
    if (state.closed) throw state.exitError || new Error('CCB kernel process has exited; the session must be restarted');
    if (state.child && (state.confirmedModel !== model || !state.modelKnown)) {
      await state.ready;
      assertOwned(state);
      const child = state.child;
      const actorToken = state.actorToken;
      const confirmedModel = state.confirmedModel;
      try {
        await sendControl(state, 'set_model', { model }, options.modelControlTimeoutMs ?? 10_000);
      } catch (error) {
        error.actorToken = actorToken;
        error.confirmedModel = confirmedModel;
        if (state.child === child && error.code !== 'CCB_CONTROL_REJECTED') {
          state.modelKnown = false;
          state.closed = true;
          state.recoverable = true;
          forceKill(child);
        }
        throw error;
      }
      assertOwned(state);
      if (state.child !== child) return;
    }
    state.confirmedModel = model;
    if (state.modelSequence === sequence) state.model = model;
    state.modelKnown = true;
  }

  function setModel(sessionId, model) {
    if (disposed) return Promise.reject(new Error('kernel backend has been disposed'));
    if (typeof model !== 'string' || !model.trim()) return Promise.reject(new Error('CCB model must be a non-empty string'));
    model = model.trim();
    const state = stateFor(sessionId);
    const sequence = ++state.modelSequence;
    state.hasModelSelection = true;
    if (state.turn) {
      state.model = model;
      const child = state.child;
      return enqueue(state, () => applyModel(state, model, sequence)).catch(error => {
        if (state.child === child && state.modelSequence === sequence && error.code === 'CCB_CONTROL_REJECTED' && state.confirmedModel) {
          state.model = state.confirmedModel;
        }
        throw error;
      });
    }
    return enqueue(state, () => applyModel(state, model, sequence));
  }

  function sendMessage(sessionId, message, opts = {}) {
    if (disposed) return Promise.reject(new Error('kernel backend has been disposed'));
    const state = stateFor(sessionId);
    if (state.turnQueued) return Promise.reject(new Error('a turn is already running for this session'));
    state.turnQueued = true;
    return enqueue(state, () => sendMessageNow(state, message, opts))
      .then(started => started.result)
      .finally(() => { state.turnQueued = false; });
  }

  async function sendMessageNow(state, message, opts = {}) {
    const sessionId = state.sessionId;
    if (disposed) throw new Error('kernel backend has been disposed');
    if (opts.signal?.aborted) throw new Error('CCB turn was cancelled before it started');
    const requestContext = typeof options.requestContext === 'function' ? options.requestContext(message) : '';
    const content = userContent(requestContext ? `${requestContext}\n\n${message}` : message, opts.images);
    const messageUuid = typeof opts.messageUuid === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.messageUuid)
      ? opts.messageUuid : randomUUID();
    if (state.turn) throw new Error('a turn is already running for this session');
    await recoverActor(state);
    assertOwned(state);
    if (state.closed) throw state.exitError || new Error('CCB kernel process has exited; the session must be restarted');
    configureSession(state, state.hasModelSelection ? { ...opts, model: state.model } : opts);
    const coldStart = !state.child || !!state.exited;
    if (coldStart) hub.emit({ type: 'initialization_status', sessionId,
      initializationStatus: { step: 'starting', isComplete: false } });
    await ensureProcess(state, { reason: 'user', signal: opts.signal });
    assertOwned(state);
    await applyPermissionMode(state);
    if (state.hasModelSelection && state.model) await applyModel(state, state.model);
    else if (typeof opts.model === 'string' && opts.model.trim()) await applyModel(state, opts.model);
    else if (!state.modelKnown && state.model) await applyModel(state, state.model);
    if (opts.effortLevel == null && state.effortActor === state.actorToken && state.appliedEffort != null) {
      // apply_flag_settings treats null as deletion of an inline flag. Omitting
      // the field would retain the previous model's effort in the live child.
      await sendControl(state, 'apply_flag_settings', { settings: { effortLevel: null } }, options.modelControlTimeoutMs ?? 10_000);
      assertOwned(state);
      state.appliedEffort = null;
    }
    if (opts.effortLevel != null) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effortLevel)) throw new Error('Invalid CCB effortLevel');
      // The settings control updates effort without changing tool permissions.
      // Tie the acknowledgement to the actor: a recovered process must reapply it.
      if (state.effortActor !== state.actorToken || state.appliedEffort !== opts.effortLevel) {
        await sendControl(state, 'apply_flag_settings', { settings: { effortLevel: opts.effortLevel } }, options.modelControlTimeoutMs ?? 10_000);
        assertOwned(state);
        state.effortActor = state.actorToken;
        state.appliedEffort = opts.effortLevel;
      }
    }
    assertOwned(state);
    if (state.exited && !state.childFullyClosed) await new Promise(resolve => state.child.once('close', resolve));
    if (state.closed) throw state.exitError || new Error('CCB kernel process has exited; the session must be restarted');
    if (state.identityError) throw state.identityError;
    if (opts.signal?.aborted) throw new Error('CCB turn was cancelled before it started');

    const turn = { settled: false, timer: null, graceTimer: null, interrupted: false, actorToken: state.actorToken, cycleOpen: false };
    turn.promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    state.turn = turn;
    // A spawned process is not yet an initialized kernel. Announce the boundary
    // from its actual handshake, so a slow provider is not labelled startup.
    const startupActor = state.actorToken;
    const announceModelWait = () => {
      if (disposed || sessions.get(sessionId) !== state || state.turn !== turn || turn.settled ||
          state.actorToken !== startupActor || state.exited || opts.signal?.aborted) return;
      if (coldStart) hub.emit({ type: 'initialization_status', sessionId,
        initializationStatus: { step: 'starting', isComplete: true } });
      hub.emit({ type: 'initialization_status', sessionId,
        initializationStatus: { step: 'model_request', isComplete: false } });
    };
    Promise.resolve(state.initReady).then(announceModelWait, () => {});
    if (options.nativeCycleEvents) {
      turn.tools = new Set();
      turn.inputIds = new Set([messageUuid]);
      turn.command = /^\s*[/!]/u.test(message);
      turn.startedAt = Date.now();
      const owned=()=>!disposed && sessions.get(sessionId)===state && state.turn===turn &&
        state.actorToken===turn.actorToken && !state.closed && !turn.interrupted && !opts.signal?.aborted &&
        (!opts.ownsSteering || opts.ownsSteering());
      turn.steers=require('./ccb-steer-queue.cjs').createSteerQueue({owned,
        canWrite:()=>turn.cycleOpen && !turn.hasTerminal,
        write:frame=>{
          if (!state.child.stdin.writable || state.child.stdin.destroyed || !writeFrame(state.child,frame)) return false;
          state.writtenInputIds.add(frame.uuid);
          return true;
        },
        cancel:uuid=>sendControl(state,'cancel_async_message',{message_uuid:uuid},options.steerControlTimeoutMs ?? 10000),
        announce:event=>{
          if(event.type==='steers_rekeyed')turn.inputIds.add(event.rekeyedSteers[0].to);
          hub.emit({...event,sessionId,actorToken:turn.actorToken});
        },
        changed:()=>finishIdleCycle(state,turn),
      });
    }
    state.protection?.update(state.actorToken, { pendingCycle: true });
    state.protection?.noteActivity(state.actorToken);
    state.interrupted = false;
    // The approval hook arrives PER TURN, from session-kernel, which is the component that
    // knows how to render a card in the app. Reading it at construction time instead (the
    // previous behaviour) meant session-kernel's hook was never consulted: every tool silently
    // fell through to "No approval hook is wired for this kernel" and was denied. A per-turn
    // hook is the right shape anyway — a test or a headless host swaps it without rebuilding
    // the backend.
    state.requestApproval = typeof opts.requestApproval === 'function' ? opts.requestApproval : null;

    // A turn that never reports must not hold the session forever.
    if (turnTimeoutMs > 0) {
      turn.timer = setTimeout(() => {
        if (turn.settled) return;
        state.interrupted = true;
        try { sendControl(state, 'interrupt').catch(() => {}); } catch { /* best effort */ }
        // Say WHY. A bare "timed out" sends the reader to the kernel, but the kernel was
        // healthy — it was waiting on an upstream that kept returning 503. Naming the last
        // retry turns a mystery into an actionable message.
        const retry = state.lastApiRetry;
        const because = retry && Date.now() - retry.at < turnTimeoutMs
          ? ` (upstream ${retry.errorStatus || retry.error || 'error'}, retry ${retry.attempt}/${retry.maxRetries})`
          : '';
        state.closed = true;
        state.recoverable = true;
        forceKill(state.child);
        rejectTurn(state, new Error(`CCB kernel turn timed out after ${turnTimeoutMs}ms${because}`));
      }, turnTimeoutMs);
      if (typeof turn.timer.unref === 'function') turn.timer.unref();
    }

    // An abort from the session kernel's cancel path is the same as our cancel().
    if (opts.signal) {
      const onAbort = () => cancel(sessionId);
      if (opts.signal.aborted) onAbort();
      else if (typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', onAbort, { once: true });
        turn.signal = opts.signal;
        turn.onAbort = onAbort;
      }
    }

    const frame = {
      type: 'user',
      uuid: messageUuid,
      parent_tool_use_id: null,
      session_id: sessionId,
      message: { role: 'user', content },
    };
    const registerReplay = options.replayUserMessages === true && !state.replayInputs.has(messageUuid) && state.replayInputs.size < 2048;
    if (registerReplay) {
      state.replayInputs.set(messageUuid, false);
    }
    if (!writeFrame(state.child, frame)) {
      if (registerReplay) state.replayInputs.delete(messageUuid);
      rejectTurn(state, new Error('CCB kernel stdin is not writable'));
    } else {
      state.hasUserFrame = true;
      state.writtenInputIds?.add(messageUuid);
    }

    const result = turn.promise.then(value => normaliseTurnResult({ text: value.text, stopReason: value.stopReason }))
      .finally(() => {
        if (turn.timer) clearTimeout(turn.timer);
        if (turn.signal && turn.onAbort && typeof turn.signal.removeEventListener === 'function') {
          turn.signal.removeEventListener('abort', turn.onAbort);
        }
      });
    return { result };
  }

  /**
   * Interrupt the turn in flight.
   *
   * Returns { ok: false } when nothing is running, which makes a second cancel
   * a no-op — the session kernel calls cancel from several places (stop button,
   * window close, remove) and every one of them after the first must be inert.
   *
   * Measured: the kernel answers control_response immediately and then emits
   * result/error_during_execution for the interrupted turn, so the turn settles
   * on its own. If it does not, the accumulator is returned as 'cancelled' after
   * `interruptGraceMs` so the UI is not left spinning; the process is kept.
   */
  function removeSession(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return { ok: false };
    state.replayInputs?.clear();
    sessions.delete(sessionId);
    const error = new Error('CCB session was removed');
    error.code = 'CCB_SESSION_REMOVED';
    for (const pending of state.pendingControl?.values() || []) pending.reject(error);
    state.pendingControl?.clear();
    if (state.turn) rejectTurn(state, error);
    state.closed = true;
    if (state.child) forceKill(state.child);
    return { ok: true };
  }

  function cancel(sessionId) {
    const state = sessions.get(sessionId);
    if (disposed) return { ok: false, reason: 'disposed' };
    if (!state || !state.turn || !state.child) return { ok: false, reason: 'no running turn' };
    const turn = state.turn;
    if (turn.interrupted) return { ok: false, reason: 'already interrupted' };
    turn.interrupted = true;
    state.interrupted = true;
    try {
      sendControl(state, 'interrupt').catch((error) => log(`[ccb ${sessionId}] interrupt failed: ${error && error.message}`));
    } catch (error) {
      log(`[ccb ${sessionId}] interrupt write failed: ${error && error.message}`);
    }
    if (interruptGraceMs > 0 && !turn.graceTimer) {
      turn.graceTimer = setTimeout(() => {
        if (turn.settled || state.turn !== turn) return;
        log(`[ccb ${sessionId}] kernel did not settle the interrupted turn; settling as cancelled`);
        state.closed = true;
        state.recoverable = true;
        forceKill(state.child);
        state.turn = null;
        turn.steers?.dispose();
        state.protection?.update(state.actorToken, { pendingCycle: false });
        turn.settled = true;
        if (turn.timer) clearTimeout(turn.timer);
        turn.resolve({ text: '', stopReason: 'cancelled', isError: false });
      }, interruptGraceMs);
      if (typeof turn.graceTimer.unref === 'function') turn.graceTimer.unref();
    }
    return { ok: true };
  }

  function onEvent(callback) {
    return hub.onEvent(callback);
  }

  /** Everything the handshake told us, for diagnostics and the UI. */
  function getInfo(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return null;
    const model = state.child && !state.exited && state.modelKnown && state.modelConfirmedOnReady ? state.confirmedModel : null;
    const contextWindow = model && state.contextWindows?.get(model);
    return {
      ...(contextWindow ? { contextCapacity: { actorToken: state.actorToken, model, contextWindow } } : {}),
      init: state.initInfo,
      cwd: state.cwd,
      exited: state.exited,
      pid: state.child?.pid ?? null,
      actorToken: state.child && !state.exited ? state.actorToken : null,
      confirmedModel: state.child && !state.exited && state.modelKnown && state.modelConfirmedOnReady ? state.confirmedModel : null,
      // What the environment fix actually did, and what it could not do. The UI
      // and the probes read this instead of guessing why a shell failed.
      env: state.envReport,
      persistence: {
        cliSessionId: state.cliSessionId,
        cwd: state.cwd,
        homeDir: state.envReport?.applied?.homeDir || state.homeDir,
        scratchDir: state.envReport?.applied?.scratchDir || state.scratchDir,
        transcriptPath: state.identityConfirmed ? findCliTranscript(state, state.transcriptHint) : null,
      },
    };
  }

  // Internal process inventory: physical live children, including idle children
  // whose desktop rows have been removed. This is not an IPC session count.
  function getActiveProcesses() {
    return [...liveChildren].filter(child => Number.isInteger(child.pid) && child.pid > 0)
      .map(child => {
        const state = childStates.get(child);
        const owned = sessions.get(state.sessionId) === state && state.child === child && !state.exited;
        return { sessionId: state.sessionId, pid: child.pid, actorToken: state.child === child ? state.actorToken : null,
        protection: owned ? getProtectionState(state.sessionId) : null, initialized: owned && !!state.initInfo,
        hasPendingTurn: !!state.turn || state.turnQueued, pendingControls: state.pendingControl?.size || 0,
        pendingApprovals: state.pendingApprovals, lastActivityAt: state.lastActivityAt,
        idleEligible: owned && isEvictable(state) };
      });
  }

  function isEvictable(state) {
    return !!state.child && !state.closed && !state.exited && !state.starting && !state.stopping
      && !!state.initInfo && !state.handshakePending && !state.turn && !state.turnQueued && !state.operationsPending
      && !(state.pendingControl?.size) && !state.pendingApprovals;
  }

  function collectSessionLoops(sessionId) {
    const state = sessions.get(sessionId);
    if (!state?.child || state.exited) return undefined;
    const before = state.protection?.getCronRevision(state.actorToken);
    const rows = state.protection?.collectSessionLoops(state.actorToken);
    if (state.protection?.getCronRevision(state.actorToken) !== before) state.protectionVersion++;
    return rows;
  }

  function getProtectionState(sessionId) {
    const state = sessions.get(sessionId);
    if (!state?.child || state.exited) return null;
    const before = state.protection?.getCronRevision(state.actorToken);
    const snapshot = state.protection?.snapshot(state.actorToken);
    if (state.protection?.getCronRevision(state.actorToken) !== before) state.protectionVersion++;
    if (!snapshot) return null;
    return { ...snapshot, version: state.protectionVersion, actorToken: state.actorToken,
      nativeFlags: snapshot.flags,
      flags: { ...snapshot.flags,
        agentRun: snapshot.flags.agentRun || !!state.turn || !!state.turnQueued,
        stopping: snapshot.flags.stopping || !!state.stopping,
        backgroundTasks: snapshot.flags.backgroundTasks || snapshot.observedTasks > 0,
      } };
  }

  async function evictSession(sessionId, expected = {}) {
    const state = sessions.get(sessionId);
    const pauseReason = expected.reason || 'idle_timeout';
    if (!['idle_timeout','governor_evict'].includes(pauseReason)) return {ok: false, reason: 'unsupported-pause-reason'};
    if (!state || !isEvictable(state)) return { ok: false, reason: 'not-idle' };
    const child = state.child;
    // A used actor must be restartable before ending it. Preserve the native log.
    const transcript = findCliTranscript(state, state.transcriptHint);
    if ((state.hasUserFrame || state.resume) && !transcript) return { ok: false, reason: 'no-verified-transcript' };
    // Keep the host's synchronous qualification check adjacent to the commit.
    // It may reenter the backend; inspect actor and protection again afterwards.
    if (expected.validate !== undefined && (typeof expected.validate !== 'function' || expected.validate() !== true)) return { ok: false, reason: 'stale-candidate' };
    if (sessions.get(sessionId) !== state || state.child !== child || !isEvictable(state)) return { ok: false, reason: 'not-idle' };
    const protection = getProtectionState(sessionId);
    if (!protection || Object.values(protection.flags).some(Boolean)) return { ok: false, reason: 'protected' };
    if ((expected.pid !== undefined && expected.pid !== child.pid) ||
        (expected.actorToken !== undefined && expected.actorToken !== state.actorToken) ||
        (expected.protectionVersion !== undefined && expected.protectionVersion !== protection.version)) return { ok: false, reason: 'stale-candidate' };
    state.stopping = true;
    state.processGoneReason = pauseReason;
    state.recoverable = true;
    state.transcriptHint = transcript;
    try {
      await new Promise((resolve, reject) => {
        let done = false;
        let deadline;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(deadline); resolve(); };
        const timer = setTimeout(() => {
          forceKill(child);
          // Never claim successful eviction until the OS reports close.
          deadline = setTimeout(() => { if (!done) { done = true; reject(new Error('CCB process did not close after eviction')); } }, disposeTimeoutMs);
          if (typeof deadline.unref === 'function') deadline.unref();
        }, disposeTimeoutMs);
        child.once('close', finish);
        try { child.stdin.end(); } catch { forceKill(child); }
      });
      if (sessions.get(sessionId) === state && state.child === child) hub.emit({type: 'actor_paused', sessionId, actorToken: null, reason: pauseReason});
      return { ok: true, pid: child.pid };
    } finally { if (state.child === child) state.stopping = false; }
  }

  async function warm(sessionId, opts = {}) {
    if (disposed) throw new Error('kernel backend has been disposed');
    const state = stateFor(sessionId);
    return enqueue(state, async () => {
      await recoverActor(state);
      assertOwned(state);
      configureSession(state, opts);
      await ensureProcess(state, { reason: opts.reason || 'warm', signal: opts.signal });
      assertOwned(state);
      return state.initReady;
    });
  }

  /**
   * The model list the kernel advertised, shaped for the settings UI.
   *
   * Empty rather than invented when the handshake has not happened yet: a picker showing one
   * hard-coded model is worse than a picker that says "starting", because the first looks
   * like data and is not. Every value here comes from the kernel itself.
   */
  function listModels(sessionId) {
    const state = sessions.get(sessionId);
    const models = state && state.initInfo && Array.isArray(state.initInfo.models)
      ? state.initInfo.models
      : [];
    return models.map((model) => ({
      id: typeof model.value === 'string' && model.value ? model.value : model.name,
      name: typeof model.displayName === 'string' && model.displayName ? model.displayName : model.name,
      description: typeof model.description === 'string' ? model.description : '',
      supportsEffort: model.supportsEffort === true,
      effortLevels: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.slice() : [],
      supportsFastMode: model.supportsFastMode === true,
      supportsAutoMode: model.supportsAutoMode === true,
    })).filter((model) => typeof model.id === 'string' && model.id);
  }

  /** Send the initialize handshake explicitly and resolve with its body. */
  async function initialize(sessionId) {
    const state = stateFor(sessionId);
    return enqueue(state, async () => {
      await ensureProcess(state);
      return state.initReady;
    });
  }

  // These controls operate only on an existing, explicitly identified actor.
  // They do not spawn or resume a session, and are not permission decisions.
  async function actorMcpControl(sessionId, actorToken, subtype, request, timeoutMs = options.mcpControlTimeoutMs ?? 30_000) {
    const state = sessions.get(sessionId);
    const stale = () => {
      const error = new Error('CCB MCP actor is no longer current');
      error.code = 'CCB_ACTOR_STALE';
      return error;
    };
    const current = () => !disposed && state && sessions.get(sessionId) === state &&
      typeof actorToken === 'string' && actorToken.length > 0 && state.actorToken === actorToken &&
      state.child && !state.closed && !state.exited;
    if (!current()) throw stale();
    const child = state.child;
    await state.initReady;
    if (!current() || state.child !== child) throw stale();
    const response = await sendControl(state, subtype, request, timeoutMs);
    if (!current() || state.child !== child) throw stale();
    return response;
  }

  // Return aggregate fields and the inspector's identifier/count rows only.
  // SDK prompt contents, credentials and unrelated fields stay inside the actor.
  async function getContextUsage(sessionId, actorToken) {
    let body;
    try {
      body = await actorMcpControl(sessionId, actorToken, 'get_context_usage', {}, options.contextControlTimeoutMs ?? 10_000);
    } catch (cause) {
      const known = new Set(['CCB_ACTOR_STALE', 'CCB_CONTROL_TIMEOUT', 'CCB_CONTROL_EXIT', 'CCB_SESSION_REMOVED', 'CCB_KERNEL_DISPOSED', 'CCB_CONTROL_REJECTED', 'CCB_CONTROL_INVALID']);
      const error = new Error('CCB context usage request failed');
      error.code = known.has(cause?.code) ? cause.code : 'CCB_CONTEXT_FAILED';
      throw error;
    }
    const invalid = () => Object.assign(new Error('CCB returned invalid context usage'), { code: 'CCB_CONTROL_INVALID' });
    const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!body || typeof body !== 'object' || !Array.isArray(body.categories) ||
        !numeric(body.totalTokens) || !numeric(body.maxTokens) || !numeric(body.rawMaxTokens) || !numeric(body.percentage)) throw invalid();
    const names = new Set(['System prompt', 'System tools', '[ANT-ONLY] System tools', 'MCP tools', 'MCP tools (deferred)', 'System tools (deferred)', 'Custom agents', 'Memory files', 'Skills', 'Messages', 'Autocompact buffer', 'Compact buffer', 'Free space']);
    const colors = new Set(['promptBorder', 'inactive', 'cyan_FOR_SUBAGENTS_ONLY', 'permission', 'claude', 'warning', 'purple_FOR_SUBAGENTS_ONLY']);
    const categories = body.categories.map(category => {
      if (!category || typeof category.name !== 'string' || !numeric(category.tokens) || typeof category.color !== 'string' ||
          (category.isDeferred !== undefined && typeof category.isDeferred !== 'boolean')) throw invalid();
      return { name: names.has(category.name) ? category.name : 'Other', tokens: category.tokens,
        color: colors.has(category.color) ? category.color : 'inactive',
        ...(category.isDeferred === undefined ? {} : { isDeferred: category.isDeferred }) };
    });
    const rows = (value, keys) => Array.isArray(value) ? value.filter(row =>
      row && numeric(row.tokens) && keys.every(key => typeof row[key] === 'string' && row[key].length > 0)
    ).map(row => Object.fromEntries([...keys.map(key => [key, row[key]]), ['tokens', row.tokens]])) : [];
    return { actorToken, categories, totalTokens: body.totalTokens, maxTokens: body.maxTokens,
      mcpTools: rows(body.mcpTools, ['name', 'serverName']),
      memoryFiles: rows(body.memoryFiles, ['path']), agents: rows(body.agents, ['agentType']),
      rawMaxTokens: body.rawMaxTokens, percentage: body.percentage,
      ...(numeric(body.autoCompactThreshold) ? { autoCompactThreshold: body.autoCompactThreshold } : {}),
      ...(typeof body.isAutoCompactEnabled === 'boolean' ? { isAutoCompactEnabled: body.isAutoCompactEnabled } : {}) };
  }

  async function mcpServerStatus(sessionId, actorToken) {
    const response = await actorMcpControl(sessionId, actorToken, 'mcp_status', {});
    if (!response || !Array.isArray(response.mcpServers)) {
      const error = new Error('CCB returned an invalid MCP status response');
      error.code = 'CCB_CONTROL_INVALID';
      throw error;
    }
    return { actorToken, servers: response.mcpServers };
  }

  async function reconnectMcpServer(sessionId, actorToken, serverName) {
    if (typeof serverName !== 'string' || !serverName) throw new TypeError('MCP server name must be a non-empty string');
    await actorMcpControl(sessionId, actorToken, 'mcp_reconnect', { serverName });
    return { actorToken };
  }

  async function toggleMcpServer(sessionId, actorToken, serverName, enabled) {
    if (typeof serverName !== 'string' || !serverName || typeof enabled !== 'boolean') throw new TypeError('MCP server name and boolean enabled are required');
    await actorMcpControl(sessionId, actorToken, 'mcp_toggle', { serverName, enabled });
    return { actorToken };
  }

  // Flow handles are local capabilities tied to a particular actor and server.
  // They do not verify the server URL or confer permission to open a browser.
  function oauthFlows(state) {
    if (!state.mcpOAuthFlows) state.mcpOAuthFlows = new Map();
    return state.mcpOAuthFlows;
  }

  function oauthInvalid() {
    const error = new Error('CCB MCP OAuth flow is no longer current');
    error.code = 'CCB_MCP_OAUTH_STALE';
    return error;
  }

  async function authenticateMcpServer(sessionId, actorToken, serverName) {
    if (typeof serverName !== 'string' || !serverName) throw new TypeError('MCP server name must be a non-empty string');
    const state = sessions.get(sessionId);
    if (!state || state.actorToken !== actorToken) throw oauthInvalid();
    const flows = oauthFlows(state);
    const flow = { id: randomUUID(), actorToken, expiresAt: Date.now() + (options.mcpOAuthFlowTimeoutMs ?? 300_000) };
    flows.set(serverName, flow);
    try {
      const response = await actorMcpControl(sessionId, actorToken, 'mcp_authenticate', { serverName });
      if (flows.get(serverName) !== flow || Date.now() >= flow.expiresAt) throw oauthInvalid();
      if (!response || typeof response.requiresUserAction !== 'boolean' ||
          (response.requiresUserAction && (typeof response.authUrl !== 'string' || !response.authUrl))) {
        const error = new Error('CCB returned an invalid MCP OAuth response');
        error.code = 'CCB_CONTROL_INVALID';
        throw error;
      }
      if (!response.requiresUserAction) {
        flows.delete(serverName);
        return { actorToken, requiresUserAction: false };
      }
      return { actorToken, flowId: flow.id, requiresUserAction: true, authUrl: response.authUrl };
    } catch (error) {
      if (flows.get(serverName) === flow) flows.delete(serverName);
      throw error;
    }
  }

  async function submitMcpOAuthCallback(sessionId, actorToken, serverName, flowId, callbackUrl) {
    if (typeof serverName !== 'string' || !serverName || typeof flowId !== 'string' || !flowId ||
        typeof callbackUrl !== 'string' || !callbackUrl) throw new TypeError('MCP server name, flow ID and callback URL are required');
    const state = sessions.get(sessionId);
    const flows = state && oauthFlows(state);
    const flow = flows && flows.get(serverName);
    if (!flow || flow.consumed || flow.id !== flowId || flow.actorToken !== actorToken || Date.now() >= flow.expiresAt) throw oauthInvalid();
    if (flow.clearing) { const error = new Error('CCB MCP OAuth clear is in progress'); error.code = 'CCB_MCP_OAUTH_BUSY'; throw error; }
    // Consume before dispatch so retries or concurrent callbacks cannot reuse it.
    flow.consumed = true;
    try {
      await actorMcpControl(sessionId, actorToken, 'mcp_oauth_callback_url', { serverName, callbackUrl });
      if (flows.get(serverName) !== flow || Date.now() >= flow.expiresAt) throw oauthInvalid();
      return { actorToken };
    } finally {
      if (flows.get(serverName) === flow) flows.delete(serverName);
    }
  }

  async function clearMcpAuth(sessionId, actorToken, serverName) {
    if (typeof serverName !== 'string' || !serverName) throw new TypeError('MCP server name must be a non-empty string');
    const state = sessions.get(sessionId);
    if (!state || state.actorToken !== actorToken) throw oauthInvalid();
    const flows = oauthFlows(state), flow = flows.get(serverName);
    const clears = state.mcpOAuthClears ??= new Map();
    if (clears.has(serverName)) { const error = new Error('CCB MCP OAuth clear is in progress'); error.code = 'CCB_MCP_OAUTH_BUSY'; throw error; }
    const operation = {}; clears.set(serverName, operation);
    if (flow) flow.clearing = true;
    let rejected = false;
    try {
      await actorMcpControl(sessionId, actorToken, 'mcp_clear_auth', { serverName });
      return { actorToken };
    } catch (error) {
      rejected = error?.code === 'CCB_CONTROL_REJECTED';
      throw error;
    } finally {
      if (clears.get(serverName) === operation) clears.delete(serverName);
      const current = !disposed && sessions.get(sessionId) === state && state.actorToken === actorToken && state.child && !state.closed && !state.exited;
      if (!rejected || !current) {
        // A successful or uncertain clear may have affected any same-actor
        // replacement started concurrently, so no local handle remains usable.
        flows.delete(serverName);
      } else if (flow && flows.get(serverName) === flow) {
        if (!flow.consumed && Date.now() < flow.expiresAt) flow.clearing = false;
        else flows.delete(serverName);
      }
    }
  }

  async function readMcpResource(sessionId, actorToken, serverName, uri) {
    if (typeof serverName !== 'string' || !serverName || typeof uri !== 'string' || !uri) {
      throw new TypeError('MCP server name and resource URI must be non-empty strings');
    }
    const response = await actorMcpControl(sessionId, actorToken, 'mcp_read_resource', { serverName, uri });
    const valid = item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.uri === 'string' &&
      ['mimeType', 'text', 'blob'].every(field => item[field] === undefined || typeof item[field] === 'string') &&
      (item._meta === undefined || (item._meta !== null && typeof item._meta === 'object' && !Array.isArray(item._meta)));
    if (!response || !Array.isArray(response.contents) || !response.contents.every(valid)) {
      const error = new Error('CCB returned an invalid MCP resource response');
      error.code = 'CCB_CONTROL_INVALID';
      throw error;
    }
    return { actorToken, contents: response.contents };
  }

  /**
   * End stdin, wait for the process to go, and kill it if it will not.
   *
   * On Windows a killed process may still have descendants, so the escalation of
   * last resort is `taskkill /T /F` — the whole point is that quitting the app
   * never leaves a bun.exe behind.
   */
  function dispose() {
    if (disposeComplete) return Promise.resolve({ ok: true, alreadyDisposed: true, sessions: 0 });
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = disposeChildren().catch((error) => {
      disposePromise = null;
      throw error;
    });
    return disposePromise;
  }

  async function disposeChildren() {
    const states = [...sessions.values()];
    for (const state of states) {
      for (const [id, pending] of state.pendingControl || []) {
        if (!id.startsWith('get_context_usage-')) continue;
        state.pendingControl.delete(id);
        pending.reject(Object.assign(new Error('CCB kernel disposed'), { code: 'CCB_KERNEL_DISPOSED' }));
      }
      state.replayInputs?.clear();
      if (state.turn) rejectTurn(state, new Error('kernel backend was disposed during the turn'));
    }
    // The session table can already have lost ownership while a child still lives.
    await Promise.all([...liveChildren].map((child) => new Promise((resolve, reject) => {
      if (!liveChildren.has(child)) { resolve(); return; }
      let timer;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener('exit', finish);
        child.removeListener('close', finish);
        resolve();
      };
      // exit precedes pipe drain. Match liveChildren/onExit ownership, which
      // is released on close, before reporting disposal complete.
      child.once('close', finish);
      timer = setTimeout(() => {
        forceKill(child);
        if (done) return;
        timer = setTimeout(() => {
          if (done) return;
          done = true;
          child.removeListener('exit', finish);
          child.removeListener('close', finish);
          reject(new Error('CCB process did not exit after dispose force kill'));
        }, disposeTimeoutMs);
      }, disposeTimeoutMs);
      try { child.stdin.end(); } catch { /* escalation handles a closed pipe */ }
    })));
    sessions.clear();
    awaitingControl.clear();
    process.removeListener('exit', reapOnExit);
    detachProtectionClock();
    hub.clear();
    disposeComplete = true;
    return { ok: true, sessions: states.length };
  }

  function forceKill(child) {
    try {
      if (platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      }
      child.kill('SIGKILL');
    } catch (error) {
      log(`[ccb] force kill failed: ${error && error.message}`);
    }
  }

  function start(opts = {}) {
    if (disposed) throw new Error('kernel backend has been disposed');
    const sessionId = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
    if (!sessionId) {
      return { id: KERNEL_ID, sessionId: null, startedAt: Date.now() };
    }
    const state = stateFor(sessionId);
    configureSession(state, opts);
    // Spawn eagerly: the first frame takes seconds, and the session kernel's
    // start() is where the UI shows "kernel starting". A spawn failure is
    // reported through an event rather than thrown, because the session record
    // already exists by then.
    ensureProcess(state).catch((error) => {
      log(`[ccb ${sessionId}] start failed: ${error && error.message}`);
      hub.emit({ sessionId, type: 'error', message: String(error && error.message) });
    });
    return { id: KERNEL_ID, sessionId, startedAt: Date.now() };
  }

  const backend = {
    id: KERNEL_ID,
    start,
    sendMessage,
    ...(options.nativeCycleEvents ? {
      acceptSteer,
      getSteerUuids:id=>sessions.get(id)?.turn?.steers?.uuids ?? [],
      hasWrittenInputUuid:(id,uuid)=>sessions.get(id)?.writtenInputIds?.has(uuid) ?? false,
      sendSteeredNow:(id,uuid)=>sessions.get(id)?.turn?.steers?.escalate(uuid) ?? false,
      withdrawSteer:(id,uuid)=>sessions.get(id)?.turn?.steers?.withdraw(uuid) ?? false,
      // Turn-boundary hand-back for a stop: entries still held on this side are
      // released back to the host BEFORE the turn is aborted or interrupted, so
      // they survive the stop instead of vanishing with the turn. Written entries
      // are excluded by atBoundary() itself, so nothing already handed to the CLI
      // can be sent twice through this path.
      parkHeldSteers:id=>sessions.get(id)?.turn?.steers?.atBoundary(),
    } : {}),
    setModel,
    cancel,
    onEvent,
    dispose,
    removeSession,
    initialize,
    getContextUsage,
    mcpServerStatus,
    reconnectMcpServer,
    toggleMcpServer,
    authenticateMcpServer,
    submitMcpOAuthCallback,
    clearMcpAuth,
    readMcpResource,
    getInfo,
    getActiveProcesses,
    getProtectionState,
    collectSessionLoops,
    evictSession,
    warm,
    listModels,
    paths,
    // This backend emits its own `error` events when a turn fails (rejectTurn does), so the
    // session kernel must not emit a second one for the same failure.
    reportsTurnErrors: () => true,
  };

  return assertKernelBackend(backend);
}

module.exports = {
  createCcbKernel,
  resolveCcbPaths,
  defaultBunPath,
  defaultKernelRoot,
  defaultProjectRoot,
  referenceKernelRoot,
  KERNEL_ID,
  BASE_FLAGS,
  flattenContent,
};
