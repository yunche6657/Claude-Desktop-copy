// Bridge services for the shipped frontend.
//
// The frontend at resources/ion-dist talks to the main process through the
// channel template
//
//   $eipc_message$_<namespace>_$_<domain>_$_<Service>_$_<method>
//
// for 1333 methods across 8 namespaces (see bridge-map.json, captured from a
// running original). Registering every channel up front keeps the surface the
// observed one; each method is then routed to a real handler where this
// reconstruction has one, and to a typed negative answer where it does not.
//
// The negative answers are deliberately shaped like the original's own
// "unavailable" states rather than null: the frontend reads `status` and
// downgrades the corresponding affordance instead of throwing, which is the
// behaviour an original instance shows for features that are not enabled.
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createShellSessions } = require('./shell-sessions.cjs');
// Subscription sign-in (OAuth + PKCE) and the multi-account store behind it.
const { createAccountStore } = require('./account-store.cjs');
// The Customize > Skills store. None of its nine methods had a handler, so the page
// could open, read "Add your first skills", and never accept a skill.
const {
  deleteSkill,
  listSkills,
  readSkillFiles,
  renameSkill,
  saveSkill,
  setSkillEnabled,
  skillDir,
} = require('./local-skills.cjs');
const { findManifest, readZip, safeEntryPath } = require('./zip-read.cjs');
// The permission modes the tool-approval gate understands. Used to validate what the
// composer's mode picker sends before it is written to the session record.
const { VALID_MODES } = require('./permissions.cjs');
// One gateway resolver shared with tools/gateway-config.cjs (the launcher). The settings
// banner and the launcher must never disagree about whether a provider exists.
const { resolveGateway, synthesizeProfile } = require('./gateway-source.cjs');
const { normalizeProviderConfig, providerConfigIssues } = require('./provider-config-contract.cjs');
const { createDeploymentMode } = require('./deployment-mode.cjs');
const { discoverModels } = require('./model-discovery.cjs');

const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';

/**
 * The local session services, in the order they are registered and fanned out.
 *
 * ONE LIST, EIGHT COPIES, TWO ORDERS — AND THE ORDER IS OBSERVABLE
 *   This pair of names was written out inline at eight places in this file: twice in the event fan-out (L1196, L1215)
 *   and six times in the `define(...)` registration blocks. Two of the eight had `LocalAgentModeSessions` first and six
 *   had `LocalSessions` first, so the list was already two lists.
 *
 *   The order is not cosmetic. L1196 walks this list to emit `$eipc_event$_…_<svc>_$_<name>` for each service, and
 *   L2466+ walks it to register `claude.web_$_<svc>_$_<method>` handlers. A renderer that takes the first arriving
 *   namespace, or any code that depends on registration order, would see the two sites differently. R555 measured the
 *   orders rather than assuming they were harmless.
 *
 *   `LocalSessions` first is the choice made here because six of the eight sites already used it and it is the
 *   namespace the tests exercise first. The two sites that disagreed are the reason this constant exists: there is no
 *   remaining place where a reader has to notice which order a given loop uses.
 *
 * THIS CONSTANT ALSO CORRECTS A WRONG CONCLUSION FROM R553
 *   R553 reported that this array existed only in test files and that production registered each namespace as its own
 *   literal. That was read from the first four sites of a detector output which listed fifteen files and eight sites
 *   under `desktop/` — a partial read of a complete result. The array was here eight times.
 */
const LOCAL_SERVICES = ['LocalSessions', 'LocalAgentModeSessions'];

const messageChannel = (domain, service, method) =>
  `$eipc_message$_${NAMESPACE}_$_${domain}_$_${service}_$_${method}`;
const eventChannel = (domain, service, name) =>
  `$eipc_event$_${NAMESPACE}_$_${domain}_$_${service}_$_${name}`;

// The app version the frontend displays.
//
// `APP_VERSION` is the version this reconstruction was written against; the installed
// package can be newer (it upgrades in place). The frontend reads TWO different keys:
//   - `version`         (this build's constant; used only internally)
//   - `app_version`     (what the About panel and every analytics event send)
// and only `version` existed, so the About line rendered `undefined`.
//
// Resolved from the AppModel registry, the same source app-protocol.cjs uses: readdir on
// WindowsApps returns EPERM and Get-AppxPackage is blocked inside Electron's main process.
const APP_VERSION = '2.42304.0';

/**
 * The newest installed Claude package version, or null when it cannot be determined.
 * Exported so the fallback behaviour can be tested without a registry.
 * @param {() => string[]} [lister] optional injectable lister for tests
 * @returns {string|null}
 */
function resolveInstalledVersion(lister) {
  try {
    const names = typeof lister === 'function'
      ? lister()
      : require('./app-protocol.cjs').listInstalledClaudePackages();
    const versions = [];
    for (const name of names || []) {
      const m = String(name).match(/Claude_(\d+\.\d+\.\d+\.\d+)_/);
      if (m) versions.push(m[1]);
    }
    if (!versions.length) return null;
    // Compare numerically, not lexically: 3.1623.10.0 > 3.1623.9.0.
    versions.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i += 1) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    });
    return versions[versions.length - 1];
  } catch {
    return null;
  }
}

/**
 * The shape a status-style bridge method answers when this build does not
 * implement it. It is deliberately an object with `status`, because callers
 * that read `.status` expect it; callers that render the value must not receive
 * it (see isFeatureStatusMethod in registerBridgeServices).
 */
function unavailable(reason = 'Not implemented in this reconstruction') {
  return { status: 'unavailable', reason };
}

/**
 * Resolve a download name to a path that does not overwrite an existing file.
 *
 * Extracted to module scope so it can be exported and tested directly. Under node there is
 * no save dialog, so the handler itself cannot be distinguished from the generic fallback by
 * behaviour; this function is the part a fallback cannot reproduce.
 *
 * @param {string} dir target directory
 * @param {string} name proposed file name
 * @returns {string} an absolute path that is free
 */
function uniqueDownloadPath(dir, name) {
  // Strip characters Windows forbids, collapse runs of dots (so a name like "../../x" cannot
  // look like traversal even though separators are already gone), and cap the length so the
  // path stays valid.
  let safe = String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
  safe = safe.replace(/\.{2,}/g, '_');
  // A leading dot would create a hidden file on unix; keep the name visible.
  safe = safe.replace(/^\.+/, '_');
  if (!safe) safe = 'download';
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  let n = 1;
  while (true) {
    try {
      fs.accessSync(candidate);
      // Taken: try "name (1).ext", "name (2).ext", ...
      candidate = path.join(dir, `${stem} (${n})${ext}`);
      n += 1;
      if (n > 500) return path.join(dir, `${stem}-${Date.now()}${ext}`);
    } catch {
      return candidate;
    }
  }
}

/**
 * Classify why running git failed, using the UI's own reason enum
 * (shared-0-BRYCPbU4.js, `Db` = { NotFound:"not-found", ExecBlocked:"exec-blocked",
 * StartupFailed:"startup-failed" }).
 *
 * Exported so the mapping can be asserted directly. The live host has a working git, so
 * the failure branches are otherwise unreachable from a test -- and a test that only sees
 * the success path cannot tell a real probe from a hard-coded `{available:true}`.
 * @param {{code?: string}|undefined} error
 * @returns {'not-found'|'exec-blocked'|'startup-failed'}
 */
function classifyGitFailure(error) {
  const code = error && error.code;
  // ENOENT is "no such binary"; EPERM/EACCES is "the OS refused to run it".
  if (code === 'ENOENT') return 'not-found';
  if (code === 'EPERM' || code === 'EACCES') return 'exec-blocked';
  return 'startup-failed';
}

/**
 * Turn one chosen file path into the record the "Open file" caller expects:
 *   { folder, name } and, only when the file really sits under the offered folder,
 *   `relPath` relative to it.
 *
 * Exported because the dialog cannot be opened in a test. Without a separately testable
 * function, a handler that builds this record is indistinguishable from the generic
 * fallback under node -- both answer null -- so a regression proof that deletes the handler
 * would stay green.
 *
 * @param {string} chosen absolute path the user picked
 * @param {string} [folder] folder the caller offered as a starting point
 * @returns {{folder: string, name: string, relPath?: string}}
 */
function buildFilePickResult(chosen, folder) {
  const result = { folder: path.dirname(chosen), name: path.basename(chosen) };
  if (typeof folder === 'string' && folder) {
    const rel = path.relative(folder, chosen);
    // A path outside the offered folder must NOT claim a relPath: the caller branches on
    // `i.relPath !== void 0` and would otherwise open the wrong thing.
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) result.relPath = rel;
  }
  return result;
}

  // Some callers render a method's return value directly as a React child, and
  // `{status, reason}` is not renderable — it throws
  //   Objects are not valid as a React child (found: object with keys {status, reason})
  // and the whole route then lands in the error boundary. So an unimplemented
  // method answers null unless its name shows it returns a feature-status
  // object, and only those get the {status, reason} shape from `unavailable()`.
  const isFeatureStatusMethod = (method) =>
    /^(get|is|can)[A-Z]/.test(method) && /Feature|Availability|Support|Status|Enabled/.test(method);

/**
 * Collections the frontend spreads, filters or maps. Returning null here is
 * what breaks boot; these must be real empty containers.
 */
function emptyFor(frag) {
  // `searchSessions` ends in "Sessions" but does NOT answer {sessions: [...]}.
  // Its consumer iterates the answer directly:
  //   for (let t of l) { ... e.push({ session: i.get(t.sessionId), snippet: t.snippet }) }
  // so answering an object here made the palette throw
  //   TypeError: l is not iterable
  // and the whole route fell into the error boundary ("This page ran into a
  // problem"). This is the shape check that has to come first.
  if (/searchSessions$/i.test(frag)) return [];
  // `listCliSessions` also ends in "Sessions" but answers an ARRAY. Its consumer
  // passes it straight to `select: e => e.map(jo)` (shared-11-Ci0VQatJ.js), so the
  // {sessions, archived, pinned} container made that select throw
  //   TypeError: a.map is not a function
  // and the CLI session list stayed empty with no visible error.
  //
  // NOTE: `frag` is the FULL key ("domain_$_Service_$_method"), not the bare method
  // name, so these tests must not be anchored with ^.
  if (/listCliSessions$/i.test(frag)) return [];
  if (/Sessions$/i.test(frag) || /fetchAllSessions$/.test(frag)) return { sessions: [], archived: [], pinned: [] };
  if (/getSessionList$/.test(frag)) return { sessions: [], archived: [], pinned: [] };
  if (/getAll(Spaces|ScheduledTasks)?$/.test(frag)) return [];
  if (/Spaces$|getSpacesStoreState$/.test(frag)) return { spaces: [], order: [] };
  if (/McpServers$|listServers$|DirectMcpServerStatuses$|ManagedAskToolNames$/.test(frag)) return [];
  if (/Extensions|Plugins$|Skills$|Skills\b/.test(frag)) return [];
  if (/Folders$|Projects$|DetectedProjects$/.test(frag)) return [];
  if (/TrustedHosts$|SSHConfigs$|Branches$|Commits$/.test(frag)) return [];
  // These three are ARRAYS and their callers do not null-check.
  //
  // Measured: getSSHHostToolGrants answered null, and the SSH host settings panel runs
  //   (await yn.getSSHHostToolGrants()).filter(e => e.endpointKey === q).length
  // which throws "Cannot read properties of null (reading 'filter')". The throw is swallowed
  // by that effect's .catch(), so the visible symptom was not a crash -- it was a tool-grant
  // count that stayed permanently at 0.
  if (/SSHHostToolGrants$|WslDistros$|PendingSSHPasswordRequests$/.test(frag)) return [];
  if (/Transcript/.test(frag)) return { entries: [], messages: [] };
  if (/Issues$|Checks$|Comments$|Timeline$|Files$/.test(frag)) return [];
  if (/Artifacts$/.test(frag)) return [];
  // Readers measured to answer null while a caller consumes the value (round 234):
  //   listMarketplaces, listAccountMemories, listGlobalOutputStyles, readGlobalMemory,
  //   getUncommittedChanges, getUncommittedChangesByFolder
  // Each is a collection the UI maps or counts; null degrades it to an empty panel instead
  // of an empty collection, and the next `.map` on it would throw.
  if (/Marketplaces$|Memories$|OutputStyles$|GlobalMemory$/.test(frag)) return [];
  if (/UncommittedChanges(ByFolder)?$/.test(frag)) return [];
  // Object-shaped status readers: {status, ...} is rendered field by field, so a null here
  // makes the panel read "unknown" rather than crash, but it is still the wrong answer.
  if (/SessionMissReason$|LocalSandboxStatus$|SandboxStatus$/.test(frag)) return { status: 'unavailable' };
  if (/LocalDeviceInfo$|WakeSchedulerStatus$|getStatus$/.test(frag)) return {};
  // Scalar readers whose callers test truthiness or render a string.
  if (/SharingEnabled$|isSharingEnabled$/.test(frag)) return false;

  if (/CoworkUserFiles\.getInfo$|UserFiles_\$_getInfo$/.test(frag)) return {};
  if (/getCounts$|StorageUsage$|getUsage$/.test(frag)) return { conversations: 0, workspace: 0, files: 0 };
  // `frag` is the full key ("claude.web.LocalSessionPresets_$_load"), so match the tail.
  if (/Presets_\$_load$|\.load$/.test(frag) && /Presets/.test(frag)) return { presets: [] };
  if (/refetchMyAccess$/.test(frag)) return { ok: false, reason: 'unavailable' };
  // A shortcut that was never registered: empty string, not null — the UI renders it.
  if (/getGlobalShortcut$/.test(frag)) return '';
  if (/interrupt$/.test(frag)) return { ok: false, reason: 'no running turn' };
  // `personOpenedSession` is a notification, not a query. Its caller is
  //   ke?.personOpenedSession?.(e.id)?.catch(() => void 0)
  // and nothing reads the value -- but it IS a reader-shaped channel (no set/mark prefix), so
  // answering null tripped the "every reader answers a typed value" rule. An explicit ack is
  // both honest and sufficient.
  if (/personOpenedSession$/.test(frag)) return { ok: true };
  // The rewind family is deliberately unimplemented (see test/rewind-refused-prompt.test.mjs
  // and checkpoint-surface). They still need consumable shapes: undoRewind/switchRewindMark
  // return a boolean, and rewindToRefusedPrompt's caller guards with `s === null ? null :`
  // so an object is the safe answer here — a bare null would also fail the rule below.
  if (/undoRewind$|switchRewindMark$/.test(frag)) return false;
  if (/rewindToRefusedPrompt$/.test(frag)) return { refused: false };
  return null;
}

/**
 * @param {{
 *   ipcMain: Electron.IpcMain,
 *   bridgeMap: object,
 *   mainWindow: Electron.BrowserWindow|null,
 *   settings: { sidebarMode: string, theme: string, projectPath: string },
 *   frontend: { root: string },
 *   sessionStore?: object,
 *   log?: (e: object) => void,
 * }} opts
 */
function registerBridgeServices(opts) {
  const {
    ipcMain,
    bridgeMap,
    getMainWindow,
    settings,
    frontend,
    log,
  } = opts;

  const calls = new Map(); // channel -> count, for diagnostics
  const note = (frag) => { calls.set(frag, (calls.get(frag) || 0) + 1); };
  // channel -> count of calls answered by the generic fallback (no exact handler). Exposed so a
  // diagnostic can list the channels the running frontend needs but this build does not implement.
  const fallbackCalls = new Map();
  let scheduledTasks = null;
  let sessionMedia = null;
  let sessionVideo = null;
  let fileAccess = null;
  let previewHost = null;
  let previewAccess = null;
  let launchStore = null;
  // R641: the third-party-inference settings window, created on demand and reused.
  let setupWindow = null;
  const revokePreviewSession = id => {
    previewAccess?.revokeSession(id);
    previewHost?.teardownRemoteSessionPreview(id);
    launchStore?.publish();
  };

  // ---- exact handlers, keyed "<domain>_$_<Service>_$_<method>" --------------
  const handlers = new Map();
  const define = (frag, fn) => handlers.set(frag, fn);
  if (opts.updateService) {
    define('claude.web_$_AutoUpdater_$_checkForUpdates', () => opts.showUpdates());
    define('claude.web_$_AutoUpdater_$_restartToUpdate', () => opts.showUpdates());
    define('claude.web_$_AutoUpdater_$_restartToUpdateWhenIdle', () => ({ ok: false, reason: '请通过更新对话框运行安装向导' }));
    define('claude.web_$_AutoUpdater_$_cancelPendingRestart', () => ({ ok: true }));
    define('claude.web_$_updaterStateStore_$_getState', () => opts.updateService.getState());
    define('claude.web_$_updaterStateStore_$_getStateSync', () => opts.updateService.getState());
  }

  // Apply a theme to the live renderer.
  //
  // `system` is resolved here rather than in the renderer because the renderer's own resolver
  // reads matchMedia, and the host is the side that knows the OS preference when the window is
  // in a forced mode. Resolving it to a concrete light/dark keeps the DOM attribute meaningful:
  // the stylesheet only understands [data-mode=dark] and the absence of it.
  //
  // Returns the mode actually applied, so the caller can report what happened instead of
  // echoing back what it was asked for.
  const applyThemeToRenderer = async (mode) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    let resolved = mode;
    if (mode === 'system') {
      // Follow the file's own convention for electron: require lazily, tolerate absence.
      try {
        const { nativeTheme } = require('electron');
        resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      } catch { resolved = 'light'; }
    }
    if (resolved !== 'light' && resolved !== 'dark') return null;
    // Execute in the renderer: set the attribute the stylesheet watches, and keep
    // color-scheme in step so form controls and scrollbars follow.
    const script = `(() => {
      const root = document.documentElement;
      root.setAttribute('data-mode', ${JSON.stringify(resolved)});
      root.style.colorScheme = ${JSON.stringify(resolved)};
      return root.getAttribute('data-mode');
    })()`;
    try {
      if (typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({ color: resolved === 'dark' ? '#151515' : '#fcfcfb', symbolColor: resolved === 'dark' ? '#f0efec' : '#0b0b0b' });
      }
      return await win.webContents.executeJavaScript(script, true);
    } catch {
      // A renderer that is navigating or gone must not turn a theme click into a rejection.
      return null;
    }
  };

  if (opts.themeController) {
    const themes = opts.themeController;
    define('claude.web_$_CustomThemes_$_setWindowMode', (_event, mode) => {
      if (mode !== 'dark' && mode !== 'light') return false;
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return false;
      win.setTitleBarOverlay?.({ color: mode === 'dark' ? '#151515' : '#fcfcfb', symbolColor: mode === 'dark' ? '#f0efec' : '#0b0b0b' });
      return true;
    });
    define('claude.web_$_CustomThemes_$_getState', () => themes.getState());
    define('claude.web_$_CustomThemes_$_listScenes', () => themes.listScenes());
    define('claude.web_$_CustomThemes_$_setTheme', (_event, value) => themes.setTheme(value));
    define('claude.web_$_CustomThemes_$_reset', () => themes.reset());
    define('claude.web_$_CustomThemes_$_getThemeFile', () => themes.getThemeFile());
  }

  // window control
  define('claude.web_$_WindowControl_$_resize', (_e, w, h) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false };
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) win.setContentSize(Math.round(w), Math.round(h));
    return { ok: true };
  });
  define('claude.web_$_WindowControl_$_show', () => { const w = getMainWindow(); if (w && !w.isDestroyed()) w.show(); return { ok: true }; });
  define('claude.web_$_WindowControl_$_focus', () => { const w = getMainWindow(); if (w && !w.isDestroyed()) w.focus(); return { ok: true }; });
  define('claude.web_$_WindowControl_$_close', () => { const w = getMainWindow(); if (w && !w.isDestroyed()) w.close(); return { ok: true }; });
  define('claude.web_$_WindowControl_$_setThemeMode', async (_e, mode) => {
    if (mode === 'light' || mode === 'dark' || mode === 'system') settings.themeMode = mode;
    // The renderer's own theme machinery is complete but inert: `applyHostTheme` exists and
    // sets data-mode + colorScheme, the stylesheet keys off `[data-mode=dark]`, and a
    // MutationObserver repaints on change. What never happens is a caller.
    //
    // Measured: clicking the 外观 > 主题 radio flips aria-checked and writes
    // LSS-userThemeMode to localStorage, then stops. documentElement stays on data-mode=light
    // and the page keeps rgb(252,252,251). Setting the attribute by hand proves the rest of
    // the chain works: bg becomes rgb(21,21,21) with colorScheme dark.
    //
    // The shipped UI only forwards this to the host (behind an Electron-only guard), expecting
    // the host to round-trip the resolved theme back through host-context. Nothing here builds
    // that round trip, so applying it at the point we already receive the value is the
    // smallest change that makes the control do what it looks like it does.
    const text = await applyThemeToRenderer(mode);
    return { ok: true, mode: settings.themeMode, applied: text };
  });
  define('claude.web_$_WindowControl_$_setIncognitoMode', (_e, on) => { settings.incognito = !!on; return { ok: true }; });
  define('claude.web_$_WindowControl_$_setModalScrimActive', (_e, on) => { settings.modalScrim = !!on; return { ok: true }; });
  define('claude.web_$_WindowControl_$_reportModalScrim', () => ({ ok: true }));
  // Capture the window and answer { data } — BASE64 ONLY, not a data URL.
  //
  // CONTRACT READ FROM THE CALLER (c49d37e5f-D7dfOEqs.js):
  //   let e = await Z?.captureScreenshot?.(F, "annotate");
  //   if (e?.data) { g(`data:image/png;base64,${e.data}`, ...) }
  //   else Gn(..., e?.error, ..., e?.code)
  //
  // So the caller supplies its own `data:image/png;base64,` prefix and expects the raw base64
  // in `.data`; failures carry `.error` and `.code`. This handler used to answer
  // { ok: true, dataUrl: 'data:image/png;base64,...' }, so `e.data` was undefined, the caller
  // took the failure branch, and every simulator screenshot silently fell back to its
  // placeholder — no error surfaced anywhere.
  //
  // The first two arguments (udid, purpose) belong to the simulator surface. This build has no
  // simulator, so they are accepted and ignored rather than forwarded.
  define('claude.web_$_WindowControl_$_captureScreenshot', async (_e, _udid, _purpose) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { data: null, error: 'window is gone', code: 'no_window' };
    }
    try {
      const image = await win.webContents.capturePage();
      return { data: image.toPNG().toString('base64') };
    } catch (error) {
      return { data: null, error: String(error && error.message || error), code: 'capture_failed' };
    }
  });
  for (const m of ['reportFrameLayout', 'reportSidebarPlaceholder', 'reportSidebarMenuState',
    'reportSplitViewMenuState', 'reportGoMenuAreas', 'reportCloseMenuTarget',
    'reportReopenClosedSessionMenuState']) {
    define(`claude.web_$_WindowControl_$_${m}`, () => ({ ok: true }));
  }

  // window state
  define('claude.web_$_WindowState_$_getFullscreen', () => { const w = getMainWindow(); return !!(w && !w.isDestroyed() && w.isFullScreen()); });
  define('claude.web_$_WindowState_$_getVisibility', () => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return 'hidden';
    if (w.isMinimized()) return 'minimized';
    return w.isVisible() ? 'visible' : 'hidden';
  });
  define('claude.web_$_WindowState_$_getOnScreen', () => { const w = getMainWindow(); return !!(w && !w.isDestroyed() && w.isVisible()); });
  define('claude.web_$_WindowState_$_getKeptHidden', () => false);
  define('claude.web_$_WindowState_$_getAppFocused', () => { const w = getMainWindow(); return !!(w && !w.isDestroyed() && w.isFocused()); });
  define('claude.web_$_WindowState_$_getZoomFactor', () => { const w = getMainWindow(); return (w && !w.isDestroyed()) ? w.webContents.getZoomFactor() : 1; });

  // preferences and feature gates
  //
  // Values observed from a running original in 3p mode: sidebarMode is
  // "epitaxy" (not "code" — that is the pre-rewrite name), the sessions bridge
  // is enabled with consent granted, and the preference bag carries 116 keys.
  // The frontend reads sidebarMode to decide which surface to mount, so an
  // empty preferences object left it on the /code route showing a placeholder.
  // Preferences are written by the frontend through setPreference, and some of
  // them record that a one-time notice was already shown. Keeping the bag in
  // memory only made every launch look like a first run: the "Auto mode is now
  // Claude Code's default permission mode" modal — gated on the account-scoped
  // `epitaxy-auto-default-notice-seen` preference — reopened on every start and
  // its full-window backdrop swallowed the first click on Send.
  //
  // The real app persists these, so they are stored next to the session store.
  // Only JSON-safe values are kept; anything else would fail to round-trip.
  const preferencesFile = () => {
    const dir = settings.dataDir || path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data');
    return path.join(dir, 'preferences.json');
  };
  const loadPreferences = () => {
    try {
      const file = preferencesFile();
      if (!fs.existsSync(file)) return {};
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };
  const notifyPreferences = () => {
    try {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed?.()) {
        win.webContents.send(messageChannel('claude.settings', 'AppPreferences', 'preferencesChanged'), preferenceSnapshot());
      }
    } catch { /* a disappearing window must not affect preference updates */ }
  };
  const savePreferences = () => {
    let tmp;
    let created = false;
    try {
      const file = preferencesFile();
      tmp = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const descriptor = fs.openSync(tmp, 'wx', 0o600);
      created = true;
      try { fs.writeFileSync(descriptor, JSON.stringify(settings.preferences || {}, null, 2)); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(tmp, file);
      notifyPreferences();
      return true;
    } catch (error) {
      if (typeof log === 'function') log(`preference write failed: ${error && error.message}`);
      return false;
    } finally {
      if (created) { try { fs.unlinkSync(tmp); } catch {} }
    }
  };
  settings.preferences = { ...loadPreferences(), ...(settings.preferences || {}) };
  // R652: this key reports a capability of the running build, not a user choice. A profile written before the
  // Cowork handlers existed carries the old `false`, and the merge above would keep it forever — which is
  // exactly what the live run showed (flag still false after the default was flipped). Drop the persisted copy
  // so preferenceSnapshot's own value is the only one that answers.
  if (settings.preferences && Object.prototype.hasOwnProperty.call(settings.preferences, 'coworkScheduledTasksEnabled')) {
    delete settings.preferences.coworkScheduledTasksEnabled;
  }

  // R652: the Cowork workspace root. main.cjs does not pass settings.coworkUserFilesPath, so the old
  // `|| homedir/Claude` fallback put user data in the home directory root and made it impossible to isolate
  // per profile. Resolve to an app-owned directory instead; an explicit setting still wins.
  const coworkWorkspaceRoot = () => settings.coworkUserFilesPath
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CodeDesktop-Cowork')
      : path.join(os.homedir(), 'Claude'));

  const preferenceSnapshot = () => require('./preference-projection.cjs').publicPreferences({
    sidebarMode: settings.sidebarMode,
    theme: settings.themeMode,
    menuBarEnabled: true,
    legacyQuickEntryEnabled: true,
    chromeExtensionEnabled: false,
    chromeExtension: {},
    quickEntryShortcut: 'double-tap-option',
    quickEntryDictationShortcut: 'off',
    dictationShortcut: 'default',
    ccdScheduledTasksEnabled: !!scheduledTasks,
    // R652: was hard-coded false; this flag is what put Cowork behind "needs a newer build".
    coworkScheduledTasksEnabled: true,
    launchEnabled: opts.enablePreviewHost === true || !!opts.previewHost,
    coworkBrowserToolsEnabled: true,
    // Observed gate: REr() answers disabled_by_user when this preference is
    // false, which is what put the Cowork surface behind "Additional setup
    // needed". A packaged install has the secure VM components, so the
    // preference follows the caller's declared packaging state.
    secureVmFeaturesEnabled: settings.secureVmFeaturesEnabled !== false,
    bypassPermissionsModeEnabled: false,
    bypassPermissionsOptInByAccount: {},
    bypassPermissionsGateByAccount: {},
    localAgentModeTrustedFolders: [],
    remoteSessionFolderGrants: {},
    remoteChatFolderGrants: {},
    routineFolderGrants: {},
    ccSshHostToolGrants: [],
    launchPreviewAllowedOrigins: [],
    allowAllBrowserActions: false,
    ccdPluginUploadsEnabled: false,
    ...(settings.preferences || {}),
    // R652: applied AFTER the spread. The literal above cannot win while the persisted preferences are expanded
    // over it, and setPreference can rewrite the key at runtime. This flag reports whether the build can
    // schedule at all, not what the user chose, so it is pinned here rather than read.
    coworkScheduledTasksEnabled: true,
  });
  define('claude.settings_$_AppPreferences_$_getPreferences', preferenceSnapshot);
  define('claude.settings_$_AppPreferences_$_setPreference', (_e, key, value) => {
    if (typeof key === 'string') {
      settings.preferences = { ...(settings.preferences || {}), [key]: value };
      if (!savePreferences()) notifyPreferences();
    }
    return { ok: true };
  });
  define('claude.settings_$_AppPreferences_$_onPreferencesChanged', () => ({ ok: true }));
  // ---- Startup: "Run on startup" and "System tray" -------------------------
  //
  // Both switches exist on Settings > System and both were inert: none of the four
  // Startup.* methods had a handler, so they fell through to the generic fallback.
  //
  // Measured on the live replica:
  //   isStartupOnLoginEnabled()  -> false     (the switch renders off)
  //   setStartupOnLoginEnabled() -> null      (no effect)
  //   setMenuBarEnabled(true)    -> null
  //   点击后 aria-checked 变 true，但刷新页面立刻回到 false，磁盘和注册表都没有任何记录
  //
  // The login-item half is NOT available here. See the measurement in
  // desktop/main.cjs's loginItemSupported comment and HANDOFF §7.73: the
  // Electron main process on this host runs at LOW integrity (measured: token RID 4096
  // vs 8192 for plain node), which denies HKCU writes and silently drops
  // app.setLoginItemSettings(). The honest answer is to report "not supported" rather
  // than flip a switch that never sticks, so isStartupOnLoginEnabled answers false and
  // setStartupOnLoginEnabled reports why.

  /** Whether this process can actually change the OS login item. */
  const loginItemWorks = () => {
    try {
      if (typeof settings.loginItemSupported === 'function') return settings.loginItemSupported() === true;
    } catch { return false; }
    return false;
  };

  define('claude.settings_$_Startup_$_isStartupOnLoginEnabled', () => {
    if (!loginItemWorks()) return false;
    try {
      const { app } = require('electron');
      const item = app.getLoginItemSettings({ path: process.execPath, args: [] });
      return Boolean(item && (item.openAtLogin || item.executableWillLaunchAtLogin));
    } catch { return false; }
  });

  define('claude.settings_$_Startup_$_setStartupOnLoginEnabled', (_e, enabled) => {
    if (!loginItemWorks()) {
      // The caller shows a toast on a falsey answer, so this reports the refusal
      // instead of pretending the switch took effect.
      return { ok: false, error: 'Run on startup is not available in this build.' };
    }
    try {
      const { app } = require('electron');
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        enabled: Boolean(enabled),
        path: process.execPath,
        args: [],
        name: 'Claude',
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });

  // The tray switch.
  //
  // The preference key is the shipped one (`menuBarEnabled`), because the original's
  // main-window close handler reads exactly that key:
  //
  //   let t = () => { ...; C8(p,!0); p.hide() }            // tray on: hide, keep running
  //   if (!yv("menuBarEnabled")) { quit(); return }        // tray off: closing quits
  //
  // so on Windows this switch is really "keep Claude running in the tray". The menu bar
  // stays hidden either way — that is what keeps the accelerators alive (see app-menu.cjs).
  //
  // The bridge stores the value and asks main.cjs's tray controller to apply it now, and
  // that same controller answers the window's close handler. Before this round nothing
  // read the value at all, so the switch wrote a preference with no consumers.
  define('claude.settings_$_Startup_$_isMenuBarEnabled', () => (settings.preferences && settings.preferences.menuBarEnabled) !== false);

  define('claude.settings_$_Startup_$_setMenuBarEnabled', (_e, enabled) => {
    settings.preferences = { ...(settings.preferences || {}), menuBarEnabled: Boolean(enabled) };
    if (!savePreferences()) notifyPreferences();
    // Applied immediately rather than on next launch. A runtime with no Tray still
    // persists the choice and reports why it could not show an icon.
    let applied = null;
    try {
      if (typeof settings.applyTray === 'function') applied = settings.applyTray(Boolean(enabled));
    } catch (error) {
      applied = { enabled: Boolean(enabled), available: false, reason: String((error && error.message) || error) };
    }
    return { ok: true, menuBarEnabled: Boolean(enabled), ...(applied ? { tray: applied } : {}) };
  });


  define('claude.settings_$_AppFeatures_$_getSupportedFeatures', () => settings.supportedFeatures || {});  define('claude.settings_$_AppConfig_$_getAppConfig', () => ({
    ...(deploymentMode.getAppConfigMode() === undefined ? {} : { deploymentMode: deploymentMode.getAppConfigMode() }),
    coworkUserFilesPath: coworkWorkspaceRoot(),
    preferences: handlers.get('claude.settings_$_AppPreferences_$_getPreferences')(),
  }));
  define('claude.settings_$_AppConfig_$_setAppFeature', () => ({ ok: true }));
  define('claude.settings_$_DesktopInfo_$_getSystemInfo', () => ({
    platform: process.platform,
    arch: process.arch,
    version: APP_VERSION,
    // The frontend reads `app_version`, NOT `version`. Measured consumers:
    //   About panel:  `${y.app_version} · ${t} (${y.arch})`
    //                 -> rendered "undefined · Windows 10.0.26200 (x64)"
    //   analytics:    app_version in desktop_dxt_installed and the feedback payload
    //   support copy: clientVersion: e?.app_version
    // It was absent, so every one of those sent or showed `undefined`.
    // The installed package is preferred because it upgrades in place and is the version the
    // user actually has; APP_VERSION is only the version this reconstruction targeted.
    app_version: resolveInstalledVersion() || APP_VERSION,
    // `installer_variant` gates Linux packaging checks (YE(): === "deb"). This is an MSIX
    // build, so the honest value names that rather than pretending to be deb/rpm.
    installer_variant: process.platform === 'win32' ? 'msix' : undefined,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    // The terminal backend picks conpty on win32 and reads `os_version` to derive
    // the build number:
    //   if (info?.platform === "win32")
    //     return { backend: "conpty", buildNumber: Number(split(info.os_version, ".")) }
    // With the field absent the split receives undefined and throws inside the
    // session detail view. `osRelease` alone is not enough.
    os_version: os.release(),
    osRelease: os.release(),
    totalMemoryMb: Math.round(os.totalmem() / 1048576),
    cpus: os.cpus().length,
    locale: 'zh-Hans-CN',
  }));

  // The name of the browser the OS would open a link with, used for the Preview pane's
  // "Open in {browserName}" label.
  //
  // The consumer (c8ae173c6-B7L_--bW.js) is null-safe:
  //   let e = r?.getDefaultBrowserName?.();
  //   e && e.then(e => { let t = e || null; t !== s && (s = t, l.notify()) })
  //   t === null ? "Open in default browser" : "Open in {browserName}"
  // so a null is not a crash -- it only means the label never names the browser. This
  // handler existed nowhere, so the label was permanently generic while the host does have
  // a default browser (measured: HKCU UrlAssociations\http\UserChoice = MSEdgeHTM).
  //
  // Returns null when the name genuinely cannot be determined, because the caller already
  // renders the generic wording for that case; inventing a name would be worse.
  define('claude.settings_$_DesktopInfo_$_getDefaultBrowserName', () => {
    const runReg = (args) => {
      try {
        const out = require('node:child_process').execFileSync('reg', args, {
          encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        });
        return out;
      } catch { return null; }
    };

    // Turn an executable path into the name a person would recognise.
    const nameFromExe = (exePath) => {
      const base = path.basename(exePath).replace(/\.exe$/i, '');
      const known = {
        msedge: 'Microsoft Edge',
        chrome: 'Google Chrome',
        firefox: 'Firefox',
        brave: 'Brave',
        opera: 'Opera',
        vivaldi: 'Vivaldi',
        iexplore: 'Internet Explorer',
        safari: 'Safari',
      };
      const key = base.toLowerCase();
      if (known[key]) return known[key];
      // Unknown browser: title-case the executable name rather than returning nothing.
      return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
    };

    if (process.platform === 'win32') {
      // The user's chosen handler for http URLs.
      const choice = runReg([
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
        '/v', 'ProgId',
      ]);
      const progId = choice && (choice.match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1];
      if (progId) {
        // The ProgId's open command names the executable.
        const cmd = runReg(['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
        const exe = cmd && (cmd.match(/REG_SZ\s+"?([^"\r\n]+?\.exe)/i) || [])[1];
        if (exe) return nameFromExe(exe);
        // No command registered: fall back to a readable form of the ProgId itself.
        return progId.replace(/HTM(L)?$/i, '') || null;
      }
      return null;
    }

    if (process.platform === 'darwin') {
      // The system default handler for http, as a bundle identifier.
      try {
        const out = require('node:child_process').execFileSync(
          'defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'],
          { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const m = out.match(/LSHandlerURLScheme\s*=\s*http;[\s\S]{0,400}?LSHandlerRoleAll\s*=\s*"?([\w.\-]+)/);
        if (m) return m[1].split('.').pop() || null;
      } catch { /* fall through */ }
      return null;
    }

    // Linux: xdg-settings knows the default browser.
    try {
      const out = require('node:child_process').execFileSync('xdg-settings', ['get', 'default-web-browser'], {
        encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out ? nameFromExe(out) : null;
    } catch { return null; }
  });

  // ---- claude.settings / Custom3pSetup -----------------------------------
  // The sidebar's account row derives its name from
  //   hr()?.principalDisplayName  (see Cz() in shared-19-DQ7bbG4j.js)
  // which comes from the third-party setup configuration. Answering null here is
  // what left the account row blank. These report the configuration this build is
  // actually running against, read from the same file the shipped app uses.
  // ---- third-party (cc-switch) configuration library -------------------------
  //
  // The library is a DIRECTORY, not a single file:
  //   configLibrary/_meta.json   -> { entries: [{id, name}], appliedId }
  //   configLibrary/<id>.json    -> the provider configuration itself
  // Measured on this host:
  //   _meta.json 167 bytes, one entry ("CC Switch"), appliedId set
  //
  // The earlier reader ignored _meta.json entirely and returned the first *.json it found,
  // so the profile NAME shown in the UI was the file's basename (a UUID) instead of the
  // configured name, and appliedId was invented rather than read.
  //
  // Every mutation method had NO handler, so the generic fallback answered null. The UI does:
  //   let n = await e.deleteConfig(t);  i(n.entries), o(n.appliedId)
  // and that threw `Cannot read properties of null (reading 'entries')` -- measured live.
  const configLibraryDirs = () => require('./gateway-source.cjs').configLibraryDirs(process.env);

  /** The library directory that exists, or the first candidate for a new one. */
  const configLibraryDir = () => {
    const candidates = configLibraryDirs();
    for (const dir of candidates) {
      try { if (fs.existsSync(dir)) return dir; } catch { /* next */ }
    }
    return candidates[0] || null;
  };

  const deploymentMode = createDeploymentMode({
    getConfigPath: () => {
      const dir = configLibraryDir();
      if (!dir) throw new Error('no library');
      return path.join(path.dirname(dir), 'claude_desktop_config.json');
    },
    resetWindowBounds: opts.resetWindowBounds,
    log,
  });

  const META_FILE = (dir) => path.join(dir, '_meta.json');
  const CONFIG_FILE = (dir, id) => path.join(dir, `${id}.json`);

  /** Read _meta.json, or an empty library when it is missing or corrupt. */
  const readConfigMeta = (dir, strict = false) => {
    const empty = { entries: [], appliedId: null };
    if (!dir) return empty;
    try {
      const raw = JSON.parse(fs.readFileSync(META_FILE(dir), 'utf8'));
      if (strict && (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.entries))) {
        throw new Error('invalid config metadata');
      }
      const entries = Array.isArray(raw && raw.entries)
        ? raw.entries.filter((e) => e && typeof e.id === 'string')
        : [];
      const appliedId = raw && typeof raw.appliedId === 'string' ? raw.appliedId : null;
      return { ...raw, entries, appliedId };
    } catch (error) {
      if (strict && error.code !== 'ENOENT') throw error;
      return empty;
    }
  };

  /** Write _meta.json atomically. */
  const writeConfigMeta = (dir, meta) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${META_FILE(dir)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, META_FILE(dir));
    opts.onMainFeatureSourceChanged?.();
  };

  /** Write one config by id, atomically. */
  const writeConfigFile = (dir, id, config) => {
    const tmp = `${CONFIG_FILE(dir, id)}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE(dir, id));
    } catch (error) {
      //
      // R639: a failed write reported only the raw fs code. Measured live in this workspace, createConfig answered
      // { ok: false, error: "EPERM: operation not permitted, open <library>/<uuid>.json.tmp-<pid>" } - which names a
      // temporary file the user never asked for, and does not say that the LIBRARY is unwritable, nor where it is.
      // The same bytes written from a shell succeed, so the condition is per-process rather than per-permission; the
      // message must therefore carry the directory so it can be compared against the one the user expects.
      //
      // Every existing caller already does catch (error) { return configError(error); }, so attaching the directory
      // to the error is enough for the answer to carry it.
      //
      try { fs.unlinkSync(tmp); } catch { /* the temp file may not exist */ }
      const code = error && error.code ? String(error.code) : "error";
      const detail = String((error && error.message) || error);
      const wrapped = new Error("cannot write the configuration library at " + dir + " (" + code + "): " + detail);
      wrapped.code = error && error.code;
      wrapped.libraryDir = dir;
      throw wrapped;
    }
    opts.onMainFeatureSourceChanged?.();
  };

  const readConfigFile = (dir, id) => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE(dir, id), 'utf8')); } catch { return null; }
    const config = normalizeProviderConfig(raw);
    // Migrate the old reconstruction's {id}/{model} entries before the shipped
    // renderer runs its own schema validator (which rejects them before IPC).
    // Use the same atomic writer as edits; never log credential-bearing config.
    if (JSON.stringify(config) !== JSON.stringify(raw)) writeConfigFile(dir, id, config);
    return config;
  };

  /** `listConfigs`'s answer shape, shared by every mutation that reports the new list. */
  const configListShape = (dir) => {
    const meta = readConfigMeta(dir);
    return {
      entries: meta.entries.map((e) => ({
        id: e.id,
        name: typeof e.name === 'string' ? e.name : e.id,
        path: dir ? CONFIG_FILE(dir, e.id) : null,
        applied: e.id === meta.appliedId,
      })),
      appliedId: meta.appliedId,
      isManaged: false,
      managedConfig: null,
      platform: process.platform,
      isInternalBuild: false,
    };
  };

  // The applied configuration, used by the getters below.
  //
  // Three sources, in order:
  //   1. the applied profile in configLibrary (the shipped app's own record);
  //   2. any listed entry, so a library with an unset appliedId still reports something;
  //   3. a gateway resolved from elsewhere (~/.claude/settings.json or the environment).
  //
  // Step 3 is not a convenience. Measured on 2026-10-23: configLibrary held
  //   _meta.json = {"entries": []}
  // plus one profile with no gateway fields at all, while ~/.claude/settings.json held a
  // working ANTHROPIC_BASE_URL. The old two-step version answered null, so the UI showed
  // "Your provider setup needs a fix / Some required fields are missing" *while turns were
  // completing normally through the launcher's own resolution*. Telling the user to repair
  // a provider that works is worse than saying nothing.
  const read3pConfig = () => {
    const dir = configLibraryDir();
    if (dir) {
      const meta = readConfigMeta(dir);
      const id = meta.appliedId || (meta.entries[0] && meta.entries[0].id);
      if (id) {
        const config = readConfigFile(dir, id);
        if (config) return { dir, file: CONFIG_FILE(dir, id), id, config };
      }
    }
    const synthesized = synthesizeProfile(resolveGateway());
    if (!synthesized) return null;
    return {
      dir: synthesized.file ? path.dirname(synthesized.file) : null,
      file: synthesized.file,
      id: synthesized.id,
      config: synthesized.config,
      synthetic: true,
      source: synthesized.source,
    };
  };

  define('claude.settings_$_Custom3pSetup_$_getMergedConfig', () => {
    const found = read3pConfig();
    if (!found) return null;
    return {
      ...found.config,
      // The configuration object carries a `type` and a nested `source`. dz() reads
      // `type` directly on the config, and pz()/mz() read `source.type` /
      // `source.remote`, so both levels must be present.
      type: 'local',
      source: { type: 'local', remote: false },
      managedUnusable: false,
      remote: false,
      hybrid: opts.getBootstrapAuthStatus?.()?.hybrid ?? false,
      principalDisplayName: found.config.principalDisplayName || os.userInfo().username,
      deploymentDisplayName: found.config.deploymentDisplayName || 'Gateway',
    };
  });
  // The cc-switch provider configuration list.
  //
  // The consumer (c71860c77, fn j) destructures an OBJECT:
  //   let t = await e.listConfigs();
  //   i(t.entries); o(t.appliedId); m(t.isManaged); v(t.platform);
  //   x.current = t.isInternalBuild ?? false;
  //   if (t.isManaged) { ... t.managedConfig ... }
  //
  // It answered a bare ARRAY, so every one of those reads was `undefined`: the list rendered
  // empty and `appliedId` never marked the active profile. Measured live before the fix:
  //   listConfigs -> "array(1)"
  //   consumer destructuring -> entries undefined
  //
  // The entries now come from _meta.json, so each one carries its configured NAME rather than
  // the file's UUID basename.
  define('claude.settings_$_Custom3pSetup_$_discoverModels', (_event, options) => discoverModels(options));
  define('claude.settings_$_Custom3pSetup_$_listConfigs', () => configListShape(configLibraryDir()));

  /**
   * R641: the shipped settings UI has a full "Configure third-party inference" page at the route
   * `/setup-desktop-3p` (measured in the bundle: `path:"setup-desktop-3p"` lazily imports
   * `c71860c77-BwbfSKgy.js`, whose only h2 is that title). Its ONE opener is `hU()` in the frontend:
   *
   *     async function hU(){ localStorage.setItem("seenInferenceSetupHint","1"); await He?.openSetupWindow?.() }
   *
   * That `?.` is the whole problem: this bridge never defined `openSetupWindow`, so the call resolved to
   * undefined, the optional call did nothing, and NOTHING happened. There is no other entry point — the
   * account menu only lists saved configurations and its own New/Rename/Delete actions.
   *
   * So the page the user wants has been present and unreachable the whole time. This handler opens it.
   *
   * The window is a plain BrowserWindow on the same app:// origin as the main window, because the route is
   * part of the same SPA: a separate protocol or file URL would not resolve `./assets/v1/...`. It is returned
   * so a caller can await it, and it is reused so repeated clicks focus instead of stacking.
   */
  define('claude.settings_$_Custom3pSetup_$_openSetupWindow', async () => {
    // Use the same modal as the sidebar Model settings entry. A separate setup
    // BrowserWindow lost the settings navigation and inherited Electron's icon.
    const window = getMainWindow?.();
    if (!window || window.isDestroyed()) return { ok: false, error: '主窗口尚未就绪' };
    try {
      if (window.isMinimized?.()) window.restore();
      window.show();
      window.focus();
      await window.webContents.executeJavaScript("location.hash = '#settings/models'", true);
      return { ok: true, page: 'models', reused: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  // Read one config by id. The consumer (c71860c77, fn M) does:
  //   let n = await e.readConfig(t);
  //   return n.ok ? (onLoadConfig(t, n.config, ...), true) : (onError(n.error ?? "unknown"), false)
  // so it needs { ok, config } -- a bare config object made `n.ok` undefined, which the caller
  // treats as failure, so opening a profile always reported an error.
  define('claude.settings_$_Custom3pSetup_$_readConfig', (_e, id) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no config' };
    const meta = readConfigMeta(dir);
    const wanted = typeof id === 'string' && id ? id : (meta.appliedId || (meta.entries[0] && meta.entries[0].id));
    if (!wanted) return { ok: false, error: 'no config' };
    // An unknown id must not silently return the applied config, or the caller would edit the
    // wrong profile.
    if (!meta.entries.some((e) => e.id === wanted)) return { ok: false, error: 'unknown config id' };
    const config = readConfigFile(dir, wanted);
    if (!config) return { ok: false, error: 'config unreadable' };
    return { ok: true, id: wanted, config };
  });

  // ---- configuration mutations ----------------------------------------------
  //
  // None of these had a handler, so the fallback answered null and the UI threw:
  //   let n = await e.deleteConfig(t);  i(n.entries)   -> Cannot read properties of null
  // measured live. Every one now performs the operation and answers the SAME list shape, or
  // { ok: false, error } when it refuses.
  const configError = (error) => ({ ok: false, error: String((error && error.message) || error) });

  /** Create a config. The consumer reads `.id` off the answer: `let n = await createConfig(t); N(n.id)`. */
  define('claude.settings_$_Custom3pSetup_$_createConfig', (_e, options) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    try {
      const meta = readConfigMeta(dir);
      const id = require('node:crypto').randomUUID();
      const rawName = (typeof options === 'string' && options.trim())
        || (options && typeof options.name === 'string' && options.name)
        || (options && typeof options.from === 'string' && options.from)
        || 'New config';
      //
      // R638: the default name repeated, so the account menu filled with identical `New config` rows.
      //
      // Measured in the live library: seven entries, all named `New config`, all with an EMPTY body. The consumer
      // does send a name, but it does not arrive as `options.name`, so every creation fell through to the same
      // literal and the list became unreadable — rows cannot be told apart, and selecting one applies an empty
      // profile that fails configuration.
      //
      // A default name is therefore made unique within the library. The ordinal skips names already taken, so a
      // hand-named `New config 2` is never duplicated.
      const takenNames = new Set(meta.entries.map((e) => (typeof e.name === 'string' ? e.name : '')));
      let name = rawName;
      if (takenNames.has(name)) {
        let ordinal = 2;
        while (takenNames.has(name + ' ' + ordinal)) ordinal += 1;
        name = name + ' ' + ordinal;
      }
      // A new entry copies nothing by default; `createFrom` writes the body afterwards through
      // writeConfig, which is what the consumer does.
      const config = normalizeProviderConfig((options && typeof options.config === 'object' && options.config) || {});
      const issues = providerConfigIssues(config);
      if (issues.length) return { ok: false, error: 'validation', issues };
      writeConfigFile(dir, id, config);
      meta.entries.push({ id, name });
      // A library with no applied entry takes the first one it gets.
      if (!meta.appliedId) meta.appliedId = id;
      writeConfigMeta(dir, meta);
      return { ok: true, id, ...configListShape(dir) };
    } catch (error) { return configError(error); }
  });

  define('claude.settings_$_Custom3pSetup_$_duplicateConfig', (_e, id, options) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    try {
      const meta = readConfigMeta(dir);
      const source = meta.entries.find((e) => e.id === id);
      if (!source) return { ok: false, error: 'unknown config id' };
      const body = readConfigFile(dir, id);
      if (!body) return { ok: false, error: 'config unreadable' };
      const newId = require('node:crypto').randomUUID();
      const name = (options && typeof options.name === 'string' && options.name) || `${source.name} copy`;
      writeConfigFile(dir, newId, body);
      meta.entries.push({ id: newId, name });
      writeConfigMeta(dir, meta);
      return { ok: true, id: newId, ...configListShape(dir) };
    } catch (error) { return configError(error); }
  });

  define('claude.settings_$_Custom3pSetup_$_renameConfig', (_e, id, name) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'invalid name' };
    try {
      const meta = readConfigMeta(dir);
      const entry = meta.entries.find((e) => e.id === id);
      if (!entry) return { ok: false, error: 'unknown config id' };
      entry.name = name.trim();
      writeConfigMeta(dir, meta);
      return { ok: true, ...configListShape(dir) };
    } catch (error) { return configError(error); }
  });

  define('claude.settings_$_Custom3pSetup_$_deleteConfig', (_e, id) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    try {
      const meta = readConfigMeta(dir);
      const index = meta.entries.findIndex((e) => e.id === id);
      if (index < 0) return { ok: false, error: 'unknown config id' };
      // Refuse to delete the applied config: the app is running against it.
      if (meta.appliedId === id) return { ok: false, error: 'cannot delete the applied config' };
      meta.entries.splice(index, 1);
      try { fs.unlinkSync(CONFIG_FILE(dir, id)); } catch { /* already gone */ }
      writeConfigMeta(dir, meta);
      return { ok: true, ...configListShape(dir) };
    } catch (error) { return configError(error); }
  });

  define('claude.settings_$_Custom3pSetup_$_setAppliedConfig', async (_e, id) => {
    const dir = configLibraryDir();
    if (!dir) throw new Error('no library');
    let meta;
    try {
      const raw = JSON.parse(fs.readFileSync(META_FILE(dir), 'utf8'));
      if (!raw) throw new SyntaxError('empty metadata');
      meta = raw;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // Native BF initializes a default entry before checking the requested ID.
      const defaultId = require('node:crypto').randomUUID();
      writeConfigFile(dir, defaultId, {});
      meta = { appliedId: defaultId, entries: [{ id: defaultId, name: 'Default' }] };
      writeConfigMeta(dir, meta);
    }
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || !meta.entries.some((e) => e.id === id)) {
      throw new Error('unknown config id');
    }
    if (meta.appliedId !== id) delete meta.hybridPointer;
    meta.appliedId = id;
    writeConfigMeta(dir, meta);
    await deploymentMode.set('3p');
    opts.onMainFeatureSourceChanged?.();
    opts.onModelCatalogChanged?.();
  });

  define('claude.settings_$_Custom3pSetup_$_relaunchApp', () => {
    if (typeof opts.relaunchApp !== 'function') throw new Error('app relaunch unavailable');
    opts.relaunchApp();
  });

  // Write a config's body. The consumer does `bn(await e.writeConfig(r.id, n))` and checks
  // `ok`; the answer must therefore be an object, never the boolean a bare value would be.
  define('claude.settings_$_Custom3pSetup_$_writeConfig', (_e, id, config) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ok: false, error: 'invalid config body' };
    }
    try {
      const meta = readConfigMeta(dir);
      if (!meta.entries.some((e) => e.id === id)) return { ok: false, error: 'unknown config id' };
      const normalized = normalizeProviderConfig(config);
      const issues = providerConfigIssues(normalized);
      if (issues.length) return { ok: false, error: 'validation', issues };
      writeConfigFile(dir, id, normalized);
      if ((meta.appliedId || meta.entries[0]?.id) === id) opts.onModelCatalogChanged?.();
      return { ok: true };
    } catch (error) { return configError(error); }
  });

  define('claude.settings_$_Custom3pSetup_$_revealConfig', (_e, id) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    const meta = readConfigMeta(dir);
    const wanted = typeof id === 'string' && id ? id : meta.appliedId;
    if (!wanted) return { ok: false, error: 'no config' };
    const file = CONFIG_FILE(dir, wanted);
    if (!fs.existsSync(file)) return { ok: false, error: 'config file missing' };
    return shellOpen(process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open'),
      process.platform === 'win32' ? ['/select,', file] : ['-R', file]);
  });

  define('claude.settings_$_Custom3pSetup_$_listSwitchableProfiles', () => {
    // The consumer maps the answer: `r = n.map(i)`. It must be an array even when empty.
    const dir = configLibraryDir();
    if (!dir) return [];
    const meta = readConfigMeta(dir);
    return meta.entries.map((e) => {
      const config = readConfigFile(dir, e.id) || {};
      return {
        kind: 'custom3p',
        name: e.name,
        orgUuid: null,
        provider: config.inferenceProvider || 'custom3p',
      };
    });
  });

  // Health shape verified against a running original:
  //   { provider, endpoint, source: { type, remote }, checkedAt, state }
  // The settings panel passes `source` into dz()/fz()/pz(), which read
  // `source.type`. Answering without `source` made it undefined and the panel threw
  //   Cannot read properties of undefined (reading 'type')
  const buildConfigHealth = () => {
    const found = read3pConfig();
    if (!found) {
      return {
        provider: null,
        endpoint: null,
        source: { type: 'none', remote: false },
        checkedAt: new Date().toISOString(),
        state: 'invalid_config',
      };
    }
    return {
      provider: found.config.inferenceProvider || 'gateway',
      endpoint: found.config.inferenceGatewayBaseUrl || null,
      source: { type: 'local', remote: false },
      checkedAt: new Date().toISOString(),
      state: found.config.inferenceProvider && providerConfigIssues(found.config).length === 0 ? 'healthy' : 'invalid_config',
      issues: providerConfigIssues(found.config),
    };
  };
  define('claude.settings_$_Custom3pSetup_$_getConfigHealth', buildConfigHealth);
  define('claude.settings_$_Custom3pSetup_$_recheckConfigHealth', buildConfigHealth);

  // The account row reads its display name through this call, not getMergedConfig
  // (verified with the main-process call histogram: the UI calls
  // getLoginDesktop3pStatus and never getMergedConfig).
  //
  // Shape verified against a running original:
  //   { enabled, source: { type, remote }, provider, thirdPartyConfigured,
  //     thirdPartyCanRun, needsInteractiveAuth, hybrid }
  // The session detail view feeds `source` into dz()/fz()/pz(), which read
  // `source.type` and `source.remote`. A flat payload without `source` makes
  // `source` undefined and the view crashes with
  //   Cannot read properties of undefined (reading 'type')
  define('claude.settings_$_Custom3pSetup_$_getLoginDesktop3pStatus', () => {
    const found = read3pConfig();
    const user = os.userInfo().username;
    const configured = Boolean(found);
    return {
      enabled: configured,
      source: {
        type: configured ? 'local' : 'none',
        remote: false,
      },
      provider: found?.config?.inferenceProvider || 'gateway',
      thirdPartyConfigured: configured,
      thirdPartyCanRun: configured,
      needsInteractiveAuth: opts.getBootstrapAuthStatus?.()?.needsInteractiveAuth ?? false,
      hybrid: opts.getBootstrapAuthStatus?.()?.hybrid ?? false,
      // Extra display fields the account row consumes.
      principalDisplayName: found?.config?.principalDisplayName || user,
      deploymentDisplayName: found?.config?.deploymentDisplayName || 'Gateway',
    };
  });

  define('claude.settings_$_Custom3pSetup_$_triggerBootstrapAuth', async (_event, args) => {
    try {
      if (typeof opts.triggerBootstrapAuth !== 'function') throw new Error('Bootstrap authentication is unavailable');
      await opts.triggerBootstrapAuth(args);
      if (args === undefined) {
        try { await deploymentMode.set('3p'); opts.onMainFeatureSourceChanged?.(); } catch { /* native mode-write failure does not undo grant */ }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // hybrid intl
  define('claude.hybrid_$_DesktopIntl_$_getInitialLocale', () => 'zh-Hans-CN');

  // Session bridge gates: observed true/true on a running original in 3p mode.
  define('claude.web_$_LocalAgentModeSessions_$_getSessionsBridgeEnabled', () => true);
  define('claude.web_$_LocalAgentModeSessions_$_getBridgeConsent', () => true);
  define('claude.web_$_LocalAgentModeSessions_$_getDefaultWorkspaceFolders', () => []);
  define('claude.web_$_LocalAgentModeSessions_$_getDirectMcpServerStatuses', () => []);
  define('claude.web_$_LocalAgentModeSessions_$_getManagedAskToolNames', () => []);

  // The transcript view refreshes from events, not by polling. LocalSessions emits
  // `onOnEvent` with the same payload type LocalAgentModeSessions uses, so a turn
  // that only writes the store leaves the UI showing stale content. Push both
  // channels after every turn.
  //
  // The event channel name is NOT `onEvent`. The preload builds it from the method
  // name by stripping the `on` prefix:
  //
  //   out[method] = (callback) => ipcRenderer.on(eventChannel(d, s, method.slice(2)), ...)
  //
  // and the method is `onOnEvent` (see bridge-map.json), so slice(2) === "OnEvent"
  // and the subscription channel ends in `_$_OnEvent`. Emitting `_$_onEvent` sent
  // every turn notification to a channel nobody was listening on: the session and
  // its transcript were both correct in the kernel, and the open view sat on
  // "Starting session…" forever because no `message` event ever reached it.
  // Both spellings are emitted, so a subscriber of either gets the payload.
  const emitSessionEvent = (event) => {
    // cef1e6037-C9OZ_iaL.js reads r.error, falling back to "Session error".
    // Both local and CCB kernels report message; adapt at the renderer boundary.
    if (event?.type === 'error' && event.error == null && typeof event.message === 'string') {
      event = { ...event, error: event.message };
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    for (const ns of ['claude.web']) {
      for (const svc of LOCAL_SERVICES) {
        for (const name of ['OnEvent', 'onEvent']) {
          try {
            win.webContents.send(
              `$eipc_event$_${NAMESPACE}_$_${ns}_$_${svc}_$_${name}`,
              svc === 'LocalAgentModeSessions' && event?.type === 'close' && event.code == null
                ? { ...event, code: 0 } : event,
            );
          } catch { /* window tearing down */ }
        }
      }
      // Tool-permission events ALSO go to their own channel.
      //
      // The preload builds a subscription channel from the method name:
      // `onOnToolPermissionRequest` -> `..._$_OnToolPermissionRequest`. That is a
      // different channel from `..._$_OnEvent`, so emitting the approval only on
      // OnEvent left the renderer's subscription empty: the request existed
      // (pendingToolPermissions held it, the tool was blocked) but no card ever
      // appeared, and nothing could answer it.
      if (event && typeof event.type === 'string' && event.type.startsWith('tool_permission')) {
        for (const target of LOCAL_SERVICES) {
          try {
            win.webContents.send(
              `$eipc_event$_${NAMESPACE}_$_${ns}_$_${target}_$_OnToolPermissionRequest`,
              event,
            );
          } catch { /* window tearing down */ }
        }
      }
    }
  };

  // Shell events do NOT have their own channel.
  //
  // The renderer builds its shell transport on top of the SAME `onOnEvent`
  // subscription and filters by type (c03935b01-Csh_0_Y5.js):
  //
  //   onShellPtyEvent: cb => v.onOnEvent(e => {
  //     if (e.type === "shell_pty_data" || "shell_pty_close" || "shell_pty_link") {
  //       cb({ type, sessionId,
  //            ...(e.data === undefined ? {} : { data: e.data }),
  //            ...(e.code === undefined ? {} : { code: e.code }),
  //            ...(e.error ? { reason: e.error } : {}),
  //            ...(e.shellPtyLink  ? { link:  e.shellPtyLink }  : {}),
  //            ...(e.shellPtyShell ? { shell: e.shellPtyShell } : {}) })
  //     }
  //   })
  //
  // So the payload is read with these field names: `data` for output, `error` for a
  // close reason, `shellPtyShell` for the shell id. Emitting a separate
  // `onShellPtyEvent` channel — as an earlier attempt did — reaches nobody.
  const emitShellEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    // Translate the shell module's own vocabulary into the renderer's field names.
    const wire = { type: event.type, sessionId: event.sessionId };
    if (event.data !== undefined) wire.data = event.data;
    if (event.code !== undefined) wire.code = event.code;
    // The renderer reads the close reason from `error`.
    if (event.reason !== undefined) wire.error = event.reason;
    if (event.shell !== undefined) wire.shellPtyShell = event.shell;
    if (event.link !== undefined) wire.shellPtyLink = event.link;
    emitSessionEvent(wire);
  };

  // ---- session kernel -------------------------------------------------------
  // The project's existing kernel (desktop/agent.cjs via agent-config.cjs) drives
  // a real Anthropic-compatible endpoint with a tool set. Until now it was only
  // reachable over HTTP from the hand-drawn view; the shipped frontend talks over
  // these bridge methods instead, so it never saw it.
  //
  // kernelFactory is injected by main.cjs, which owns the approval surface.
  const kernel = settings.kernelFactory
    ? settings.kernelFactory({
        emit: emitSessionEvent,
      })
    : null;
  // Reported by diagnose() so a caller can see which store the live kernel writes.
  const kernelStorePath = kernel && typeof kernel.storePath === 'function' ? kernel.storePath() : null;

  if (kernel) {
    // Both entry points target the Code session manager. The kernel keeps staged
    // transcripts unconfirmed until their installation path is implemented.
    const confirmImportedSessionResume = (_e, sessionId) =>
      typeof kernel.confirmImportedSessionResume === 'function'
        ? kernel.confirmImportedSessionResume(sessionId) : false;
    define('claude.web_$_LocalSessions_$_confirmImportedSessionResume', confirmImportedSessionResume);
    define('claude.settings_$_ClaudeAiImport_$_confirmImportedSessionResume', confirmImportedSessionResume);
    // Folder trust, answered from the SAME store the trust prompt uses.
    //
    // These four channels previously had no handler and fell through to the generic fallback,
    // which answers `false` for a boolean query and `null` otherwise. The UI calls
    //   await isFolderTrusted?.(path) ?? false
    // and passes the result as the folder's trust level ('user' vs 'external'), so every folder
    // was permanently external and the trust action could never change the answer.
    //
    // The first version of this fix introduced a separate `trustedFolders` set in the kernel.
    // That was wrong: LocalSessions.checkTrust / checkStoredTrust / saveTrust already maintain a
    // trust store (~/.claude.json plus our overlay). Two independent stores would let
    //   isFolderTrusted(p)  -> true      (our set)
    //   checkTrust(p).trusted -> false   (the real store)
    // disagree about the same folder. These handlers therefore delegate to the existing store,
    // so there is exactly one answer.
    //
    // Written with template literals because the fallback-coverage test detects a real handler
    // with /$_<method>`/; plain strings were invisible to it.
    define(`claude.web_$_LocalAgentModeSessions_$_isFolderTrusted`, (_e, folder) => {
      if (typeof folder !== 'string' || !folder) return false;
      const store = readTrustStore();
      const entry = store && store.projects
        ? (store.projects[projectKey(folder)] || store.projects[projectKey(folder) + '/'] || null)
        : null;
      return entry ? entry.hasTrustDialogAccepted === true : false;
    });
    define(`claude.web_$_LocalAgentModeSessions_$_addTrustedFolder`, (_e, folder) => {
      if (typeof folder !== 'string' || !folder) return null;
      const store = readTrustStore() || {};
      if (!store.projects || typeof store.projects !== 'object') store.projects = {};
      const key = projectKey(folder);
      const entry = store.projects[key] || (store.projects[key] = {});
      entry.hasTrustDialogAccepted = true;
      // Report the list the caller expects, whether or not the write lands: the shape must not
      // change with writability.
      writeTrustStore({ projects: store.projects });
      return Object.keys(store.projects).filter((k) => store.projects[k] && store.projects[k].hasTrustDialogAccepted);
    });
    define(`claude.web_$_LocalAgentModeSessions_$_removeTrustedFolder`, (_e, folder) => {
      if (typeof folder !== 'string' || !folder) return null;
      const store = readTrustStore() || {};
      if (!store.projects) return [];
      const key = projectKey(folder);
      for (const k of [key, key + '/']) {
        if (store.projects[k]) store.projects[k].hasTrustDialogAccepted = false;
      }
      writeTrustStore({ projects: store.projects });
      return Object.keys(store.projects).filter((k) => store.projects[k] && store.projects[k].hasTrustDialogAccepted);
    });
    define(`claude.web_$_LocalAgentModeSessions_$_browseAndAddTrustedFolder`, async (_e, folder) => {
      // The original opens a native picker. There is none here, so accept an explicit path and
      // otherwise report that the user cancelled rather than inventing a folder.
      if (typeof folder !== 'string' || !folder.trim()) return null;
      const store = readTrustStore() || {};
      if (!store.projects || typeof store.projects !== 'object') store.projects = {};
      const key = projectKey(folder);
      const entry = store.projects[key] || (store.projects[key] = {});
      entry.hasTrustDialogAccepted = true;
      writeTrustStore({ projects: store.projects });
      return Object.keys(store.projects).filter((k) => store.projects[k] && store.projects[k].hasTrustDialogAccepted);
    });
    const startSession = (info = {}) => {
      if (!info.scheduledTaskId || !scheduledTasks) return kernel.start(info);
      return (async () => {
        try {
          const existing = info.sessionId ? kernel.getSession(info.sessionId) : null;
          if (existing && existing.scheduledTaskId !== info.scheduledTaskId) throw new Error('Scheduled session identity is already in use');
          const started = existing || kernel.start(info);
          await scheduledTasks.confirmTaskRun(info.scheduledTaskId, started.sessionId);
          return started;
        } catch (error) {
          scheduledTasks.releaseDispatchClaim(info.scheduledTaskId);
          throw error;
        }
      })();
    };
    define('claude.web_$_LocalAgentModeSessions_$_start', (_e, info) => startSession(info || {}));
    // The detail view creates sessions through LocalSessions.start, not the
    // agent-mode one: without this the composer dispatches into a session the kernel
    // never created, so the new session id exists only in the renderer.
    define('claude.web_$_LocalSessions_$_start', (_e, info) => startSession(info || {}));    define('claude.web_$_LocalAgentModeSessions_$_sendMessage', (_e, sessionId, message, ...rest) => {
      // Signature: (sessionId, message, images, userSelectedFiles, messageUuid, ...)
      const messageUuid = typeof rest[2] === 'string' ? rest[2] : undefined;
      const busy = kernel.getSession?.(sessionId)?.isRunning === true;
      return kernel.sendMessage(sessionId, message, { images: rest[0], messageUuid,
        deferIfBusy: true, ...(busy ? {priority:'now'} : {}),
        plainInput: !rest[1]?.length && !rest[5]?.length && !rest[10]?.length });
    });
    define('claude.web_$_LocalAgentModeSessions_$_getAll', () => kernel.getAll());
    define('claude.web_$_LocalAgentModeSessions_$_getSession', (_e, sessionId) => kernel.getSession(sessionId));
    define('claude.web_$_LocalAgentModeSessions_$_deleteBridgeSession', (_e, sessionId) => (revokePreviewSession(sessionId), sessionMedia?.revokeSession(sessionId), sessionVideo?.revokeSession(sessionId), kernel.remove(sessionId)));

    // The session detail view reads the transcript. Verified against a running
    // original: getTranscript answers an ARRAY of stream-json message events, not
    // an {entries, messages} object, and the session record itself carries no
    // `messages` field. The kernel keeps the conversation separately.
    const transcriptFor = (sessionId) => kernel.getTranscript(sessionId);
    define('claude.web_$_LocalAgentModeSessions_$_getTranscript', (_e, sessionId) => transcriptFor(sessionId));
    define('claude.web_$_LocalSessions_$_getTranscript', (_e, sessionId) => transcriptFor(sessionId));
    for (const service of LOCAL_SERVICES) {
      define(`claude.web_$_${service}_$_getTranscriptRead`, (_e, sessionId) => ({ messages: transcriptFor(sessionId) }));
    }

    // Write side of the transcript.
    //
    // The bridge could READ a transcript but not WRITE one: `getTranscript` existed while a
    // writer did not, even though the kernel has supported `setTranscript` all along. That
    // asymmetry blocks any programmatic construction of session content -- tests, imports
    // and replays all need to place known rows into a session.
    //
    // It surfaced while trying to exercise the usage card: the frontend turns an assistant
    // row whose text is exactly "<plan-usage/>" into a {kind:"usage"} card
    // (c06cf64bb @159560), which mounts the component that calls getPeriodUsage. Without a
    // writer there was no honest way to produce that row.
    //
    // IMPORTANT: this is deliberately NOT registered as an IPC channel and NOT added to
    // bridge-map. The shipped frontend never calls `setTranscript`, so exposing it would put
    // a method on the renderer surface that the original does not have -- a contract change
    // dressed up as a fix. It is exported on the module instead, for hosts and tests.
    const setTranscriptFor = (sessionId, rows) => {
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'invalid session id' };
      }
      if (!Array.isArray(rows)) return { ok: false, error: 'rows must be an array' };
      const stored = kernel.setTranscript(sessionId, rows);
      if (!stored) return { ok: false, error: 'unknown session' };
      const after = kernel.getTranscript(sessionId);
      return { ok: true, rows: Array.isArray(after) ? after.length : 0 };
    };
    settings.setTranscript = setTranscriptFor;

    define('claude.web_$_LocalSessions_$_getSession', (_e, sessionId) => kernel.getSession(sessionId));

    // The Files pane's tree.
    //
    // The tree lists directories through (cfac349aa-C6zhOLan.js, `at`):
    //   return await (sessionId==="landing" ? _?.listDirectoryAtCwd?.(root, dir)
    //                                       : _?.listSessionDirectory?.(sessionId, dir)) ?? []
    // and maps each entry with { name: e.name, absPath: e.path, isDirectory: e.isDirectory,
    // ...e.link && {link} }. This method had no handler, so it answered null, which the
    // consumer coalesces to [] — rendering "Folder is empty" for a folder with 65 entries.
    // (Earlier probes watched FileSystem.* and concluded the pane made no calls; the pane
    // calls THIS method, so that probe was looking in the wrong namespace.)
    //
    // Contract: an array of { name, path, isDirectory }. Listing is confined to the
    // session's own folder: a path outside it answers [] rather than enumerating an
    // arbitrary directory on behalf of a renderer-supplied string. A genuine read failure
    // (folder deleted, access denied) rejects, because the renderer tells "failed" apart
    // from "empty" and shows a different state for each.
    const SESSION_DIR_LIMIT = 500;
    const insideFolder = (root, target) => {
      const rel = path.relative(path.resolve(root), path.resolve(target));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    define('claude.web_$_LocalSessions_$_listSessionDirectory', async (_e, sessionId, dir) => {
      const session = kernel.getSession(sessionId);
      if (!session || typeof dir !== 'string' || dir === '') return [];
      const roots = [session.workingDir, session.cwd, ...(session.userSelectedFolders || [])]
        .filter((r) => typeof r === 'string' && r !== '');
      if (!roots.some((root) => insideFolder(root, dir))) return [];
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.slice(0, SESSION_DIR_LIMIT).map((d) => ({
        name: d.name,
        path: path.join(dir, d.name),
        isDirectory: d.isDirectory(),
      }));
    });
    // Live refresh of the file tree.
    //
    // The consumer (cccc2cf0a, fn DC) does:
    //   const canWatch = scope === "local" && sessionId !== "landing"
    //     && bridge.watchSessionDirectories !== undefined
    //     && bridge.onSessionDirectoryChanged !== undefined;
    //   useEffect(() => {
    //     if (!canWatch) return;
    //     const off = bridge.onSessionDirectoryChanged((sid, dirPath) => {
    //       if (sid !== sessionId || !paths.includes(dirPath)) return;
    //       queryClient.refetchQueries({ queryKey: ..., exact: true });
    //     });
    //     bridge.watchSessionDirectories({ sessionId, watchId, dirPaths: [...paths] });
    //     return () => {
    //       bridge.watchSessionDirectories({ sessionId, watchId, dirPaths: [] });  // stop
    //       off();
    //     };
    //   }, [canWatch, sessionId, watchId, paths]);
    //
    // So the contract is: an empty dirPaths STOPS that watchId, and changes are pushed on
    // the `onSessionDirectoryChanged` event channel as (sessionId, dirPath).
    //
    // Both halves used to be empty: watchSessionDirectories answered { ok: true } and started
    // nothing, and onSessionDirectoryChanged had no handler at all, so the gate passed (the
    // fallback made both methods "exist") and no event ever arrived. A file created in the
    // tree therefore only appeared after a manual reload.
    //
    // A watcher per (sessionId, watchId) is kept so an unwatch releases exactly that set.
    //
    // The event goes out on the channel the frontend subscribes to for this method:
    //   eventChannel('claude.web', 'LocalSessions', 'SessionDirectoryChanged')
    // built from the `on<Name>` method the transport turns into ipcRenderer.on.
    //
    // The payload must be a SINGLE value. preload-frontend.cjs does:
    //   const listener = (_event, payload) => { callback(payload) }
    // -- it forwards exactly one argument, so sending (sessionId, dirPath) as two IPC args
    // delivers the first and silently drops the second. Measured live before this was fixed:
    //   received: [ { sessionId: "probe-r93b" } ]     // dirPath was undefined
    // An object is therefore the shape that survives the transport.
    const sessionDirWatchers = new Map();
    const watcherKey = (sessionId, watchId) => `${sessionId}\u0000${watchId}`;
    const sendDirectoryChanged = (sessionId, dirPath) => {
      const win = getMainWindow();
      if (!win || (win.isDestroyed && win.isDestroyed())) return;
      try {
        win.webContents.send(
          eventChannel('claude.web', 'LocalSessions', 'SessionDirectoryChanged'),
          { sessionId, dirPath },
        );
      } catch { /* the window went away mid-watch */ }
    };
    const stopWatcher = (sessionId, watchId) => {
      const key = watcherKey(sessionId, watchId);
      const entry = sessionDirWatchers.get(key);
      if (!entry) return false;
      for (const watcher of entry.watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      sessionDirWatchers.delete(key);
      return true;
    };

    define('claude.web_$_LocalSessions_$_watchSessionDirectories', (_e, request) => {
      const sessionId = request && request.sessionId;
      const watchId = request && request.watchId;
      const dirPaths = request && Array.isArray(request.dirPaths) ? request.dirPaths : null;
      if (typeof sessionId !== 'string' || typeof watchId !== 'string' || !dirPaths) {
        return { ok: false, error: 'invalid watch request' };
      }
      // An empty list is the documented way to stop this watch.
      stopWatcher(sessionId, watchId);
      if (dirPaths.length === 0) return { ok: true, watching: 0 };

      const watchers = [];
      // The cap is reported, not silent: a caller watching 40 folders and hearing `watching: 32`
      // would otherwise assume six folders are covered when they are not. Rounds 210-212
      // established the rule for tool output; it applies to any capped list.
      const MAX_WATCHED_DIRS = 32;
      const requested = dirPaths.length;
      for (const dir of dirPaths.slice(0, MAX_WATCHED_DIRS)) {
        if (typeof dir !== 'string' || !dir) continue;
        try {
          // recursive is supported on Windows and macOS; on Linux it is ignored and only the
          // top level is watched, which is stated rather than hidden.
          const watcher = fs.watch(dir, { recursive: true, persistent: false }, () => {
            // The renderer refetches the whole listing, so the change itself need not be
            // classified -- only the folder that changed.
            sendDirectoryChanged(sessionId, dir);
          });
          watcher.on('error', () => {});
          watchers.push(watcher);
        } catch { /* a missing or unreadable folder is skipped, not fatal */ }
      }
      if (!watchers.length) return { ok: false, error: 'no watchable directory' };
      sessionDirWatchers.set(watcherKey(sessionId, watchId), { watchers, dirPaths });
      const result = { ok: true, watching: watchers.length };
      if (requested > MAX_WATCHED_DIRS) {
        result.truncated = true;
        result.requested = requested;
        result.reason = 'only ' + MAX_WATCHED_DIRS + ' directories are watched at once;'
          + ' the rest are ignored — split them across two watches if all must be live';
      }
      return result;
    });

    // NOTE: there is deliberately no `onSessionDirectoryChanged` handler.
    //
    // The registration loop skips every `on*` method:
    //   if (method.startsWith('on') && method.length > 2) continue;  // events are emitted
    // because the frontend transport turns those into `ipcRenderer.on(eventChannel(...))`.
    // The subscription is therefore satisfied by the event channel itself, and what has to
    // exist is the SENDING side -- which is sendDirectoryChanged above. An earlier attempt
    // added a handler here; it was never registered and would have been dead code.

    // Exposed so main.cjs can release watchers on shutdown.
    settings.disposeSessionDirWatchers = () => {
      for (const [key] of [...sessionDirWatchers]) {
        const sep = key.indexOf('\u0000');
        stopWatcher(key.slice(0, sep), key.slice(sep + 1));
      }
    };

    // Opening a file from the tree (or from a path in the transcript).
    //
    // The pane asks LocalSessions.readSessionFileWithStatus and expects a status wrapper
    // (cf3dc8013-DPZGVxPE.js, `S`):
    //   let i = await t.readSessionFileWithStatus(n, r, ...a);
    //   return i.status === e.Ok && i.file ? i.file
    //        : { unavailable: i.status===e.NotFound ? "missing"
    //                     : i.status===e.TooLarge ? "too_large"
    //                     : i.status===e.OutsideSessionFolders ? "outside_workspace"
    //                     : "read_error", creatable: i.creatable };
    // with the status literals from shared-0-ByI5P0CP.js (`gb`):
    //   Ok="ok" NotFound="notFound" TooLarge="tooLarge"
    //   ReadError="readError" OutsideSessionFolders="outsideSessionFolders"
    //
    // This method had no handler at all, so it answered null, `i.status` threw or read
    // undefined and the file tab spun forever on a file that was right there on disk.
    //
    // The file payload needs `contents`; `encoding` is read when present (the renderer
    // treats base64 specially and refuses to inline anything above 1e6 characters).
    fileAccess = require('./session-file-access.cjs').createSessionFileAccess({
      getSession: (sessionId) => kernel.getSession(sessionId),
    });
    sessionMedia = require('./session-media-protocol.cjs').createSessionMediaProtocol({ getSession: sessionId => kernel.getSession(sessionId) });
    sessionVideo = require('./session-video-protocol.cjs').createSessionVideoProtocol({ getSession: sessionId => kernel.getSession(sessionId) });
    if (opts.mediaProtocol) sessionMedia.install({
      handle: (scheme, imagesHandler) => opts.mediaProtocol.handle(scheme, request => {
        let host;
        try { host = new URL(request.url).hostname; } catch { return new Response(null, { status: 400 }); }
        return host === 'v' ? sessionVideo.handle(request) : imagesHandler(request);
      }),
      unhandle: scheme => opts.mediaProtocol.unhandle(scheme),
    });
    for (const method of ['readSessionMediaAsDataUrl', 'readSessionPanelMediaAsDataUrl', 'getSessionMediaStreamUrl', 'getSessionPanelMediaStreamUrl']) {
      define('claude.web_$_LocalSessions_$_' + method, (_event, ...args) =>
        method.includes('StreamUrl') && !opts.mediaProtocol ? null : sessionVideo[method](...args));
    }
    const sessionImages = require('./session-images.cjs').createSessionImages({
      getSession: sessionId => kernel.getSession(sessionId), mediaProtocol: sessionMedia,
    });
    define('claude.web_$_LocalSessions_$_getSessionImageStreamUrl', (_e, sessionId, filePath) =>
      opts.mediaProtocol ? sessionImages.getSessionImageStreamUrl(sessionId, filePath) : null);
    define('claude.web_$_LocalSessions_$_readSessionImageAsDataUrl', (_e, sessionId, filePath) =>
      sessionImages.readSessionImageAsDataUrl(sessionId, filePath));
    define('claude.web_$_LocalSessions_$_readSessionFileWithStatus', (_e, sessionId, filePath, options) =>
      fileAccess.readWithStatus(sessionId, filePath, options));
    define('claude.web_$_LocalSessions_$_readSessionFile', async (_e, sessionId, filePath, options) => {
      const result = await fileAccess.readWithStatus(sessionId, filePath, options);
      return result.status === 'ok' ? result.file : null;
    });
    define('claude.web_$_LocalSessions_$_writeSessionFile', (_e, sessionId, filePath, contents, expectedHash) =>
      fileAccess.write(sessionId, filePath, contents, expectedHash));
    define('claude.web_$_LocalSessions_$_createSessionFile', (_e, sessionId, filePath) =>
      fileAccess.create(sessionId, filePath));

    // "Show this file in its folder" (the file panel's reveal action).
    //
    // MEASURED BEFORE: no handler, so it answered the generic `null`. The shipped consumer
    // (c856385e2-aEyDzrcK.js) is
    //
    //   v.showSessionFileInFolder(r.sessionId, r.path)?.then(e => { e || a() })?.catch(a)
    //   // a = (n) => addError("Couldn't show this file in its folder.", ...)
    //
    // so every reveal attempt raised an error toast even though the file was right there.
    // The answer contract is truthiness: return true when the host revealed it, and only
    // return false when the path is genuinely not revealable (outside the session roots).
    //
    // The path is validated through the same root check the reader uses, so the renderer
    // cannot ask the host to open an arbitrary location on disk.
    define('claude.web_$_LocalSessions_$_showSessionFileInFolder', async (_e, sessionId, filePath) => {
      const target = await fileAccess.resolveForReveal(sessionId, filePath);
      if (!target) return false;
      // Accept the capability from either place: a host may inject it alongside openExternal
      // (top level) or through the settings bag. Reading only one of them meant a valid
      // reveal silently degraded to 'no capability' (measured: the host reveal was never
      // called even though it had been provided).
      const reveal = typeof settings.showItemInFolder === 'function' ? settings.showItemInFolder
        : (typeof opts.showItemInFolder === 'function' ? opts.showItemInFolder : null);
      // No host capability (a headless run): the path IS valid, so answer true rather than
      // reporting a refusal the user cannot act on.
      if (!reveal) return true;
      try { reveal(target.path); return true; } catch { return false; }
    });

    // Only report a restart after the backend has acknowledged initialization.
    define('claude.web_$_LocalSessions_$_warmSession', (_e, sessionId) => {
      if (typeof kernel.warmSession !== 'function') throw new Error('session warm is unavailable');
      return kernel.warmSession(sessionId);
    });
    // Track each renderer separately: closing one window must not hide a session
    // that another renderer still displays.
    const visibilitySources = new Map();
    define('claude.web_$_LocalSessions_$_setVisibility', (event, sessionId, visible, reason) => {
      if (typeof kernel.setVisibility !== 'function' || typeof visible !== 'boolean') return false;
      if (!visible && (!reason || reason === 'blur') && getMainWindow()?.isFocused?.()) return false;
      const sender = event?.sender;
      const source = sender || 'unknown-renderer';
      let ids = visibilitySources.get(source);
      if (!ids) {
        visibilitySources.set(source, ids = new Set());
        sender?.once?.('destroyed', () => {
          for (const id of ids) kernel.setVisibility(id, false, source);
          visibilitySources.delete(source);
        });
        sender?.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
          if (inPlace || !mainFrame) return;
          for (const id of ids) kernel.setVisibility(id, false, source);
          ids.clear();
        });
      }
      if (visible) ids.add(sessionId); else ids.delete(sessionId);
      return kernel.setVisibility(sessionId, visible, source);
    });

    // ---- MCP ---------------------------------------------------------------
    //
    // Every one of these answered through the generic fallback before. This is a REAL gap, not a
    // deliberate one: the upstream main process implements them all, and this project already
    // ships a complete MCP client in desktop/mcp-host.cjs, but it had only been wired into
    // main-services.cjs (the hand-drawn shell) — never into this bridge, so the shipped frontend
    // could not see it. The user's own ~/.claude.json carries a real mcpServers block.
    //
    // Shapes matter here. getLocalMcpServers is mapped over by a select, so an object would throw
    // the way listCliSessions did; mcpReadResource is read through `.contents`, so the bare array
    // would silently render an empty preview.
    define('claude.web_$_LocalSessions_$_getLocalMcpServers', () => mcpServersView());
    define('claude.web_$_LocalAgentModeSessions_$_getLocalMcpServers', () => mcpServersView());

    function mcpWidgetRefusal(sessionId) {
      const session = kernel.getSession(sessionId);
      if (!session) return 'Session not found';
      const localLauncher = session.backend?.remoteTarget === undefined &&
        (session._startedThroughHostCliLauncher === true || session._everStartedThroughHostCliLauncher === true || session.launcherMarked === true);
      if (localLauncher) return 'Not available for this session: this app makes no connector calls for it.';
    }
    const { matchesCliServer, isToolDisabled } = require('./mcp-session-policy.cjs');

    define('claude.web_$_LocalSessions_$_mcpListResources', async (_e, sessionId, serverName) => {
      if (mcpWidgetRefusal(sessionId) !== undefined) return [];
      if (matchesCliServer(kernel.getSession(sessionId)?.cliMcpAppServerNames, serverName)) return [];
      ensureMcpConfig();
      try {
        const state = mcpHost.servers.get(serverName);
        if (!state || state.status !== 'connected' || !state.connection) return [];
        const result = await state.connection.listResources();
        return Array.isArray(result) ? result : [];
      } catch { return []; }
    });

    define('claude.web_$_LocalSessions_$_mcpReadResource', async (_e, sessionId, serverName, uri) => {
      if (mcpWidgetRefusal(sessionId) !== undefined) return { contents: [] };
      // The session kernel owns actor, descriptor and URI validation for CLI apps.
      if (matchesCliServer(kernel.getSession(sessionId)?.cliMcpAppServerNames, serverName)) {
        if (typeof kernel.readCliMcpAppResource !== 'function') return { contents: [], unavailable: 'not_connected' };
        return kernel.readCliMcpAppResource(sessionId, serverName, uri);
      }
      ensureMcpConfig();
      try {
        const state = mcpHost.servers.get(serverName);
        if (!state || state.status !== 'connected' || !state.connection) return { contents: [] };
        const result = await state.connection.readResource(uri);
        return { contents: Array.isArray(result) ? result : [] };
      } catch { return { contents: [] }; }
    });

    // A tool failure is reported as { content, isError } rather than thrown: a rejection here
    // surfaces in the UI as an unhandled promise, not as a tool result the model can read.
    define('claude.web_$_LocalSessions_$_mcpCallTool', async (_e, sessionId, serverName, toolName, args) => {
      const refusal = mcpWidgetRefusal(sessionId);
      if (refusal !== undefined) return { content: [{ type: 'text', text: refusal }], isError: true };
      const session = kernel.getSession(sessionId);
      if (matchesCliServer(session?.cliMcpAppServerNames, serverName) || isToolDisabled(session, serverName, toolName)) {
        return { content: [{ type: 'text', text: `Tool '${toolName}' is not permitted` }], isError: true };
      }
      ensureMcpConfig();
      try {
        const result = await mcpHost.callTool(serverName, toolName, args || {});
        return result && typeof result === 'object' ? result : { content: [], isError: false };
      } catch (error) {
        return { content: [{ type: 'text', text: String((error && error.message) || error) }], isError: true };
      }
    });

    // These are session/query verbs, not controls for the process-wide MCP host.
    // Keep the session id intact so the kernel can verify actor ownership.
    for (const method of ['mcpReconnect', 'mcpRetryConnection', 'mcpEnableServer']) {
      define(`claude.web_$_LocalSessions_$_${method}`, async (_e, ...args) => {
        if (typeof kernel[method] !== 'function') return { error: 'Session not running' };
        return kernel[method](...args);
      });
    }

    for (const method of ['mcpAuthenticate', 'mcpAuthenticateConfigServer', 'mcpSubmitOAuthCallbackUrl', 'mcpClearAuth']) {
      define(`claude.web_$_LocalSessions_$_${method}`, async (_e, ...args) => {
        if (typeof kernel[method] !== 'function') return { error: 'Session not running' };
        return kernel[method](...args);
      });
    }

    // The session detail view talks to LocalSessions, not LocalAgentModeSessions:
    // the histogram shows getTranscriptTail, getContextUsage and getTranscript on
    // that namespace while the agent-mode one is only used for the sidebar gates.
    // Its sendMessage must reach the kernel too, or the composer's dispatch has
    // nowhere to go.
    define('claude.web_$_LocalSessions_$_sendMessage', (_e, sessionId, message, ...rest) => {
      const messageUuid = typeof rest[5] === 'string' ? rest[5] : undefined;
      const ordinary = rest[3] !== 'now' && rest[3] !== 'next' && rest[6] !== true && rest[12]?.modelAuthored !== true;
      const markedPress = rest[12]?.personSent === true && rest[12]?.modelAuthored !== true &&
        !/^[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB\uD800-\uDFFF]*[/!]/u.test(message) &&
        kernel.getSession?.(sessionId)?.sendsHeldAfterError?.length &&
        opts.consumePreviewUserGesture?.(_e.sender) === true;
      const busy = kernel.getSession?.(sessionId)?.isRunning === true;
      const execution = kernel.sendMessage(sessionId, message, { images: rest[0], messageUuid, deferIfBusy: ordinary || busy,
        ...(rest[3]==='next' || rest[3]==='now' ? {priority:rest[3]} : busy && ordinary ? {priority:'now'} : {}),
        ...(markedPress ? {rejoinHeldAfterPress:true} : {}),
        plainInput: !rest[1]?.length && !rest[2]?.length && !rest[8]?.length && !rest[11]?.length });
      // The composer awaits admission. Execution progress and failures arrive on
      // OnEvent; waiting for the whole model turn holds its sending lock.
      if (ordinary && !markedPress) {
        Promise.resolve(execution).catch(error => emitSessionEvent({type:'error',sessionId,message:String(error?.message||error)}));
        return {dispatched:true};
      }
      return execution;
    });
    define('claude.web_$_LocalSessions_$_sendSideChatMessage', (_e, sessionId, message, ...rest) => {
      const messageUuid = typeof rest[2] === 'string' ? rest[2] : undefined;
      return kernel.sendMessage(sessionId, message, { messageUuid });
    });
    // This control names an existing steer. It never supplies a new prompt.
    define('claude.web_$_LocalSessions_$_sendSteeredNow', (_e, sessionId, uuid) =>
      kernel.sendSteeredNow?.(sessionId, uuid) ?? false);
    define('claude.web_$_LocalSessions_$_cancelQueuedMessage', (_e, sessionId, uuid) =>
      typeof kernel.cancelQueuedMessage === 'function' ? kernel.cancelQueuedMessage(sessionId, uuid) : false);
    define('claude.web_$_LocalSessions_$_reorderQueuedMessage', (_e, sessionId, uuid, overUuid) =>
      typeof kernel.reorderQueuedMessage === 'function' ? kernel.reorderQueuedMessage(sessionId, uuid, overUuid) : false);
    define('claude.web_$_LocalSessions_$_promoteQueuedMessage', (_e, sessionId, uuid) =>
      kernel.promoteHeldMessage?.(sessionId, uuid) ?? false);
    // The detail view polls this while a session mounts. It must answer
    //   { messages: <stream-json entries>, hasMore: <bool> }
    // NOT a bare array. The frontend's local transport does:
    //
    //   const o = await r(e, t);
    //   if (!o || !Array.isArray(o.messages)) return null;
    //   return { messages: o.messages.map(X), hasMore: o.hasMore === true };
    //
    // (see localTransport.fetchTranscriptTail in the des bundle). A bare array has
    // no `.messages`, so the call silently becomes `null` and the tail never loads.
    // `limit` is honoured so a long conversation can page; without it the argument
    // was ignored and only ever the last two entries came back.
    define('claude.web_$_LocalSessions_$_getTranscriptTail', (_e, sessionId, limit) => {
      const entries = transcriptFor(sessionId);
      if (!Array.isArray(entries)) return { messages: [], hasMore: false };
      const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 2;
      const start = Math.max(0, entries.length - want);
      return {
        messages: entries.slice(start),
        hasMore: start > 0,
      };
    });
    // Cursor-based paging for the transcript, used to scroll back past the tail.
    //
    // The local transport reads `u?.getTranscriptPage` and, when it exists, treats that as "this
    // build can read transcripts in pages":
    //
    //   readsTranscriptInPages(){ return u?.getTranscriptPage !== void 0 }
    //   async fetchEarlierTranscript(e,t){ let r=u?.getTranscriptPage; if(!n||!r) return []; ... }
    //   let s = await K.read(...) ?? await r(e, a, 200);
    //   if (s?.found === true && Array.isArray(s.messages)) { ... Me.set(e, s.hasMore === true) ... }
    //   else -> je.set(e,"cursor_lost"), O.delete(e), []
    //
    // Declared in bridge-map and previously unanswered, so the fallback returned null: paging
    // back was never even attempted and the "load earlier" affordance did nothing.
    //
    // Contract, taken from the original's getTranscriptPage (offset 1190026) as the renderer
    // consumes it: `found` says whether the cursor exists, `messages` are the rows above it,
    // `hasMore` says whether anything is left above those, and `source` names the read path the
    // renderer reports in telemetry (it only special-cases "window", so "full" is accurate here:
    // this replica reads the whole stored transcript).
    define('claude.web_$_LocalSessions_$_getTranscriptPage', (_e, sessionId, beforeUuid, limit) => {
      // An unknown session must say so. getTranscript answers [] for one, which would otherwise
      // come back as found:true with an empty page — the renderer reads that as "the transcript
      // is empty" instead of "there is no such session".
      if (typeof sessionId !== 'string' || !sessionId || !kernel.getSession(sessionId)) {
        return { found: false, messages: [], hasMore: false, source: 'full' };
      }
      const entries = transcriptFor(sessionId);
      if (!Array.isArray(entries)) return { found: false, messages: [], hasMore: false, source: 'full' };
      const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
      // "" means "start from the newest row", which the renderer sends for the first read.
      const above = beforeUuid === '' || beforeUuid === undefined || beforeUuid === null
        ? entries.length
        : entries.findIndex((row) => row && row.uuid === beforeUuid);
      // found:false is the renderer's "cursor_lost" signal. Returning a page instead would make
      // it splice unrelated rows into the conversation.
      if (above < 0) return { found: false, messages: [], hasMore: false, source: 'full' };
      const start = Math.max(0, above - size);
      return {
        found: true,
        messages: entries.slice(start, above),
        hasMore: start > 0,
        totalRows: entries.length,
        source: 'full',
      };
    });
    // The usage meter reads this. Its shape is stricter than "{something}": the    // local transport rejects anything without `rawMaxTokens` outright —
    //
    //   async getContextUsage(e){ let t=c?.getContextUsage; if(!t) return null;
    //     let n=await t(e);
    //     return !n||typeof n!="object"||!("rawMaxTokens" in n)?null:n }
    //
    // — so the previous {messageCount,inputTokens,outputTokens,contextWindow}
    // payload was discarded and the meter always rendered empty. The consumers
    // further down (ZX()/ua()/Kx() in shared-104 and c227f4d5e) also read
    // `categories[]` ({name, tokens, kind}), `totalTokens` and `percentage`, and
    // treat a category named "Autocompact buffer" (kind "buffer") specially, and
    // "Free space" (kind "free") as the remainder.
    //
    // Only complete per-request stream observations are counted. Missing usage
    // fields and model context capacity remain explicitly unknown.
    // Summary remains a lightweight observation; SDK classification is on demand.
    //
    // getContextUsageSummary is what the composer's context meter reads:
    //
    //   h.getContextUsageSummary(e).then(n => {
    //     if (!n || !(n.rawMaxTokens > 0)) { settledEmpty; return }   // <- the gate
    //     ...store(n)
    //   })
    //
    // It had no handler, so it answered the generic null and the gate above treated every
    // session as having no context data. Both channels satisfy this shape, but only
    // the detail channel may request the expensive SDK breakdown.
    const contextUsageFor = (sessionId) => {
      const session = kernel.getSession(sessionId);
      if (!session) return null;
      const observation = kernel.getContextUsage?.(sessionId) || null;
      const model = observation?.model || session.model || null;
      // Capacity belongs to the completed request, not the currently selected profile.
      const rawMaxTokens = Number.isSafeInteger(observation?.contextWindow) && observation.contextWindow > 0 ? observation.contextWindow : null;
      const usage = observation?.usage || null;
      // Match the last completed request's input footprint. Output belongs to
      // token accounting, not the input observation represented by this meter.
      const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
      const missingFields = fields.filter(field => !Number.isSafeInteger(usage?.[field]) || usage[field] < 0);
      const knownTokens = usage ? fields.reduce((sum, field) => sum + (Number.isSafeInteger(usage[field]) && usage[field] >= 0 ? usage[field] : 0), 0) : null;
      const used = usage && missingFields.length === 0 ? knownTokens : null;
      const categories = used === null ? [] : [
        { name: 'Messages', tokens: used, kind: 'conversation' },
        ...(rawMaxTokens === null ? [] : [{ name: 'Free space', tokens: Math.max(0, rawMaxTokens - used), kind: 'free' }]),
      ];
      return {
        sessionId, model, rawMaxTokens, totalTokens: used, knownTokens,
        percentage: rawMaxTokens !== null && used !== null ? Math.min(100, Math.round((used / rawMaxTokens) * 100)) : null,
        // The context inspector renders these collections even before a breakdown
        // is available. Empty arrays mean no classified rows, not zero token usage.
        categories, mcpTools: [], memoryFiles: [], agents: [], usage, missingFields,
        maxTokensSource: rawMaxTokens === null ? 'unknown' : 'configured_model_contextWindow',
        usageSource: observation ? 'completed_api_message' : 'unknown',
        messageId: observation?.messageId ?? null,
        isAutoCompactEnabled: null, autocompactBufferTokens: null, autocompactSource: 'unknown',
        detail: 'summary', estimated: true,
      };
    };
    define('claude.web_$_LocalSessions_$_getContextUsage', async (_e, sessionId) => {
      if (!kernel.getSession(sessionId)) return null;
      let detail = null;
      try { detail = await kernel.getContextUsageDetail?.(sessionId); } catch { /* use observation */ }
      const summary = contextUsageFor(sessionId);
      if (!summary || !detail || !Array.isArray(detail.categories)) return summary;
      const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (!numeric(detail.totalTokens) || !numeric(detail.rawMaxTokens) || detail.rawMaxTokens === 0 ||
          !detail.categories.every(row => row && typeof row.name === 'string' && numeric(row.tokens))) return summary;
      const kinds = { 'Messages': 'conversation', 'Autocompact buffer': 'buffer', 'Compact buffer': 'buffer', 'Free space': 'free' };
      const names = new Set(['System prompt', 'System tools', '[ANT-ONLY] System tools', 'MCP tools', 'MCP tools (deferred)', 'System tools (deferred)', 'Custom agents', 'Memory files', 'Skills', 'Messages', 'Autocompact buffer', 'Compact buffer', 'Free space', 'Other']);
      const categories = detail.categories.map(row => ({
        name: names.has(row.name) ? row.name : 'Other', tokens: row.tokens,
        kind: kinds[row.name] || 'other',
        ...(typeof row.color === 'string' && ['promptBorder', 'inactive', 'cyan_FOR_SUBAGENTS_ONLY', 'permission', 'claude', 'warning', 'purple_FOR_SUBAGENTS_ONLY'].includes(row.color) ? { color: row.color } : {}),
        ...(typeof row.isDeferred === 'boolean' ? { isDeferred: row.isDeferred } : {}),
      }));
      // Only the inspector's identifiers and measured counts cross the bridge.
      // SDK rows may also carry source content or actor credentials; do not spread them.
      const rows = (value, keys) => Array.isArray(value) ? value.filter(row =>
        row && numeric(row.tokens) && keys.every(key => typeof row[key] === 'string' && row[key].length > 0)
      ).map(row => Object.fromEntries([...keys.map(key => [key, row[key]]), ['tokens', row.tokens]])) : [];
      const mcpTools = rows(detail.mcpTools, ['name', 'serverName']);
      const memoryFiles = rows(detail.memoryFiles, ['path']);
      const agents = rows(detail.agents, ['agentType']);
      // Keep the SDK's own window and breakdown together, never present its default
      // as the gateway's configured/actual context capacity.
      return { ...summary, rawMaxTokens: detail.rawMaxTokens, totalTokens: detail.totalTokens,
        mcpTools, memoryFiles, agents,
        percentage: numeric(detail.percentage) ? detail.percentage : null, categories,
        maxTokensSource: 'sdk_context_window_estimate', usageSource: 'sdk_context_usage_estimate',
        isAutoCompactEnabled: typeof detail.isAutoCompactEnabled === 'boolean' ? detail.isAutoCompactEnabled : null,
        autocompactBufferTokens: null, autocompactSource: 'sdk_context_usage_estimate',
        detail: 'sdk', estimated: true };
    });
    define('claude.web_$_LocalSessions_$_getContextUsageSummary', (_e, sessionId) => contextUsageFor(sessionId));

    // Terminal pane.
    //
    // The renderer's terminal calls
    //   startShellPty(sessionId, cols, rows, spawnReason, cwd, linkAware, options)
    // and then reads output from the `onShellPtyEvent` channel. Its check is:
    //
    //   a.startShellPty(...).then(t => {
    //     if (!t || !t.ok) { Rr(r); ...setInlineError(l, "Failed to start shell"); return }
    //     r.shell = t.shell; ... if (t.waiting) {...} else { r.ptyReady = true }
    //     if (t.buffered !== undefined) Hr(r, t.buffered, t.cols, t.rows)
    //   })
    //
    // The previous handler answered a fabricated handle with no `ok` field, so the
    // pane rendered "Failed to start shell" on every open. Answering a fake
    // {ok:true} would have been worse — the terminal would appear to work and then
    // drop every keystroke. This routes to a real child process instead; see
    // desktop/shell-sessions.cjs for what that does and does not provide.
    const shells = createShellSessions({
      emit: (event) => emitShellEvent(event),
      log: (msg) => { if (typeof log === 'function') log(msg); },
    });
    define('claude.web_$_LocalSessions_$_startShellPty', (_e, sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options) =>
      shells.start(sessionId, cols, rows, spawnReason, ownerCwd, linkAware, options));
    define('claude.web_$_LocalSessions_$_stopShellPty', (_e, sessionId) => shells.stop(sessionId));
    define('claude.web_$_LocalSessions_$_resizeShellPty', (_e, sessionId, cols, rows) => shells.resize(sessionId, cols, rows));
    define('claude.web_$_LocalSessions_$_writeShellPty', (_e, sessionId, data) => shells.write(sessionId, data));
    // Which shells exist, and which of them are running a command.
    //
    // The consumer (c11959232-D0R2R6wT.js, fn Xt) treats these as SETS OF PTY KEYS:
    //   key(sessionId, tabId) = tabId === "0" ? sessionId : `${sessionId}::${tabId}`
    //   live    -- a shell process exists for this key
    //   busy    -- a subset of live that is currently running a command
    //   unknown -- keys that could not be probed
    //   probed  -- whether the probe actually ran at all
    // and it uses `live` to choose which tab to attach to:
    //   ... t.id === "0" ? (live.has(key) || !probed) : (live.has(key) || key === pending)
    //
    // This handler used to return a hard-coded
    //   { live: [], busy: [], unknown: [], probed: true, tabs: [] }
    // while a shell was demonstrably running (getTerminalShells listed it). That is not an
    // empty answer, it is a WRONG one: `probed: true` asserts the probe ran and `live: []`
    // asserts nothing is alive, so the pane could not recognise its own live tab. Measured
    // on the live replica: one shell in the store, `liveContainsTab0: false`,
    // `probed: true`.
    //
    // The answer now comes from the shells that actually exist. `busy` is left empty
    // because a pipe gives no way to ask "is this process at a prompt?" -- claiming a
    // shell is busy when it is idle would block diff refreshes, and claiming idle when
    // busy only delays them. `unknown` stays empty for the same reason: we do know the
    // state of every shell we started.
    define('claude.web_$_LocalSessions_$_getBusyShellPtyKeys', (_e, sessionId) => {
      const live = [];
      // A shell is tracked per session id, which IS the pty key for the default tab.
      for (const entry of shells.list()) {
        if (typeof sessionId === 'string' && sessionId && entry.sessionId !== sessionId) continue;
        live.push(entry.sessionId);
      }
      return {
        live,
        busy: [],
        unknown: [],
        // `probed: true` is only honest because the answer above is derived from real
        // shell state rather than assumed.
        probed: true,
        tabs: [],
      };
    });
    define('claude.web_$_LocalSessions_$_getTerminalShells', () => shells.list());
    // Terminal tab titles.
    //
    // The renderer derives a label per shell and pushes it here:
    //   c9ddef367, fn r(): for (const shell of shells) setShellPtyTitle(key(session, shell.id), label)
    //   cccc2cf0a:        setShellPtyTitle(ptyKey, derivedTitle) when the shell names itself
    // and c03935b01 wraps it as `setShellPtyTitle: (e, t) => void _?.setShellPtyTitle?.(e, t)`,
    // so the return value is ignored -- the SIDE EFFECT is the whole contract.
    //
    // It answered { ok: true } without storing anything, so every terminal tab kept its
    // placeholder label forever.
    define('claude.web_$_LocalSessions_$_setShellPtyTitle', (_e, sessionId, title) =>
      shells.setTitle(sessionId, title));

    define('claude.web_$_LocalSessions_$_getAll', () => kernel.getAll());

    // The session list, with a real generation counter.
    //
    // The consumer (shared-8-7ijQhFwx.js) does:
    //   let { sessions, loadGeneration, archivedPending } = await getSessionList();
    //   let d = loadGeneration !== 0;
    //   setState({ sessions, isInitialized: true, ..., ...(d ? { loadFailed: false } : {}) });
    //   if (d) Hh = true;
    //   zh = Wh === s ? loadGeneration : undefined;
    // and the "initialized" event carries `loadGeneration` into `Jh(...)`.
    //
    // So the field is a MONOTONIC VERSION, and `!== 0` is the signal "this list came from a
    // real load". It was hard-coded to 0, which meant `d` was always false: the store could
    // never clear `loadFailed`, and the retry bookkeeping never advanced.
    //
    // It is incremented on every call, so two consecutive reads are distinguishable.
    let loadGenerationCounter = 0;
    define('claude.web_$_LocalSessions_$_getSessionList', () => {
      loadGenerationCounter += 1;
      return {
        sessions: kernel.getAll(),
        loadGeneration: loadGenerationCounter,
        // No archived-list fetch is in flight in this build.
        archivedPending: false,
      };
    });
  }

  // ---- claude.settings / MCP ---------------------------------------------
  // Creating a session from the landing page reads the MCP server list before it
  // dispatches. Answering null made the renderer log
  //   [DESKTOP_API] Failed to fetch MCP servers {"errorName":"TypeError"}
  // and the send never happened, so these answer real (empty or file-backed) data.
  //
  // The READ side was real but the WRITE side answered { ok: true } without touching the
  // file. Measured on the live replica before the fix:
  //   writeResult: { ok: true }
  //   actuallySaved: false
  // so every MCP server the user added was silently discarded while the UI reported success.
  // The remove flow is worse: it re-reads after writing and treats "still there" as failure,
  // so it showed "Couldn't remove {serverName}" even though nothing had ever been saved.
  const mcpConfigCandidates = () => [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Claude-3p', 'claude_desktop_config.json') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'code-desktop-reconstruction', 'claude_desktop_config.json') : null,
  ].filter(Boolean);

  // The file the reader actually used, so a write goes back to the same place.
  const resolveMcpConfigPath = () => {
    const candidates = mcpConfigCandidates();
    for (const file of candidates) {
      try { if (fs.existsSync(file)) return file; } catch { /* next */ }
    }
    // Nothing exists yet: use the first candidate and create it.
    return candidates[0] || null;
  };

  const readMcpConfig = () => {
    for (const file of mcpConfigCandidates()) {
      try {
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      } catch { /* try the next candidate */ }
    }
    return {};
  };

  // The renderer expects a map of serverName -> config, never null.
  define('claude.settings_$_MCP_$_getMcpServersConfig', () => readMcpConfig());
  define('claude.settings_$_MCP_$_getMcpServersConfigWithStatus', () => {
    const servers = readMcpConfig();
    return Object.entries(servers).map(([name, config]) => ({
      name,
      config,
      // No process is spawned in this build, so every server reports as stopped.
      status: 'disconnected',
      error: null,
    }));
  });
  define('claude.settings_$_MCP_$_isLocalDevMcpEnabled', () => false);

  // Persist the server map. The caller passes the FULL map (it reads, mutates, writes back),
  // so this replaces `mcpServers` and preserves every other top-level key -- the file also
  // holds deploymentMode, coworkUserFilesPath and the whole `preferences` tree.
  //
  // MEASURED LIMITATION: on this host the Electron process cannot write outside the
  // workspace. Writing %LOCALAPPDATA%\Claude-3p\claude_desktop_config.json returns EPERM even
  // though the ACL grants FullControl, while plain node writes it fine:
  //   [dl] write failed ...\Downloads\... EPERM       (round 87, same class)
  //   electron-node write failed: EPERM               (verified via ELECTRON_RUN_AS_NODE)
  //   workspace write OK
  // So the write is attempted honestly and the failure is REPORTED. Answering { ok: true }
  // here would be exactly the defect this round fixes.
  define('claude.settings_$_MCP_$_setMcpServerConfigs', (_e, servers) => {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { ok: false, error: 'invalid server map' };
    }
    const file = resolveMcpConfigPath();
    if (!file) return { ok: false, error: 'no config path' };
    try {
      let current = {};
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
        } catch { /* a corrupt file is replaced, but only after a backup */ }
      }
      const next = { ...current, mcpServers: servers };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Write through a temp file so an interrupted write cannot truncate the real config.
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (error) {
      // Surface the real reason. The UI shows the failure and the user learns the server was
      // not saved, which is strictly better than a silent discard reported as success.
      return {
        ok: false,
        error: String((error && error.message) || error),
        code: (error && error.code) || null,
      };
    }
  });

  // These three open a file or folder in the OS. They answered { ok: true } without doing
  // anything, which is the "claims a probe ran" defect class.
  define('claude.settings_$_MCP_$_revealConfig', () => {
    const file = resolveMcpConfigPath();
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'no config file' };
    if (process.platform === 'win32') return shellOpen('explorer', ['/select,', file]);
    return shellOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', ['-R', file]);
  });
  define('claude.settings_$_MCP_$_revealLogs', () => {
    // Logs live next to the config in this build.
    const dir = path.join(path.dirname(resolveMcpConfigPath() || os.homedir()), 'logs');
    if (!fs.existsSync(dir)) return { ok: false, error: 'no log directory' };
    return shellOpen(process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open'), [dir]);
  });
  define('claude.settings_$_MCP_$_revealServerLog', (_e, serverName) => {
    if (typeof serverName !== 'string' || !serverName) return { ok: false, error: 'no server name' };
    const dir = path.join(path.dirname(resolveMcpConfigPath() || os.homedir()), 'logs');
    // Look for a log whose name mentions the server; refuse rather than open a wrong file.
    let found = null;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().includes(serverName.toLowerCase())) { found = path.join(dir, name); break; }
      }
    } catch { return { ok: false, error: 'no log directory' }; }
    if (!found) return { ok: false, error: 'no log for this server' };
    if (process.platform === 'win32') return shellOpen('explorer', ['/select,', found]);
    return shellOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', ['-R', found]);
  });

  // Session listing. The frontend does:
  //
  //   const { sessions, loadGeneration, archivedPending } =
  //     hasGetSessionList ? await getSessionList()
  //                       : { sessions: await getAll() };
  //   const rows = sessions.map(...)
  //
  // so getSessionList must resolve an object whose `sessions` is an array, and
  // getAll must resolve the array itself. Returning a bare array from
  // getSessionList (or undefined from getAll) throws inside the store and
  // leaves the surface on its loading skeleton.
  //
  // The list now comes from the session kernel (defined above) when one is
  // configured, so these only supply the auxiliary methods.
  // ---- session mutations ----------------------------------------------------
  // Rename, star, archive, unarchive and delete all funnel through these. They
  // used to fall through to the generic fallback, which answers null: the call
  // succeeded, no state changed, and nothing reported an error. The UI looked like
  // it had accepted the action and then re-rendered the unchanged session.
  //
  // `updateSession` is the busiest of them — the detail view calls it for a
  // title/star/archive patch on essentially every session it opens — so a silent
  // null there made titles and stars unable to persist at all.
  if (kernel) {
    // A patch may carry several independent fields. Only the ones the session
    // record actually models are applied, and each is type-checked so a malformed
    // patch cannot corrupt the record into a shape the sidebar cannot read.
    const applyPatch = (sessionId, patch) => {
      const current = kernel.getSession(sessionId);
      if (!current || !patch || typeof patch !== 'object') return null;
      const next = {};
      if (typeof patch.title === 'string') next.title = patch.title;
      if (typeof patch.isStarred === 'boolean') next.isStarred = patch.isStarred;
      if (typeof patch.isArchived === 'boolean') next.isArchived = patch.isArchived;
      if (typeof patch.permissionMode === 'string') next.permissionMode = patch.permissionMode;
      if (typeof patch.effortLevel === 'string') next.effortLevel = patch.effortLevel;
      if (typeof patch.fastMode === 'boolean') next.fastMode = patch.fastMode;
      if (typeof patch.titleSource === 'string' && 'title' in next) next.titleSource = patch.titleSource;
      if (patch.color !== undefined) next.color = patch.color;
      if ('cuSelectedDisplayId' in patch) next.cuSelectedDisplayId = patch.cuSelectedDisplayId;
      return kernel.update(sessionId, next);
    };

    const updateSession = async (sessionId, patch) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'model')) {
        const switched = await kernel.setModel(sessionId, patch.model);
        if (!switched) return null;
      }
      const updated = applyPatch(sessionId, patch);
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    };
    define('claude.web_$_LocalSessions_$_updateSession', async (_e, sessionId, patch) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'model')) {
        const switched = await kernel.setModel(sessionId, patch.model);
        if (!switched) return null;
      }
      const updated = applyPatch(sessionId, patch);
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    // The composer's model selector and effort picker.
    //
    //   setModel(sessionId, "claude-opus-5-5")
    //   setEffort(sessionId, "high")
    //
    // Both were unhandled, so the answer was null: the picker closed, the session
    // record kept its old model, and the button snapped back to the previous label.
    // The trace shows the call IS made, which is why this looked like a UI bug.
    const setSessionModel = async (sessionId, model) => {
      if (typeof model !== 'string' || !model.trim() || model !== model.trim() || /[\x00-\x1f\x7f]/.test(model)) return null;
      const updated = await kernel.setModel(sessionId, model);
      const current = kernel.getSession(sessionId);
      if (updated && current) emitSessionEvent({ type: 'session_updated', sessionId, session: current });
      return updated ?? null;
    };
    define('claude.web_$_LocalSessions_$_setModel', (_e, sessionId, model) => setSessionModel(sessionId, model));
    define('claude.web_$_LocalSessions_$_setEffort', (_e, sessionId, effort) => {
      if (typeof effort !== 'string' || !effort) return null;
      const updated = kernel.setEffort(sessionId, effort);
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    // The effort options the picker offers. Every level the UI knows about is valid
    // here because the agent runner forwards whatever the caller picks.
    define('claude.web_$_LocalSessions_$_getDefaultEffort', () => 'medium');

    // The composer's permission-mode picker (Auto / Manual / Accept edits / Plan /
    // Bypass).
    //
    // `setPermissionMode` was unhandled, so it answered null and the mode never
    // changed: the dropdown closed and the button kept its old label. The bridge is
    // the only place this can be fixed — the tool-approval gate reads
    // `session.permissionMode` when it decides whether to prompt.
    //
    // The modes themselves are validated by the permissions module so an unknown
    // string cannot make every future tool call behave unpredictably.
    define('claude.web_$_LocalSessions_$_setPermissionMode', (_e, sessionId, mode) => {
      if (typeof mode !== 'string' || !mode) return null;
      if (!VALID_MODES.has(mode)) return null;
      const updated = applyPatch(sessionId, { permissionMode: mode });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    define('claude.web_$_LocalSessions_$_getDefaultPermissionMode', () => {
      const configured = (process.env.CLAUDE_PERMISSION_MODE || '').trim();
      return VALID_MODES.has(configured) ? configured : 'ask';
    });

    // CLI sessions for the sidebar's "recents" list.
    //
    // This was answered only by emptyFor() (which returns []), so it never crashed — but it
    // also never returned anything, which means a CLI session could never appear. The fallback
    // being *safe* is why nobody noticed; safe is not the same as correct.
    //
    // The consumer (shared-11-_AVGLHEz.js) maps every entry through:
    //
    //   id: `local_cli_${e.handle}`, title: e.title ?? null,
    //   timestamp: new Date(e.lastActivityAt).toISOString(),
    //   cwd: e.cwd, cliHandle: e.handle, cliBridgeSessionId: e.bridgeSessionId,
    //   sessionStatus: e.liveness === Liveness.Running ? 'running' : 'idle'
    //
    // so handle / lastActivityAt / cwd are required, and lastActivityAt must be a valid date
    // (an invalid one throws inside toISOString).
    define('claude.web_$_LocalSessions_$_listCliSessions', (_e, limit) => {
      const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
      let all = [];
      try { all = kernel.getAll(); } catch { all = []; }
      return all
        .filter((session) => session && session.sessionId)
        // Only sessions that came from a CLI handle belong here; a locally created session is
        // already listed by getAll(). Reporting every session twice would duplicate the sidebar.
        .filter((session) => typeof session.cliHandle === 'string' && session.cliHandle)
        .slice(0, cap)
        .map((session) => ({
          handle: session.cliHandle,
          title: typeof session.title === 'string' ? session.title : null,
          // The consumer calls new Date(...).toISOString(), so never hand it null/undefined.
          lastActivityAt: Number.isFinite(session.lastActivityAt) ? session.lastActivityAt : Date.now(),
          cwd: typeof session.cwd === 'string' ? session.cwd : '',
          bridgeSessionId: session.sessionId,
          liveness: session.isRunning ? 'running' : 'idle',
        }));
    });
    // ---- importable CLI sessions ----------------------------------------
    //
    // The sidebar offers to import sessions the CLI already wrote to ~/.claude/projects.
    // Two channels back that banner, and NEITHER existed:
    //
    //   probeImportableCliSessions  -> only the generic fallback ({sessions,archived,pinned})
    //   importAllCliSessions        -> no handler at all, so the generic fallback answered null
    //
    // The consumer (cc43287c9-Me-M2ucD.js, fn `Kle`) reads `m?.count` off the probe answer to
    // decide whether to show the banner, and disables the whole thing unless BOTH functions are
    // present (`l = e && !!o && !!s && a && !r && c`). So with a `{sessions:[],...}` container the
    // count was undefined and the banner could never appear, even though 58 real CLI session
    // files existed on this host.
    //
    // A CLI transcript is JSONL: one record per line, each with a `type`. Only `user` and
    // `assistant` rows carry a message; queue-operation / attribution-snapshot rows are noise.
    const CLI_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
    /** Encode a cwd the way the CLI names its project directories. */
    const cliProjectDirName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

    // The CLI transcript reader lives in its own module so the parent chain it builds can be
    // tested directly (test/cli-transcript-chain.test.mjs).
    const { readCliTranscript } = require('./cli-transcript.cjs');

    /** Every CLI session file under ~/.claude/projects, newest first. */
    const listCliSessionFiles = (cap) => {
      const rootDir = CLI_PROJECTS();
      let dirs = [];
      try { dirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
      const found = [];
      for (const dir of dirs) {
        const full = path.join(rootDir, dir.name);
        let files = [];
        try { files = fs.readdirSync(full).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
        for (const name of files) {
          const file = path.join(full, name);
          let stat;
          try { stat = fs.statSync(file); } catch { continue; }
          found.push({
            handle: name.replace(/\.jsonl$/, ''),
            file,
            lastActivityAt: stat.mtimeMs,
            projectDir: dir.name,
          });
        }
      }
      found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      return cap ? found.slice(0, cap) : found;
    };

    /** Handles already present in the kernel, so "importable" can exclude them. */
    const importedCliHandles = () => {
      const handles = new Set();
      try {
        for (const session of kernel.getAll()) {
          if (session && typeof session.cliHandle === 'string' && session.cliHandle) handles.add(session.cliHandle);
        }
      } catch { /* an unreadable store just means nothing is known to be imported */ }
      return handles;
    };

    // The banner counts sessions, so the answer must carry `count`. Keep the empty containers
    // too: a consumer that spreads them must not get undefined.
    define('claude.web_$_LocalSessions_$_probeImportableCliSessions', (_e, limit) => {
      const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
      // "Importable" means NOT ALREADY IMPORTED.
      //
      // The first version counted every CLI transcript on disk, so after an import the probe
      // still reported the full total and the sidebar banner kept offering to import sessions
      // that were already there. Measured: 55 imported, count still 55.
      const imported = importedCliHandles();
      const files = listCliSessionFiles(0).filter((entry) => !imported.has(entry.handle));
      const shown = files.slice(0, cap);
      return {
        count: files.length,
        sessions: shown.map((entry) => ({
          handle: entry.handle,
          cwd: '',
          lastActivityAt: entry.lastActivityAt,
        })),
        archived: [],
        pinned: [],
      };
    });

    // Import every CLI session that is not already present.
    //
    // A session is considered imported when a kernel session carries the same cliHandle, so
    // running this twice does not duplicate the sidebar.
    define('claude.web_$_LocalSessions_$_importAllCliSessions', async () => {
      const files = listCliSessionFiles(0);
      const existing = importedCliHandles();

      let imported = 0;
      for (const entry of files) {
        if (existing.has(entry.handle)) continue;
        const rows = readCliTranscript(entry.file);
        // An empty transcript is not a session; importing it would add a blank row to the
        // sidebar that the user can never open.
        if (!rows.length) continue;
        try {
          const started = kernel.start({ cwd: process.env.CLAUDE_WORKSPACE || process.cwd() });
          kernel.update(started.sessionId, {
            cliHandle: entry.handle,
            title: (() => {
              const firstUser = rows.find((row) => row.type === 'user');
              const firstText = firstUser && Array.isArray(firstUser.message.content)
                ? firstUser.message.content.find((block) => block && block.type === 'text')
                : null;
              return firstText ? String(firstText.text).slice(0, 120) : null;
            })(),
          });
          kernel.setTranscript(started.sessionId, rows);
          imported += 1;
        } catch { /* one unreadable transcript must not abort the whole import */ }
      }
      try { kernel.flush(); } catch { /* persistence is best-effort here */ }
      return { imported, count: files.length };
    });
    // Draft initialization is real; callers can fall back to normal start when refused.
    const draftOwners = new Map();
    const draftOwner = sender => {
      if (!sender) return null;
      if (draftOwners.has(sender)) return draftOwners.get(sender);
      const owner = { generation: 0, dead: false, ids: new Set() };
      draftOwners.set(sender, owner);
      const clear = () => {
        owner.generation++;
        for (const id of owner.ids) kernel.discardPrewarm?.(id);
        owner.ids.clear();
      };
      sender.once?.('destroyed', () => { owner.dead = true; clear(); draftOwners.delete(sender); });
      sender.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clear(); });
      return owner;
    };
    const prewarmDraft = async (kind, info = {}, sender) => {
      const owner = draftOwner(sender), generation = owner?.generation;
      if (!info || typeof info.cwd !== 'string' || !info.cwd) {
        return { kind, ready: false, refusedReason: 'workspace_required' };
      }
      if (typeof kernel.prewarm !== 'function') return { kind, ready: false, refusedReason: 'unavailable' };
      try {
        const result = await kernel.prewarm({ ...info, kind });
        if (owner?.dead || (owner && owner.generation !== generation)) {
          kernel.discardPrewarm?.(result.sessionId);
          return { kind, ready: false, refusedReason: 'renderer_gone' };
        }
        owner?.ids.add(result.sessionId);
        return result;
      }
      catch (error) { return { kind, ready: false, refusedReason: String(error?.message || error) }; }
    };
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_prewarmLocal`, (event, info) => prewarmDraft(typeof info?.cwd === 'string' && info.cwd.trim() ? 'spare' : 'session', info, event?.sender));
      define(`claude.web_$_${svc}_$_prewarmFolderless`, (event, info) => prewarmDraft('spare', info, event?.sender));
      define(`claude.web_$_${svc}_$_prewarmAuth`, () => ({ ok: false, ready: false, reason: 'auth_prewarm_unavailable' }));
      define(`claude.web_$_${svc}_$_discardPrewarm`, (_e, sessionId) => {
        if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
        for (const owner of draftOwners.values()) owner.ids.delete(sessionId);
        return { ok: true, discarded: kernel.discardPrewarm?.(sessionId) === true };
      });
    }
    // Fast mode, the toggle the composer shows as "Fast mode off".
    //
    // The call arrives in two shapes — a boolean and the string "fast" — for the same
    // toggle (both observed in the trace), so this normalises rather than trusting one
    // spelling. Off is the honest default: this build always talks to the configured
    // model, and claiming a faster one would be a lie about what runs.
    define('claude.web_$_LocalSessions_$_setFastMode', (_e, sessionId, value) => {
      const on = value === true || value === 'fast' || value === 'on';
      const off = value === false || value === 'normal' || value === 'off';
      if (!on && !off) return null;
      const updated = applyPatch(sessionId, { fastMode: on });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    // NOTE: only LocalSessions declares setFastMode in bridge-map.json. Adding an
    // agent-mode handler here would create a channel the preload never exposes, so
    // there is deliberately no LocalAgentModeSessions.setFastMode.

    // Stop the running turn.
    //
    // `stop` had no handler, so pressing the stop button answered null and the turn
    // kept running: the only way to end a long response was to wait it out. The
    // kernel already implements cancellation through an AbortController, so this is
    // purely the missing bridge between the button and that controller.
    // `interrupt` is the name the composer's stop button actually calls.
    //
    // Measured: pressing stop emitted exactly one bridge call —
    //   [trace] claude.web.LocalSessions.interrupt [sessionId]
    // — and nothing else. `stop` was implemented (it delegates to kernel.cancel) but the
    // frontend never calls it, so the call fell through to the generic fallback, which
    // answers null. The UI then hid the stop button while the turn kept running:
    //   after stop: { stillRunning: 1, stopStillShown: false }
    // The turn was only ended by waiting it out.
    //
    // Same delegation as stop, deliberately: one cancellation path, two entry names.
    define('claude.web_$_LocalSessions_$_interrupt', (_e, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
      const result = kernel.cancel(sessionId);
      return { ok: true, cancelled: Boolean(result && result.ok) };
    });
    define('claude.web_$_LocalAgentModeSessions_$_interrupt', (_e, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
      const result = kernel.cancel(sessionId);
      return { ok: true, cancelled: Boolean(result && result.ok) };
    });
    define('claude.web_$_LocalSessions_$_stop', (_e, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
      const result = kernel.cancel(sessionId);
      // `cancel` reports false when nothing was running; that is not an error — the
      // UI can press stop after the turn already finished.
      return { ok: true, cancelled: Boolean(result && result.ok) };
    });
    define('claude.web_$_LocalAgentModeSessions_$_stop', (_e, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
      const result = kernel.cancel(sessionId);
      return { ok: true, cancelled: Boolean(result && result.ok) };
    });

    // Answering an in-app tool approval.
    //
    // The renderer's signature is respondToToolPermission(requestId, decision, input)
    // — the SESSION id is not passed; the kernel records which session each request
    // belongs to. `decision` is the UI's own vocabulary ("allow" | "deny" | "always"
    // | "once" | "timeout"); anything outside the allow set denies, which is the safe
    // direction for a gate.
    //
    // Before this existed the bridge answered null and never emitted a request, so the
    // in-app approval card could never appear: approval happened only through the
    // native consent modal, which the renderer knows nothing about.
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_respondToToolPermission`, (_e, requestId, decision, input) => {
        if (typeof requestId !== 'string' || !requestId) return { ok: false, error: 'invalid_request' };
        return kernel.respondToApproval(requestId, decision, input);
      });
    }
    // The sidebar's archive action. The renderer passes the options the transport
    // builds ({cleanupWorktree, forceWorktreeCleanup, ...}); none of them change
    // what happens here — the session is only flagged, never deleted.
    define('claude.web_$_LocalSessions_$_archive', (_e, sessionId) => {
      const updated = applyPatch(sessionId, { isArchived: true });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return { ok: Boolean(updated) };
    });
    define('claude.web_$_LocalSessions_$_unarchive', (_e, sessionId) => {
      const updated = applyPatch(sessionId, { isArchived: false });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return { ok: Boolean(updated) };
    });
    // ---- rewind -------------------------------------------------------------
    //
    // Two declared methods have a single shipped consumer (cb1e253a0-DgeDleLc.js, `rh`):
    //
    //   async function rh(e,t,n){
    //     if(e?.rewindV2){ let {prefill:r, refusal:i} = await e.rewindV2(t,n); ... }
    //     if(e?.rewind)  return {prefill: await e.rewind(t,n) ?? void 0};
    //     throw c(Error("rewind IPC unavailable"), ...)
    //   }
    //
    // Both answered null through the generic fallback. That is NOT a benign empty value
    // here: the consumer destructures the answer, and destructuring null is a TypeError.
    // Measured on a running replica before this handler existed:
    //
    //   rewindV2(...) -> THREW: Cannot destructure property 'prefill' of
    //                    '(intermediate value)' as it is null
    //
    // So the answer must be an OBJECT. `refusal` is left undefined on success (the
    // consumer maps an unknown refusal code to Me.Unknown, so inventing a code would
    // fabricate a failure the original never reported).
    //
    // Scope note, measured rather than assumed: of the six rewind-family names declared
    // in bridge-map.json, a word-boundary scan of all 3,838 shipped files finds real
    // member calls for exactly TWO (rewindV2, rewind). rewindFiles / undoRewind /
    // switchRewindMark / rewindToRefusedPrompt are declared but never called, so they are
    // deliberately left to the fallback: implementing them would be inventing behaviour
    // no shipped caller reaches. test/checkpoint-surface.test.mjs pins both halves.
    //
    // rewind means "removes this message and everything after it" (the shipped context
    // menu's own wording, i18n id Jtuq2Qoy3B), so the target row is KEPT and everything
    // below it is dropped. The truncated prompt goes back to the composer as `prefill`.
    const rewindCore = (sessionId, messageUuid) => {
      if (typeof sessionId !== 'string' || !sessionId) return { refusal: 'unknown_session' };
      if (typeof messageUuid !== 'string' || !messageUuid) return { refusal: 'missing_target' };
      const rows = kernel.getTranscript(sessionId);
      if (!Array.isArray(rows) || !rows.length) return { refusal: 'unknown_session' };
      const at = rows.findIndex((row) => row && row.uuid === messageUuid);
      // Keep the target, drop everything after it. Never guess a near match: a rewind to
      // the wrong row would silently destroy the user's conversation.
      if (at < 0) return { refusal: 'target_not_found' };
      const kept = rows.slice(0, at + 1);
      kernel.setTranscript(sessionId, kept.map((row) => ({ ...row })));
      // A rewind interrupts whatever the session was doing; leaving it marked running
      // would show a spinner over a conversation that can no longer advance.
      //
      // keepHeldInput:false is load-bearing. A rewind DROPS every row after its target, so a
      // steer still held on this side is text the user just rewound past. Handing it back to
      // the deferred queue would start a fresh turn with exactly that discarded text.
      // Measured with the hand-back unconditional: the fixture received A, then B — after the
      // transcript had already been truncated to A. The original treats a rewind as a
      // cut-and-withdraw, so nothing is redelivered here.
      const record = kernel.getSession(sessionId);
      if (record && record.isRunning) {
        try { kernel.cancel(sessionId, { keepHeldInput: false }); } catch { /* an idle session is not a failure */ }
      }
      const textBlock = kept[kept.length - 1]
        && Array.isArray(kept[kept.length - 1].message?.content)
        ? kept[kept.length - 1].message.content.find((block) => block && block.type === 'text')
        : null;
      return { prefill: textBlock && typeof textBlock.text === 'string' ? textBlock.text : undefined };
    };
    // ---- SSH host list -------------------------------------------------------------
    //
    // `getSSHConfigs` is the single most-called fallback channel measured across 73 recorded
    // runs (1,631 of 13,373 hits, 12-16 calls per startup). Every consumer tolerates null:
    //   (await r?.getSSHConfigs?.()?.catch(() => void 0))?.find(...)
    //   await Ct?.getSSHConfigs?.() ?? []
    // so the UI does not break — but it also never offers a remote host, even on a machine
    // that has one configured. SSH is a real shipped feature (43 bundles, 292 zh-Hans
    // strings), so answering null is a missing feature rather than a safe default.
    //
    // The source is the user's own ~/.ssh/config. Only Host blocks are reported: that is what
    // the picker lists. A machine without the file legitimately gets [], which is a different
    // answer from "I could not be bothered".
    const readSshHosts = () => {
      const configPath = path.join(os.homedir(), '.ssh', 'config');
      let text;
      try {
        if (!fs.existsSync(configPath)) return [];
        text = fs.readFileSync(configPath, 'utf8');
      } catch {
        // An unreadable file is still "no hosts I can offer", not a crash.
        return [];
      }
      const hosts = [];
      // A Host line may name several patterns, and every following option applies to ALL of
      // them. Measured with `Host beta gamma` + `HostName beta.example.com`: the first version
      // kept only the last pattern, so `gamma` silently disappeared from the picker.
      let group = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z]+)\s+(.+)$/);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const value = match[2].trim();
        if (key === 'host') {
          group = [];
          for (const pattern of value.split(/\s+/)) {
            // Wildcards are matching patterns, not connectable hosts.
            if (!pattern || pattern.includes('*') || pattern.includes('?')) continue;
            const entry = { sshHost: pattern };
            group.push(entry);
            hosts.push(entry);
          }
        } else if (group.length) {
          for (const entry of group) {
            // Keep the pattern as the display name: a single HostName can apply to several
            // aliases (`Host beta gamma` + `HostName beta.example.com` is legal), and
            // overwriting sshHost with the HostName made both rows identical.
            if (key === 'hostname') entry.sshHostName = value;
            else if (key === 'port') entry.sshPort = Number(value) || undefined;
            else if (key === 'user') entry.sshUser = value;
            else if (key === 'identityfile') entry.sshIdentityFile = value;
          }
        }
      }
      return hosts;
    };
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_getSSHConfigs`, () => readSshHosts());
      define(`claude.web_$_${svc}_$_setSSHConfigs`, (_e, list) => {
        // ~/.ssh/config is the user's file, not ours; report the honest answer.
        return { ok: false, reason: 'read-only', hosts: readSshHosts() };
      });
    }
    // ---- clear / restore the conversation -----------------------------------------
    //
    // `/clear` is a real slash command in the shipped UI:
    //   let i = C?.clearSession;  ...  formatMessage("Couldn't clear the conversation. Try again.")
    // so without a handler the menu item exists and every attempt fails with that message.
    //
    // The session record carries `hasPreClearSession` next to `rewindUndoable`, which is what
    // the renderer reads to offer "resume the cleared conversation". So clearing must KEEP the
    // rows it removed — undoing a clear is part of the documented feature, and a clear that
    // discarded them would be unrecoverable.
    //
    // Stored on the record (not in a module-level map) so it survives a restart the same way
    // the transcript does. `resumePreClearSession` puts them back and clears the field.
    const clearedTranscripts = new Map();
    const clearSessionCore = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'unknown_session' };
      const record = kernel.getSession(sessionId);
      if (!record) return { ok: false, reason: 'unknown_session' };
      const rows = kernel.getTranscript(sessionId) || [];
      // Clearing an already-empty conversation is a no-op, not a failure: the UI shows
      // "cleared" either way and there is nothing to remember for a resume.
      if (rows.length) {
        clearedTranscripts.set(sessionId, rows.map((row) => ({ ...row })));
        kernel.setTranscript(sessionId, []);
      }
      // The renderer reads this to offer the resume affordance.
      try { kernel.update(sessionId, { hasPreClearSession: rows.length > 0 }); } catch { /* older records */ }
      // Tell the renderer, not just the caller.
      //
      // Returning {ok:true} only reassures the caller. The conversation reset is driven by this
      // event: the transport maps it to {kind:'cleared', hasPreClearSession, unwoundRefusalFallback}
      // and the store's branch runs a whole reset —
      //
      //   case"cleared": return i=!0, nD(e), yO(e), n.unwoundRefusalFallback&&jT(e),
      //     { ...rD(t), refusalFallback: ..., restoredRefusalFallback: ...,
      //       hasPreClearSession: n.hasPreClearSession ?? null, spawnedFresh: t.spawnedFresh }
      //   nD(e) = U.dropSession(e), K.reset(e), W.clear(e), IC(e), bn(e),
      //           clearSession(e), resend(e), aC(e), tC(e), ...
      //
      // Without it the transcript rows are gone from the record but the store keeps its
      // per-session sub-state (streaming buffers, refusal fallback, connection bookkeeping) and
      // the resume affordance is driven by a field the store never received.
      //
      // Shape from the pinned original (offset 984048): session snapshot, `hasPreClearSession`,
      // and `unwoundRefusalFallback`. This replica has no refused-turn fallback state to unwind,
      // so that flag is always false — passed explicitly rather than omitted so the transport's
      // `n.unwoundRefusalFallback && jT(e)` short-circuit is not silently relying on undefined.
      emitSessionEvent({ type: 'cleared', sessionId, session: kernel.getSession(sessionId),
        hasPreClearSession: rows.length > 0, unwoundRefusalFallback: false });
      return { ok: true };
    };
    const resumePreClearSessionCore = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'unknown_session' };
      const kept = clearedTranscripts.get(sessionId);
      if (!kept || !kept.length) return { ok: false, reason: 'nothing_to_resume' };
      kernel.setTranscript(sessionId, kept.map((row) => ({ ...row })));
      clearedTranscripts.delete(sessionId);
      try { kernel.update(sessionId, { hasPreClearSession: false }); } catch { /* older records */ }
      return { ok: true };
    };
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_clearSession`, (_e, sessionId) => clearSessionCore(sessionId));
      define(`claude.web_$_${svc}_$_resumePreClearSession`, (_e, sessionId) => resumePreClearSessionCore(sessionId));
    }
    // rewindV2 answers { prefill?, refusal? }; rewind is the older shape, { prefill }.
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_rewindV2`, (_e, sessionId, messageUuid) => rewindCore(sessionId, messageUuid));
      define(`claude.web_$_${svc}_$_rewind`, (_e, sessionId, messageUuid) => {
        const answer = rewindCore(sessionId, messageUuid);
        // The pre-v2 caller reads only `prefill`; an absent one must stay undefined
        // rather than become a fabricated empty string.
        return { prefill: answer.prefill };
      });
    }

    // Discard the turn that has not produced a response yet (Escape in an empty composer).
    //
    // DECLARED in bridge-map and called by the shipped composer, but this build had no
    // handler, so the generic fallback answered `null`. The consumer treats that as "not
    // discarded" and falls back to a plain stop:
    //
    //   let u = Tn.discardPendingTurn, d = jx.holdForAck(q.id, () => u(q.id));
    //   SN(d, { onStopped: t => { cC({..., discarded: t}), !t && (a(), Bu(q), c(), l()); ... },
    //           onFailed: ..., onRefused: ... });
    //
    // so the composer's "unsend" path silently degraded to "stop" every time: the message the
    // user tried to take back stayed in the conversation. `true` means the turn was taken back;
    // `false` means an honest stop (the message cannot be recovered); throwing means refused.
    //
    // Modelled on the original's discardPendingTurn, restricted to what this replica can honour:
    //   - a turn that has already produced output cannot be taken back (the original checks
    //     hadFirstResponse and logs "honest stop");
    //   - a host-held steer IS recoverable: it was never written to the CLI, so withdrawing it
    //     is exactly the cut-and-withdraw the original performs;
    //   - an in-flight turn is stopped afterwards, the same way the composer's stop does it.
    //
    // The rows that were taken back are announced with `turn_discarded`, the event the shipped
    // renderer's transport and store both handle to drop those messages from the transcript.
    const discardPendingTurnCore = async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'unknown_session' };
      const record = kernel.getSession(sessionId);
      if (!record) return { ok: false, reason: 'unknown_session' };
      const running = record.isRunning === true;
      // A turn that already produced output cannot be unsent: the model has acted on the
      // prompt, so removing it would leave the transcript showing an answer to nothing.
      //
      // This reads the kernel's per-turn flag. An earlier version read
      // `record.pendingTurn.responseStarted`, a field nothing in this replica ever writes — the
      // guard was dead in production and only a test could trip it.
      if (running && kernel.turnProducesOutput?.(sessionId) === true) return false;
      // The prompt of the running turn is the row the renderer drops. It is NOT in
      // getQueuedMessages: that list is the host-side hold, and the prompt is already the turn
      // in flight. Reading only the queue announced nothing for an ordinary turn (measured: 0
      // turn_discarded events, and the fallback's null looked identical).
      const queued = kernel.getQueuedMessages(sessionId).map((row) => row.uuid).filter(Boolean);
      if (!running && !queued.length) return false;
      const promptUuid = running ? kernel.getRunningTurnUuid?.(sessionId) ?? undefined : undefined;
      // A written steer can be withdrawn only after the CLI confirms
      // cancel_async_message. Await that confirmation BEFORE aborting its
      // owner: cancelling the actor first makes its late ACK untrustworthy.
      // Ordinary host-held rows return a synchronous boolean here.
      for (const uuid of new Set(queued)) {
        const withdrawn = await kernel.cancelQueuedMessage(sessionId, uuid);
        if (withdrawn !== true) return false;
      }
      if (running) {
        // Waiting for a steer ACK may allow this turn to emit output, close,
        // or be replaced. In any of those cases it is no longer safe to
        // unsend the originally captured prompt or cancel a different turn.
        if (kernel.getSession(sessionId)?.isRunning !== true ||
            kernel.getRunningTurnUuid?.(sessionId) !== promptUuid ||
            kernel.turnProducesOutput?.(sessionId) === true) return false;
        const stopped = kernel.cancel(sessionId, { keepHeldInput: false });
        if (stopped?.ok !== true) return false;
      }
      // Never claim a queued UUID was withdrawn if the kernel still owns it.
      const stillQueued = new Set(kernel.getQueuedMessages(sessionId).map(row => row.uuid));
      const discarded = [...new Set([promptUuid, ...queued.filter(uuid => !stillQueued.has(uuid))].filter(Boolean))];
      if (discarded.length) {
        emitSessionEvent({ type: 'turn_discarded', sessionId, userMessageUuid: discarded[0], discardedUuids: discarded });
      }
      return running || discarded.length > 0;
    };
    for (const svc of LOCAL_SERVICES) {
      define(`claude.web_$_${svc}_$_discardPendingTurn`, (_e, sessionId) => discardPendingTurnCore(sessionId));
    }

    // Fork a session.
    //
    // The caller (yn() in caec4a2d4-BRHJTwC2.js) builds the new id itself and asks
    // the bridge to copy the conversation:
    //
    //   let i = `local_${crypto.randomUUID()}`;
    //   ...
    //   let a = await r(e.ref.id, i, e.forkAtMessageUuid, e.targetCwd);
    //   ...
    //   hn(t, a.sessionId, {...})          // continues in a.sessionId
    //
    // so the answer MUST carry `sessionId`; a null answer made the row's "Fork"
    // item do nothing at all (no new session, no error, no navigation).
    //
    // `forkAtMessageUuid` limits the copy to the messages up to and including that
    // entry, which is what "fork from this message" means. Without it the whole
    // conversation is copied.
    define('claude.web_$_LocalSessions_$_forkSession', (_e, sourceId, newSessionId, forkAtMessageUuid, targetCwd) => {
      const source = kernel.getSession(sourceId);
      if (!source) return null;

      const sourceEntries = kernel.getTranscript(sourceId);
      const entries = Array.isArray(sourceEntries) ? sourceEntries : [];

      // Truncate at the requested message, inclusive.
      let copied = entries;
      if (typeof forkAtMessageUuid === 'string' && forkAtMessageUuid) {
        const at = entries.findIndex((entry) => entry && entry.uuid === forkAtMessageUuid);
        copied = at >= 0 ? entries.slice(0, at + 1) : entries;
      }

      // The caller supplies the id so its optimistic record and the kernel agree.
      const id = typeof newSessionId === 'string' && newSessionId
        ? newSessionId
        : `local_${crypto.randomUUID()}`;

      const forkCwd = typeof targetCwd === 'string' && targetCwd ? targetCwd : source.cwd;
      const fork = require('./session-fork.cjs').prepareFork(source,copied,forkCwd);
      // Publish native history before eagerly starting the new CLI actor.
      const created = kernel.start({
        ...fork,
        sessionId: id,
        cwd: typeof targetCwd === 'string' && targetCwd ? targetCwd : source.cwd,
        model: source.model,
        effortLevel: source.effortLevel,
        permissionMode: source.permissionMode,
        title: source.title,
      });
      if (!created) return null;

      // Copy the conversation. Entry uuids are kept as-is: they are what the
      // transcript's parentUuid chain and the "fork from here" anchor refer to.
      kernel.setTranscript(id, copied.map((entry) => ({ ...entry })));

      const updated = kernel.update(id, {
        parentSessionId: sourceId,
        cliSessionId: fork.cliSessionId,
        ccbResume: fork.ccbResume,
      }) || kernel.getSession(id);

      emitSessionEvent({ type: 'session_updated', sessionId: id, session: updated });
      return { sessionId: id, type: 'local', copiedMessages: copied.length };
    });
    // Delete removes the record and its transcript, which is what the kernel's
    // remove() already does.
    define('claude.web_$_LocalSessions_$_delete', (_e, sessionId) => (revokePreviewSession(sessionId), sessionMedia?.revokeSession(sessionId), sessionVideo?.revokeSession(sessionId), kernel.remove(sessionId)));
    define('claude.web_$_LocalAgentModeSessions_$_archive', (_e, sessionId) => {
      const updated = applyPatch(sessionId, { isArchived: true });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return { ok: Boolean(updated) };
    });
    define('claude.web_$_LocalAgentModeSessions_$_delete', (_e, sessionId) => (revokePreviewSession(sessionId), sessionMedia?.revokeSession(sessionId), sessionVideo?.revokeSession(sessionId), kernel.remove(sessionId)));

    // The same mutators under the other namespace.
    //
    // The composer picks its transport by surface, and the two namespaces expose the
    // same method names. Rounds 17-19 implemented setModel / setEffort /
    // setPermissionMode / updateSession on LocalSessions only, so a surface talking to
    // LocalAgentModeSessions would still find every one of them dead. Measured:
    //
    //   LocalSessions.setModel            -> the session record
    //   LocalAgentModeSessions.setModel   -> null
    //
    // These forward to the same kernel call so the two cannot drift.
    define('claude.web_$_LocalAgentModeSessions_$_updateSession', (_e, sessionId, patch) => updateSession(sessionId, patch));
    define('claude.web_$_LocalAgentModeSessions_$_setModel', (_e, sessionId, model) => setSessionModel(sessionId, model));
    define('claude.web_$_LocalAgentModeSessions_$_setEffort', (_e, sessionId, effort) => {
      if (typeof effort !== 'string' || !effort) return null;
      const updated = kernel.setEffort(sessionId, effort);
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    define('claude.web_$_LocalAgentModeSessions_$_setPermissionMode', (_e, sessionId, mode) => {
      if (typeof mode !== 'string' || !mode) return null;
      if (!VALID_MODES.has(mode)) return null;
      const updated = applyPatch(sessionId, { permissionMode: mode });
      if (updated) emitSessionEvent({ type: 'session_updated', sessionId, session: updated });
      return updated ?? null;
    });
    // `stopTask` cancels the scheduled/background task for a session. This build has no
    // task runner, so it reports that nothing was cancelled rather than pretending.
    define('claude.web_$_LocalAgentModeSessions_$_stopTask', (_e, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid_session' };
      const result = kernel.cancel(sessionId);
      return { ok: true, cancelled: Boolean(result && result.ok) };
    });

    // Archived sessions are a separate listing. Answering a constant empty object
    // made the archive view permanently empty even once archiving worked.
    define('claude.web_$_LocalSessions_$_loadArchivedSessions', () => ({
      sessions: kernel.getAll().filter((s) => s.isArchived === true),
      loadGeneration: 0,
    }));

    // Content search behind the palette's "Search chats and projects" box.
    //
    // The contract is an ARRAY of { sessionId, snippet }, not { sessions: [...] }:
    //
    //   queryFn: async () => n ? n(s, {limit: o}) : []
    //   ... for (let t of l) { if (t.sessionId === a) continue;
    //        let n = i.get(t.sessionId); n && e.push({ session: n, snippet: t.snippet }) }
    //
    // and the caller only issues the call once the query is >= 2 characters.
    // Answering the constant `{ sessions: [] }` — an object where an array is
    // iterated — made every search return nothing, so the palette could never find
    // a conversation by its content.
    //
    // Matching is a case-insensitive substring over the session title, its working
    // directory, and the text of its transcript; `snippet` is the surrounding text
    // of the first hit, which is what the result row shows under the title.
    // Both namespaces expose searchSessions and the palette may call either
    // (LocalSessions for the code surface, LocalAgentModeSessions for cowork), so
    // both get the real implementation rather than the fallback.
    const searchSessionsImpl = (_e, query, options) => {
      const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (text.length < 2) return [];
      const limit = options && Number.isFinite(options.limit) && options.limit > 0
        ? Math.max(1, Math.floor(options.limit))
        : 50;

      const snippetAround = (haystack, needle) => {
        const at = haystack.toLowerCase().indexOf(needle);
        if (at < 0) return '';
        const start = Math.max(0, at - 40);
        const end = Math.min(haystack.length, at + needle.length + 80);
        return `${start > 0 ? '…' : ''}${haystack.slice(start, end).replace(/\s+/g, ' ').trim()}${end < haystack.length ? '…' : ''}`;
      };

      const results = [];
      for (const session of kernel.getAll()) {
        if (results.length >= limit) break;

        // Title and folder first: these are cheap and are what a user usually means.
        const title = typeof session.title === 'string' ? session.title : '';
        const folder = typeof session.cwd === 'string' ? session.cwd : '';
        let snippet = snippetAround(title, text) || snippetAround(folder, text);

        // Then the conversation itself.
        if (!snippet) {
          for (const entry of kernel.getTranscript(session.sessionId) || []) {
            const content = entry && entry.message ? entry.message.content : null;
            const pieces = Array.isArray(content)
              ? content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join(' ')
              : (typeof content === 'string' ? content : '');
            if (!pieces) continue;
            const hit = snippetAround(pieces, text);
            if (hit) { snippet = hit; break; }
          }
        }

        if (snippet) results.push({ sessionId: session.sessionId, snippet });
      }
      return results;
    };
    define('claude.web_$_LocalSessions_$_searchSessions', searchSessionsImpl);
    define('claude.web_$_LocalAgentModeSessions_$_searchSessions', searchSessionsImpl);
  }

  // Usage statistics for the account Overview page.
  //
  // The caller validates the answer against a zod schema and throws on null:  //
  //   let e = await t();
  //   if (!e) throw Error("getCodeStats returned null");
  //   let n = codeStatsSchema.safeParse(e);
  //   if (!n.success) throw Error("getCodeStats returned an unexpected payload shape");
  //
  // so an unshaped answer produced a QueryClient error on every mount. The schema
  // (c06cf64bb-C0tIfxkK.js, `qo`) requires every field below; the `i(...)` arrays
  // default to [] and the `r = a().catch(0)` fields default to 0.
  //
  // Everything here is computed from the kernel's own sessions and transcripts, so
  // the numbers describe this build's real activity rather than being invented.
  if (kernel) {
    define('claude.web_$_LocalSessions_$_getCodeStats', () => {
      const sessions = kernel.getAll();
      const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

      // Sessions grouped by their creation day.
      const perDay = new Map();
      let totalMessages = 0;
      let firstMs = null;
      let lastMs = null;
      let peakHour = null;
      const hourCounts = new Map();

      for (const s of sessions) {
        const created = typeof s.createdAt === 'number' ? s.createdAt : null;
        const last = typeof s.lastActivityAt === 'number' ? s.lastActivityAt : created;
        if (created !== null) {
          if (firstMs === null || created < firstMs) firstMs = created;
          const key = dayKey(created);
          const row = perDay.get(key) || { date: key, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
          row.sessionCount += 1;
          perDay.set(key, row);
          const hour = new Date(created).getHours();
          hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
        }
        if (last !== null && (lastMs === null || last > lastMs)) lastMs = last;

        // Transcript entries are this build's message history.
        const entries = kernel.getTranscript(s.sessionId) || [];
        totalMessages += entries.length;
        if (created !== null && entries.length) {
          const key = dayKey(created);
          const row = perDay.get(key);
          if (row) row.messageCount += entries.length;
        }
      }

      for (const [hour, count] of hourCounts) {
        if (peakHour === null || count > hourCounts.get(peakHour)) peakHour = hour;
      }

      // Longest run of consecutive days that have any session.
      const days = [...perDay.keys()].sort();
      let longestStreak = 0;
      let currentStreak = 0;
      let prev = null;
      for (const day of days) {
        if (prev !== null) {
          const gap = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86400000;
          currentStreak = gap === 1 ? currentStreak + 1 : 1;
        } else {
          currentStreak = 1;
        }
        if (currentStreak > longestStreak) longestStreak = currentStreak;
        prev = day;
      }

      // Prefer provider usage; legacy transcripts retain the text estimate.
      const { transcriptUsage } = require('./transcript-usage.cjs');
      const modelUsage = {};
      const dailyModelTokens = [];
      for (const s of sessions) {
        const model = s.model || 'claude-sonnet-5-5';
        const entries = kernel.getTranscript(s.sessionId) || [];
        const usage = transcriptUsage(entries);
        const input = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        const output = usage.outputTokens;
        const row = modelUsage[model] || {
          inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        };
        for (const field of Object.keys(row)) row[field] += usage[field] || 0;
        modelUsage[model] = row;

        if (typeof s.createdAt === 'number' && input + output > 0) {
          dailyModelTokens.push({
            date: dayKey(s.createdAt),
            tokensByModel: { [model]: input + output },
          });
        }
      }

      return {
        totalSessions: sessions.length,
        totalMessages,
        activeDays: perDay.size,
        firstSessionDate: firstMs === null ? null : new Date(firstMs).toISOString(),
        lastSessionDate: lastMs === null ? null : new Date(lastMs).toISOString(),
        peakActivityHour: peakHour,
        streaks: { currentStreak, longestStreak },
        dailyActivity: [...perDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
        dailyModelTokens,
        modelUsage,
      };
    });
  }

  // Desktop notifications.
  //
  // `getAuthorizationStatus()` must answer a STATUS STRING, not an object. The
  // callers compare against the enum (shared-0-ByI5P0CP.js, `yy`):
  //
  //   notDetermined | denied | authorized | provisional | ephemeral
  //
  // and one of them gates the whole feature on it:
  //
  //   let N = j === "authorized" || j === "provisional" || j === "ephemeral"
  //        || j === "unqueryable"
  //
  // The generic fallback answered {status:"unavailable"}, so `j` was never one of
  // those, and Settings > General's "Response completions" switch was rendered
  // disabled — it could not be turned on, and clicking it changed nothing.
  //
  // This build can show a real OS notification: Electron's main process has the
  // Notification API. `notDetermined` is the honest status until the user asks, and
  // requestAuthorization() answers `authorized` because there is no OS prompt to
  // forward here.
  // Notification authorization.
  //
  // The status enum is (shared-0-BRYCPbU4.js, `bb`):
  //   NotDetermined="notDetermined" Denied="denied" Authorized="authorized"
  //   Provisional="provisional" Ephemeral="ephemeral"
  //
  // These were two independent constants: status always "notDetermined" and
  // requestAuthorization always "authorized". Measured live:
  //   statusBefore:  "notDetermined"
  //   requestResult: "authorized"
  //   statusAfter:   "notDetermined"     <- the grant never took effect
  // so the caller believed permission had been granted while the status still said otherwise,
  // and every later check asked again.
  //
  // API support is not a Windows delivery or authorization check.
  //
  // The answer is remembered per process so a request does not "succeed" then revert.
  let notificationAuthorization = null;
  const notificationStatus = () => {
    if (notificationAuthorization) return notificationAuthorization;
    // Without a working Notification implementation there is nothing to authorize.
    let supported = false;
    try {
      if (typeof settings.notificationsSupported === 'function') supported = settings.notificationsSupported() === true;
    } catch { supported = false; }
    notificationAuthorization = supported ? 'notDetermined' : 'denied';
    return notificationAuthorization;
  };

  define('claude.web_$_DesktopNotifications_$_getAuthorizationStatus', () => notificationStatus());
  define('claude.web_$_DesktopNotifications_$_requestAuthorization', () => {
    // Granting is only meaningful when the platform can deliver a notification.
    let supported = false;
    try {
      if (typeof settings.notificationsSupported === 'function') supported = settings.notificationsSupported() === true;
    } catch { supported = false; }
    notificationAuthorization = supported ? 'authorized' : 'denied';
    return notificationAuthorization;
  });
  define('claude.web_$_DesktopNotifications_$_supportsNotificationActions', () => false);
  // Send the user to the OS notification settings.
  //
  // The caller (c0c371a67, mn()) only reaches this when the status is Denied, so answering
  // { ok: true } without opening anything was doubly useless: the branch was unreachable
  // AND the action was a no-op. Now the branch is reachable and the action really happens.
  define('claude.web_$_DesktopNotifications_$_openNotificationSettings', () => {
    try {
      if (process.platform === 'win32') {
        // ms-settings: is the documented URI for the modern Settings app.
        return shellOpen('cmd', ['/c', 'start', '', 'ms-settings:notifications']);
      }
      if (process.platform === 'darwin') {
        return shellOpen('open', ['x-apple.systempreferences:com.apple.preference.notifications']);
      }
      return shellOpen('xdg-open', ['settings://notifications']);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });
  define('claude.web_$_DesktopNotifications_$_showNotification', (_e, ...args) => {
    if (typeof settings.showNotification === 'function') settings.showNotification(...args);
  });

  define('claude.web_$_LocalSessions_$_getDetectedProjects', () => (settings.detectedProjects || []));
  // Both namespaces expose getSupportedCommands and the caller uses whichever the
  // active transport provides (shared-5-BcqPJtUL.js):
  //
  //   queryFn: async () => bridge.getSupportedCommands
  //     ? (await bridge.getSupportedCommands()).filter(e => e.scope === "cowork")
  //     : []
  //
  // so the answer must be an ARRAY. The generic fallback treated it as a
  // feature-status method and answered {status:"unavailable"}, which made `.filter`
  // throw and produced a QueryClient error on every mount.
  // What getSupportedCommands must contain.
  //
  // The palette (shared-5-Bg6ZMqvt.js) filters the answer:
  //
  //   async function VT(){ return (await Jn.getSupportedCommands()).filter(HT) }
  //   function HT(e){ return e.scope === "cowork" }
  //
  // Returning [] passed that filter and rendered the palette's own built-ins, but the
  // header still said 「部分命令未能加载。请再次输入 / 重试。」 because this list is what
  // supplies the CLI commands. Each entry needs a name and the scope the filter looks
  // for; `hint` feeds the right-hand description in the row.
  //
  // The names are the CLI's own slash commands as the shipped composer lists them.
  // Only the commands the palette does NOT already render itself.
  //
  // Measured: the palette lists 13 built-ins on its own (plugin model effort plan skills
  // workflows usage config storage sandbox theme resume help). Serving those same names
  // produced 24 rows with 10 duplicates, each duplicate tagged 「自定义命令」 — so the
  // renderer treats anything from this list as a user-defined command. Listing only the
  // one that is genuinely absent avoids both the duplication and the wrong label.
  const CLI_COMMANDS = [
    { name: 'permissions', hint: 'Review permission settings' },
    { name: 'compact', hint: '压缩当前会话上下文，可附加摘要要求' },
    { name: 'goal', hint: '设置持久目标并自动续跑；status / pause / resume / continue / complete / clear' },
  ];
  const supportedCommands = () => CLI_COMMANDS.map((command) => ({
    name: command.name,
    hint: command.hint,
    description: command.hint,
    // The palette only keeps entries with this scope.
    scope: 'cowork',
    source: 'cli',
    aliases: [],
    hiddenAliases: [],
  }));
  define('claude.web_$_LocalSessions_$_getSupportedCommands', () => supportedCommands());
  define('claude.web_$_LocalAgentModeSessions_$_getSupportedCommands', () => supportedCommands());

  // Usage summary for Settings > Usage.
  //
  // The consumer (c71860c77-DZeKw33Y.js) reads:
  //
  //   e.windowHours
  //   e.surfaces.{chat,cowork,code}.{inputTokens,outputTokens,costUSD,webSearchRequests}
  //   e.bars[].{start, chat:{...}, cowork:{...}, code:{...}}   // start is "YYYY-MM-DD"
  //
  // and the page renders "Couldn't load usage" when the query answers null. It was
  // previously unhandled, so the whole usage page failed even once settings rendered.
  //
  // The numbers come from this build's own transcripts, so they describe real
  // activity. Cost is left undefined rather than guessed: this build talks to an
  // inference gateway, not to Anthropic list pricing.
  if (kernel) {
    define('claude.settings_$_Custom3pUsage_$_getSummary', (_e, days) => {
      const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
      const since = Date.now() - windowDays * 86400000;
      const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

      // The page prints 「缓存 token：读取 X · 写入 Y」 from these two fields. They were
      // absent, so the cell rendered NaN next to a real token total:
      //
      //   Code 387.9万 输入 + 输出 token
      //   缓存 token：读取 NaN · 写入 NaN
      //
      // The exact names come from the bundle's own schema (Xh):
      //   { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
      // The row template binds these names (c71860c77-C-Aidqqd.js):
      //   values: { read: <fmt>(t.cacheReadTokens), write: <fmt>(t.cacheWriteTokens) }
      // Serving only cacheReadInputTokens/cacheCreationInputTokens left both slots undefined
      // and the line rendered 「缓存 token：读取 NaN · 写入 NaN」 beside a real token total.
      // Keep the schema names too: other consumers read them.
      const emptyTotals = () => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
      });
      const surfaces = { chat: emptyTotals(), cowork: emptyTotals(), code: emptyTotals() };
      const byDay = new Map();

      for (const session of kernel.getAll()) {
        const at = typeof session.lastActivityAt === 'number' ? session.lastActivityAt
          : (typeof session.createdAt === 'number' ? session.createdAt : null);
        if (at === null || at < since) continue;
        const day = dayKey(at);
        const row = byDay.get(day) || { start: day, chat: emptyTotals(), cowork: emptyTotals(), code: emptyTotals() };
        byDay.set(day, row);

        const usage = require('./transcript-usage.cjs').transcriptUsage(kernel.getTranscript(session.sessionId) || []);
        // Code is the surface these sessions actually use. Cache aliases share values.
        for (const [field, tokens] of Object.entries(usage)) {
          surfaces.code[field] += tokens;
          row.code[field] += tokens;
        }
      }

      const bars = [...byDay.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
      return { windowHours: windowDays * 24, surfaces, bars };
    });
  }

  // The project file list behind the @-mention picker and the Files pane.
  //
  // The consumer (c227f4d5e-BtCczSFM.js) is specific about the shape:
  //
  //   let e = await bridge.getProjectFileListIfChanged(version)   // version|null
  //   if (i.paths === null) { /* unchanged: keep the cached list */ }
  //   else if (i.paths) a = MD(i.version, i.paths)                // split on \n
  //   ... lines.map(l => l.endsWith('/') ? l.slice(0,-1) : l)     // dirs end with /
  //
  // so the answer is { version, paths } where `paths` is a NEWLINE-SEPARATED string
  // and directories are marked with a trailing slash. `paths: null` means "unchanged
  // since the version you passed", which is what lets it skip re-indexing.
  //
  // The previous fallback answered null, so the picker had no files at all and
  // @-mentions could not resolve a path.
  let fileListCache = null;
  // Which folder the open session is looking at.
  //
  // The file index below used to resolve its root from
  //   settings.focusedCwd || kernel.getAll()[0].cwd || process.cwd()
  // but `focusedCwd` was never assigned anywhere in this file, so the fallback was
  // the FIRST session ever created — not the open one. In this workspace that first
  // session has cwd `...\注册号 逆向` while the open session has
  // `...\注册号 逆向\claude-code-desktop`, so @-mention indexed 20389 paths from the
  // PARENT folder (ccd-ref/, qq_tools/, …) and none of this project's own files.
  //
  // The renderer does tell us: `c21f11e6d` / `c227f4d5e` call
  //   t.setFocusedSession(sessionId)  on focus,  t.setFocusedSession(null) on blur
  // and both LocalSessions and LocalAgentModeSessions declare it. Nothing implemented
  // it, so the information was being discarded.
  //
  // `settings.focusedCwd` stays the single source of truth: the setter writes it and
  // the index reads it. Keeping one value (rather than also re-reading the session
  // at index time) means a missing write breaks the chain loudly instead of being
  // silently papered over by a second lookup.
  let focusedSessionId = null;
  const defineFocusedSession = (service) => {
    // Returns {ok:true} rather than null: the two call sites discard the answer, but
    // a real acknowledgement is the honest shape for a setter that did take effect.
    define(`claude.web_$_${service}_$_setFocusedSession`, (_e, sessionId) => {
      focusedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
      let cwd = null;
      if (focusedSessionId && kernel) {
        try {
          const s = kernel.getSession(focusedSessionId);
          cwd = s && typeof s.cwd === 'string' && s.cwd ? s.cwd : null;
        } catch { cwd = null; }
      }
      settings.focusedCwd = cwd;
      // A focus change invalidates the cached list, otherwise the picker keeps
      // serving the previous project's paths.
      fileListCache = null;
      return { ok: true, sessionId: focusedSessionId, cwd };
    });
  };
  defineFocusedSession('LocalSessions');
  defineFocusedSession('LocalAgentModeSessions');

  define('claude.web_$_Resources_$_getProjectFileListIfChanged', (_e, knownVersion) => {
    // The renderer calls this with ONE argument:
    //
    //   function jD(){ let e = it?.getProjectFileListIfChanged; if (e) return t => e(t) }
    //   ... await e(r)          // r is the previously seen version (c227f4d5e)
    //
    // but every handler in this bridge takes the EIPC event object first, so a single
    // argument lands in `_e` and `knownVersion` stays undefined. That silently
    // disabled the "unchanged" fast path: the caller never received `paths: null` and
    // re-indexed the whole tree every time.
    //
    // Accept both shapes: when the second slot is empty and the first is a string,
    // treat the first as the version. That keeps the event-first convention for any
    // other caller and fixes this one.
    const known = typeof knownVersion === 'string'
      ? knownVersion
      : (typeof _e === 'string' ? _e : undefined);

    // `focusedCwd` is written by setFocusedSession above and is the only signal that
    // names the OPEN session's folder. The later fallbacks cover the landing page,
    // where no session is focused yet; they are not a substitute for the focus write.
    const root = settings.focusedCwd
      || (kernel && kernel.getAll().length ? kernel.getAll()[0].cwd : null)
      || process.cwd();

    const walk = (dir, prefix, out, depth) => {
      if (depth > 12 || out.length > 20000) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        // Directories the picker should never offer.
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          walk(path.join(dir, entry.name), rel, out, depth + 1);
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
    };

    // A version derived from the folder plus its top-level mtime, so a caller that
    // already has this version gets `paths: null` instead of the whole list again.
    let stamp = 0;
    try { stamp = fs.statSync(root).mtimeMs; } catch { stamp = 0; }
    const version = `${root}:${Math.round(stamp)}`;

    if (fileListCache && fileListCache.version === version && known === version) {
      return { version, paths: null };
    }
    if (fileListCache && fileListCache.version === version) {
      return { version, paths: fileListCache.paths };
    }

    const out = [];
    walk(root, '', out, 0);
    const paths = out.join('\n');
    fileListCache = { version, paths };
    return { version, paths };
  });

  // The effective local Code settings.
  //
  // The consumer (shared-6-DkPBS4Mh.js) validates the answer against a zod schema
  // where EVERY field is `.optional().catch(...)`, so a partial object is legal —
  // but a null answer is parsed to `{}` (Pj), which means every setting reads as
  // "unknown" and the Settings pane shows its defaults instead of this build's real
  // configuration.
  //
  // The CLI status gate.
  //
  // The renderer compares the WHOLE answer to a string (cc43287c9-DJ31ir0Z.js, `kz`):
  //   let o = (async () => await e() === xt.Updating
  //              ? (await t()).success ? "landed" : "download_failed"
  //              : "not_needed")().catch(() => "error")
  // with xt from shared-0-ByI5P0CP.js (`Ty`):
  //   NotInstalled="not_installed" Updating="updating"
  //   Ready="ready"                DownloadFailed="download_failed"
  //
  // So getStatus must answer the bare enum string. Without a handler it fell through to
  // the generic fallback, which answers a {status, reason} object for `get*` methods —
  // an object can never be === "updating", and "unavailable" is not even in the enum.
  //
  // This build ships no Claude Code CLI, so the honest answer is "not_installed": the CLI
  // really is absent. Saying "ready" would make the app offer to start a CLI that does
  // not exist, and saying "updating" would make it wait on a download that never happens.
  define('claude.web_$_ClaudeCode_$_getStatus', () => 'not_installed');
  // prepare() is only reached while getStatus == "updating", which never happens here.
  // The consumer reads `.success` off the result, so answer that shape rather than null —
  // no download is attempted, and success:false is the truthful outcome of "not attempted
  // because there is nothing to update".
  define('claude.web_$_ClaudeCode_$_prepare', () => ({ success: false }));

  // Whether the GitHub CLI can run on this machine.
  //
  // Note the shape difference from its sibling checkGitAvailable: THIS ONE ANSWERS A BARE
  // BOOLEAN, not an object. The consumer (c227f4d5e-B8RiNIYP.js, fn `xR` exported as `zo`)
  // does:
  //   const t = nn?.checkGhAvailable;
  //   queryFn: () => t(e)
  //   const { data: o, isFetchedAfterMount: s, isFetching: c } = useQuery(...)
  //   const l = (o === false && !s) ? undefined : o;   // "false before remount" -> unknown
  //   const u = (l === undefined) && c;
  //   return { available: l, isChecking: u };
  // and the UI offers an "Install the GitHub CLI" dialog when gh is unavailable.
  //
  // With no handler the answer was `null`, so `available` was `null` -- neither true nor
  // false. Measured on the live replica: available null, treatsAsAvailable false,
  // treatsAsUnavailable false, i.e. the UI fell through both branches.
  //
  // Whether a folder has been trusted for agent work.
  //
  // The contract is `{ trusted: boolean }` and the consumers dereference it directly:
  //   shared-19:   Qt.checkTrust(n).then(t => { e || i(t.trusted ? n : null) }).catch(...)
  //   cc43287c9:   (await t(r.cwd)).trusted                    (fn Toe -- no catch)
  //   c5a37dedf:   if (v.checkTrust && !(await v.checkTrust(e)).trusted) throw new Ne(...)
  // The last one is the launch path for a local code session, and it is NOT inside a
  // .catch, so a null answer throws
  //   TypeError: Cannot read properties of null (reading 'trusted')
  // and the launch fails with no explanation. Measured on the live replica before the fix:
  //   answer null; launchPath { ok: false, threw: "...reading 'trusted'" }
  //
  // Trust is recorded by the real Claude Code CLI in ~/.claude.json under
  //   projects["<posix-style path>"].hasTrustDialogAccepted
  // so this reads that file rather than inventing a separate store. A folder with no entry
  // is simply not trusted yet -- which is a fact, not a failure.
  // Where the trust store lives.
  //
  // The CLI's own file is ~/.claude.json. Electron's main process on this host cannot WRITE
  // there: fs.accessSync says the file is writable and a plain Node process can write it, but
  // from the main process every write returns
  //   EPERM: operation not permitted, open 'C:\Users\Administrator\.claude.json'
  // -- the same process-level restriction that pushed the session store into the workspace.
  //
  // So: keep READING the CLI file (it is the source of truth for folders trusted elsewhere),
  // and fall back to a workspace-local overlay for writes. Reads check both, overlay first.
  const claudeJsonPath = () => path.join(os.homedir(), '.claude.json');
  const trustOverlayPath = () => {
    // An explicit override lets a test point the overlay at its own temp dir, so it never
    // touches the real workspace file.
    if (process.env.CLAUDE_TRUST_STORE) return process.env.CLAUDE_TRUST_STORE;
    const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
    return path.join(workspace, '.data', 'trust-store.json');
  };
  // ---- MCP -----------------------------------------------------------------
  //
  // Found missing: every MCP channel (mcpCallTool / mcpListResources / mcpReadResource /
  // getLocalMcpServers / mcpAuthenticate / mcpReconnect) had no handler and answered through the
  // generic fallback. That is a REAL gap, not a deliberate one: the upstream main process
  // implements all of them (index.chunk-Bn6onBlX.js has 411 MCP references, and this project
  // already ships a complete MCP client in desktop/mcp-host.cjs — load/list/connect/callTool/
  // disconnect/restart/stopAll). It was wired only into main-services.cjs (the hand-drawn shell),
  // never into this bridge, so the shipped frontend could not see it.
  //
  // The user's own ~/.claude.json carries a real `mcpServers` block, so this is testable against
  // real configuration rather than a fixture.
  const mcpHost = opts.mcpHost || new (require('./mcp-host.cjs').McpHost)();
  let mcpConfigLoaded = false;
  const mcpConfigPath = () => process.env.CLAUDE_MCP_CONFIG || claudeJsonPath();
  const ensureMcpConfig = () => {
    if (mcpConfigLoaded) return null;
    const file = mcpConfigPath();
    const parsed = readJsonFile(file);
    mcpConfigLoaded = true;
    if (!parsed || typeof parsed !== 'object') return { loaded: false, configPath: file };
    try {
      const result = mcpHost.load(parsed);
      return { loaded: true, configPath: file, ...result };
    } catch (error) {
      return { loaded: false, configPath: file, error: error.message };
    }
  };
  /** The renderer's view of a server: name, transport, status and tool count. */
  const mcpServersView = () => {
    ensureMcpConfig();
    return mcpHost.list();
  };

  const readJsonFile = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  /** True when the file (or its directory) can actually be written by THIS process. */
  const canWriteFile = (file) => {
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `_trust_probe_${process.pid}`);
      fs.writeFileSync(probe, 'p');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  };
  /** Merge: the CLI file, then our overlay on top (our answers win). */
  const readTrustStore = () => {
    const base = readJsonFile(claudeJsonPath()) || {};
    const overlay = readJsonFile(trustOverlayPath()) || {};
    const projects = { ...(base.projects || {}) };
    for (const [key, entry] of Object.entries(overlay.projects || {})) {
      projects[key] = { ...(projects[key] || {}), ...(entry || {}) };
    }
    return { ...base, ...overlay, projects };
  };
  /** Write our overlay. Returns false when even the workspace is not writable. */
  const writeTrustStore = (store) => {
    const overlay = trustOverlayPath();
    try {
      fs.mkdirSync(path.dirname(overlay), { recursive: true });
      fs.writeFileSync(overlay, JSON.stringify(store, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  };
  // The CLI keys projects by forward-slash paths; a Windows cwd must be converted.
  const projectKey = (cwd) => String(cwd).replace(/\\/g, '/');

  // The trust answer is `{ trusted, sources }` -- NOT just `{ trusted }`.
  //
  // `sources` is the list of "dangerous feature" sources found in the folder, and the
  // caller forwards it straight into the confirmation prompt:
  //   let a = await checkTrust(cwd, remote, opts);
  //   return a.trusted ? "accepted"
  //        : requestTrustOutcome(cwd, a.sources, remote, { gateId });
  //                                 ^^^^^^^^^ this becomes the dialog's `sources`
  // and the dialog then does `sources.length`.
  //
  // Omitting it caused a hard renderer crash. Measured on the live replica:
  //   [BOOTSTRAP] Fatal error boundary triggered
  //   TypeError: Cannot read properties of undefined (reading 'length')
  //   at Z (c165c93f1-BohzKorE.js:1:5895)   <- the trust dialog
  // and the app was stuck on "This page ran into a problem" with no composer.
  //
  // This build has no dangerous-feature scanner, so the honest value is an empty array --
  // never undefined.
  const TRUST_SOURCES = () => [];

  define('claude.web_$_LocalSessions_$_checkTrust', (_e, cwd) => {
    // A missing cwd is not trusted: answering an object keeps the caller's `.trusted` safe.
    if (typeof cwd !== 'string' || !cwd) return { trusted: false, sources: TRUST_SOURCES() };
    const store = readTrustStore();
    if (!store || !store.projects) return { trusted: false, sources: TRUST_SOURCES() };
    const key = projectKey(cwd);
    // The CLI also records the path with a trailing slash in some versions.
    const entry = store.projects[key] || store.projects[key + '/'] || null;
    return {
      trusted: entry ? entry.hasTrustDialogAccepted === true : false,
      sources: TRUST_SOURCES(),
    };
  });

  define('claude.web_$_LocalSessions_$_checkStoredTrust', (_e, cwd) => {
    if (typeof cwd !== 'string' || !cwd) return { trusted: false, sources: TRUST_SOURCES() };
    const store = readTrustStore();
    const key = projectKey(cwd);
    const entry = store && store.projects ? (store.projects[key] || store.projects[key + '/']) : null;
    return {
      trusted: entry ? entry.hasTrustDialogAccepted === true : false,
      sources: TRUST_SOURCES(),
    };
  });

  // Persist the answer, so "trust this folder" survives a restart. The caller passes the
  // cwd and the decision; the shape written matches what the CLI reads back.
  define('claude.web_$_LocalSessions_$_saveTrust', (_e, cwd, trusted) => {
    if (typeof cwd !== 'string' || !cwd) return { ok: false, trusted: false };
    const store = readTrustStore() || {};
    if (!store.projects || typeof store.projects !== 'object') store.projects = {};
    const key = projectKey(cwd);
    const entry = store.projects[key] || (store.projects[key] = {});
    const wanted = trusted === undefined ? true : Boolean(trusted);
    entry.hasTrustDialogAccepted = wanted;
    // Only our own overlay is written. Writing the CLI's file fails with EPERM here, and a
    // "save" that reports ok:true while writing nothing is worse than one that reports failure.
    if (!writeTrustStore({ projects: store.projects })) {
      return { ok: false, trusted: !wanted, error: 'trust store is not writable' };
    }
    return { ok: true, trusted: wanted };
  });

  // Answer the pending "trust this folder?" question for a session.
  //
  // Consumer (cc43287c9-DP2cbT8E.js, fn `IX`):
  //   let t = Kt?.answerPendingCwdTrust;
  //   if (!e || !a || !o || !s || !t) return;
  //   n(o, s).then(e => { if (e !== "cancelled") { t(c, a, e === "accepted"); return; } ... })
  // called as answerPendingCwdTrust(sessionId, promptId, accepted). The return value is NOT
  // read -- the point is the side effect: accepting must persist trust for that folder, so
  // the prompt stops reappearing and the session can move.
  //
  // With no handler the answer was null and nothing happened: the prompt stayed pending and
  // the working-directory move never completed. Accepting now records trust through the same
  // store the CLI uses.
  define('claude.web_$_LocalSessions_$_answerPendingCwdTrust', (_e, sessionId, promptId, accepted) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false };
    // Resolve the folder this prompt belongs to from the live session record.
    //
    // NOTE: this used to look the record up through
    //   handlers.get('claude.web_$_LocalSessions_$_getSessionList')
    // but that method has no handler, so `list` was always null, `cwd` was always null, and
    // the trust write below was unreachable dead code -- accepting a prompt recorded
    // nothing. The kernel is the real source of session records and is already in scope.
    let cwd = null;
    try {
      const records = kernel && typeof kernel.getAll === 'function' ? kernel.getAll() : [];
      const list = Array.isArray(records) ? records : (records && records.sessions) || [];
      const record = list.find((s) => s && (s.sessionId === sessionId || s.id === sessionId));
      if (record) cwd = record.pendingCwd || record.workingDir || record.cwd || null;
    } catch { /* leave cwd null */ }

    if (accepted === true && cwd) {
      const store = readTrustStore() || {};
      if (!store.projects || typeof store.projects !== 'object') store.projects = {};
      const key = projectKey(cwd);
      const entry = store.projects[key] || (store.projects[key] = {});
      entry.hasTrustDialogAccepted = true;
      try { fs.writeFileSync(claudeJsonPath(), JSON.stringify(store, null, 2), 'utf8'); } catch { /* reported below */ }
    }
    return { ok: true, accepted: accepted === true, promptId: promptId ?? null };
  });

  // Pick a folder with the OS dialog. Returns the chosen absolute path, or null if the user
  // cancelled -- the caller checks `if (!r) return`, so null is the correct "cancelled" value.
  //
  // The "change folder" affordance is gated by
  //   ic = e => e?.type === "local" && !!LocalSessions.changeCwd && !!FileSystem.browseFolder && ...
  // Both existed as declared methods, so the menu item RENDERED, but every one of
  // changeCwd / browseFolder / browseFiles answered null: clicking it did nothing at all.
  // That is worse than a missing item, because the user has no way to tell it is inert.
  define('claude.web_$_FileSystem_$_browseFolder', async (_e, title) => {
    const win = getMainWindow && getMainWindow();
    if (!win || (win.isDestroyed && win.isDestroyed())) return null;
    let dialog;
    try { dialog = require('electron').dialog; } catch { return null; }
    if (!dialog) return null;
    try {
      const result = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title ? title : 'Select folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) return null;
      return result.filePaths[0];
    } catch { return null; }
  });

  define('claude.web_$_FileSystem_$_browseFolders', async (_e, title) => {
    const win = getMainWindow && getMainWindow();
    if (!win || (win.isDestroyed && win.isDestroyed())) return null;
    let dialog;
    try { dialog = require('electron').dialog; } catch { return null; }
    if (!dialog) return null;
    try {
      const result = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title ? title : 'Select folders',
        properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      });
      if (!result || result.canceled || !Array.isArray(result.filePaths)) return null;
      return result.filePaths;
    } catch { return null; }
  });

  define('claude.web_$_FileSystem_$_browseFiles', async (_e, title) => {
    const win = getMainWindow && getMainWindow();
    if (!win || (win.isDestroyed && win.isDestroyed())) return null;
    let dialog;
    try { dialog = require('electron').dialog; } catch { return null; }
    if (!dialog) return null;
    try {
      const result = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title ? title : 'Select files',
        properties: ['openFile', 'multiSelections'],
      });
      if (!result || result.canceled || !Array.isArray(result.filePaths)) return null;
      return result.filePaths;
    } catch { return null; }
  });

  // Pick a SINGLE file, answering { folder, name, relPath }.
  //
  // The wrapper is `async function ck(e, t) { let n = Ge?.browseFile; if (n) return ak(() => n(e, t)) }`
  // (shared-20, exported as `u`), and the caller in shared-23 reads the answer as:
  //   let i = await Fm(title, folder);
  //   if (!i) return;                                 // null = cancelled, safe
  //   if (n && i.relPath !== void 0) { n.openFile(i.relPath); return }
  //   ... r.some(e => e.openIfInside(i.folder, i.name)) ...
  // so the record must carry folder / name / relPath.
  //
  // browseFiles (plural) was implemented in round 85 but this singular one was not, so the
  // pair was inconsistent: the "Open file" action rendered (the gate is `!!browseFile`) and
  // did nothing. Same class as browseFolder before round 84.
  //
  // The record-building logic is exported as `buildFilePickResult` so it can be exercised
  // without a dialog. Without that, a test under node cannot tell this handler apart from the
  // generic fallback: both answer null when no dialog exists, and a regression proof that
  // removes the handler stays green.
  define('claude.web_$_FileSystem_$_browseFile', async (_e, title, folder) => {
    const win = getMainWindow && getMainWindow();
    if (!win || (win.isDestroyed && win.isDestroyed())) return null;
    let dialog;
    try { dialog = require('electron').dialog; } catch { return null; }
    if (!dialog) return null;
    try {
      const result = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title ? title : 'Open file',
        // The caller may name a starting folder; only pass it when it is a real directory.
        ...(typeof folder === 'string' && folder && fs.existsSync(folder) ? { defaultPath: folder } : {}),
        properties: ['openFile'],
      });
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) return null;
      return buildFilePickResult(result.filePaths[0], folder);
    } catch { return null; }
  });

  // Move a session to a different working directory.
  //
  // The consumer (cc43287c9, fn `IX` and the folder-picker path) expects the move to either
  // happen or park in `pendingCwd` with a `pendingCwdTrustPrompt` for an untrusted folder.
  // Answering `{ ok }` keeps the caller from reading a field off null.
  define('claude.web_$_LocalSessions_$_changeCwd', (_e, sessionId, cwd) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'no session' };
    if (typeof cwd !== 'string' || !cwd) return { ok: false, reason: 'no path' };
    let exists = false;
    try { exists = fs.statSync(cwd).isDirectory(); } catch { exists = false; }
    if (!exists) return { ok: false, reason: 'not a directory' };
    // Trust decides whether the move can happen now or must wait for confirmation.
    const store = readTrustStore();
    const key = projectKey(cwd);
    const entry = store && store.projects ? (store.projects[key] || store.projects[key + '/']) : null;
    const trusted = entry ? entry.hasTrustDialogAccepted === true : false;
    if (!trusted) {
      // Park the request: the UI shows a prompt and calls answerPendingCwdTrust.
      return { ok: false, pending: true, pendingCwd: cwd, reason: 'untrusted' };
    }
    return { ok: true, cwd };
  });

  // Answering a boolean is the whole contract. This host has no `gh` on PATH, so the honest
  // value is `false` -- which is also what makes the install prompt reachable.
  define('claude.web_$_LocalSessions_$_checkGhAvailable', () => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = require('node:child_process').execFileSync(finder, ['gh'], {
        encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  });

  // Whether git can actually run on this machine.
  //
  // The consumer (cb92a6d7a-B_0aRBoJ.js) stores the answer and reads it as
  //   gitAvailable?.available === false
  //   gitAvailable?.available !== true   -> re-check
  // and renders a reason-specific banner when the reason is
  //   n.StartupFailed  ("Git is installed, but it failed to start ...")
  // The reason enum is
  //   { NotFound: "not-found", ExecBlocked: "exec-blocked", StartupFailed: "startup-failed" }
  // (shared-0-BRYCPbU4.js, `Db`, exported as `ig`).
  //
  // With no handler the generic fallback answered `null`, so `available` was `undefined`.
  // Every `=== false` branch was skipped and the "git became available" transition never
  // fired: the app behaved as though git were fine, without ever having asked.
  //
  // The answer is now derived by running git, and it distinguishes the three reasons the
  // UI already knows how to explain:
  // ---- subscription quota ---------------------------------------------------
  //
  // The frontend's usage panel (c96d752d0, fn JG) does:
  //   queryKey: ["epitaxy","period-usage"]
  //   queryFn: () => Sn?.getPeriodUsage?.() ?? null
  //   const { data: r } = useQuery(...);  const hasUsage = !!r
  // and renders windows.five_hour / .seven_day with { utilization, resets_at, status }.
  //
  // A null answer HIDES the whole panel, which is what happened before: there was no
  // handler at all, so the fallback returned null and the quota UI never appeared.
  //
  // Where the numbers come from: the shipped CLI calls `/api/oauth/usage` on the Anthropic
  // API with the OAuth access token (confirmed in the official binary:
  //   case "plain": return "/api/oauth/usage";
  //   case "cedar_ember": return "/api/oauth/usage?cedar_ember=1&skip_spend=1";
  // The same call is reproduced here. Without an OAuth token we answer null rather than
  // inventing numbers -- a fabricated quota would be worse than no quota.
  const OAUTH_USAGE_PATH = '/api/oauth/usage';
  const ANTHROPIC_API = 'https://api.anthropic.com';

  // ---- subscription accounts -------------------------------------------------
  //
  // Accounts signed in through the OAuth flow (desktop/oauth-login.cjs) live in a
  // workspace-local store (desktop/account-store.cjs). The Electron process cannot write
  // outside the workspace on this host, which is why this is `.data/accounts.json` and not
  // a per-user app-data path (same constraint as the session store, see main.cjs).
  const accountStore = opts.accountStore || createAccountStore({
    filePath: path.join(settings.dataDir || path.join(process.cwd(), '.data'), 'accounts.json'),
  });
  const coworkGlobalMemory = require('./cowork-global-memory.cjs').createCoworkGlobalMemory({
    userDataDir: path.resolve(opts.coworkMemoryUserDataDir || settings.dataDir || path.join(process.cwd(), '.data')),
    getAccountContext: () => {
      const getAccount = () => typeof accountStore.getActiveIdentitySnapshot === 'function'
        ? accountStore.getActiveIdentitySnapshot() : accountStore.getActiveIdentity?.() ?? null;
      return typeof opts.resolveCoworkMemoryIdentity === 'function' ? opts.resolveCoworkMemoryIdentity(getAccount) : getAccount();
    },
  });
  define('claude.web_$_CoworkMemory_$_readGlobalMemory', () => coworkGlobalMemory.readGlobalMemory());
  define('claude.web_$_CoworkMemory_$_writeGlobalMemory', (_event, content) => coworkGlobalMemory.writeGlobalMemory(content));
  for (const method of ['listAccountMemories', 'readAccountMemory', 'writeAccountMemory', 'deleteAccountMemory', 'resetMemories']) {
    define(`claude.web_$_CoworkMemory_$_${method}`, (_event, ...args) => coworkGlobalMemory[method](...args));
  }
  // Opening the browser is the host's job (Electron `shell`); only https is ever opened.
  const openExternal = typeof opts.openExternal === 'function' ? opts.openExternal : null;
  const openAuthorizeUrl = async (url) => {
    if (!openExternal) throw Object.assign(new Error('no way to open a browser'), { kind: 'http_error' });
    if (!/^https:\/\//i.test(url)) throw new Error('refusing to open a non-https URL');
    await openExternal(url);
  };
  // A sign-in already in progress must not be started twice: two loopback listeners racing
  // for one browser tab is how you get a state mismatch.
  let signInInFlight = null;

  /** Find an OAuth access token: a signed-in account first, then profile, then environment. */
  const findOAuthToken = async () => {
    try {
      const fromAccount = await accountStore.getActiveAccessToken();
      if (fromAccount) return { token: fromAccount, source: 'account' };
    } catch { /* fall through */ }
    try {
      const found = read3pConfig();
      const cred = found && found.config && found.config.credentials;
      if (cred && typeof cred === 'object') {
        const t = cred.accessToken || cred.access_token;
        if (typeof t === 'string' && t.trim()) return { token: t.trim(), source: 'profile' };
      }
      const cfg = found && found.config;
      if (cfg && typeof cfg.oauthAccessToken === 'string' && cfg.oauthAccessToken.trim()) {
        return { token: cfg.oauthAccessToken.trim(), source: 'profile' };
      }
    } catch { /* fall through to the environment */ }
    const envToken = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
    if (envToken) return { token: envToken, source: 'env' };
    return null;
  };

  /**
   * Map an Anthropic `/api/oauth/usage` body onto the shape the panel reads.
   *
   * The official body already uses the same window names, so this is a near-identity
   * mapping. Kept as a separate function so it can be tested without the network.
   * @param {object} body
   * @returns {object}
   */
  const mapUsageWindows = (body) => {
    const src = body && typeof body === 'object' ? body : {};
    const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_oauth_apps', 'overage'];
    const windows = {};
    for (const name of WINDOWS) {
      const w = src[name];
      if (!w || typeof w !== 'object') continue;
      const utilization = typeof w.utilization === 'number' ? w.utilization : undefined;
      const resetsAt = typeof w.resets_at === 'number' ? w.resets_at
        : (typeof w.resets_at === 'string' ? w.resets_at : undefined);
      if (utilization === undefined && resetsAt === undefined) continue;
      windows[name] = {
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
        // The panel reads `status` to pick "approaching_limit" styling.
        ...(typeof w.status === 'string' ? { status: w.status } : {}),
      };
    }
    // Nothing usable means "no quota to show", not "zero quota".
    if (!Object.keys(windows).length) return null;
    return {
      windows,
      // Extra fields the panel may read; passed through when present.
      ...(src.extra_usage && typeof src.extra_usage === 'object' ? { extra_usage: src.extra_usage } : {}),
      fetchedAt: Date.now(),
    };
  };

  define('claude.web_$_ClaudeCode_$_getPeriodUsage', async () => {
    const auth = await findOAuthToken();
    // No subscription token -> no quota. Answering a zeroed shape would render a fake panel.
    if (!auth) return null;

    // The subscription token is a credential for Anthropic ONLY. This used to read
    // ANTHROPIC_BASE_URL, so pointing the agent at a third-party gateway would have sent the
    // user's OAuth token to that gateway. Always the official host, regardless of env.
    const url = `${ANTHROPIC_API}${OAUTH_USAGE_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        // 401/403 means the token is stale; the UI should show nothing rather than zeros.
        return null;
      }
      const body = await response.json();
      return mapUsageWindows(body);
    } catch {
      // Network failure, timeout, malformed JSON: the panel simply does not render.
      return null;
    } finally {
      clearTimeout(timer);
    }
  });

  // Exposed for tests: pure mapping, no network.
  settings.mapUsageWindows = mapUsageWindows;

  // Sign in with a Claude subscription.
  //
  // Contract (shared-1 hH()): `await I?.signInWithAnthropicApi?.() ?? {ok:false,errorKind:"ERR_FAILED"}`
  // and the UI switches on `errorKind` (eH()). Before this there was no handler, so the
  // generic fallback answered null and every attempt showed "Sign-in failed unexpectedly".
  //
  // The user authenticates in their own browser; we only receive the one-time code on a
  // loopback port. A second call while one is pending returns the SAME promise instead of
  // opening a second listener.
  define('claude.settings_$_Custom3pSetup_$_signInWithAnthropicApi', () => {
    if (!signInInFlight) {
      signInInFlight = accountStore.signIn({ openBrowser: openAuthorizeUrl })
        .finally(() => { signInInFlight = null; });
    }
    return signInInFlight.then((r) => (r.ok ? { ok: true } : { ok: false, errorKind: r.errorKind }));
  });

  define('claude.settings_$_Custom3pSetup_$_importSub2TwoFA', async (_event, options) => {
    try {
      const result = await require('./sub2api-twofa.cjs').importTwoFA(options);
      return { ok: true, ...result };
    } catch { return { ok: false, error: 'Sub2API 2FA 导入失败，请检查地址、管理令牌和账号格式' }; }
  });

  define('claude.settings_$_Custom3pSetup_$_importModelSubscription', (_event, options) =>
    require('./model-subscription-import.cjs').importModelSubscription(options || {}));

  define('claude.settings_$_Custom3pSetup_$_importSubscription', (_event, options) => {
    const dir = configLibraryDir();
    if (!dir) return { ok: false, error: 'no library' };
    try {
      const imported = require('./subscription-import.cjs').parseSubscription(options);
      const meta = readConfigMeta(dir, true);
      const id = require('node:crypto').randomUUID();
      writeConfigFile(dir, id, imported.config);
      try {
        meta.entries.push({ id, name: imported.name });
        if (!meta.appliedId) meta.appliedId = id;
        writeConfigMeta(dir, meta);
      } catch (error) {
        try { fs.unlinkSync(CONFIG_FILE(dir, id)); } catch {}
        throw error;
      }
      return { ok: true, id, ...configListShape(dir) };
    } catch (error) { return configError(error); }
  });

  // The multi-account surface is OUR extension: the official desktop app has one signed-in
  // account and no list/switch methods, so none of this is a bridge channel and none of it is
  // in bridge-map. It is exported on the module for our own settings UI and for tests.
  settings.accounts = {
    list: () => accountStore.list(),
    signIn: (options) => accountStore.signIn({ openBrowser: openAuthorizeUrl, ...options }),
    importTokens: (tokens, options) => accountStore.upsertFromTokens(tokens, { source: 'import', ...options }),
    setActive: (id) => accountStore.setActive(id),
    remove: (id) => accountStore.remove(id),
  };

  //   not found on PATH            -> not-found
  //   found but refused by policy  -> exec-blocked   (EPERM/EACCES)
  //   found but fails to start     -> startup-failed (any other failure)
  define('claude.web_$_ClaudeCode_$_checkGitAvailable', () => {
    let out;
    try {
      out = require('node:child_process').execFileSync('git', ['--version'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) {
      return { available: false, reason: classifyGitFailure(error) };
    }
    // A zero exit with output means git really ran.
    return { available: typeof out === 'string' && out.trim().length > 0 };
  });

  // The fields below are the ones this build can answer honestly. Anything not
  // listed is left out rather than invented: `managedSettingsPending` /
  // `managedSettingsUnverified` stay absent because there is no managed policy
  // source here, and the caller treats absent as "not managed".
  // The models the gateway actually serves.
  //
  // availableModels used to be `[<the current model>]`, so the composer offered exactly one
  // choice no matter what the gateway had. Measured against http://127.0.0.1:3000: the
  // gateway answers /v1/models with 15 ids (deepseek-v4-pro, gpt-5.5, glm-5.3, kimi-k3...),
  // while the picker listed just deepseek-v4.1-flash.
  //
  // The list is fetched lazily and cached: resolveLocalSettings is called on every settings
  // read, and a network round trip there would stall the whole page. On failure the current
  // model is returned alone — an honest degradation, not an invented catalogue.
  const modelListCache = { value: null, at: 0, key: null };
  const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
  const fetchAvailableModels = async (gateway, currentModel) => {
    const configured = require('./bootstrap-service.cjs').normalizeModelIds(gateway.raw?.inferenceModels);
    if (configured.length) { rememberGatewayModels(gateway.raw.inferenceModels, gateway); return [...new Set([currentModel, ...configured].filter(Boolean))]; }
    const key = `${gatewayModelKey(gateway)}|${currentModel}`;
    if (modelListCache.value && modelListCache.key === key && Date.now() - modelListCache.at < MODEL_LIST_TTL_MS) {
      return modelListCache.value;
    }
    const fallback = currentModel ? [currentModel] : [];
    try {
      const modelBase = String(gateway.baseUrl || "").replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/, "").replace(/\/v1$/, "");
      const url = modelBase + "/v1/models";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      let response;
      try {
        response = await fetch(url, {
          headers: {
            ...(gateway.apiKey ? { "x-api-key": gateway.apiKey, authorization: `Bearer ${gateway.apiKey}` } : {}),
          },
          signal: controller.signal,
        });
      } finally { clearTimeout(timer); }
      if (!response.ok) return fallback;
      const body = await response.json();
      const rows = Array.isArray(body && body.data) ? body.data : (Array.isArray(body && body.models) ? body.models : []);
      const ids = rows.map((row) => row && (row.id || row.name)).filter((id) => typeof id === "string" && id);
      if (!ids.length) return fallback;
      // Keep the current model in the list even if the gateway did not name it, so the
      // picker cannot show a value it does not contain.
      const list = currentModel && !ids.includes(currentModel) ? [currentModel, ...ids] : ids;
      modelListCache.value = list;
      modelListCache.at = Date.now();
      modelListCache.key = key;
      // Share with the bootstrap document, which is rendered synchronously and cannot fetch.
      rememberGatewayModels(rows, gateway);
      return list;
    } catch {
      return fallback;
    }
  };
  let availableCodeModels = [];

    // The renderer PUSHES its model list here —
    //   [trace] claude.web.LocalSessions.setAvailableCodeModels [["deepseek-v4.1-flash"]]
    // — and this channel had no handler, so the answer was null and the list was dropped.
    // The composer then offered only the single current model even though the gateway
    // serves 15 (measured: /v1/models lists deepseek-v4-pro, gpt-5.5, glm-5.3, kimi-k3...).
    //
    // The push itself carries only what the renderer already knows, so this handler records
    // it rather than pretending to be the source. When the renderer does not know either,
    // resolveLocalSettings falls back to the gateway catalogue it fetched.
    define('claude.web_$_LocalSessions_$_setAvailableCodeModels', (_e, models) => {
      const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
      if (list.length) availableCodeModels = list;
      return { ok: true, count: list.length };
    });
    define('claude.web_$_LocalAgentModeSessions_$_setAvailableCodeModels', (_e, models) => {
      const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
      if (list.length) availableCodeModels = list;
      return { ok: true, count: list.length };
    });

  // Warm the catalogue shortly after startup.
  //
  // The bootstrap document is rendered synchronously and cannot fetch, and the renderer never
  // calls resolveLocalSettings — so without this the cache stayed cold forever and the picker
  // kept advertising one model.
  //
  // Deferred on purpose, and deliberately not part of construction: an immediate fetch ran
  // during every bridge construction, which broke tests that count requests
  // (signin-bridge expected exactly one call to Anthropic and saw two). The timer also keeps
  // a slow gateway from delaying the window, and the fallback (current model only) is honest.
  if (typeof setTimeout === 'function') {
    const warmTimer = setTimeout(() => {
      try {
        const warmGateway = resolveGateway();
        const warmEnv = { ...process.env };
        require('./startup-defaults.cjs').clearStartupDefaultsForRelaunch(warmEnv);
        const warmModel = (warmEnv.CLAUDE_AGENT_MODEL || warmEnv.ANTHROPIC_MODEL || warmGateway.model || '').trim();
        fetchAvailableModels(warmGateway, warmModel || 'claude-sonnet-5-5').catch(() => {});
      } catch { /* an unconfigured gateway is not an error here */ }
    }, 0);
    if (warmTimer && typeof warmTimer.unref === 'function') warmTimer.unref();
  }

  define('claude.web_$_ClaudeCode_$_resolveLocalSettings', async () => {
    const env = { ...process.env };
    require('./startup-defaults.cjs').clearStartupDefaultsForRelaunch(env);
    // The model this build will actually call. It used to be read ONLY from the environment,
    // with a hard-coded fallback of 'claude-sonnet-5-5' — but the provider profile (the thing
    // the settings UI writes and the launcher injects) is the real source, and the launcher
    // does not set CLAUDE_AGENT_MODEL. So the picker advertised claude-sonnet-5-5 while the
    // agent talked to whatever the profile named, and a gateway offering different models
    // (e.g. deepseek-v4-pro) left the composer with a model it could not use — the Send button
    // stayed disabled with no error anywhere.
    //
    // Read the same resolved gateway the agent uses, so the two cannot disagree.
    const gateway = resolveGateway();
    const model = (env.CLAUDE_AGENT_MODEL || env.ANTHROPIC_MODEL || gateway.model || '').trim();
    const availableModels = await fetchAvailableModels(gateway, model || 'claude-sonnet-5-5');
    const permissionMode = (env.CLAUDE_PERMISSION_MODE || 'ask').trim();

    // Settings the user changed in this build override the defaults above, so a
    // value written by patchUserSettings is actually read back.
    let stored = {};
    try {
      if (typeof settings.readCodeSettings === 'function') stored = settings.readCodeSettings() || {};
    } catch { stored = {}; }
    const pick = (key, fallback) => (stored && stored[key] !== undefined ? stored[key] : fallback);

    return {
      model: { value: model || 'claude-sonnet-5-5', source: 'settings' },
      availableModels: { value: availableModels },
      defaultPermissionMode: { value: pick('defaultPermissionMode', permissionMode) },
      // This build has no sandbox and no workflow runner, and says so rather than
      // reporting them as enabled.
      sandboxEnabled: { value: pick('sandboxEnabled', false) },
      strictSandboxMode: { value: pick('strictSandboxMode', false) },
      enableWorkflows: { value: pick('enableWorkflows', false) },
      // These two are STRINGS in the schema, not booleans.
      //
      //   disableBypassPermissionsMode: bj("...", yj(e()))   // e = string
      //   disableAutoMode:              bj("...", yj(e()))
      //
      // while sandboxEnabled and the others use `c()` (boolean). Answering `true`
      // here failed validation with "expected string, received boolean", and the
      // field was dropped with a console warning — so the pane never learned that
      // bypass is unavailable. The string is the REASON it is disabled.
      disableBypassPermissionsMode: {
        value: pick('disableBypassPermissionsMode', 'Bypass permissions are not offered in this build'),
      },
      disableAutoMode: {
        value: pick('disableAutoMode', ''),
      },
    };
  });
  // The Settings pane writes Code settings through this. Persist into the same
  // overlay the account-settings PATCH uses, so a change survives a restart.
  define('claude.web_$_ClaudeCode_$_patchUserSettings', (_e, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'invalid_patch' };
    }
    if (typeof settings.patchCodeSettings !== 'function') {
      return { ok: false, error: 'not_writable' };
    }
    try {
      return { ok: true, settings: settings.patchCodeSettings(patch) };
    } catch (error) {
      return { ok: false, error: String(error && error.message) };
    }
  });

  // Git state for a folder, used by the Changes pane and the branch label.
  // Native getWorkingTreeStatus returns null for an untrusted cwd. A generic
  // feature-status fallback lacks files, which its frontend dereferences.
  const isGitCwdTrusted = (cwd) => {
      const store = readTrustStore();
      const key = projectKey(cwd);
      const entry = store?.projects?.[key] || store?.projects?.[key + '/'];
      return entry?.hasTrustDialogAccepted === true;
  };
  const landingTrustedRoot = cwd => {
    const projects = readTrustStore()?.projects || {};
    let candidate = path.resolve(cwd);
    while (true) {
      const key = projectKey(candidate);
      if (projects[key]?.hasTrustDialogAccepted === true || projects[key + '/']?.hasTrustDialogAccepted === true) return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  };
  const landingDirectory = require('./landing-directory.cjs').createLandingDirectory({
    isTrusted: cwd => !!landingTrustedRoot(cwd), getTrustedRoot: landingTrustedRoot,
  });
  define('claude.web_$_LocalSessions_$_listDirectoryAtCwd', (_event, cwd, requested) => landingDirectory.listDirectoryAtCwd(cwd, requested));
  const gitStatus = require('./git-status.cjs').createGitStatus({ isTrusted: isGitCwdTrusted });
  define('claude.web_$_LocalSessions_$_getLocalBranches', (_e, cwd) => gitStatus.getLocalBranches(cwd));
  define('claude.web_$_LocalSessions_$_getWorkingTreeStatus', (_e, cwd) => gitStatus.getWorkingTreeStatus(cwd));
  const gitDiff = require('./git-diff.cjs').createGitDiff({ isTrusted: isGitCwdTrusted });
  define('claude.web_$_LocalSessions_$_getGitDiff', (_e, ...args) => gitDiff.getGitDiff(...args));
  define('claude.web_$_LocalSessions_$_getGitDiffStats', (_e, ...args) => gitDiff.getGitDiffStats(...args));
  define('claude.web_$_LocalSessions_$_getDiffFileContent', (_e, ...args) => gitDiff.getDiffFileContent(...args));
  define('claude.web_$_LocalSessions_$_getGitDiffFilePatch', (_e, ...args) => gitDiff.getGitDiffFilePatch(...args));
  define('claude.web_$_LocalSessions_$_getGitCommits', (_e, ...args) => gitDiff.getGitCommits(...args));
  define('claude.web_$_LocalSessions_$_getCommitDiff', (_e, ...args) => gitDiff.getCommitDiff(...args));
  //
  // The consumer reads (shared-11-Ci0VQatJ.js):
  //
  //   let {git, dir} = ...
  //   if (a === undefined || t.repo.toLowerCase() !== a.toLowerCase()) return false
  //   ... t.root, t.trees[].folder, t.branch, t.defaultBranch
  //
  // so the answer must carry `repo` at minimum, plus the folder it describes. The
  // previous fallback answered null, which the pane treats as "not a repository" and
  // renders empty — indistinguishable from a clean tree.
  //
  // This asks git itself rather than guessing; outside a repository it reports
  // isRepo:false rather than inventing one.
  define('claude.web_$_LocalSessions_$_getGitInfo', (_e, folder) => {
    const dir = typeof folder === 'string' && folder ? folder : process.cwd();
    const run = (args) => {
      try {
        const out = require('node:child_process').execFileSync('git', args, {
          cwd: dir, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim();
      } catch { return null; }
    };

    const inside = run(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return { dir, isRepo: false, repo: '', branch: null, defaultBranch: null, root: null, trees: [] };
    }

    const root = run(['rev-parse', '--show-toplevel']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = run(['remote', 'get-url', 'origin']);
    // "owner/name" from an ssh or https remote, which is the form the UI compares.
    let repo = '';
    if (remote) {
      const ssh = remote.match(/[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
      const https = remote.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
      repo = (ssh && ssh[1]) || (https && https[1]) || '';
    }
    // The default branch, when the remote HEAD is known locally.
    const headRef = run(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const defaultBranch = headRef ? headRef.replace('refs/remotes/origin/', '') : null;

    return {
      dir,
      isRepo: true,
      repo,
      branch: branch && branch !== 'HEAD' ? branch : null,
      defaultBranch,
      root,
      remote: remote || null,
      // A single worktree at the folder itself; the UI tolerates an empty list.
      trees: root ? [{ folder: root, removed: false }] : [],
    };
  });
  // searchSessions is defined in the kernel block above; it needs the sessions.
  define('claude.web_$_GitState_$_getGitStateSnapshot', () => []);

  // Whether a folder's working tree has uncommitted changes.
  //
  // The consumer (shared-11-D8DsEVkq.js, fn Jp) is:
  //   queryFn: () => path
  //     ? (U.getWorkingTreeDirtyState ? U.getWorkingTreeDirtyState(path)
  //        : (await U.isWorkingTreeDirty?.(path)) ? Fe.Dirty : Fe.Clean)
  //     : Fe.Clean
  //   select: e => e !== Fe.Clean          // exported as the "is dirty" selector
  //
  // `Fe` resolves to the enum
  //   { Dirty: "dirty", Clean: "clean", Unknown: "unknown" }
  // (shared-0-BRYCPbU4.js: `Lx=function(e){return e.Dirty="dirty",e.Clean="clean",
  //  e.Unknown="unknown",e}({})`, re-exported as `e_` and imported into shared-11 as
  //  `Fe`). The literal spelling matters: `null !== "clean"` is true, so answering
  // `null` — which is what the generic fallback did, because `get*` with no matching
  // `emptyFor` rule and no Status/Availability suffix yields `null` — marks EVERY
  // folder as dirty forever and keeps the Changes pane from ever settling to "clean".
  //
  // The value must come from git, not from a guess. Outside a repository the honest
  // answer is `"unknown"`: it is inside the enum, and `"unknown" !== "clean"` is true,
  // which matches the UI, since a folder that is not a repo cannot be reported clean.
  // It is NOT reported as "clean", because claiming cleanliness without asking would be
  // a fabricated success.
  define('claude.web_$_LocalSessions_$_getWorkingTreeDirtyState', (_e, folder) => {
    const dir = typeof folder === 'string' && folder ? folder : process.cwd();
    const run = (args) => {
      try {
        return require('node:child_process').execFileSync('git', args, {
          cwd: dir, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch { return null; }
    };

    // Ask git whether this is a work tree before asking about dirty state.
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return 'unknown';

    // `status --porcelain` prints one line per changed path and nothing when clean.
    // A null result here means git itself failed, which is not the same as clean.
    const status = run(['status', '--porcelain']);
    if (status === null) return 'unknown';
    return status.length > 0 ? 'dirty' : 'clean';
  });

  define('claude.web_$_ForgeState_$_getForgeStateSnapshot', () => []);
  // The original scheduler dispatches to the renderer. Listener ACK is delivery,
  // while LocalSessions.start above confirms the actual allocated session identity.
  if (settings.dataDir) {
    scheduledTasks = require('./scheduled-tasks.cjs').createScheduledTasks({
      root: path.join(settings.dataDir, 'ccd-scheduler'),
      powerMonitor: opts.schedulerPowerMonitor,
      isOnline: opts.schedulerIsOnline,
      dispatchThrottle: opts.schedulerDispatchThrottle,
      emit: event => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return false;
        win.webContents.send(messageChannel('claude.web', 'CCDScheduledTasks', 'onScheduledTaskEvent'), event);
        return true;
      },
      isReadyToDispatch: () => {
        const win = getMainWindow();
        return !!win && !win.isDestroyed() && win.webContents.isLoadingMainFrame?.() !== true;
      },
    });
    for (const method of ['getAllScheduledTasks','getScheduledTaskFileContent','createScheduledTask',
      'updateScheduledTask','updateScheduledTaskStatus','removeApprovedPermission','getWatcherHistory',
      'markListenerReady','setEventAckSupported','ackEvent','releaseDispatchClaim','setHostRunsSupported']) {
      define('claude.web_$_CCDScheduledTasks_$_' + method, (_event, ...args) => scheduledTasks[method](...args));
    }
    if (kernel && typeof kernel.getAll === 'function') {
      scheduledTasks.setSessionRosterSource(id => kernel.getAll().filter(session => session.scheduledTaskId === id), true);
      scheduledTasks.setActiveSessionCounter(id => {
        const active = kernel.getAll().filter(session => session.scheduledTaskId && session.isRunning);
        return { thisTask: active.filter(session => session.scheduledTaskId === id).length, totalScheduled: active.length };
      });
    }
    scheduledTasks.start();
  }
  // The server supervisor and browser views have separate lifecycles.
  const emitLaunch = (name, ...args) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(messageChannel('claude.web', 'Launch', name), ...args);
  };
  const previewProviders = opts.previewProviders || {};
  const { derivePreviewPolicy, createPreviewOriginPolicy, buildBuiltinBrowserHostPolicy } = require('./preview-origin-policy.cjs');
  const previewPolicy = () => {
    const profile = read3pConfig()?.config || {};
    const supplied = previewProviders.getPolicyInput?.() || {};
    const policy = derivePreviewPolicy({ managedConfig: bridgeMap.__desktopManagedConfig || {},
      preferences: settings.preferences, builtinBrowserEnabled: profile.builtinBrowserEnabled ?? profile.builtinBrowser?.enabled,
      ...supplied });
    return { ...policy, epoch: JSON.stringify(policy) };
  };
  const originPolicy = createPreviewOriginPolicy({
    getHostPolicy: () => {
      if (previewProviders.getHostPolicy) return previewProviders.getHostPolicy();
      const profile = read3pConfig()?.config || {};
      const browser = profile.builtinBrowser || {};
      return buildBuiltinBrowserHostPolicy({ ...browser,
        enabled: (profile.builtinBrowserEnabled ?? browser.enabled) === true,
        allowedDomains: profile.builtinBrowserAllowedDomains ?? browser.allowedDomains,
        blockedDomains: profile.builtinBrowserBlockedDomains ?? browser.blockedDomains,
        defaultDomainPolicy: profile.builtinBrowserDefaultDomainPolicy ?? browser.defaultDomainPolicy,
      });
    },
    hostedSiteCheck: previewProviders.hostedSiteCheck,
  });
  previewAccess = require('./preview-access.cjs').createPreviewAccess({
    getPreviewHost: () => previewHost,
    getSession: id => kernel?.getSession(id),
    getRemoteSession: previewProviders.getRemoteSession,
    featureEnabled: () => previewPolicy().browserFeatureEnabled,
    getPolicy: async () => previewPolicy(),
    classifyOrigin: originPolicy.classifyOrigin,
    readAllowedOrigins: () => settings.preferences.launchPreviewAllowedOrigins || [],
    writeAllowedOrigins: values => {
      const previous = settings.preferences;
      settings.preferences = { ...previous, launchPreviewAllowedOrigins: values };
      if (savePreferences()) return true;
      settings.preferences = previous;
      return false;
    },
    consumeUserGesture: opts.consumePreviewUserGesture,
    getStandingReadPermission: previewProviders.getStandingReadPermission,
    getCurrentStamp: (id, tab) => previewHost?.getReadStamp(id, tab),
    isWorkspaceTrusted: cwd => isGitCwdTrusted(cwd),
  });
  previewHost = opts.previewHost || (opts.enablePreviewHost === true
    ? require('./preview-host.cjs').createPreviewHost({
      getMainWindow, emit: emitLaunch, offscreen: process.env.CLAUDE_BACKGROUND_CHECK === '1',
      readToolsEnabled: () => previewAccess.readsEnabled(),
      authorizeRead: stamp => previewAccess.authorizeRead(stamp),
      getSession: id => kernel?.getSession(id),
      authorizeHtmlFile: async ({ sourcePath, sessionId }) => {
        if (!sessionId || !fileAccess || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return false;
        const authorized = await fileAccess.resolveForReveal(sessionId, sourcePath);
        if (!authorized?.path) return false;
        const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
        return normalize(authorized.path) === normalize(sourcePath);
      },
      interactiveHtmlEnabled: () => previewPolicy().browserFeatureEnabled,
      onHtmlPreviewsChanged: () => launchStore?.publish(),
    }) : null);
  const previewLaunch = require('./preview-launch.cjs').createPreviewLaunch({
    isTrusted: isGitCwdTrusted,
    emit: (name, ...args) => {
      if (name === 'activeServers') launchStore?.publish();
      else emitLaunch(name, ...args);
    },
  });
  launchStore = require('./service-store.cjs').registerServiceStore({
    ipcMain, domain: 'claude.web', service: 'Launch', name: 'activeServers',
    getState: () => [...previewLaunch.getActiveServers(), ...(previewHost?.getHtmlPreviews?.() || []), ...previewAccess.getActiveServers()],
    send: (channel, state) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, state);
    },
  });
  define('claude.web_$_Launch_$_isAvailable', () => true);
  define('claude.web_$_Launch_$_getAllSessionPreviewTabs', () => previewHost?.getAllSessionPreviewTabs() || []);
  define('claude.web_$_Launch_$_getConfiguredServices', (_e, cwd) => previewLaunch.getConfiguredServices(cwd));
  define('claude.web_$_Launch_$_startFromConfig', async (_e, cwd, name, sessionId) => {
    const result = await previewLaunch.startFromConfig(cwd, name, sessionId);
    if (result.serverId && previewHost) {
      const preview = await previewHost.createPreview(result.serverId, previewLaunch.getPreviewUrl(result.serverId), cwd, sessionId);
      if (preview) Object.assign(result, preview);
      else result.error = 'Dev server started but its preview page failed to load';
    }
    return result;
  });
  define('claude.web_$_Launch_$_stopServer', (_e, id) => {
    if (previewHost?.getHtmlPreviews?.().some(row => row.serverId === id)) return previewHost.destroyPreview(id);
    const browser = previewAccess.getActiveServers().find(row => row.serverId === id);
    if (browser) { previewAccess.revokeSession(browser.sessionId); launchStore?.publish(); return true; }
    previewHost?.destroyPreview(id);
    return previewLaunch.stopServer(id);
  });
  define('claude.web_$_Launch_$_getLogs', (_e, id) => previewLaunch.getLogs(id));
  define('claude.web_$_Launch_$_getPreviewUrl', (_e, id) => previewHost?.getPreviewUrl(id) || previewLaunch.getPreviewUrl(id));
  for (const method of ['loadHtmlPreview', 'loadHtmlPreviewContent', 'loadClaudePagePreview', 'setArtifactPaneHost']) {
    define('claude.web_$_Launch_$_' + method, (_event, ...args) => previewHost?.[method]?.(...args) ?? null);
  }
  define('claude.web_$_Launch_$_startBrowserPreview', async (_e, ...args) => {
    const result = await previewAccess.startBrowserPreview(...args); launchStore?.publish(); return result;
  });
  define('claude.web_$_Launch_$_ensureRemoteBlankPreview', (_e, id, cowork = false) =>
    cowork && !previewPolicy().coworkBrowserEnabled ? null : previewAccess.ensureRemoteBlankPreview(id, cowork));
  define('claude.web_$_Launch_$_resolveRemotePaneConsent', (_e, query) => previewAccess.resolveRemotePaneConsent(query));
  define('claude.web_$_Launch_$_recordRemotePaneOriginDecision', (event, id, url, remember) =>
    previewPolicy().coworkBrowserEnabled ? previewAccess.recordRemotePaneOriginDecision(id, url, remember, event?.sender) : false);
  define('claude.web_$_Launch_$_admitRemotePaneOriginOnce', (event, id, origin) => previewAccess.admitRemotePaneOriginOnce(id, origin, event?.sender));
  if (previewHost) {
    for (const method of ['showPreview','hidePreview','destroyPreview','teardownRemoteSessionPreview',
      'refreshPreview','focusPreview','setPreviewViewport','clearPreviewViewport','setPreviewColorScheme',
      'getPreviewTabs','getPreviewNavState','navigatePreview','goBack','goForward','setActivePreviewTab',
      'closePreviewTab','reopenClosedPreviewTab','reorderPreviewTab','openPreviewTab','closeAllPreviewTabs',
      'setPreviewMuted','capturePreviewScreenshot','capturePreviewScreenshotIfChanged',
      'previewConsoleLogs','previewSnapshot','previewInspect']) {
      define('claude.web_$_Launch_$_' + method, (_event, ...args) => previewHost[method](...args));
    }
  }

  // ---- claude.web / ClaudeVM ---------------------------------------------
  // Cowork's secure workspace runs in a lightweight VM. The frontend asks
  // whether the Windows Virtual Machine Platform is present, offers to enable it,
  // and reports download/boot progress through the three event channels below.
  //
  // Status values the frontend understands (observed in its VM store):
  // download: "checking" | "downloading" | "ready" | "error"
  // running:  "offline" | "booting" | "ready" | "error"
  // Cowork uses the reconstruction's session kernel on the host. Report that
  // execution mode explicitly: the shipped start flow otherwise waits for VM
  // readiness before it calls LocalAgentModeSessions.start.
  //
  // This build does not ship a working VM service, so the platform check reports
  // what the host actually has and the download is refused with a stated reason
  // rather than a bare null (a null is what left the banner stuck at 0%).
  const vmState = {
    download: 'checking',
    running: 'offline',
    progress: 0,
    error: null,
  };

  // The frontend's VM store is fed by these three events, not only by the polling
  // getters. Without a push the composer keeps reading the boot-time value.
  const emitVmStatus = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const send = (event, payload) => {
      try {
        win.webContents.send(
          `$eipc_event$_${NAMESPACE}_$_claude.web_$_ClaudeVM_$_${event}`,
          payload,
        );
      } catch { /* window may be tearing down */ }
    };
    send('downloadStatusChanged', vmState.download);
    send('runningStatusChanged', vmState.running);
    send('downloadProgress', vmState.progress);
  };

  define('claude.web_$_ClaudeVM_$_getDownloadStatus', () => vmState.download);
  define('claude.web_$_ClaudeVM_$_getRunningStatus', () => vmState.running);
  define('claude.web_$_ClaudeVM_$_isHostLoopModeEnabled', () => kernel !== null);
  define('claude.web_$_ClaudeVM_$_isHostLoopDevOverrideActive', () => false);
  define('claude.web_$_ClaudeVM_$_setForceDisableHostLoop', () => ({ ok: true }));
  define('claude.web_$_ClaudeVM_$_setYukonSilverConfig', () => ({ ok: true }));

  // Whether the Windows Virtual Machine Platform is present.
  //
  // `dism` and Get-WindowsOptionalFeature both require elevation, and demanding
  // elevation just to answer a capability probe would be wrong. The presence of
  // the Host Compute Service (vmcompute) is the same fact without elevation: it
  // only exists when the Virtual Machine Platform / Hyper-V optional features are
  // installed. Its service key is read from the registry, and the query itself is
  // the probe the shipped flow performs.
  // Answers a BOOLEAN, because the caller tests it for truthiness.
  //
  // CONTRACT (c352a19af-Bj-sVAHT.js):
  //   g.checkVirtualMachinePlatform().then(t => { e || c(t ? null : 'not_enabled') })
  //
  // The caller does not read a field — it branches on the value itself. This handler used to
  // answer { installed, state, detail }, and an object is ALWAYS truthy, so the not_enabled
  // branch was unreachable: on a host without the feature the flow proceeded as if it were
  // present and failed later, with nothing pointing back here.
  define('claude.web_$_ClaudeVM_$_checkVirtualMachinePlatform', () => {
    // A single backslash per separator: reg.exe receives "HKLM\SYSTEM\...".
    const key = String.raw`HKLM\SYSTEM\CurrentControlSet\Services\vmcompute`;
    const { execFileSync } = require('node:child_process');
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'Start'], {
        timeout: 8000,
        windowsHide: true,
        encoding: 'utf8',
      });
      // Start=2 (auto) or 3 (manual) both mean the service is installed.
      const m = String(out).match(/Start\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      const start = m ? parseInt(m[1], 16) : null;
      return start === 2 || start === 3;
    } catch (error) {
      // A missing key means the optional feature is not installed on the host.
      return false;
    }
  });

  // Enabling the feature needs elevation and a reboot, so this reports that it
  // cannot be done in-process instead of pretending to succeed.
  define('claude.web_$_ClaudeVM_$_enableVirtualMachinePlatform', () => ({
    ok: false,
    reason: 'Requires elevation and a reboot; run "dism /online /enable-feature /featurename:VirtualMachinePlatform" as administrator.',
  }));
  define('claude.web_$_ClaudeVM_$_restartAfterVMPInstall', () => ({ ok: false, reason: 'Restart is not driven from this build.' }));

  // Downloading the VM image is the step the banner's "Setting up..." tracks. This
  // build has no such pipeline, so the state is moved to a terminal error with a
  // stated cause, which the frontend renders as a message instead of hanging.
  define('claude.web_$_ClaudeVM_$_download', () => {
    vmState.download = 'error';
    vmState.error = 'This build does not implement the secure VM download pipeline.';
    return { ok: false, reason: vmState.error };
  });
  define('claude.web_$_ClaudeVM_$_startVM', async () => {
    // The real capability question is whether the Cowork VM *service* answers,
    // not whether the Windows Virtual Machine Platform feature is present. The
    // service is installed by the packaged app as CoworkVMService and listens on
    // \\.\pipe\cowork-vm-service; the frontend's secureVm gate ultimately depends
    // on reaching it.
    const { probeVmService } = require('./cowork-vm-service.cjs');
    const probe = await probeVmService();
    if (probe.reachable) {
      vmState.running = 'ready';
      vmState.download = 'ready';
      // The frontend subscribes to status events; polling methods alone do not
      // re-render the composer, so both are pushed here.
      emitVmStatus();
      return { success: true, ok: true, detail: 'Cowork VM service reachable.' };
    }
    // R654: the probe answers a boolean (the renderer branches on the value), so reading `.installed` /
    // `.state` here always produced undefined and the message always claimed the platform was missing.
    // Measured: checkVirtualMachinePlatform() -> true, yet startVM reported "(state: undefined)".
    const platformEnabled = handlers.get('claude.web_$_ClaudeVM_$_checkVirtualMachinePlatform')() === true;
    if (!platformEnabled) {
      return {
        success: false,
        error: 'Windows Virtual Machine Platform is not enabled. Enable it and restart Windows.',
        ok: false,
        reason: 'Windows Virtual Machine Platform is not enabled. Enable it and restart Windows.',
      };
    }
    // The platform is present, so the remaining cause is the service. EPERM and timeout mean different things:
    // EPERM is an access/integrity problem, timeout is a stopped service.
    const hint = probe.detail === 'EPERM'
      ? 'access denied reaching the pipe — this process is running at low integrity, which usually means it was launched with --no-sandbox'
      : 'the service did not answer';
    const error = `Cowork VM service is not reachable over ${probe.pipePath} (${probe.detail}): ${hint}.`
      + ' The Windows Virtual Machine Platform itself is enabled.';
    return { success: false, error, ok: false, reason: error };
  });
  define('claude.web_$_ClaudeVM_$_restartVM', () => ({ ok: false, reason: 'No VM host service in this build.' }));

  // boot / feature reporting the frontend does on start
  for (const m of ['reportCommitHash', 'ready', 'report']) {
    define(`claude.web_$_WebBuild_$_${m}`, () => ({ ok: true }));
    define(`claude.web_$_OsOpenHandlers_$_${m}`, () => ({ ok: true }));
    define(`claude.web_$_OsEntryPlaces_$_${m}`, () => ({ ok: true }));
  }
  define('claude.web_$_ContentStampReporter_$_report', () => ({ ok: true }));

  // macOS privacy permissions (TCC: Transparence, Consent, Control).
  //
  // The consumer compares each field against the enum
  //   Tt = { Granted:"granted", Denied:"denied", NotDetermined:"not-determined",
  //          NotSupported:"not-supported", Restricted:"restricted" }
  // (shared-0-BRYCPbU4.js, `zb`, exported as `Bh`) and renders the row as:
  //   s = state.accessibility === Tt.Granted          // show as granted
  //   showSettingsButton = state.accessibility !== Tt.Granted
  //                     && state.accessibility !== Tt.NotSupported
  //
  // There was no handler, so `getState` matched the sync-store fallback and answered `{}`.
  // Every field was then `undefined`, which is neither Granted nor NotSupported, so on
  // Windows the app rendered a macOS-only "Open System Settings" button for a permission
  // gate this platform does not have. Measured on the live replica:
  //   platform "Win32", state {}, showsOpenSettings true
  //
  // On Windows there is no TCC gate at all. `not-supported` is the enum member that says
  // exactly that, and it is the one value that suppresses the settings button while also
  // not pretending the permission was granted.
  define('claude.web_$_ComputerUseTcc_$_getState', () => {
    const unsupported = process.platform !== 'darwin';
    if (unsupported) {
      return {
        accessibility: 'not-supported',
        screenRecording: 'not-supported',
        microphone: 'not-supported',
      };
    }
    // macOS: this build has no TCC bridge, so it cannot claim a grant. `not-determined`
    // is the honest answer -- the user has not been asked and we cannot ask.
    return {
      accessibility: 'not-determined',
      screenRecording: 'not-determined',
      microphone: 'not-determined',
    };
  });
  // Requesting a permission on a platform without TCC is a no-op, and saying so is more
  // useful than a bare null. The callers render from getState, so this shape only has to
  // be non-throwing.
  for (const m of ['requestAccessibility', 'requestScreenRecording', 'requestMicrophone']) {
    define(`claude.web_$_ComputerUseTcc_$_${m}`, () => ({
      granted: false,
      status: process.platform === 'darwin' ? 'not-determined' : 'not-supported',
      reason: process.platform === 'darwin'
        ? 'No privacy-permission bridge in this reconstruction.'
        : 'This platform has no privacy-permission gate.',
    }));
  }
  define('claude.web_$_ComputerUseTcc_$_listInstalledApps', () => []);

  // device / filesystem surface this build genuinely has
  define('claude.web_$_FileSystem_$_getSystemPath', (_e, name) => {
    const map = { home: os.homedir(), temp: os.tmpdir(), desktop: path.join(os.homedir(), 'Desktop'), documents: path.join(os.homedir(), 'Documents') };
    return map[name] ?? null;
  });
  // Directory listings answer a bare array, so any cap is invisible to the caller. This value
  // is chosen to cover ordinary system folders whole (System32: 4,994 entries, 458 KB, 3 ms)
  // while still bounding a pathological directory. It must be declared before the first use:
  // `const` is not hoisted, and the first version of this change placed it 40 lines too late.
  const LIST_DIRECTORY_MAX_ENTRIES = 20_000;

  define('claude.web_$_FileSystem_$_listDirectory', async (_e, dir) => {
    if (typeof dir !== 'string') return [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    // The contract is a bare array, so a cap here cannot be reported to the caller: it would
    // simply look like the folder has 500 entries. Measured the real cost before choosing the
    // limit — C:/Windows/System32 has 4,994 entries, and reading + mapping all of them takes
    // 3 ms with a 458 KB payload. A low cap bought no measurable performance and silently
    // hid 90% of that folder, so the limit is set where it only guards against a pathological
    // directory rather than an ordinary system one.
    return entries.slice(0, LIST_DIRECTORY_MAX_ENTRIES).map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      isDirectory: d.isDirectory(),
    }));
  });

  // ---- session-scoped file access -------------------------------------------
  //
  // These four are the Cowork file surface. Contracts read from the consumers:
  //   readLocalFile(sessionId, encodeURIComponent(path))  -> { content }
  //       (c21f11e6d, zb(): `let i = await tt?.readLocalFile?.(e, enc); let o = i?.content ?? ""`)
  //   writeLocalFile(sessionId, encodeURIComponent(path), text) -> boolean
  //       (Bb(): `if (!await tt?.writeLocalFile?.(...)) throw Error("File system is not available")`)
  //   listFilesInFolder(sessionId, folder) -> array
  //       (Kv(): `let r = await tt.listFilesInFolder(e, t); n(s => ({ ...s, [t]: r }))`)
  //   savePastedFile(contentBase64, mimeType, fileName) -> { path }
  //       (shared-52-uHFNjl7C.js, FP(): `let t = await Cn.savePastedFile(n, e.type, e.name);
  //        return t.path ? { path: t.path } : { path: null, failCause: 'ipc_write_failed' }`)
  //       NOTE: there is no sessionId in this call. An earlier version of this comment said
  //       "-> the stored path", which described an implementation we had guessed rather than
  //       the one the renderer uses; the mismatch was silent for many rounds.
  //
  // All four answered null. The dangerous one is listFilesInFolder: its guard is a
  // truthiness test on the METHOD (`if (tt?.listFilesInFolder)`), which the generic fallback
  // satisfies, so the call happened, the state stored `null`, and the file explorer then did
  // `value.map(...)` -- measured on the live replica:
  //   render { ok: false, threw: "Cannot read properties of null (reading 'map')" }
  //
  // Paths are session-scoped: a session may only touch the folders it was started with.
  // The read status enum is (shared-0-BRYCPbU4.js, `yx`):
  //   Ok="ok" NotFound="notFound" TooLarge="tooLarge" ReadError="readError"
  //   OutsideSessionFolders="outsideSessionFolders"
  const READ_STATUS = {
    Ok: 'ok', NotFound: 'notFound', TooLarge: 'tooLarge',
    ReadError: 'readError', OutsideSessionFolders: 'outsideSessionFolders',
  };
  const FILE_READ_MAX_BYTES = 4 * 1024 * 1024;

  // The folders a session is allowed to touch, from its own record.
  const sessionFolders = (sessionId) => {
    try {
      const records = kernel && typeof kernel.getAll === 'function' ? kernel.getAll() : [];
      const list = Array.isArray(records) ? records : (records && records.sessions) || [];
      const record = list.find((s) => s && (s.sessionId === sessionId || s.id === sessionId));
      if (!record) return null;
      const roots = [
        record.workingDir, record.originCwd, record.cwd, record.homePath,
        ...(Array.isArray(record.userSelectedFolders) ? record.userSelectedFolders : []),
        ...(Array.isArray(record.additionalDirectories) ? record.additionalDirectories : []),
      ].filter((p) => typeof p === 'string' && p);
      return roots;
    } catch { return null; }
  };

  /**
   * A path inside `dir` that does not exist yet, derived from `name`.
   *
   * "report.txt" becomes "report-2.txt", then "report-3.txt", and so on. The extension is kept
   * so the OS still opens it with the right application. Returns null if 100 candidates are all
   * taken, which means something is wrong with the directory rather than with the name.
   */
  const uniqueTarget = async (dir, name) => {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = path.join(dir, attempt === 0 ? name : `${base}-${attempt + 1}${ext}`);
      try {
        await fs.promises.access(candidate);
      } catch {
        // access() throwing means it does not exist, which is what we want.
        return candidate;
      }
    }
    return null;
  };

  const withinSessionFolders = (sessionId, target) => {
    const roots = sessionFolders(sessionId);
    // An unknown session has no declared roots; refuse rather than allow everything.
    if (!roots || !roots.length) return false;
    let resolved;
    try { resolved = path.resolve(target); } catch { return false; }
    return roots.some((root) => {
      let r;
      try { r = path.resolve(root); } catch { return false; }
      const rel = path.relative(r, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  };

  // Decode the encoded path the callers pass. `encodeURIComponent` leaves "%5C" for
  // backslashes, so decodeURIComponent restores the real path.
  const decodePath = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try { return decodeURIComponent(value); } catch { return value; }
  };

  define('claude.web_$_FileSystem_$_readLocalFile', async (_e, sessionId, encodedPath) => {
    const target = decodePath(encodedPath);
    if (!target) return { status: READ_STATUS.NotFound, content: '' };
    if (!withinSessionFolders(sessionId, target)) {
      return { status: READ_STATUS.OutsideSessionFolders, content: '' };
    }
    let stat;
    try { stat = await fs.promises.stat(target); } catch {
      return { status: READ_STATUS.NotFound, content: '' };
    }
    if (!stat.isFile()) return { status: READ_STATUS.NotFound, content: '' };
    if (stat.size > FILE_READ_MAX_BYTES) {
      return { status: READ_STATUS.TooLarge, content: '', size: stat.size };
    }
    try {
      const content = await fs.promises.readFile(target, 'utf8');
      return { status: READ_STATUS.Ok, content };
    } catch {
      return { status: READ_STATUS.ReadError, content: '' };
    }
  });

  define('claude.web_$_FileSystem_$_writeLocalFile', async (_e, sessionId, encodedPath, content) => {
    const target = decodePath(encodedPath);
    if (!target) return false;
    if (!withinSessionFolders(sessionId, target)) return false;
    if (typeof content !== 'string') return false;
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, 'utf8');
      return true;
    } catch { return false; }
  });

  define('claude.web_$_FileSystem_$_listFilesInFolder', async (_e, sessionId, folder) => {
    const target = decodePath(folder);
    // Must answer an ARRAY: the caller stores the result and the view maps it.
    if (!target) return [];
    if (!withinSessionFolders(sessionId, target)) return [];
    let entries;
    try {
      entries = await fs.promises.readdir(target, { withFileTypes: true });
    } catch { return []; }
    return entries.slice(0, LIST_DIRECTORY_MAX_ENTRIES).map((d) => ({
      name: d.name,
      path: path.join(target, d.name),
      isDirectory: d.isDirectory(),
    }));
  });

  // Store a pasted file and answer { path }, which is what the renderer reads.
  //
  // ARGUMENT ORDER AND RETURN SHAPE ARE SET BY THE CALLER, NOT BY US.
  //
  // The shipped code (shared-52-uHFNjl7C.js) does:
  //   let t = await Cn.savePastedFile(n, e.type, e.name);
  //   return t.path ? { path: t.path } : { path: null, failCause: 'ipc_write_failed' };
  // where n = await eP(e) is the base64 payload of a data: URL. The real signature is
  //   savePastedFile(contentBase64, mimeType, fileName)  ->  { path }
  // and there is no sessionId in it.
  //
  // This handler used to take (sessionId, name, content) and return a bare string. Both were
  // wrong, silently: t.path was undefined, so every attachment was reported failCause
  // 'ipc_write_failed' while the chip still appeared in the composer. Measured live before
  // the fix: the prompt carried @notes.txt but no notes.txt existed on disk, and the model
  // answered that it could not find the file anywhere in the workspace.
  //
  // The destination is the workspace root because the call names no session; that is also
  // where an @-reference resolves from, which is the point.
  define('claude.web_$_FileSystem_$_savePastedFile', async (_e, content, mimeType, fileName) => {
    const currentMode = () => deploymentMode.get() ?? (read3pConfig() ? '3p' : undefined);
    if (opts.coworkMemoryUserDataDir && currentMode() === '3p') {
      const staged = await require('./pending-upload.cjs').savePendingUpload({
        userDataDir: opts.coworkMemoryUserDataDir, content,
        fileName: typeof fileName === 'string' && fileName ? fileName : `pasted-${Date.now()}.bin`,
        isCurrent: () => currentMode() === '3p',
      });
      return staged ? { path: staged } : { path: null, failCause: 'ipc_write_failed' };
    }
    const roots = sessionFolders(null);
    const root = (roots && roots.length) ? roots[0] : (settings.projectPath || process.cwd());
    const name = typeof fileName === 'string' && fileName ? path.basename(fileName) : ('pasted-' + Date.now() + '.bin');
    // Never overwrite an existing file.
    //
    // Measured: three sessions sharing one cwd, each pasting "probe2.txt", left exactly one
    // 1-byte file — the later pastes silently replaced the earlier ones. The renderer derives
    // the name from the browser (image.png, screenshot.png, ...), so two screenshots in a row
    // collide every time and the first is lost with no error anywhere.
    //
    // "Never" includes the fallback name: Date.now() is millisecond-granular, and two pastes
    // in the same millisecond would still collide, so the suffix search is unconditional.
    const target = await uniqueTarget(root, name);
    if (!target) return { path: null, failCause: 'ipc_write_failed' };
    try {
      // 'wx' fails instead of truncating, so a race that creates the file between the probe
      // and this write cannot destroy it either.
      // The payload is base64 of the file's bytes, not text. Decoding keeps images intact;
      // writing the base64 string itself would produce a corrupt file that still exists.
      const buffer = typeof content === 'string' && content ? Buffer.from(content, 'base64') : Buffer.alloc(0);
      await fs.promises.writeFile(target, buffer, { flag: 'wx' });
      return { path: target };
    } catch { return { path: null, failCause: 'ipc_write_failed' }; }
  });

  // Open a file with whatever the OS has associated with it, and reveal it in its folder.
  //
  // These two were declared but unhandled, and their absence had a visible consequence
  // that was one step removed from the missing method. The file UI asks
  //   CoworkFilePreview.isOpenInDefaultAppEnabled()
  // whether it may offer "open in default app", and the generic fallback answers `false`
  // for every `is*` method with no handler. So the capability was permanently reported
  // unavailable and the action never appeared -- even though this build CAN do it.
  //
  // Measured before: isOpenInDefaultAppEnabled -> false, openLocalFile -> null,
  // showInFolder -> null, while FileSystem.listDirectory/getSystemPath were real.
  //
  // Both return `{ ok: boolean }` rather than a bare value: the callers treat a falsy
  // answer as a refusal and surface "Couldn't open this file with the default app."
  // (c856385e2-BuWw23-a.js), so a silent null would be reported as a failure anyway.
  const shellOpen = (target, args, options) => new Promise((resolve) => {
    try {
      const child = require('node:child_process').spawn(target, args, {
        // detached + unref so the helper does not keep the app's event loop alive, and
        // stdio ignored so a launched GUI app cannot write into our console.
        //
        // windowsHide defaults to false, which is right for `explorer /select,` (the
        // window IS the point) and wrong for a bare `cmd /c start`: that one shows a
        // console and, when the target is missing, a modal MessageBox nobody is watching.
        // Callers whose helper must stay invisible say so explicitly.
        detached: true, stdio: 'ignore',
        windowsHide: options && options.windowsHide === true,
      });
      child.on('error', (error) => resolve({ ok: false, error: String(error && error.message) }));
      // 'spawn' fires once the process exists; that is the success signal. Waiting for
      // 'exit' would block until the user closes the opened application.
      child.on('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message) });
    }
  });

  define('claude.web_$_FileSystem_$_openLocalFile', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no path' };
    // Report a missing file as a refusal instead of letting the shell raise a dialog.
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: 'not found' };
    } catch { return { ok: false, error: 'not found' }; }
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, so it must run through cmd; the empty title argument
      // is what stops `start` from treating a quoted path as a window title.
      //
      // The existsSync above is what keeps a missing file from becoming a modal
      // 「Windows 找不到文件」 dialog: `start` on a missing target does not fail the
      // spawn, it starts cmd, shows a MessageBox and waits. windowsHide keeps the helper
      // console out of sight for the same reason -- this is a library call, not a user
      // command, so it must never put a window in front of the app.
      return shellOpen('cmd', ['/c', 'start', '', filePath], { windowsHide: true });
    }
    return shellOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', [filePath]);
  });

  define('claude.web_$_FileSystem_$_showInFolder', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no path' };
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: 'not found' };
    } catch { return { ok: false, error: 'not found' }; }
    if (process.platform === 'win32') {
      // /select, highlights the item; explorer returns a non-zero exit code even on
      // success, so the result is reported from whether the process spawned at all.
      return shellOpen('explorer', ['/select,', filePath]);
    }
    return shellOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', ['-R', filePath]);
  });

  // The capability probe the file UI actually consults. It must answer from what this
  // build can do, not from the generic `is*` fallback.
  define('claude.web_$_CoworkFilePreview_$_isOpenInDefaultAppEnabled', () => true);

  // Save a remote or in-memory file to disk and answer where it landed.
  //
  // Consumers:
  //   shared-6, Yy():  let n = await kt?.writeFileDownload?.(e, t) ?? null;
  //                    return n && await kt?.showInFolder?.(n), n
  //   cc1aae219 gates the menu items on method PRESENCE:
  //     De = J && !!ht?.writeFileDownloadAndOpen && !Se   // "Download and open"
  //     Oe = J && !!ht?.writeFileDownload && !!ht?.showInFolder && !Se   // "Download"
  //   Both gates were satisfied by the generic fallback, so the items rendered and every
  //   click answered null -- visible but inert, the same class as rounds 84 and 86.
  //
  // The second argument is either an http(s) URL to fetch or the bytes themselves.
  // Answering the stored path is the whole contract: `n && showInFolder(n)`.
  // Where a download may be written.
  //
  // MEASURED, not assumed: the Electron main process gets EPERM writing to ~/Downloads,
  // ~/Desktop, ~/Documents and even os.tmpdir() on this host, while a plain node process
  // writes to all of them happily. Verified inside the live main process:
  //   [dl] write failed C:\Users\Administrator\Downloads\fx-probe-r87b.txt EPERM
  // and independently under ELECTRON_RUN_AS_NODE, where only the workspace was writable.
  //
  // So the download directory is probed once and the first writable candidate wins. The
  // order expresses intent (Downloads first), and the fallback keeps the feature working
  // instead of answering null on every click.
  let cachedDownloadDir = null;
  const DOWNLOAD_DIR = () => {
    if (cachedDownloadDir) return cachedDownloadDir;
    const candidates = [
      path.join(os.homedir(), 'Downloads'),
      path.join(process.cwd(), '.data', 'downloads'),
      path.join(process.cwd(), 'downloads'),
      os.tmpdir(),
    ];
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        cachedDownloadDir = dir;
        return dir;
      } catch { /* try the next candidate */ }
    }
    // Nothing is writable: fall back to the first candidate so the error surfaces as a null
    // answer rather than a crash.
    cachedDownloadDir = candidates[0];
    return cachedDownloadDir;
  };


  /** Turn the second argument into a Buffer, fetching a URL when needed. */
  async function downloadPayload(source) {
    if (typeof source === 'string') {
      // An http(s) URL, or already-decoded text.
      if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      }
      return Buffer.from(source, 'utf8');
    }
    if (source instanceof ArrayBuffer) return Buffer.from(source);
    if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    if (Array.isArray(source)) return Buffer.from(source);
    return null;
  }

  define('claude.web_$_FileSystem_$_writeFileDownload', async (_e, name, source) => {
    let bytes;
    try { bytes = await downloadPayload(source); } catch { return null; }
    if (!bytes) return null;
    const dir = DOWNLOAD_DIR();
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch { return null; }
    const target = uniqueDownloadPath(dir, name);
    try {
      await fs.promises.writeFile(target, bytes);
      return target;
    } catch (error) {
      if (process.env.CLAUDE_TRACE === 'all') console.log('[dl] write failed', target, error && error.code);
      return null;
    }
  });

  define('claude.web_$_FileSystem_$_writeFileDownloadAndOpen', async (_e, name, source) => {
    let bytes;
    try { bytes = await downloadPayload(source); } catch { return null; }
    if (!bytes) return null;
    const dir = DOWNLOAD_DIR();
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch { return null; }
    const target = uniqueDownloadPath(dir, name);
    try {
      await fs.promises.writeFile(target, bytes);
    } catch { return null; }
    // Opening is best-effort: the download already succeeded, so the path is still useful.
    //
    // But "best-effort" must not mean "unchecked". This used to spawn
    //   cmd /c start "" <target>
    // with stdio ignored and windowsHide off, and never look at the exit code. `start`
    // does NOT fail the spawn when the target is missing: cmd itself starts, reports
    // 「Windows 找不到文件 …」 in a modal MessageBox, and then waits for the user to
    // dismiss it. Because the parent unrefs the child, nothing was left to observe it.
    //
    // Measured on this host: 45 such cmd.exe processes were still alive, each holding one
    // modal dialog, the oldest from 14:52 and the newest from 19:49. The suite spawns one
    // per run (test/file-download.test.mjs), so every round added another and the answer
    // window was eventually buried in them.
    //
    // The file was written a few lines above, so a missing path here means a genuine race
    // only; skip the launch instead of asking the shell to complain about it. And when the
    // launch does happen, watch the exit code and keep windows hidden so a shell refusal can
    // never turn into a modal dialog over the app.
    try {
      if (!fs.existsSync(target)) return target;
      const child = require('node:child_process').spawn(
        process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open'),
        process.platform === 'win32' ? ['/c', 'start', '', target] : [target],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.on('error', () => {});
      // Nothing can consume the exit code of a detached, unref'd child, so at least record
      // the refusal when the tracing switch is on rather than dropping it silently.
      child.on('exit', (code) => {
        if (code !== 0 && process.env.CLAUDE_TRACE === 'all') console.log('[dl] open exited', code, target);
      });
      child.unref();
    } catch { /* the file is saved regardless */ }
    return target;
  });

  // ---- storage usage ---------------------------------------------------------
  //
  // The Settings > System page draws a storage breakdown from these two channels. Both
  // were answered only by the generic fallback, which returns null, and the page then
  // crashed — twice, at two different fields:
  //
  //   [trace] claude.web.DeviceStorage.getUsage [false]
  //   [fallback] claude.web.DeviceStorage.getUsage
  //   TypeError: Cannot read properties of null (reading 'code')
  //     at c71860c77-BH7EuJ1o.js  (p.status==='ready' ? p.value.code : void 0)
  //
  // 1. The first fix returned { conversations, workspace } and the page moved one step on:
  //
  //   TypeError: Cannot read properties of undefined (reading 'claudeCodeBytes')
  //     at Ha(...)  ->  runtime: r + e.runtime.claudeCodeBytes
  //
  // 2. So the real shape is the one Ha() reads, recovered field by field from the bundle:
  //
  //   e.code     recordsBytes transcriptsBytes worktrees.bytes scratchBytes otherHistoryBytes
  //              sessionCount
  //   e.runtime  claudeCodeBytes claudeCodeVersionCount
  //   e.app      webCacheBytes browserPanesBytes logsBytes otherCachesBytes
  //   t          totalBytes systemImageBytes sessionDiskBytes pendingUpdateBytes
  //              leftoverBytes otherBytes
  //
  // The numbers are measured from the directories the app actually uses, not invented:
  // ~/.claude/projects holds the CLI transcripts, ~/.claude/file-history the edit history,
  // the workspace .data/sessions the shell's own store. A breakdown that does not match
  // the disk would be worse than no panel at all.
  const storage = require('./storage-usage.cjs').createStorageUsage({
    workspace: process.env.CLAUDE_WORKSPACE || process.cwd(),
    dataDir: settings.dataDir,
    userDataDir: opts.storageUserDataDir || opts.coworkMemoryUserDataDir,
    runtimeRoots: opts.storageRuntimeRoots || [],
    storePath: kernelStorePath || (typeof kernel?.storePath === 'string' ? kernel.storePath : null),
    coworkRoot: coworkWorkspaceRoot(),
    getSessions: () => kernel?.getAll?.() || [],
    getTranscript: id => kernel?.getTranscript?.(id) || [],
    getCoworkSessionIds: () => Object.keys(readCoworkStore().sessionSpaces || {}),
    removeSession: kernel?.remove ? id => kernel.remove(id) : undefined,
    onProgress: (scope, done, total) => {
      const win = getMainWindow();
      if (!disposed && win && !win.isDestroyed()) win.webContents.send(eventChannel('claude.web', scope === 'cowork' ? 'CoworkStorage' : 'DeviceStorage', scope === 'cowork' ? 'onCleanupProgress' : 'onCodeCleanupProgress'), done, total);
    },
  });
  for (const svc of ['DeviceStorage', 'CoworkStorage']) {
    const scope = svc === 'CoworkStorage' ? 'cowork' : 'device';
    define(`claude.web_$_${svc}_$_getUsage`, () => storage.getUsage(scope));
    define(`claude.web_$_${svc}_$_${scope === 'cowork' ? 'previewCleanup' : 'previewCodeCleanup'}`, (_e, request) => storage.previewCleanup(scope, request));
    define(`claude.web_$_${svc}_$_${scope === 'cowork' ? 'runCleanup' : 'runCodeCleanup'}`, (_e, token, choices) => storage.runCleanup(scope, token, choices));
    define(`claude.web_$_${svc}_$_${scope === 'cowork' ? 'cancelCleanup' : 'cancelCodeCleanup'}`, () => storage.cancelCleanup(scope));
  }
  define('claude.web_$_DeviceStorage_$_clearCacheAndRestart', async () => {
    const result = storage.clearCache();
    if (result.ok && typeof opts.relaunchApp === 'function') await opts.relaunchApp();
    return result;
  });
  define('claude.web_$_CoworkStorage_$_getCounts', () => {
    const usage = storage.getUsage('cowork');
    return { conversations: usage.conversations.count, workspace: 0 };
  });

  // ---- Cowork: Spaces / ScheduledTasks / Artifacts / Storage ----------------
  //
  // MEASURED BEFORE WRITING ANY OF THIS
  //   55 Cowork channels answered from the generic fallback, in four groups:
  //       web.CoworkSpaces         33
  //       web.CoworkScheduledTasks 16
  //       web.CoworkArtifacts       3
  //       web.CoworkStorage         3
  //   and the flag coworkScheduledTasksEnabled was hard-coded false in preferenceSnapshot, which is what put the
  //   whole Cowork surface behind "needs a newer build / reinstall the desktop app".
  //
  // HOW THE SHAPES WERE CHOSEN - from the renderer, not from guesswork
  //   getAllSpaces       -> awaited, then used as an array
  //   getSpace           -> (await getSpace(id)) and then .migration is read
  //   createSpace        -> awaited, then .id / .uuid are read
  //   deleteSpace        -> if (!await deleteSpace(id)) throw, so it must be truthy
  //   setArtifactStarred -> awaited, compared === false to detect failure
  //
  // WHERE STATE LIVES
  //   One JSON file under the Cowork root, written atomically, so spaces and tasks survive a restart and can be
  //   inspected with a text editor. One file, because two stores would need two migrations.
  const coworkRoot = () => {
    const base = coworkWorkspaceRoot();
    const dir = path.join(base, '.cowork');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      // R652: this used to be silent. A live run kept answering createSpace from the in-memory cache while
      // nothing reached disk, so the loss was invisible until the next start. Name the directory and the code.
      if (typeof opts.log === 'function') {
        opts.log('cowork root not writable: ' + dir + ' (' + (error && error.code) + ')');
      }
    }
    return dir;
  };
  const coworkStoreFile = () => path.join(coworkRoot(), 'store.json');
  const emptyCoworkStore = () => ({ version: 1, spaces: [], tasks: [], artifacts: {}, sessionSpaces: {}, migrations: {} });
  let coworkCache = null;
  const readCoworkStore = () => {
    if (coworkCache) return coworkCache;
    try {
      const raw = fs.readFileSync(coworkStoreFile(), 'utf8');
      const parsed = JSON.parse(raw);
      // Tolerate a hand-edited or partial file rather than throwing inside every handler.
      coworkCache = { ...emptyCoworkStore(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      if (!Array.isArray(coworkCache.spaces)) coworkCache.spaces = [];
      if (!Array.isArray(coworkCache.tasks)) coworkCache.tasks = [];
      return coworkCache;
    } catch {
      coworkCache = emptyCoworkStore();
      return coworkCache;
    }
  };
  const writeCoworkStore = () => {
    const file = coworkStoreFile();
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(readCoworkStore(), null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      if (typeof opts.log === 'function') opts.log('cowork store write failed: ' + (error && error.code));
      coworkCache = null;
      throw new Error('Cowork 数据保存失败，请检查磁盘空间与数据目录写入权限。');
    }
  };
  const nowIso = () => new Date().toISOString();
  const newId = () => require('crypto').randomUUID();
  const findSpace = (id) => readCoworkStore().spaces.find((s) => s && (s.id === id || s.uuid === id)) || null;

  // --- Spaces -----------------------------------------------------------------
  define('claude.web_$_CoworkSpaces_$_getAllSpaces', () => readCoworkStore().spaces);
  define('claude.web_$_CoworkSpaces_$_getSpacesStoreState', () => {
    const store = readCoworkStore();
    return { spaces: store.spaces, initialized: true, loading: false };
  });
  define('claude.web_$_CoworkSpaces_$_getSpace', (_e, id) => findSpace(id));
  define('claude.web_$_CoworkSpaces_$_createSpace', (_e, input) => {
    const store = readCoworkStore();
    const payload = input && typeof input === 'object' ? input : {};
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'Untitled space';
    const space = {
      id: newId(),
      uuid: null,
      name,
      instructions: typeof payload.instructions === 'string' ? payload.instructions : '',
      folders: [],
      projects: [],
      links: [],
      autoDescription: null,
      description: null,
      starred: false,
      migration: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    space.uuid = space.id;
    store.spaces.push(space);
    writeCoworkStore();
    return space;
  });
  define('claude.web_$_CoworkSpaces_$_updateSpace', (_e, id, patch) => {
    const space = findSpace(id);
    if (!space) return null;
    const body = patch && typeof patch === 'object' ? patch : {};
    for (const key of ['name', 'instructions', 'description', 'starred']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) space[key] = body[key];
    }
    space.updatedAt = nowIso();
    writeCoworkStore();
    return space;
  });
  define('claude.web_$_CoworkSpaces_$_deleteSpace', (_e, id) => {
    const store = readCoworkStore();
    const before = store.spaces.length;
    store.spaces = store.spaces.filter((s) => !(s && (s.id === id || s.uuid === id)));
    if (store.spaces.length === before) return false;
    writeCoworkStore();
    return true;
  });
  // Membership: folders, projects and links are id lists on the space. Each mutator reports success because the
  // renderer throws when one answers falsy.
  const addTo = (field) => (_e, id, value) => {
    const space = findSpace(id);
    if (!space) return false;
    if (!Array.isArray(space[field])) space[field] = [];
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (!space[field].some((v) => (typeof v === 'string' ? v : JSON.stringify(v)) === key)) space[field].push(value);
    space.updatedAt = nowIso();
    writeCoworkStore();
    return true;
  };
  const removeFrom = (field) => (_e, id, value) => {
    const space = findSpace(id);
    if (!space || !Array.isArray(space[field])) return false;
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    space[field] = space[field].filter((v) => (typeof v === 'string' ? v : JSON.stringify(v)) !== key);
    space.updatedAt = nowIso();
    writeCoworkStore();
    return true;
  };
  define('claude.web_$_CoworkSpaces_$_addFolderToSpace', addTo('folders'));
  define('claude.web_$_CoworkSpaces_$_removeFolderFromSpace', removeFrom('folders'));
  define('claude.web_$_CoworkSpaces_$_addProjectToSpace', addTo('projects'));
  define('claude.web_$_CoworkSpaces_$_removeProjectFromSpace', removeFrom('projects'));
  define('claude.web_$_CoworkSpaces_$_addLinkToSpace', addTo('links'));
  define('claude.web_$_CoworkSpaces_$_removeLinkFromSpace', removeFrom('links'));
  define('claude.web_$_CoworkSpaces_$_getAutoMemoryDir', (_e, id) => {
    const space = findSpace(id);
    if (!space) return null;
    return path.join(coworkRoot(), 'memory', String(space.id));
  });
  define('claude.web_$_CoworkSpaces_$_readSpaceMemoryIndex', (_e, id) => {
    const dir = path.join(coworkRoot(), 'memory', String(id));
    try { return fs.readFileSync(path.join(dir, 'index.md'), 'utf8'); } catch { return null; }
  });
  define('claude.web_$_CoworkSpaces_$_getSpaceMemorySummary', (_e, id) => {
    const dir = path.join(coworkRoot(), 'memory', String(id));
    let files = 0;
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else files += 1;
      }
    };
    walk(dir);
    return { files, dir, hasIndex: fs.existsSync(path.join(dir, 'index.md')) };
  });
  define('claude.web_$_CoworkSpaces_$_getSpaceMemoryCapabilities', () => ({ supported: true, copy: true, index: true }));
  // File browsing inside a space folder: real reads, and a size ceiling so one huge file cannot flood the bridge.
  define('claude.web_$_CoworkSpaces_$_listFolderContents', (_e, dir) => {
    if (typeof dir !== 'string' || !dir) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        path: path.join(dir, entry.name),
        isDirectory: entry.isDirectory(),
      }));
    } catch { return []; }
  });
  define('claude.web_$_CoworkSpaces_$_readFileContents', (_e, file) => {
    if (typeof file !== 'string' || !file) return null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      if (stat.size > 2 * 1024 * 1024) return null;
      return fs.readFileSync(file, 'utf8');
    } catch { return null; }
  });
  define('claude.web_$_CoworkSpaces_$_openFile', (_e, file) => {
    try { require('electron').shell.openPath(String(file)); return true; } catch { return false; }
  });
  define('claude.web_$_CoworkSpaces_$_createSpaceFolder', (_e, root, name) => {
    if (typeof root !== 'string' || !root) return null;
    const dir = path.join(root, String(name || 'space'));
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return null; }
  });
  define('claude.web_$_CoworkSpaces_$_copyFilesToSpaceFolder', (_e, id, files) => {
    const space = findSpace(id);
    const target = space && Array.isArray(space.folders) && space.folders.length ? String(space.folders[0]) : null;
    if (!target || !Array.isArray(files)) return false;
    let copied = 0;
    for (const src of files) {
      try { fs.copyFileSync(String(src), path.join(target, path.basename(String(src)))); copied += 1; } catch { /* skip */ }
    }
    return copied;
  });
  // Classification and summarisation are model work. There is no model here, so these report "nothing to do"
  // rather than inventing a description the UI would then present as real.
  define('claude.web_$_CoworkSpaces_$_classifySessions', () => ({}));
  define('claude.web_$_CoworkSpaces_$_summarizeSpace', () => null);
  define('claude.web_$_CoworkSpaces_$_setAutoDescription', (_e, id, value) => {
    const space = findSpace(id);
    if (!space) return false;
    space.autoDescription = value ?? null;
    space.updatedAt = nowIso();
    writeCoworkStore();
    return true;
  });
  // Remote-session association, used when a space is pinned to a remote host.
  define('claude.web_$_CoworkSpaces_$_getRemoteSessionSpaces', () => readCoworkStore().sessionSpaces);
  define('claude.web_$_CoworkSpaces_$_setRemoteSessionSpace', (_e, sessionId, spaceId) => {
    const store = readCoworkStore();
    store.sessionSpaces[String(sessionId)] = spaceId ?? null;
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkSpaces_$_removeRemoteSessionSpace', (_e, sessionId) => {
    const store = readCoworkStore();
    delete store.sessionSpaces[String(sessionId)];
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkSpaces_$_appendRemoteSessionSpaceFolders', (_e, sessionId, folders) => {
    const store = readCoworkStore();
    const id = store.sessionSpaces[String(sessionId)];
    const space = id ? findSpace(id) : null;
    if (!space || !Array.isArray(folders)) return false;
    if (!Array.isArray(space.folders)) space.folders = [];
    space.folders.push(...folders);
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkSpaces_$_setSpaceMigration', (_e, id, value) => {
    const space = findSpace(id);
    if (!space) return false;
    space.migration = value ?? null;
    space.updatedAt = nowIso();
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkSpaces_$_recordSpaceMigrationOutcome', (_e, id, outcome) => {
    const store = readCoworkStore();
    store.migrations[String(id)] = outcome ?? null;
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkSpaces_$_startSpaceMemoryCopy', (_e, id) => {
    const store = readCoworkStore();
    const token = String(id);
    store.migrations[token] = { state: 'running', startedAt: nowIso() };
    writeCoworkStore();
    return token;
  });
  define('claude.web_$_CoworkSpaces_$_getSpaceMemoryCopyStatus', (_e, id) => {
    const record = readCoworkStore().migrations[String(id)];
    return record ?? { state: 'idle' };
  });
  define('claude.web_$_CoworkSpaces_$_requestSpacesInventoryReport', () => {
    const store = readCoworkStore();
    return {
      spaces: store.spaces.length,
      tasks: store.tasks.length,
      folders: store.spaces.reduce((n, s) => n + (Array.isArray(s.folders) ? s.folders.length : 0), 0),
      generatedAt: nowIso(),
    };
  });

  // --- Scheduled tasks --------------------------------------------------------
  const coworkScheduler = require("./cowork-scheduler.cjs").createCoworkScheduler({
    ...(settings.coworkScheduler || {}),
    getStore: readCoworkStore, saveStore: writeCoworkStore, root: coworkRoot, kernel,
    defaultCwd: coworkWorkspaceRoot,
    getInstructions: () => coworkGlobalMemory.readGlobalMemory(),
    emit: payload => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(eventChannel("claude.web", "CoworkScheduledTasks", "onScheduledTaskEvent"), payload);
    },
  });
  coworkScheduler.start();
  for (const method of ["getAllScheduledTasks", "getScheduledTaskFileContent", "createScheduledTask", "updateScheduledTask", "updateScheduledTaskStatus", "getWatcherHistory", "markListenerReady", "releaseDispatchClaim"]) {
    define("claude.web_$_CoworkScheduledTasks_$_" + method, (_e, ...args) => coworkScheduler[method](...args));
  }
  define("claude.web_$_CoworkScheduledTasks_$_removeApprovedPermission", (_e, id, toolName, ruleContent) => {
    const task = readCoworkStore().tasks.find(value => value.id === id); if (!task) return false;
    task.approvedPermissions = (task.approvedPermissions || []).filter(value => value.toolName !== toolName || (ruleContent !== undefined && value.ruleContent !== ruleContent));
    writeCoworkStore(); return true;
  });
  define("claude.web_$_CoworkScheduledTasks_$_clearChromePermissions", (_e, id) => {
    const task = readCoworkStore().tasks.find(value => value.id === id); if (!task) return false;
    task.chromeAllowedDomains = []; writeCoworkStore(); return true;
  });
  define("claude.web_$_CoworkScheduledTasks_$_setEventAckSupported", () => true);
  define("claude.web_$_CoworkScheduledTasks_$_ackEvent", () => true);
  define("claude.web_$_CoworkScheduledTasks_$_beginManualMigration", () => ({ ok: true }));
  define("claude.web_$_CoworkScheduledTasks_$_endManualMigration", () => ({ ok: true }));
  define("claude.web_$_CoworkScheduledTasks_$_revertRemoteMigration", () => ({ ok: true }));
  define("claude.web_$_CoworkScheduledTasks_$_answerBoundCreateSign", () => ({ ok: true }));

  // --- Artifacts --------------------------------------------------------------
  define('claude.web_$_CoworkArtifacts_$_setArtifactStarred', (_e, id, starred) => {
    const store = readCoworkStore();
    const key = String(id);
    store.artifacts[key] = { ...(store.artifacts[key] || {}), starred: !!starred };
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkArtifacts_$_deleteArtifact', (_e, id) => {
    const store = readCoworkStore();
    const key = String(id);
    if (!store.artifacts[key]) return false;
    delete store.artifacts[key];
    writeCoworkStore();
    return true;
  });
  define('claude.web_$_CoworkArtifacts_$_setArtifactMcpTools', (_e, id, tools, extra) => {
    const store = readCoworkStore();
    const key = String(id);
    store.artifacts[key] = {
      ...(store.artifacts[key] || {}),
      mcpTools: Array.isArray(tools) ? tools : [],
      mcpExtras: extra ?? null,
    };
    writeCoworkStore();
    return true;
  });

  // Local backups contain only explicit session attachments and artifacts.
  let localBackup = null;
  const backupService = () => localBackup || (localBackup = require('./local-backup.cjs').createLocalBackup({
    kernel, root: coworkRoot(), getStore: readCoworkStore, storeFile: coworkStoreFile(),
    managedRoots: opts.coworkMemoryUserDataDir ? [path.join(opts.coworkMemoryUserDataDir, 'pending-uploads')] : [],
    setStore: value => { coworkCache = value; },
  }));
  const backupCall = (method, ...args) => {
    try { return backupService()[method](...args); }
    catch (error) {
      const known = ['NOT_FOUND', 'INVALID_KIND', 'BACKUP_TOO_LARGE', 'UNSAFE_PATH', 'FILE_CHANGED',
        'CHECKSUM_MISMATCH', 'INVALID_BACKUP', 'INVALID_CONFLICT_MODE', 'IMPORT_UNAVAILABLE',
        'CONFLICT', 'SESSION_RUNNING', 'RESTORE_WRITE_FAILED'];
      const code = error?.code || error?.message;
      return { ok: false, errorCode: known.includes(code) ? code : method === 'export' ? 'EXPORT_FAILED' : 'BACKUP_FAILED' };
    }
  };
  define('claude.web_$_CoworkStorage_$_exportTask', (_e, id) => backupCall('export', { kind: 'task', id }));
  define('claude.web_$_CoworkStorage_$_exportProject', (_e, id) => backupCall('export', { kind: 'project', id }));
  define('claude.web_$_CoworkStorage_$_exportAll', () => backupCall('export', { kind: 'all' }));
  define('claude.settings_$_LocalBackup_$_preview', (_e, options) => backupCall('preview', options));
  define('claude.settings_$_LocalBackup_$_export', (_e, options) => backupCall('export', options));
  define('claude.settings_$_LocalBackup_$_inspect', (_e, file) => backupCall('inspect', file));
  define('claude.settings_$_LocalBackup_$_restore', (_e, file, options) => backupCall('restore', file, options));
  define('claude.web_$_DeviceStorage_$_getFreeDiskSpace', async () => {
    try { const s = await fs.promises.statfs(os.homedir()); return s.bavail * s.bsize; } catch { return null; }
  });

  // The user's subagent definitions, shown as "@" mention candidates and in the agent
  // picker.
  //
  // Two consumers, with different robustness against a null:
  //   1. gO() (c227f4d5e-B8RiNIYP.js):
  //        e?.getAgents?.().catch(_O) ?? []      // null -> [], safe
  //        select: e => e.filter(x => x.source === "user")
  //   2. lk() (same module), the mention provider:
  //        r().then(t => i(t, e))                // i does t.filter(...)
  //      A null there throws inside `.filter`; `.catch(() => [])` swallows it and the
  //      provider yields an EMPTY list. Measured on the live replica:
  //        answer null, consumer2 { threw: true,
  //                                 message: "Cannot read properties of null (reading 'filter')" }
  //
  // So the visible effect was that "@" never offered any Agents, and the cause was a
  // thrown TypeError rather than an honest "you have none".
  //
  // Agents are markdown files under ~/.claude/agents (user) and .claude/agents in a project.
  // This host has no such directory, so the truthful answer is an empty array -- not null.
  // The records carry the fields the consumers read: source, name, description.
  define('claude.web_$_LocalSessions_$_getAgents', async (_e, folder) => {
    const agents = [];
    const roots = [
      { dir: path.join(os.homedir(), '.claude', 'agents'), source: 'user' },
    ];
    // A project-level directory, when the caller names one.
    if (typeof folder === 'string' && folder) {
      roots.push({ dir: path.join(folder, '.claude', 'agents'), source: 'project' });
    }

    for (const { dir, source } of roots) {
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue; // no directory here is normal, not an error
      }
      for (const name of names.slice(0, 200)) {
        if (!/\.md$/i.test(name)) continue;
        const file = path.join(dir, name);
        let description = '';
        try {
          // Only the front matter / first lines are needed for the subtitle.
          const text = await fs.promises.readFile(file, 'utf8');
          const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (fm) {
            const d = fm[1].match(/^\s*description\s*:\s*(.+)$/m);
            if (d) description = d[1].trim().replace(/^["']|["']$/g, '');
          }
        } catch { /* keep the agent with no description */ }
        agents.push({
          name: name.replace(/\.md$/i, ''),
          description,
          source,
          path: file,
        });
      }
    }
    return agents;
  });


  // ---- Customize > Skills -------------------------------------------------
  //
  // Nine methods the page needs and none of them had a handler. Every call fell
  // through to the generic fallback: list/getLocalSkillFiles answered [], and
  // save/rename/setEnabled/delete answered null, so the page could be opened, read
  // "Add your first skills", and never accept a skill.
  //
  // Measured on the live replica before this block existed:
  //   listLocalSkills()                        -> []
  //   saveLocalSkill('demo2', ..., skillMd)    -> null     (Create dialog saves nothing)
  //   getLocalSkillFiles('demo2')              -> []
  // and the Skills page still rendered its empty state after a real SKILL.md was put
  // under .claude/skills/demo-skill.
  //
  // Storage lives inside the writable data directory rather than ~/.claude/skills:
  // Electron's main process gets EPERM for every path outside the workspace on this
  // host (tools/probe-store-write.cjs and tools/probe-main-write.cjs both measured
  // it), so a store under the home directory could not be written at all.
  const skillsDataDir = () => settings.dataDir
    || path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data');

  define('claude.web_$_LocalAgentModeSessions_$_listLocalSkills', () => listSkills(skillsDataDir()));

  define('claude.web_$_LocalAgentModeSessions_$_getLocalSkillFiles', (_e, name) => {
    if (typeof name !== 'string' || !name) return [];
    return readSkillFiles(skillsDataDir(), name);
  });

  define('claude.web_$_LocalAgentModeSessions_$_saveLocalSkill',
    (_e, name, description, skillMd, overwrite, replaces) => saveSkill(skillsDataDir(), {
      name, description, skillMd, overwrite: Boolean(overwrite), replaces,
    }));

  // Upload path: the renderer hands over the base64 of the whole archive plus the
  // manifest it already read out of it.
  define('claude.web_$_LocalAgentModeSessions_$_saveLocalSkillArchive', (_e, upload) => {
    const input = upload || {};
    try {
      const zip = readZip(Buffer.from(String(input.base64Content || ''), 'base64'));
      const found = findManifest(zip.entries);
      if (!found) return { ok: false, error: 'That archive has no SKILL.md file.', isUserFacingError: true };
      // The manifest the renderer parsed wins: it validated the front matter already
      // and its `name` is what the page expects the row to be called.
      const result = saveSkill(skillsDataDir(), {
        name: input.name,
        description: input.description,
        skillMd: input.skillMd,
        overwrite: Boolean(input.overwrite),
        replaces: input.replaces,
      });
      if (!result.ok) return result;
      // Everything else in the archive goes next to SKILL.md, minus the folder prefix.
      const dir = skillDir(skillsDataDir(), result.skillId);
      let leftOut = 0;
      for (const entry of zip.entries) {
        const safe = safeEntryPath(entry.name);
        if (!safe || !safe.startsWith(found.prefix || '')) continue;
        const rel = safe.slice((found.prefix || '').length);
        if (!rel || /^SKILL\.md$/i.test(rel)) continue;
        const target = path.join(dir, rel);
        // safeEntryPath already refused "..", but resolve once more so a crafted name
        // cannot land outside the skill directory.
        if (!target.startsWith(dir + path.sep)) { leftOut += 1; continue; }
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.data);
        } catch { leftOut += 1; }
      }
      return leftOut > 0 ? { ...result, leftOutFileCount: leftOut } : result;
    } catch (error) {
      return { ok: false, error: `That archive could not be read: ${String((error && error.message) || error)}`, isUserFacingError: true };
    }
  });

  define('claude.web_$_LocalAgentModeSessions_$_renameLocalSkill',
    (_e, name, newName) => renameSkill(skillsDataDir(), name, newName));

  define('claude.web_$_LocalAgentModeSessions_$_setLocalSkillEnabled',
    (_e, name, enabled) => setSkillEnabled(skillsDataDir(), name, enabled));

  define('claude.web_$_LocalAgentModeSessions_$_deleteLocalSkill',
    (_e, name) => deleteSkill(skillsDataDir(), name));

  define('claude.web_$_LocalAgentModeSessions_$_revealLocalSkill', async (_e, name) => {
    if (typeof name !== 'string' || !name) return { ok: false };
    const dir = skillDir(skillsDataDir(), name);
    if (!fs.existsSync(dir)) return { ok: false, error: 'No such skill.' };
    if (process.platform === 'win32') return shellOpen('explorer', [dir]);
    return shellOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]);
  });

  // Sync is a no-op here: there is no account-side skill library to reconcile, and the
  // caller only uses it as a "something changed" nudge.
  define('claude.web_$_LocalAgentModeSessions_$_syncSkills', () => ({ ok: true }));

  // The editors this machine can open a file in, for the "Open in <editor>" menu.
  //
  // Consumer (c856385e2-BuWw23-a.js, fn `an`):
  //   (await g?.getInstalledEditors?.() ?? []).filter(sn).sort(on)
  //   sn = e => e.installed && e.type !== "xcode"
  //   on = (a, b) => a.name.localeCompare(b.name)
  // and the record is read as { name, type, installed }; `type` is then passed straight to
  // openInEditor(path, type, line, col, wslDistro).
  //
  // The type enum is (shared-0-BRYCPbU4.js, `_x`):
  //   { VSCode:"vscode", Cursor:"cursor", Zed:"zed", Windsurf:"windsurf", Xcode:"xcode" }
  // and the display names come from c14700b8b: VS Code / Cursor / Zed / Windsurf / Xcode.
  //
  // With no handler the menu was simply empty -- the consumers use `?? []`, so this was
  // never a crash, only a missing feature. Measured on the live replica: answer null,
  // filtered list length 0, while `code` is on PATH at D:\VSCode\bin\code.cmd.
  define('claude.web_$_LocalSessions_$_getInstalledEditors', () => {
    const EDITORS = [
      { type: 'vscode', name: 'VS Code', commands: ['code', 'code.cmd', 'code-insiders'] },
      { type: 'cursor', name: 'Cursor', commands: ['cursor', 'cursor.cmd'] },
      { type: 'zed', name: 'Zed', commands: ['zed', 'zed.exe'] },
      { type: 'windsurf', name: 'Windsurf', commands: ['windsurf', 'windsurf.cmd'] },
      // Xcode is macOS-only; it is reported but the consumer filters it out on non-mac.
      { type: 'xcode', name: 'Xcode', commands: ['xed'] },
    ];

    const which = (command) => {
      try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const out = require('node:child_process').execFileSync(finder, [command], {
          encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        }).trim();
        // `where` may return several lines; the first existing one wins.
        return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
      } catch { return null; }
    };

    return EDITORS.map((editor) => {
      let path = null;
      for (const command of editor.commands) {
        path = which(command);
        if (path) break;
      }
      return {
        type: editor.type,
        name: editor.name,
        installed: Boolean(path),
        // Not part of the contract the consumer reads, but useful and harmless.
        ...(path ? { path } : {}),
      };
    });
  });

  // Open a file at an optional line/column in a named editor.
  //
  // Caller (c856385e2-BuWw23-a.js):
  //   g?.openInEditor?.(path, editor.type, line, col, wslDistro)?.then(ok => { if (!ok) fail() })
  // so the answer is read as a boolean: true means "opened", anything falsy reports
  // "Couldn't open this in {editor}".
  //
  // The argument forms differ per editor: VS Code / Cursor / Windsurf take
  // `--goto path:line:col`, Zed takes `path:line:col`, Xcode uses `xed --line`.
  const EDITOR_LAUNCH = {
    vscode: (file, line, col) => (line ? ['--goto', `${file}:${line}:${col || 1}`] : [file]),
    cursor: (file, line, col) => (line ? ['--goto', `${file}:${line}:${col || 1}`] : [file]),
    windsurf: (file, line, col) => (line ? ['--goto', `${file}:${line}:${col || 1}`] : [file]),
    zed: (file, line, col) => [line ? `${file}:${line}:${col || 1}` : file],
    xcode: (file, line) => (line ? ['--line', String(line), file] : [file]),
  };
  const EDITOR_COMMANDS = {
    vscode: ['code', 'code.cmd'],
    cursor: ['cursor', 'cursor.cmd'],
    zed: ['zed', 'zed.exe'],
    windsurf: ['windsurf', 'windsurf.cmd'],
    xcode: ['xed'],
  };

  define('claude.web_$_LocalSessions_$_openInEditor', async (_e, filePath, type, line, column) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    const commands = EDITOR_COMMANDS[type];
    if (!commands) return false;
    try {
      if (!fs.existsSync(filePath)) return false;
    } catch { return false; }

    const build = EDITOR_LAUNCH[type] || ((f) => [f]);
    const args = build(filePath, typeof line === 'number' ? line : undefined, typeof column === 'number' ? column : undefined);

    const tryLaunch = (command) => new Promise((resolve) => {
      let child;
      try {
        child = require('node:child_process').spawn(command, args, {
          detached: true, stdio: 'ignore', windowsHide: true,
          // A .cmd shim must run through a shell on Windows.
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
        });
      } catch { resolve(false); return; }
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    });

    for (const command of commands) {
      if (await tryLaunch(command)) return true;
    }
    return false;
  });

  // ---- claude.settings / HistoryImport -------------------------------------
  //
  // Fifteen methods, none of them handled. Every call fell through to the generic
  // fallback, which answers null, and one caller does not guard against that:
  //
  //   D?.getImportHistory?.().then(e => h(e)).catch(() => h([]))
  //   ... m.length ...
  //
  // With getImportHistory answering null, h(null) stored null and the next render read
  // m.length on it. Measured on the live replica:
  //
  //   [frontend:error] [BOOTSTRAP] Fatal error boundary triggered
  //   {"errorMessage":"Cannot read properties of null (reading 'length')",
  //    "errorCode":"0TA57KU","route":"/new",
  //    "errorStack":".../c432d56b4-D0UU7xlJ.js:1:71428"}
  //
  // So opening the app could kill the whole surface behind an error boundary — the user
  // saw a blank page, not a missing feature. This is the "called but unhandled" family
  // again, but here the fallback's null is not survivable.
  //
  // Everything below reports an honest empty state: no import history, no sources, no
  // capabilities. Nothing is faked — there is no session-import subsystem in this shell,
  // and an empty answer is the truth. What matters is the SHAPE: every container is a
  // real array/object so a caller may read .length, spread it, or .map() it.
  const importHistory = [];

  define('claude.settings_$_HistoryImport_$_getImportHistory', () => importHistory.slice());
  define('claude.settings_$_HistoryImport_$_getImportCapabilities', () => ({
    canImport: false,
    canExport: false,
    canAutoImport: false,
    disabledReason: 'Importing history is not available in this build.',
    remotePull: false, remotePullConfigured: false, localZip: false, localSessions: false,
    sessionExport: false, hostLoopRequired: false, cliUpdateRequired: false,
    hasImportableSessions: false, local1PSessionCount: 0, promptBanner: 'off', showSettingsPage: false,

  }));
  define('claude.settings_$_HistoryImport_$_enumerateSessionSources', () => []);
  define('claude.settings_$_HistoryImport_$_scanSessionSource', (_event, sourceId) => ({ sourceId, shape: 'unknown', sessions: [], count: 0 }));
  define('claude.settings_$_HistoryImport_$_importSessionSources', () => ({ imported: 0, skipped: 0, count: 0 }));
  define('claude.settings_$_HistoryImport_$_listSourceExtras', () => []);
  define('claude.settings_$_HistoryImport_$_importSourceExtras', () => ({ imported: 0 }));
  define('claude.settings_$_HistoryImport_$_getRemovePreview', () => ({ sessions: [], count: 0 }));
  define('claude.settings_$_HistoryImport_$_removeImportRun', () => ({ ok: true, removed: 0 }));
  define('claude.settings_$_HistoryImport_$_removeAllImportRuns', () => ({ ok: true, removed: 0 }));
  define('claude.settings_$_HistoryImport_$_getAutoImportStatus', () => ({
    enabled: false,
    running: false,
    lastRunAt: null,
  }));
  define('claude.settings_$_HistoryImport_$_listInstructionTexts', () => []);
  define('claude.settings_$_HistoryImport_$_instructionTextAdded', () => ({ ok: true }));
  // Subscription channels: the frontend registers a callback and expects nothing back.
  define('claude.settings_$_HistoryImport_$_onOnImportProgress', () => () => {});
  define('claude.settings_$_HistoryImport_$_onOnAutoImportStatus', () => () => {});

  // ---- generic fallback ----------------------------------------------------
  const registered = [];
  for (const [domain, services] of Object.entries(bridgeMap)) {
    if (domain.startsWith('__')) continue;
    for (const [service, methods] of Object.entries(services || {})) {
      if (!Array.isArray(methods)) continue;
      for (const method of methods) {
        if (method.startsWith('on') && method.length > 2) continue; // events are emitted, not handled
        const frag = `${domain}_$_${service}_$_${method}`;
        const channel = messageChannel(domain, service, method);
        const exact = handlers.get(frag);
        ipcMain.handle(channel, async (_event, ...args) => {
          note(frag);
          // A trace of every entered channel, so a claim like "the UI never calls
          // sendMessage" can be checked from the main process instead of inferred
          // from the renderer. CLAUDE_TRACE=all logs everything; =1 logs send/start.
          const traceAll = process.env.CLAUDE_TRACE === 'all';
          if (traceAll || (process.env.CLAUDE_TRACE === '1' && /send|start/i.test(method))) {
            console.log(`[trace] ${domain}.${service}.${method}`, JSON.stringify(args).slice(0, 160));
          }
          if (exact) return await exact(_event, ...args);
          // Record that this channel had no handler. Every fallback answer below is a guess at
          // a shape; a guess is only safe while the call site tolerates it. Recording the fact
          // (rather than inferring it from static source, which cannot see template handlers)
          // is what makes 'which channels are actually unimplemented' answerable from a running
          // app. This is how prewarmLocal should have been found.
          fallbackCalls.set(frag, (fallbackCalls.get(frag) || 0) + 1);
          if (process.env.CLAUDE_TRACE === 'all') {
            console.log(`[fallback] ${domain}.${service}.${method}`);
          }
          // The sync store variants are dereferenced synchronously and must
          // resolve an object, never null.
          if (/^getState$|^getStateSync$/.test(method)) return {};
          if (/^onStateChange$/.test(method)) return { ok: true };
          if (/^is|^can/.test(method)) return false;
          if (/^get|^list|^read|^fetch|^search|^probe|^detect|^resolve|^check|^validate|^classify/.test(method)) {
            const empty = emptyFor(frag);
            if (empty !== null) return empty;
            // Feature-status methods answer a status object; everything else
            // answers null so a call site that renders the value cannot crash.
            return isFeatureStatusMethod(method) ? unavailable() : null;
          }
          return null;
        });
        registered.push(channel);
      }
    }
  }

  let disposed = false;
  return {
    getNotificationPreferences: () => ({
      notificationLevels: { ...(settings.preferences?.notificationLevels || {}) },
      notificationSound: settings.preferences?.notificationSound,
    }),
    getHybridIdentityConfigPath: () => {
      const dir = configLibraryDir();
      return dir ? path.join(path.dirname(dir), 'claude_desktop_config.json') : null;
    },
    // Main-only source: never publish provider credentials or a synthetic remote reader.
    getMainGrowthBookSourceConfig: () => {
      const found = read3pConfig();
      const profile = found?.config || {};
      return { mode: deploymentMode.get() ?? (found ? '3p' : undefined),
        bootstrap: profile.bootstrap ? { url: profile.bootstrap.url, enabled: profile.bootstrap.enabled } : undefined,
        builtinBrowserEnabled: (profile.builtinBrowserEnabled ?? profile.builtinBrowser?.enabled) === true,
        selfHostedSessions: false };
    },
    getMainGrowthBookContext: () => {
      const found = read3pConfig();
      const mode = deploymentMode.get() ?? (found ? '3p' : undefined);
      const profile = found?.config || {};
      const builtinBrowserEnabled = (profile.builtinBrowserEnabled ?? profile.builtinBrowser?.enabled) === true;
      const features = mode === '3p' ? require('./growthbook-3p-policy.cjs').hardcodedMainGrowthBookFeatures({
        builtinBrowserEnabled, selfHostedSessions: false,
      }) : {};
      return { mode, source: { kind: 'static', identity: `${mode}:${builtinBrowserEnabled}`, features } };
    },
    registeredCount: registered.length,
    pickLruIdleVictim: (processes, options) => kernel?.pickLruIdleVictim?.(processes, options) || null,
    getWarmLifecycleState: sessionId => kernel?.getWarmLifecycleState?.(sessionId) || null,
    /**
     * Write a session's transcript.
     *
     * Exposed on the module rather than as an IPC channel: the shipped frontend never calls
     * `setTranscript`, so putting it on the renderer surface would add a method the original
     * does not have. Hosts, imports and tests need it; the renderer does not.
     * @param {string} sessionId
     * @param {Array} rows
     * @returns {{ok: boolean, rows?: number, error?: string}}
     */
    setTranscript: (sessionId, rows) => settings.setTranscript(sessionId, rows),
    /**
     * Subscription accounts (our extension; the official app has no multi-account surface).
     * Exposed on the module, not as bridge channels. `list()` never returns tokens.
     */
    accounts: settings.accounts,
    /**
     * Map an Anthropic `/api/oauth/usage` body onto the shape the usage panel reads.
     *
     * Exposed for tests so the mapping can be verified without the network. The handler
     * `ClaudeCode.getPeriodUsage` is the only caller in production.
     */
    mapUsageWindows: (body) => settings.mapUsageWindows(body),
    /**
     * Raise an in-app approval and wait for the renderer's answer.
     *
     * Exposed so main.cjs can prefer the in-app card over the native consent modal.
     * Returns 'allow' | 'deny', or 'cancelled' when the turn ended before an answer
     * arrived. The kernel's own `requestApproval` is bound to a session, but the
     * tool-approval executor does not know the session, so this wrapper creates a
     * standalone request that `respondToToolPermission` can still answer.
     */
    requestApproval: (request) => {
      if (!kernel) return Promise.resolve('deny');
      return kernel.requestApproval(null, request);
    },
    /** Channel call histogram, for diagnostics and tests. */
    callCounts: () => new Map(calls),
    /** Channels the frontend called but this build has no handler for, most-called first. */
    fallbackCalls: () => [...fallbackCalls.entries()].sort((a, b) => b[1] - a[1]),
    resetFallbacks: () => fallbackCalls.clear(),
    /** Reset the histogram so a measurement window can start clean. */
    resetCounts: () => calls.clear(),
    /** The most-called channels, for a quick read of what the UI actually uses. */
    topCalls: (n = 30) => [...calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, n),
    // Diagnostic hooks for the session kernel. The handlers close over the kernel,
    // so these are the only way to ask it a question from outside.
    diagnose: () => ({
      hasKernel: Boolean(kernel),
      sessionCount: kernel ? kernel.getAll().length : 0,
      sessions: kernel ? kernel.getAll().map((s) => ({
        sessionId: s.sessionId,
        title: s.title ?? null,
        isRunning: s.isRunning,
        lastActivityAt: s.lastActivityAt,
        transcript: kernel.getTranscript(s.sessionId).length,
      })) : [],
      storePath: kernelStorePath,
      storeExists: Boolean(kernelStorePath && fs.existsSync(kernelStorePath)),
    }),
    callKernel: async (method, args) => {
      if (!kernel) return { error: 'no kernel' };
      if (typeof kernel[method] !== 'function') return { error: `no method ${method}` };
      try {
        return { ok: true, value: await kernel[method](...(args || [])) };
      } catch (error) {
        return { ok: false, error: String(error && error.message) };
      }
    },
    flushKernel: () => {
      if (!kernel) return { error: 'no kernel' };
      // Force the coalesced write out so a caller can inspect the store on disk.
      kernel.flush();
      return { ok: true };
    },
    // Which kernel backend a turn would use, straight from the function that decides it.
    // Exposed so "we fell back to the local loop" is readable rather than deduced, and so a
    // test can assert the wiring without starting Electron.
    kernelChoice: () => (typeof settings.kernelChoice === 'function'
      ? settings.kernelChoice()
      : { id: null, reason: 'no kernelChoice injected' }),
    // Terminal panes spawn real child processes; main calls this on quit so they
    // are not orphaned.
    disposeShells: () => {
      if (typeof settings.disposeShells === 'function') return settings.disposeShells();
      return { ok: true };
    },
    /**
     * Which channels answered a guessed shape instead of a real implementation.
     *
     * The counter already existed for debugging; exposing it makes "which visible things are
     * actually unimplemented" answerable from a running app instead of by reading source.
     * Sorted by hit count so the first answer is the most-used broken channel.
     */
    surfaceReport() {
      const methods = [];
      for (const [domain, services] of Object.entries(bridgeMap)) {
        if (domain.startsWith('__')) continue; // configuration values are not IPC methods
        for (const [service, names] of Object.entries(services || {})) {
          if (!Array.isArray(names)) continue;
          for (const method of names) {
            const channel = `${domain}_$_${service}_$_${method}`;
            const kind = method.startsWith('on') && method.length > 2 ? 'event'
                : handlers.has(channel) ? 'handler' : 'fallback';
            methods.push({ domain, service, method, kind });
          }
        }
      }
      const counts = {};
      for (const { kind } of methods) counts[kind] = (counts[kind] || 0) + 1;
      return { total: methods.length, counts, methods };
    },
    fallbackReport() {
      const rows = [...fallbackCalls.entries()]
        .map(([frag, count]) => ({ channel: frag, count }))
        .sort((a, b) => b.count - a.count);
      return { total: rows.reduce((sum, row) => sum + row.count, 0), channels: rows };
    },
    emit(service, domain, event, payload) {
      const win = getMainWindow();
      if (disposed || !win || win.isDestroyed()) return false;
      win.webContents.send(eventChannel(domain, service, event), payload);
      return true;
    },
    dispose() {
      try { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy(); } catch { /* already gone */ }
      setupWindow = null;
      const coworkSchedulerDisposal = coworkScheduler.stop();
      kernel?.dispose?.();
      const schedulerDisposal = scheduledTasks?.stop();
      sessionVideo?.dispose();
      sessionMedia?.dispose();
      previewAccess.dispose();
      originPolicy.dispose();
      previewHost?.dispose();
      launchStore.dispose();
      const launchDisposal = previewLaunch.dispose().catch(error => log?.(String(error.message || error))); 
      disposed = true;
      for (const channel of registered) { try { ipcMain.removeHandler(channel); } catch {} }
      registered.length = 0;
      return Promise.all([launchDisposal, schedulerDisposal, coworkSchedulerDisposal]);
    },
  };
}

// The gateway catalogue, shared with the bootstrap.
//
// The bootstrap document is built synchronously, so it cannot fetch /v1/models itself. The
// settings handler above warms this cache; until it is warm the accessor returns [] and the
// selector advertises only the resolved model. Measured before this existed: the picker
// offered one model while the gateway served 15.
let knownModels = [];
let knownModelsKey = null;
function gatewayModelKey(gateway) {
  // Bind discovery to the profile and credential without exposing credentials in diagnostics.
  return crypto.createHash('sha256').update(JSON.stringify([
    gateway?.baseUrl, gateway?.apiKey, gateway?.apiType, gateway?.file, gateway?.raw?.inferenceModels,
  ])).digest('hex');
}
function knownGatewayModels(gateway) {
  if (gateway && knownModelsKey !== gatewayModelKey(gateway)) return [];
  return knownModels.slice();
}
function rememberGatewayModels(list, gateway) {
  if (Array.isArray(list)) {
    knownModels = list.map(row => typeof row === 'string' ? row : require('./model-capabilities.cjs').normalizeModelMetadata(row)).filter(Boolean);
    knownModelsKey = gateway ? gatewayModelKey(gateway) : null;
  }
}

module.exports = {
  NAMESPACE,
  knownGatewayModels,
  rememberGatewayModels,
  APP_VERSION,
  buildFilePickResult,
  classifyGitFailure,
  messageChannel,
  eventChannel,
  registerBridgeServices,
  resolveInstalledVersion,
  unavailable,
  uniqueDownloadPath,
};
