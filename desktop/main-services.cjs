// Desktop services bound onto the EIPC bus.
//
// These implement the claude.internal.ui / claude.web services that the
// reconstructed preload calls. Each service delegates to a real local facility
// (Electron window API, fs, git, the session store) instead of returning
// fabricated data; anything the reconstruction cannot establish is reported as
// unavailable rather than simulated.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { dialog, app } = require('electron');
const { VIEW } = require('./eipc-bus.cjs');
const { runCommand, parseCommand, checkAvailability } = require('./local-exec.cjs');
const fileTools = require('./file-tools.cjs');
const { MODES, ACTIONS, VALID_MODES, DECISIONS, decide, classify } = require('./permissions.cjs');
const { McpHost } = require('./mcp-host.cjs');
const { listTree, listDirectory } = require('./workspace-tree.cjs');
const { SessionArchive, shouldResume, resumeEnvironment } = require('./session-archive.cjs');

const GIT_TIMEOUT_MS = 3000;

// Runs git in a caller-supplied directory. Any failure is reported as "not a
// repository" because that is what a non-repo directory looks like from git's
// own exit status; the distinction between "no git binary" and "no repo" is
// kept in `reason` so callers can tell them apart.
function inspectGitRepo(folderPath, exec = execFile) {
  return new Promise(resolve => {
    if (typeof folderPath !== 'string' || !folderPath || !fs.existsSync(folderPath)) {
      return resolve({ isGitRepo: false, branch: null, statusClean: null, reason: 'missing-path' });
    }
    exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folderPath, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        const reason = error.code === 'ENOENT' ? 'git-unavailable' : 'not-a-repository';
        return resolve({ isGitRepo: false, branch: null, statusClean: null, reason });
      }
      const branch = stdout.trim() || 'HEAD';
      exec('git', ['status', '--porcelain'], { cwd: folderPath, timeout: GIT_TIMEOUT_MS }, (statusError, statusOut) => {
        resolve({
          isGitRepo: true,
          branch,
          statusClean: statusError ? null : statusOut.trim().length === 0,
          reason: statusError ? 'status-unavailable' : null,
        });
      });
    });
  });
}

function registerDesktopServices({ bus, mainWindow, sessions, mode, consent }) {
  bus.registerView(mainWindow.webContents, VIEW.MAIN_WINDOW);

  // ---- claude.internal.ui / MainWindowTitleBar ----------------------------
  bus.registerService(
    'claude.internal.ui',
    'MainWindowTitleBar',
    {
      minimize: () => {
        mainWindow.minimize();
        return { ok: true };
      },
      maximize: () => {
        mainWindow.maximize();
        return { ok: true, isMaximized: mainWindow.isMaximized() };
      },
      unmaximize: () => {
        mainWindow.unmaximize();
        return { ok: true, isMaximized: mainWindow.isMaximized() };
      },
      toggleMaximize: () => {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        return { ok: true, isMaximized: mainWindow.isMaximized() };
      },
      close: () => {
        mainWindow.close();
        return { ok: true };
      },
      getWindowState: () => windowState(mainWindow),
      // The renderer opens Settings through window.electronWindowControl.openSettingsWindow();
      // measured absent, so Cmd/Ctrl+, did nothing at all — the call site is
      //   function Er(){ return window.electronWindowControl?.openSettingsWindow?.() }
      // and the optional chaining swallowed the missing method silently. There is one
      // window in this shell, so opening Settings means routing it to the settings path.
      openSettingsWindow: () => {
        // One window in this shell: opening Settings means routing it there. The route
        // is a hash route on the same origin, so will-navigate allows it.
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents
          .executeJavaScript("location.hash = '#settings/general'", true)
          .catch(() => { /* the document may not be ready yet */ });
        return { ok: true };
      },
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  const pushState = () => bus.emit(mainWindow.webContents, 'claude.internal.ui', 'MainWindowTitleBar', 'windowStateChanged', windowState(mainWindow));
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'resize']) {
    mainWindow.on(event, pushState);
  }

  // ---- claude.web / AppFeatures -------------------------------------------
  let settings = {
    sidebarMode: 'code',
    theme: 'light',
    // Must be one of permissions.MODES; 'auto' is not, and using it here made
    // every file call fail the mode assertion on a fresh install.
    permissionMode: MODES.ASK,
    model: mode === 'demo' ? 'demo' : 'claude',
    projectPath: '',
    mcpConfigPath: '',
  };
  const pushSettings = () => bus.emit(mainWindow.webContents, 'claude.web', 'AppFeatures', 'settingsChanged', settings);
  const SIDEBAR_MODES = new Set(['chat', 'cowork', 'code']);

  bus.registerService(
    'claude.web',
    'AppFeatures',
    {
      getSettings: () => ({ ...settings }),
      updateSettings: (_event, patch) => {
        if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
          settings = { ...settings, ...pickKnownSettings(patch) };
          pushSettings();
        }
        return { ...settings };
      },
      getSidebarMode: () => settings.sidebarMode,
      setSidebarMode: (_event, next) => {
        if (typeof next !== 'string' || !SIDEBAR_MODES.has(next)) {
          throw new Error(`Unsupported sidebar mode: ${String(next)}`);
        }
        settings.sidebarMode = next;
        pushSettings();
        return next;
      },
      getBootFeatures: () => ({
        mode,
        tools: 'disabled',
        // Observed in the shipped bundle: sidebarMode "code" maps to /epitaxy.
        codeRoute: '/epitaxy',
        coldLaunchParam: 'coldLaunch',
      }),
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / WorkspaceManager --------------------------------------
  bus.registerService(
    'claude.web',
    'WorkspaceManager',
    {
      listWorkspaces: () => (settings.projectPath ? [{ path: settings.projectPath, name: path.basename(settings.projectPath) }] : []),
      selectWorkspaceFolder: async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择工作区文件夹',
          properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths.length) return { canceled: true };
        const folderPath = result.filePaths[0];
        // Selecting a folder is what makes it the approved root; without this
        // the tree and the file tools would have nothing to work against.
        settings.projectPath = folderPath;
        pushSettings();
        return {
          canceled: false,
          path: folderPath,
          name: path.basename(folderPath),
          git: await inspectGitRepo(folderPath),
        };
      },
      inspectGitRepository: (_event, folderPath) => inspectGitRepo(folderPath),

      // Project browsing. The root is always the approved workspace, never a
      // caller-supplied path, so the tree cannot be pointed at another folder.
      listWorkspaceTree: (_event, options) => {
        if (!settings.projectPath) throw new Error('no workspace selected');
        return listTree(settings.projectPath, options || {});
      },
      listDirectory: (_event, relative) => {
        if (!settings.projectPath) throw new Error('no workspace selected');
        return listDirectory(settings.projectPath, relative || '');
      },
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / LocalAgentSessions ------------------------------------
  // Thin adapters over the existing HTTP session store so the desktop and the
  // browser build share one persistence path and one engine.
  //
  // Archiving needs a second store: the archive index lives beside the
  // transcripts under userData, matching the shipped layout
  // (claude-code-sessions/archived-sessions.idx).
  let archiveStore = null;
  const sessionArchive = () => {
    if (!archiveStore) archiveStore = new SessionArchive(app.getPath('userData'));
    return archiveStore;
  };
  const pushSessions = () =>
    bus.emit(mainWindow.webContents, 'claude.web', 'LocalAgentSessions', 'sessionsChanged', {
      live: sessions.list().length,
      archived: sessionArchive().listArchived().length,
    });
  bus.registerService(
    'claude.web',
    'LocalAgentSessions',
    {
      listSessions: () => sessions.list(),
      createSession: (_event, config) => sessions.create(config || {}),
      getSession: (_event, id) => sessions.get(id),
      deleteSession: (_event, id) => sessions.remove(id),
      sendPrompt: async (_event, sessionId, payload) => {
        const text = payload && typeof payload.text === 'string' ? payload.text : '';
        const { runId } = await sessions.send(sessionId, text, event =>
          bus.emit(mainWindow.webContents, 'claude.web', 'LocalAgentSessions', 'sessionEvent', { sessionId, runId, ...event }),
        );
        return { runId };
      },
      abortSession: (_event, sessionId) => sessions.cancel(sessionId),

      // Archive / restore. The transcript is kept when a session is archived, so
      // restoring is just removing the index entry.
      archiveSession: (_event, sessionId) => {
        const live = sessions.get(sessionId);
        const archive = sessionArchive();
        const result = archive.archive(sessionId, { title: live?.title });
        if (live) sessions.remove(sessionId);
        pushSessions();
        return result;
      },
      unarchiveSession: (_event, sessionId) => {
        const result = sessionArchive().unarchive(sessionId);
        pushSessions();
        return result;
      },
      listArchivedSessions: () => sessionArchive().listArchived(),
      // The resume decision for one session, exposed so the renderer can label a
      // session accurately instead of guessing from its message count.
      getResumePolicy: (_event, sessionId, options) => {
        const transcript = sessionArchive().loadTranscript(sessionId);
        // sessions.get throws for an unknown id; that is the expected "not
        // found" signal here, so it is treated as "no live session".
        let live = null;
        try { live = sessions.get(sessionId); } catch { live = null; }
        const session = transcript || live;
        if (!session) throw new Error(`no session ${sessionId}`);
        const completedTurns = (session.messages || []).some(message => message.role === 'assistant' && message.status === 'completed');
        return shouldResume(
          { resumesTranscript: Boolean(transcript), hasCompletedTurns: completedTurns },
          { remoteControlSpawn: Boolean(options?.remoteControlSpawn) },
        );
      },
      // Persists the transcript and returns the environment a resumed run needs.
      prepareResume: (_event, sessionId, options) => {
        // Write the transcript first, then read it back: the resume decision
        // must be based on what is actually persisted, not on the in-memory copy.
        let live = null;
        try { live = sessions.get(sessionId); } catch { live = null; }
        const existing = sessionArchive().loadTranscript(sessionId);
        const source = live || existing;
        if (!source) throw new Error(`no session ${sessionId}`);
        sessionArchive().saveTranscript(source);
        const transcript = sessionArchive().loadTranscript(sessionId);
        const completedTurns = (source.messages || []).some(message => message.role === 'assistant' && message.status === 'completed');
        const policy = shouldResume(
          { resumesTranscript: Boolean(transcript), hasCompletedTurns: completedTurns },
          { remoteControlSpawn: Boolean(options?.remoteControlSpawn) },
        );
        return {
          ...policy,
          env: policy.resume ? resumeEnvironment(sessionId) : resumeEnvironment(''),
          messages: policy.resume ? (transcript?.messages || source.messages) : [],
        };
      },
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / LocalExecution ----------------------------------------
  // The capability that separates the Code view from a chat window. Every run
  // goes through the consent window first; a refusal or a timeout never reaches
  // the child process.
  const approvedRoots = () => (settings.projectPath ? [settings.projectPath] : null);

  bus.registerService(
    'claude.web',
    'LocalExecution',
    {
      runCommand: async (_event, request) => {
        if (!request || typeof request.command !== 'string') {
          throw new Error('runCommand requires a command string');
        }
        if (!consent) throw new Error('Local execution is unavailable: no consent surface');

        // Refuse a command that cannot run BEFORE asking for approval.
        //
        // Measured (tools/_exec-availability.cjs): 23 of the 30 allowlisted names have no
        // spawnable binary on this host — `ls`, `echo`, `npm` and friends are aliases or .cmd
        // shims. Previously the prompt appeared, the user clicked Allow, and then exec died
        // with ENOENT, which reads exactly like "the approval system is broken". Asking for
        // consent to something impossible spends the user's trust on nothing.
        try {
          const parsed = parseCommand(request.command);
          const availability = checkAvailability(parsed);
          if (!availability.available) {
            bus.emit(mainWindow.webContents, 'claude.web', 'LocalExecution', 'consentResolved', {
              command: request.command,
              decision: 'unavailable',
              reason: availability.reason,
            });
            return {
              ok: false,
              unavailable: true,
              command: request.command,
              error: availability.reason,
            };
          }
        } catch (error) {
          // parseCommand's own refusals (metacharacters, allowlist) are reported the same way:
          // as a refusal, not as a crash.
          return { ok: false, refused: true, command: request.command, error: String(error && error.message) };
        }

        const decision = await consent.ask({
          kind: 'run-command',
          command: request.command,
          cwd: request.cwd || settings.projectPath || process.cwd(),
          toolName: request.toolName,
        });

        bus.emit(mainWindow.webContents, 'claude.web', 'LocalExecution', 'consentResolved', {
          command: request.command,
          decision,
        });

        if (decision !== 'allow') {
          return { ok: false, denied: true, decision, command: request.command };
        }

        const result = await runCommand(
          { command: request.command, cwd: request.cwd || settings.projectPath },
          { allowedRoots: approvedRoots() },
        );
        bus.emit(mainWindow.webContents, 'claude.web', 'LocalExecution', 'commandFinished', result);
        return result;
      },
      getPolicy: () => ({
        allowedRoots: approvedRoots(),
        requiresConsent: true,
      }),
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / Files ------------------------------------------------
  // Reads need no prompt (in every mode except that plan mode also reads
  // freely). Writes and replacements go through the permission policy, and when
  // a prompt is required the diff is what the user actually sees.
  const roots = () => (settings.projectPath ? [settings.projectPath] : null);
  const permissionMode = () => settings.permissionMode;

  // A renderer sends workspace-relative paths (that is what the tree renders),
  // so they are resolved against the approved root here. Resolving them against
  // process.cwd() would silently address a different directory.
  const absolute = filePath => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('a file path is required');
    }
    if (path.isAbsolute(filePath)) return filePath;
    if (!settings.projectPath) throw new Error('no workspace selected');
    return path.join(settings.projectPath, filePath);
  };

  bus.registerService(
    'claude.web',
    'Files',
    {
      read: (_event, filePath) => {
        const policy = decide(permissionMode(), ACTIONS.READ);
        if (policy.prompt) throw new Error(policy.reason);
        return fileTools.readFile(absolute(filePath), { allowedRoots: roots() });
      },

      previewWrite: (_event, filePath, content) => {
        const policy = decide(permissionMode(), ACTIONS.EDIT);
        if (policy.prompt) throw new Error(policy.reason);
        const preview = fileTools.previewWrite(absolute(filePath), content, { allowedRoots: roots() });
        return { path: preview.path, existed: preview.existed, diff: preview.diff };
      },

      write: async (_event, filePath, content) => {
        const preview = fileTools.previewWrite(absolute(filePath), content, { allowedRoots: roots() });
        const policy = decide(permissionMode(), ACTIONS.EDIT);
        // dontAsk must refuse outright instead of opening a card.
        //
        // Measured: this branch used to run for every non-ALLOW verdict, so a user who
        // picked "Don't ask" was asked to approve every write — the one thing that mode
        // promises never to do. classify() distinguishes DENY from ASK, and only ASK has
        // anyone to answer it.
        if (classify(permissionMode(), ACTIONS.EDIT) === DECISIONS.DENY) {
          return { ok: false, denied: true, decision: 'denied-by-mode', reason: policy.reason };
        }
        if (policy.prompt) {
          if (!consent) throw new Error('Editing requires approval, but no consent surface is available');
          const decision = await consent.ask({
            kind: 'run-command',
            command: `${preview.existed ? 'Edit' : 'Write'} ${preview.path}`,
            cwd: path.dirname(preview.path),
            toolName: preview.existed ? 'Edit' : 'Write',
          });
          if (decision !== 'allow') return { ok: false, denied: true, decision };
        }
        const result = fileTools.writeFile(preview.path, content, { allowedRoots: roots() });
        bus.emit(mainWindow.webContents, 'claude.web', 'Files', 'fileChanged', {
          path: result.path, written: result.written, added: result.diff.added, removed: result.diff.removed,
        });
        return { ok: true, written: result.written, path: result.path, diff: result.diff };
      },

      replace: async (_event, filePath, oldText, newText) => {
        const policy = decide(permissionMode(), ACTIONS.EDIT);
        // dontAsk must refuse outright instead of opening a card.
        //
        // Measured: this branch used to run for every non-ALLOW verdict, so a user who
        // picked "Don't ask" was asked to approve every write — the one thing that mode
        // promises never to do. classify() distinguishes DENY from ASK, and only ASK has
        // anyone to answer it.
        if (classify(permissionMode(), ACTIONS.EDIT) === DECISIONS.DENY) {
          return { ok: false, denied: true, decision: 'denied-by-mode', reason: policy.reason };
        }
        if (policy.prompt) {
          if (!consent) throw new Error('Editing requires approval, but no consent surface is available');
          const decision = await consent.ask({
            kind: 'run-command',
            command: `Edit ${path.resolve(filePath)}`,
            cwd: path.dirname(path.resolve(filePath)),
            toolName: 'Edit',
          });
          if (decision !== 'allow') return { ok: false, denied: true, decision };
        }
        const result = fileTools.replaceInFile(absolute(filePath), oldText, newText, { allowedRoots: roots() });
        bus.emit(mainWindow.webContents, 'claude.web', 'Files', 'fileChanged', {
          path: result.path, written: result.written, added: result.diff.added, removed: result.diff.removed,
        });
        return { ok: true, written: result.written, path: result.path, diff: result.diff };
      },

      diff: (_event, filePath, content) => fileTools.previewWrite(absolute(filePath), content, { allowedRoots: roots() }).diff,
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / Permissions ------------------------------------------
  bus.registerService(
    'claude.web',
    'Permissions',
    {
      getMode: () => permissionMode(),
      setMode: (_event, next) => {
        if (!VALID_MODES.has(next)) throw new Error(`Unknown permission mode: ${String(next)}`);
        settings.permissionMode = next;
        pushSettings();
        return next;
      },
      getModes: () => Object.values(MODES),
      // Exposes the decision table so the renderer can label a mode accurately
      // instead of hardcoding copy that could drift from the policy.
      describe: (_event, action) => decide(permissionMode(), action),
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / Dialogs ----------------------------------------------
  // Native save/open dialogs. The renderer never chooses a path on its own, so
  // an export cannot silently overwrite a file and an import cannot read one the
  // user did not pick.
  bus.registerService(
    'claude.web',
    'Dialogs',
    {
      saveTextFile: async (_event, defaultName, text) => {
        if (typeof text !== 'string') throw new Error('text must be a string');
        if (text.length > 64 * 1024 * 1024) throw new Error('the export exceeds the 64MB limit');
        const safeName = String(defaultName || 'export.json').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出会话',
          defaultPath: path.join(app.getPath('documents'), safeName),
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(result.filePath, text, 'utf8');
        return { ok: true, path: result.filePath, bytes: Buffer.byteLength(text) };
      },
      openTextFile: async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '导入会话',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
        const filePath = result.filePaths[0];
        const stat = fs.statSync(filePath);
        if (stat.size > 64 * 1024 * 1024) throw new Error('the file exceeds the 64MB limit');
        return { ok: true, path: filePath, text: fs.readFileSync(filePath, 'utf8') };
      },
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  // ---- claude.web / McpHost ----------------------------------------------
  // Servers come from a `{ mcpServers: { ... } }` config, the same shape the
  // shipped app reads. Only the stdio transport is implemented; http/sse
  // entries are listed as unsupported rather than pretended to work.
  const mcp = new McpHost();
  const loadMcpConfig = () => {
    const configPath = settings.mcpConfigPath
      || path.join(app.getPath('userData'), 'mcp.json');
    if (!fs.existsSync(configPath)) return { loaded: false, configPath, accepted: [], rejected: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const result = mcp.load(parsed);
      return { loaded: true, configPath, ...result };
    } catch (error) {
      return { loaded: false, configPath, error: error.message, accepted: [], rejected: [] };
    }
  };
  loadMcpConfig();

  const pushMcpState = () => bus.emit(mainWindow.webContents, 'claude.web', 'McpHost', 'serversChanged', mcp.list());

  bus.registerService(
    'claude.web',
    'McpHost',
    {
      listServers: () => mcp.list(),
      getConfigStatus: () => {
        const status = loadMcpConfig();
        return { ...status, servers: mcp.list() };
      },
      connectServer: async (_event, name) => {
        const state = await mcp.connect(name);
        pushMcpState();
        return state;
      },
      disconnectServer: async (_event, name) => {
        const result = await mcp.disconnect(name);
        pushMcpState();
        return result;
      },
      restartServer: async (_event, name) => {
        const state = await mcp.restart(name);
        pushMcpState();
        return state;
      },
      callTool: (_event, name, toolName, args) => mcp.callTool(name, toolName, args),
    },
    { allowedViews: [VIEW.MAIN_WINDOW] },
  );

  return () => {
    mcp.stopAll();
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'resize']) {
      mainWindow.removeListener(event, pushState);
    }
  };
}

function windowState(win) {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
    isFocused: win.isFocused(),
  };
}

// Only settings the renderer may change; everything else stays main-owned.
// Values that feed a policy decision are validated here, because a bad value
// that reaches the service layer would fail later and less clearly.
function pickKnownSettings(patch) {
  const allowed = ['theme', 'permissionMode', 'model', 'projectPath', 'sidebarMode', 'mcpConfigPath'];
  const out = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'sidebarMode') {
      if (['chat', 'cowork', 'code'].includes(patch[key])) out[key] = patch[key];
      continue;
    }
    if (key === 'permissionMode') {
      if (VALID_MODES.has(patch[key])) out[key] = patch[key];
      continue;
    }
    if (typeof patch[key] === 'string') out[key] = patch[key].slice(0, 4096);
  }
  return out;
}

module.exports = { registerDesktopServices, inspectGitRepo };


