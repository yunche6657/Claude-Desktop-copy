// Electron main process.
//
// Window shape follows the shipped Claude 2.42304.0 shell: a frameless
// BrowserWindow whose top 52px is the local title bar, with the content below
// it. In the original the content is a WebContentsView loading claude.ai; here
// the content is the locally served renderer, so the reconstruction keeps the
// shell geometry and the EIPC contract without fetching a remote UI.
'use strict';

const { app, BrowserWindow, shell, ipcMain, protocol, powerMonitor, net, screen, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// Acquire before defaults, storage, backends, or quit hooks can do any work.
let mainWindow = null;
const singleInstance = require('./single-instance.cjs').acquireSingleInstance({ app, getWindow: () => mainWindow });
if (!singleInstance.primary) return;
require('./distribution-workspace.cjs').prepareDistributionWorkspace({ app });
require('./startup-defaults.cjs').applyStartupDefaults();
const { EipcBus } = require('./eipc-bus.cjs');
const { registerDesktopServices } = require('./main-services.cjs');
const { ConsentManager } = require('./consent-manager.cjs');
const { registerAppScheme, installAppProtocol, resolveFrontendRoot } = require('./app-protocol.cjs');
const { createBackendProxy } = require('./backend-proxy.cjs');
const { createBootstrapResponder } = require('./bootstrap-service.cjs');
const { createApiInterceptors } = require('./api-interceptors.cjs');
const { APP_VERSION } = require('./bridge-services.cjs');
const { createNotificationService } = require('./notification-service.cjs');
const { createNotificationIconLoader } = require('./notification-icon.cjs');
const { APP_ICON_PATH, WINDOWS_AUMID } = require('./app-icon.cjs');
const { createNotificationNavigation } = require('./notification-navigation.cjs');
const { createNotificationPolicy } = require('./notification-policy.cjs');
const notificationPolicy = createNotificationPolicy({
  getPreferences: () => bridge?.getNotificationPreferences() ?? {},
  getFeatureValue: (key, fallback) => mainFeatures?.getFeatureOn(key, fallback) ?? fallback,
});
const notificationService = createNotificationService({
  Notification: require('electron').Notification,
  getAppIcon: createNotificationIconLoader(require('electron').nativeImage),
  getNotificationLevel: notificationPolicy.getNotificationLevel,
  getSilent: notificationPolicy.getSilent,
  onNavigate: createNotificationNavigation({
    getWindow: () => mainWindow,
    getWebContents: () => mainWindow?.webContents,
    dispatch: (_contents, route) => bridge?.emit('Navigation', 'claude.web', 'Navigate', route),
  }),
  onResult: (event, error) => {
    if (event === 'failed' || event === 'unsupported') {
      console.warn('[desktop-notifications]', event, error ? String(error) : '');
    }
  },
});
const { packagingState } = require('./packaging-signals.cjs');
const { applyPackagingState } = require('./packaging-features.cjs');
const { createSessionKernel } = require('./session-kernel.cjs');
// Kernel selection: which backend runs a turn, and why. The choice is a pure function of a
// small probe so it can be tested without a 115 MB runtime, and its reason is reported rather
// than inferred -- "we are on the local kernel" must be a fact the user can read, not something
// they deduce from odd behaviour.
const { selectKernel, probeCcb, probeLocal } = require('./kernel-select.cjs');
const { fallbackDecision, FALLBACK_LOG } = require('./kernel-fallback.cjs');
const { createCcbKernel } = require('./ccb-kernel.cjs');
const { prepareCcbRuntime } = require('./ccb-runtime-config.cjs');
let ccbRuntime = null;
let kernelSelection = null;
const { createModelRuntimeRestart, modelRuntimeBusy } = require('./model-runtime-restart.cjs');
const modelRuntimeRestart = createModelRuntimeRestart({
  relaunch: () => appLifecycle.relaunchApp(),
  isBusy: () => modelRuntimeBusy({ bridge, backends: ownedCcbBackends }),
  onError: message => console.error('[model-runtime]', message),
});

// Keep the candidate's backend private while carrying the actor identity through
// the governor. The bridge returns a new object, so match it to the inventory
// and reject ambiguous identities rather than guessing an owner.
function createGovernorVictimHandlers({ backends, getBridge, now = Date.now, warn = () => {} }) {
  const owners = new WeakMap();
  const matches = (process, victim) => process.sessionId === victim.sessionId &&
    process.pid === victim.pid && process.actorToken === victim.actorToken;
  function peekLruIdleVictim(purpose) {
    const inventory = [];
    for (const backend of backends) {
      for (const process of backend.getActiveProcesses()) inventory.push({ backend, process });
    }
    const victim = getBridge()?.pickLruIdleVictim(inventory.map(item => item.process), { purpose });
    if (!victim || !victim.actorToken || !Number.isInteger(victim.pid) ||
        victim.protectionVersion === undefined) return null;
    const matching = inventory.filter(item => matches(item.process, victim));
    if (matching.length !== 1) return null;
    const result = { ...victim, idleSeconds: victim.lastUsedAt ? Math.round((now() - victim.lastUsedAt) / 1000) : 0 };
    owners.set(result, { backend: matching[0].backend, purpose });
    return result;
  }
  function evictVictim(sessionId, { victim, purpose } = {}) {
    const owner = victim && owners.get(victim);
    if (!owner || owner.purpose !== purpose || victim.sessionId !== sessionId || !backends.has(owner.backend)) return;
    owners.delete(victim);
    const validate = () => {
      if (!backends.has(owner.backend)) return false;
      const current = owner.backend.getActiveProcesses().filter(process => matches(process, victim));
      if (current.length !== 1) return false;
      const checked = getBridge()?.pickLruIdleVictim(current, { purpose });
      return !!checked && matches(current[0], checked) && checked.protectionVersion === victim.protectionVersion &&
        !!checked.lastUsedAt && Math.round((now() - checked.lastUsedAt) / 1000) >= 60;
    };
    return owner.backend.evictSession(sessionId, {
      reason: 'governor_evict', pid: victim.pid, actorToken: victim.actorToken, protectionVersion: victim.protectionVersion, validate,
    }).catch(error => warn('[cli-governor] eviction failed:', error.code || error.name));
  }
  return { peekLruIdleVictim, evictVictim };
}

/**
 * Decide, once, which backend runs a turn here.
 *
 * Read-only: it looks for a bun binary and a bundle, it does not start anything. Kept as a
 * named function so the startup log, the diagnostic channel and the kernel factory all read
 * the SAME decision — three copies of this logic would eventually disagree, and the whole
 * point of reporting a fallback is that the report is true.
 */
function chooseKernel() {
  if (kernelSelection) return kernelSelection;
  return kernelSelection = selectKernel({
    requested: process.env.CLAUDE_AGENT_KERNEL || null,
    probes: [
      probeCcb({ env: process.env, root: require('./ccb-runtime-paths.cjs').resolveAgentRoot() }),
      probeLocal({ hasAgent: true }),
    ],
  });
}

/** Build the CCB backend, or throw with a message naming what is missing. */
function createCcbBackend({ cwd, log, acquireSlot }) {
  const root = require('./ccb-runtime-paths.cjs').resolveAgentRoot();
  modelRuntimeRestart.assertReady();
  return modelRuntimeRestart.guardBackend(createCcbKernel({
    projectRoot: root,
    isPackaged: app.isPackaged,
    bunPath: process.env.CCB_BUN || undefined,
    entryPath: process.env.CCB_ENTRY || path.join(root, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'),
    nativeCycleEvents: !process.env.CCB_ENTRY,
    kernelRoot: process.env.CCB_ROOT || path.join(root, 'agent-core', 'claude-code'),
    cwd,
    // Approval stays ON. bypassPermissions would execute every tool without asking, which is
    // the opposite of what the in-app approval card exists for; with 'default' the kernel asks
    // and the host decides.
    permissionMode: process.env.CLAUDE_CCB_PERMISSION_MODE || 'default',
    permissionPromptTool: 'stdio',
    // Preserve individual API message usage rather than the cumulative result usage.
    extraArgs: ['--include-partial-messages'],
    // The kernel must call the model the configured gateway actually serves; its own default is
    // a Claude id, which a non-Anthropic gateway does not have (every turn then retries).
    model: process.env.CLAUDE_AGENT_MODEL || process.env.ANTHROPIC_MODEL || null,
    env: ccbRuntime ? ccbRuntime.env : process.env,
    contextWindows: ccbRuntime?.contextWindows,
    protectionClock: cliProtectionClock,
    acquireSlot: acquireSlot || (({ reason }) => {
      if (!cliGovernor) throw new Error('CLI governor is not initialized');
      return cliGovernor.acquireSlot(reason);
    }),
    // A tool the kernel wants to run reaches the renderer's approval card through the same
    // requestApproval path the local kernel uses. Without this hook the backend denies by
    // default (so the kernel never hangs) — correct, but it means every tool would be refused
    // and the approval UI would never appear.
    canUseTool: async (request) => {
      try {
        if (!bridge || typeof bridge.requestApproval !== 'function') return 'deny';
        const decision = await bridge.requestApproval(request);
        if (decision === 'allow' || decision === 'deny') return decision;
        return 'deny';
      } catch (error) {
        log('approval bridge failed: ' + (error && error.message));
        return 'deny';
      }
    },
    log,
  }));
}

// The boot-feature map is read from two places: the `desktopBootFeatures` global
// the preload exposes, and the `getSupportedFeatures` bridge method. Both must
// agree, or a gate that is reported supported in one and unsupported in the
// other keeps the UI disabled.
//
// Cowork is gated on the packaging check (see packaging-signals.cjs): on a
// packaged install yukonSilver and coworkBrowser are supported. This applies the
// same adjustment to whichever copy it is given.
// The MSIX gate used to be spelled out here. It moved to packaging-features.cjs because no test could reach it: this
// file has no `module.exports` and opens a window on load, so a test could only search its text for the name. R568
// measured that this function and `chooseKernel` were the only two that no test named.
function withPackagingState(features) {
  return applyPackagingState(features, packagingState());
}

// The shipped frontend identifies the desktop shell from its own user agent:
// an original instance reports `... Claude/2.42304.0 Chrome/<v> Electron/<v> ...`
// and the bundles key their "am I the app" branch off that product token.
// Without it the frontend takes its web branch — it rewrites /epitaxy to /code,
// never sets data-dframe, and renders the marketing page instead of the
// workbench. Only the product token is imposed; the engine versions stay this
// build's own, because the token is the observed signal.
const DESKTOP_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Claude/${APP_VERSION} ` +
  `Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari/537.36`;
const { registerBridgeServices } = require('./bridge-services.cjs');
// Hides the menu bar while keeping the menu (and therefore its accelerators)
// installed, and emits the MenuEvents the renderer subscribes to.
const { installApplicationMenu } = require('./app-menu.cjs');
// The tray icon and the "closing the window keeps Claude running" behaviour it gates.
const { createTrayController } = require('./tray.cjs');
const bridgeMap = require('./shim/bridge-map.json');

// Measured from the real window; see evidence/measurements.json.
const WINDOW = { width: 1936, height: 1048, minWidth: 960, minHeight: 640 };
// The shipped frontend's own ground colour (--cds-surface-1).
const BACKGROUND = '#FCFCFB';

// The app:// scheme must be declared before the app is ready.
registerAppScheme({ protocol, additionalSchemes: [require('./session-media-protocol.cjs').SESSION_MEDIA_SCHEME, require('./preview-artifact.cjs').artifactScheme] });

// Where the shipped frontend lives. Packaged, this is process.resourcesPath,
// exactly as the original's uIa() does; in this checkout it is the sibling
// resources directory so the developer tree resolves without copying.
const FRONTEND_RESOURCES = process.env.CLAUDE_RESOURCES
  || path.resolve(__dirname, '..', 'resources');

// Observed route for this surface: sidebarMode "code" rewrites to /epitaxy and
// appends coldLaunch=1 (the shipped route builder E4n()).
const FRONTEND_URL = process.env.CLAUDE_FRONTEND_URL || 'app://localhost/epitaxy?coldLaunch=1';

let server;
let bus;
let detachServices;
let consent;
let bridge;
let cowork3pMemoryIdentity = null;
const resolveCoworkMemoryIdentity = require('./cowork-memory-identity.cjs').createCoworkMemoryIdentityResolver({
  getMode: () => bridge?.getMainGrowthBookSourceConfig()?.mode,
  get3pIdentity: () => cowork3pMemoryIdentity?.() ?? null,
});
let mainFeatures = null;
const cliMcpGateSource = require('./cli-mcp-host-sources.cjs').createCliMcpGateSource();
const cliMcpDiscovery = require('./cli-mcp-discovery-provider.cjs').createCliMcpDiscoveryProvider({
  gate: cliMcpGateSource,
  reserved: require('./cli-mcp-host-sources.cjs').createReservedSource(),
});
let hybridOidcSession = null;
let hybridLogin = null;
let hybridSlotStore = null;
const hybridAuthResults = new Map();
const hybridAuthRequests = new Map();
let bootstrapAuthAbort = null;
let hybridAuthSourceIdentity;
let bootstrapAuthGeneration = 0;
let hybridAuthStopped = false;
function syncHybridAuthSource() {
  if (!bridge || !hybridOidcSession || hybridAuthStopped) return;
  const config = bridge.getMainGrowthBookSourceConfig();
  const next = JSON.stringify([config?.mode ?? null, config?.bootstrap?.url ?? null, config?.bootstrap?.enabled !== false]);
  if (hybridAuthSourceIdentity === undefined) { hybridAuthSourceIdentity = next; return; }
  if (hybridAuthSourceIdentity === next) return;
  hybridAuthSourceIdentity = next;
  bootstrapAuthGeneration++;
  bootstrapAuthAbort?.abort();
  bootstrapAuthAbort = null;
  hybridLogin?.invalidate();
  hybridOidcSession.invalidate();
  hybridAuthResults.clear();
  hybridAuthRequests.clear();
}
let windowState;
let cliGovernor = null;
const previewActivation = require('./preview-activation.cjs').createPreviewActivation();
const ownedCcbBackends = new Set();
const cliProtectionClock = require('./cli-protection-clock.cjs').createProtectionClock();
// The installed application menu. Held so it can be disposed on quit, and so the
// accelerators stay alive for the whole window lifetime.
let appMenu = null;
// The tray icon controller (desktop/tray.cjs), created with the main window.
let tray = null;

// Where the session kernel persists its store.
//
// An earlier version wrote to app.getPath('userData'), which fails with EPERM on
// this host for every write (see the comment at the call site). Rather than
// assume another directory works, each candidate is proved writable by actually
// creating and removing a file, and the first that passes is used.
function resolveStorePath() {
  if (process.env.CLAUDE_SESSION_STORE) return process.env.CLAUDE_SESSION_STORE;
  const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
  const candidates = [
    path.join(workspace, '.data', 'sessions', 'kernel-sessions.json'),
    path.join(app.getPath('userData'), 'sessions', 'kernel-sessions.json'),
  ];
  for (const candidate of candidates) {
    const dir = path.dirname(candidate);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `_write_probe_${process.pid}`);
      fs.writeFileSync(probe, 'probe');
      fs.unlinkSync(probe);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  // Nothing is writable: run in memory rather than fail every mutation.
  console.error('[kernel] no writable session store; sessions will not persist');
  return null;
}

// Point Chromium's own storage at the workspace.
//
// IndexedDB was completely dead in the renderer — even `indexedDB.open('probe-db', 1)`
// failed with "UnknownError: Internal error." — and the page logged it on every mount:
//
//   [frontend:warning] [LOCAL_STORAGE] IndexedDB state read rejected; continuing without
//   persisted state {"name":"dframe-starred-code","error":"UnknownError"}
//
// "Continuing without persisted state" means the renderer's own stores (starred sessions,
// session groups, pinned projects, task cards) silently lose everything on reload.
//
// The cause is the same one documented at resolveStorePath: Electron's main process cannot
// write under the default userData here, and Chromium keeps IndexedDB inside it. Plain node
// CAN write there (measured), so this is a property of the Electron process, not of the ACL.
//
// setPath must run before app.whenReady(), which is why it sits here rather than with the
// other window setup. The directory is proved writable first, and the default is kept when
// it is not, so a host where userData works is unaffected.
(function relocateChromiumStorage() {
  try {
    const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
    const candidate = path.join(workspace, '.data', 'chromium');
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, `_write_probe_${process.pid}`);
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
    app.setPath('userData', candidate);
    // Chromium keeps cache and blobs in their own roots; point them at the same tree so a
    // partially writable default does not reintroduce the failure on one of them.
    for (const name of ['sessionData', 'cache', 'temp', 'crashDumps']) {
      try {
        const directory = path.join(candidate, name);
        fs.mkdirSync(directory, { recursive: true });
        app.setPath(name, directory);
      } catch { /* older Electron or an unavailable storage path */ }
    }
  } catch (error) {
    console.error('[storage] could not relocate Chromium storage:', error && error.message);
  }
})();

// The host may export ELECTRON_RUN_AS_NODE=1, which makes Electron behave as
// plain Node and leaves require('electron') without a BrowserWindow.
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Separate the reconstruction from the official Claude taskbar identity.
// Windows toast support requires registration for this independent identity.
if (process.platform === 'win32') {
  try { app.setAppUserModelId(WINDOWS_AUMID); } catch { /* older Electron */ }
}

app.whenReady().then(async () => {
  cliProtectionClock.start(powerMonitor);
  const { UpdateService } = require('./update-service.cjs');
  const updateService = process.env.CCD_UPDATE_MANIFEST_URL ? new UpdateService({
    source: process.env.CCD_UPDATE_MANIFEST_URL,
    signerThumbprint: process.env.CCD_UPDATE_SIGNER_SHA1 || '',
    currentVersion: app.getVersion(),
    directory: path.join(app.getPath('userData'), 'updates'),
  }) : new (require('./github-update-service.cjs').GitHubUpdateService)({ currentVersion: app.getVersion() });
  const showUpdates = require('./update-dialog.cjs').createUpdateDialog({
    service: updateService, dialog: require('electron').dialog, shell, getWindow: () => mainWindow,
  });
  updateService.on('state', state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(state.status === 'downloading' ? state.progress : -1);
    bridge?.emit('updaterStateStore', 'claude.web', 'StateChange', state);
  });
  {
    ccbRuntime = await prepareCcbRuntime({ env: process.env });
    if (!process.env.CLAUDE_AGENT_MODEL && ccbRuntime.env.CLAUDE_AGENT_MODEL) {
      process.env.CLAUDE_AGENT_MODEL = ccbRuntime.env.CLAUDE_AGENT_MODEL;
    }
  }
  const { createApp } = await import('../server.mjs');
  const { createAgentRunner, isConfigured } = require('./agent-config.cjs');

  const mode = process.env.MODE || 'demo';

  // Agent mode needs a workspace and a consent surface, so it is built after the
  // window exists. The runner is created lazily on first use to keep startup
  // fast and to fail only when the feature is actually invoked.
  let agentRunner = null;
  // Keyed by permission mode: a session can switch modes and the runner bakes the
  // mode into its approval executor. One cached runner would pin every session to
  // whichever mode happened to be created first.
  const agentRunners = new Map();
  // Keyed on BOTH the permission mode and the session's model. Keying on the mode alone meant
  // a session that switched model kept getting the runner built for the previous one, because
  // the map returned the first match. The model is optional: an undefined model means 'use
  // whatever the process config says', which is the pre-existing behaviour.
  const getAgent = (permissionMode, model) => {
    modelRuntimeRestart.assertReady();
    const key = String(permissionMode || '') + '|' + String(model || '');
    if (agentRunners.has(key)) return agentRunners.get(key);
    const workspaceRoot = process.env.CLAUDE_WORKSPACE || process.cwd();
    // Deterministic reply seam, for acceptance runs only.
    //
    // The kernel, the transcript, the event stream and the renderer are all real; only the
    // model call is replaced. That is what lets the message path be verified while the
    // provider is unreachable — MEASURED: every gateway model answered 503
    //   {"error":{"message":"No available accounts: no available accounts"}}
    // for three consecutive rounds, which left 'send a message and read the reply' with no
    // coverage at all even though it is the app's core action.
    //
    // Opt-in and inert by default: with CLAUDE_AGENT_STUB_TEXT unset nothing below runs and
    // the real runner is built exactly as before.
    const stubText = process.env.CLAUDE_AGENT_STUB_TEXT;
    if (typeof stubText === 'string' && stubText.length > 0) {
      // CLAUDE_AGENT_STUB_TOOL=Write:<name>:<path>:<content> makes the stub ask for ONE tool
      // call before answering. That exercises the part a text-only stub cannot reach: the
      // model's request travelling through the approval gate into desktop/tools.cjs and back as
      // a tool_result. The tool really runs; only the decision to call it is scripted.
      const toolSpec = process.env.CLAUDE_AGENT_STUB_TOOL;
      const askedOnce = new Set();
      const runner = {
        model: process.env.CLAUDE_AGENT_MODEL || 'stub',
        tools: [],
        run: async (opts) => {
          const onEvent = opts && typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
          const messages = (opts && opts.messages) || [];
          const turnKey = String(messages.length);
          const alreadyAsked = askedOnce.has(turnKey);
          if (typeof toolSpec === 'string' && toolSpec && !alreadyAsked) {
            askedOnce.add(turnKey);
            const [name, ...rest] = toolSpec.split(':');
            let input = {};
            if (name === 'Write') input = { path: rest[0] || 'stub-written.md', content: rest.slice(1).join(':') || 'STUB' };
            else if (name === 'Read') input = { path: rest[0] || 'stub-written.md' };
            else if (name === 'Bash') input = { command: rest.join(':') };
            const block = { type: 'tool_use', id: 'toolu_stub_1', name, input };
            onEvent({ type: 'text', text: 'calling ' + name });
            const message = { role: 'assistant', content: [block] };
            messages.push(message);
            const outcome = opts && typeof opts.execute === 'function'
              ? await opts.execute({ id: 'toolu_stub_1', name, input })
              : await opts.requestTool({ id: 'toolu_stub_1', name, input });
            onEvent({ type: 'tool_result', id: 'toolu_stub_1', name, isError: Boolean(outcome && outcome.isError), preview: String((outcome && outcome.content) || '').slice(0, 200) });
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stub_1', content: String((outcome && outcome.content) || '') }] });
            const finalText = stubText + '|TOOL-' + (outcome && outcome.isError ? 'ERROR' : 'OK');
            onEvent({ type: 'text', text: stubText });
            onEvent({ type: 'done', stopReason: 'end_turn', text: finalText, turnCount: 2 });
            return { text: finalText, messages, turns: 2, stopReason: 'end_turn' };
          }
          onEvent({ type: 'text', text: stubText });
          onEvent({ type: 'done', stopReason: 'end_turn', text: stubText, turnCount: 1 });
          return { text: stubText, messages, turns: 1, stopReason: 'end_turn' };
        },
        runStream: async (opts) => runner.run(opts),
      };
      modelRuntimeRestart.guardRunner(runner);
      agentRunners.set(key, runner);
      return runner;
    }
    const runner = createAgentRunner({
      workspaceRoot,
      env: ccbRuntime?.env || process.env,
      approve: async request => {
        // Prefer the in-app approval card: the kernel raises a
        // `tool_permission_request` event, the renderer shows it, and the answer comes
        // back through respondToToolPermission. The native consent modal remains the
        // fallback for a host with no renderer, where nobody could click an in-app
        // card.
        if (bridge && typeof bridge.requestApproval === 'function') {
          try {
            const decision = await bridge.requestApproval(request);
            if (decision === 'allow' || decision === 'deny') return decision;
            if (decision === 'cancelled') return 'cancel';
          } catch { /* fall through to the native modal */ }
        }
        if (!consent) return 'cancel';
        return await consent.ask(request);
      },
      permissionMode: typeof permissionMode === 'string' ? permissionMode : undefined,
      model: typeof model === 'string' && model ? model : undefined,
    });
    modelRuntimeRestart.guardRunner(runner);
    agentRunners.set(key, runner);
    return runner;
  };

  if (mode === 'agent' && !isConfigured(ccbRuntime?.env || process.env)) {
    // Keep the settings UI available so a missing key/model can be configured.
    // The runner still rejects unconfigured inference; it never uses demo replies.
    console.warn('agent configuration incomplete; select a provider and model in settings');
  }

  server = createApp({
    dataDir: path.join(app.getPath('userData'), 'sessions'),
    mode,
    executable: process.env.CLAUDE_EXECUTABLE,
    agent: mode === 'agent' ? { run: (...args) => getAgent().run(...args), model: process.env.CLAUDE_AGENT_MODEL || null } : null,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  // View selection.
  //   handdrawn (default) — this project's own renderer/ served over loopback.
  //   frontend           — the shipped resources/ion-dist frontend over app://,
  //                        which is the 1:1 route established by measurement:
  //                        dframe-root tree, sidebar 288px, titlebar 36px and
  //                        all 28 icon-font glyphs come from ion-dist itself.
  const view = process.env.CLAUDE_VIEW || 'handdrawn';
  const useFrontend = view === 'frontend';

  // Resolved before the window so the window can carry the frontend's icon.
  const frontendRoot = resolveFrontendRoot({
    resourcesPath: FRONTEND_RESOURCES,
    override: process.env.CLAUDE_FRONTEND_ROOT,
  });

  windowState = await require('./window-state.cjs').createWindowState({ app, screen,
    deleteSignedInFlag: () => require('./window-signed-in-flag.cjs').deleteWindowSignedInFlag(app.getPath('userData'), message => console.warn(message)),
  });
  windowState.placeOnDisplays();
  const win = new BrowserWindow({
    show: process.env.CLAUDE_BACKGROUND_CHECK !== '1',
    focusable: process.env.CLAUDE_BACKGROUND_CHECK !== '1',
    skipTaskbar: process.env.CLAUDE_BACKGROUND_CHECK === '1',
    ...windowState.getOptions(),
    minWidth: 600,
    minHeight: 400,
    title: '小克',
    // Vendored native icon also supplies the executable's packaging icon.
    icon: APP_ICON_PATH,
    backgroundColor: BACKGROUND,
    frame: false,
    titleBarStyle: 'hidden',
    // The shipped main window is created with
    //   titleBarStyle: "hidden", titleBarOverlay: true
    // (see qSe() in index.chunk-lzaSYO3Q.js). titleBarOverlay is what draws the
    // native minimize / maximize / close buttons on Windows; with only
    // frame:false and titleBarStyle:"hidden" the window has no buttons at all,
    // which is why the X was missing. The frontend reserves the space for them
    // through --desktop-titlebar-inset (36px) and the title bar's right padding.
    //
    // Colours follow the shipped overlay builder RYn(): a light window gets
    // symbolColor "#3d3d3a" over the title bar ground; height matches the 36px
    // inset the frontend reserves.
    titleBarOverlay: useFrontend
      ? { color: '#fcfcfb', symbolColor: '#0b0b0b', height: 36 }
      : { color: '#FBFBF9', symbolColor: '#0b0b0b', height: 52 },
    // On macOS the controls are the traffic lights, positioned by the shell.
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: useFrontend
      ? {
          offscreen: process.env.CLAUDE_BACKGROUND_CHECK === '1',
          backgroundThrottling: process.env.CLAUDE_BACKGROUND_CHECK !== '1',
          // The shipped frontend's own preload, reconstructed from the observed
          // bridge surface (the original ships .vite/build/mainView.js here).
          preload: path.join(__dirname, 'preload-frontend.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          // The original uses sandbox:true with a preload that calls
          // require('electron'); that combination is only valid for the
          // bundled preload, so sandbox is off here and context isolation plus
          // a contextBridge-only preload carry the boundary instead.
          sandbox: false,
          // Empty is the observed-valid shape: an original instance also parses
          // this argument, and the full captured feature map is supplied through
          // the `desktopBootFeatures` global instead.
          additionalArguments: ['--desktop-features={}'],
        }
      : {
          preload: path.join(__dirname, 'preload-main-view.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
  });
  mainWindow = win;
  previewActivation.track(win.webContents);

  // The tray icon, and the close-to-tray behaviour the "System tray" preference gates.
  //
  // The shipped build reads the SAME preference in its close handler; without this the
  // switch would store a value nothing acts on (closing the window always quit).
  windowState.manage(win, { restorePresentation: process.env.CLAUDE_BACKGROUND_CHECK !== '1' });
  // Restore saved presentation first so an early duplicate launch wins over a
  // persisted minimized state.
  singleInstance.windowReady();
  tray = createTrayController({
    getMainWindow: () => mainWindow,
    getIconPath: () => APP_ICON_PATH,
    log: (message) => console.log(message),
  });

  /**
   * The persisted "System tray" preference.
   *
   * Read from the same file the bridge writes, because the close handler runs in the
   * main process and must agree with what the switch stored. The shipped default is ON
   * (the original ships `menuBarEnabled: true`), so an unreadable file keeps the app
   * running rather than silently quitting on a window close.
   */
  const trayEnabled = () => {
    try {
      const file = path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data', 'preferences.json');
      if (!fs.existsSync(file)) return true;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && parsed.menuBarEnabled !== false;
    } catch { return true; }
  };

  win.on('close', (event) => {
    const enabled = trayEnabled();
    const action = tray.closeAction(enabled);
    if (action === 'quit') return; // let the close proceed
    event.preventDefault();
    win.hide();
  });

  // Apply the persisted choice at launch so the icon reflects it before any UI is shown.
  try {
    const enabled = trayEnabled();
    const result = tray.setEnabled(enabled);
    console.log(`[tray] startup preference menuBarEnabled=${enabled} ->`, JSON.stringify(result));
  } catch (error) {
    console.log('[tray] could not apply the startup preference:', String(error && error.message));
  }

  // Apply the desktop product token before anything loads.
  //
  // Three layers are needed because each covers a different consumer:
  //   1. session.setUserAgent       — what a reload re-reads
  //   2. webContents.setUserAgent   — what this document reports
  //   3. an HTTP header on request  — what the protocol handler sees
  // Verified by observation: with only the CDP override the frontend took its
  // desktop branch (data-dframe set, /epitaxy kept, sidebar 288, 28 icons), which
  // is exactly the behaviour this token selects.
  if (useFrontend) {
    try { win.webContents.session.setUserAgent(DESKTOP_USER_AGENT); } catch { /* older Electron */ }
    try { win.webContents.setUserAgent?.(DESKTOP_USER_AGENT); } catch { /* not available */ }
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, 'User-Agent': DESKTOP_USER_AGENT },
      });
    });

    const rendererErrorLog = require('./renderer-error-log.cjs').createRendererErrorLog({ directory: path.join(app.getPath('userData'), 'logs') });
    win.webContents.on('console-message', (event) => {
      const details = require('./renderer-boundary-patch.cjs').parseRendererBoundaryConsole(String(event.message ?? ''));
      // Preserve sanitized coordinates through the sink's second sanitization pass.
      if (details) rendererErrorLog.record({ ...details, stack: details.frames.map(frame => `app://localhost/${frame}`).join('\n') });
    });

    // The frontend's own exceptions are otherwise invisible when the window is
    // loaded headless, and a thrown render leaves only a generic error card.
    if (process.env.CLAUDE_FRONTEND_LOG === '1') {
      win.webContents.on('console-message', (e) => {
        const level = e.level ?? 'log';
        const message = String(e.message ?? '');
        if (/error|warn/i.test(String(level))) {
          console.log(`[frontend:${level}] ${message.slice(0, 600)}`);
        }
      });
    }
    win.webContents.on('preload-error', (_e, file, error) => {
      console.error('[preload-error]', file, error && error.message);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[render-process-gone]', JSON.stringify(details));
      // The renderer is gone, but the kernel lives in this process and still holds whatever
      // the user changed in the last 50 ms (the save timer has not fired). Write it out now:
      // the app is about to relaunch the window and nobody will press anything to trigger a
      // flush. Same reason as the before-quit flush — this path just crashes instead of
      // exiting cleanly. Wrapped so a disk error cannot turn one crash into two.
      try { bridge?.flushKernel?.(); } catch { /* best effort */ }
    });
  }

  // The menu bar is hidden but the MENU STAYS INSTALLED.
  //
  // `win.removeMenu()` uninstalls it, and an uninstalled menu carries no
  // accelerators -- so every MenuEvents subscription in the renderer
  // (onToggleSessionPane, onCloseSessionPane, onFindInFiles, ...) was dead, and
  // Cmd/Ctrl+Shift+D / +P / +F / +; / +\ did nothing.
  //
  // The shipped build does the opposite: it installs the menu with
  // Menu.setApplicationMenu and then hides only the bar
  // (`setMenuBarVisibility(false)`), which keeps accelerators working. See
  // desktop/app-menu.cjs for the template and the observed accelerators.
  try {
    appMenu = installApplicationMenu({
      windows: () => BrowserWindow.getAllWindows(),
      onCheckForUpdates: showUpdates,
    });
    // Logged so a probe can tell "the menu was installed" from "it silently did not".
    // The accelerator list is the runtime proof that the shortcuts a user presses are
    // actually registered: a menu item without an accelerator is unreachable by key.
    //
    // Electron's getApplicationMenu() returns a Menu whose `.items` are MenuItem
    // objects; a submenu on a MenuItem is itself a Menu, so recurse through `.items`
    // rather than treating it as an array.
    const collect = (menu, out) => {
      const items = (menu && menu.items) || [];
      for (const item of items) {
        if (item.accelerator) out.push(`${item.label} = ${item.accelerator}`);
        if (item.submenu) collect(item.submenu, out);
      }
      return out;
    };
    let accels = [];
    try {
      const { Menu } = require('electron');
      accels = collect(Menu.getApplicationMenu(), []);
    } catch (error) {
      accels = ['ERR ' + String(error && error.message)];
    }
    console.log('[menu] application menu installed; menu bar hidden, accelerators live');
    console.log('[menu] accelerators:', JSON.stringify(accels));

    // Menu self-test.
    //
    // CDP input reaches the renderer but never the native menu, so "the accelerator
    // fires and the renderer receives the event" cannot be observed from outside the
    // app. With CLAUDE_MENU_SELFTEST=1 the app fires one pane item shortly after load
    // and logs the outcome; a probe then reads both the log (main half) and the
    // renderer's own received-events list (renderer half) and matches them.
    //
    // This invokes `menuItem.click()` — the same call an accelerator makes — so the
    // path under test is the real one. Nothing is exposed to the frontend.
    if (process.env.CLAUDE_MENU_SELFTEST === '1') {
      const label = process.env.CLAUDE_MENU_SELFTEST_LABEL || 'Show Changes';
      // Repeated: a single shot can land before the renderer has subscribed (the page
      // is still loading at 9s on a cold start), which would make the probe read
      // "not delivered" for a reason unrelated to the menu. Firing every 5s for a
      // minute means a probe that subscribes at any point still observes a delivery.
      const fire = () => {
        try {
          const before = appMenu.sent.length;
          const result = appMenu.click(label);
          const n = appMenu.sent.length - before;
          console.log('[menu] selftest click', JSON.stringify(label), '-> ok=' + result.ok + ' sentCount=' + n);
          if (!result.ok) console.error('[menu] selftest FAILED:', result.error);
        } catch (error) {
          console.error('[menu] selftest threw:', error && error.message);
        }
      };
      setTimeout(fire, 9000);
      const timer = setInterval(fire, 5000);
      timer.unref();
      setTimeout(() => clearInterval(timer), 70000).unref();
    }
  } catch (error) {
    // A menu failure must not prevent the window from loading.
    console.error('[menu] install failed:', error && error.message);
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let target;
    try { target = new URL(url); } catch { event.preventDefault(); return; }
    if (useFrontend) {
      // The frontend is an SPA on app://localhost: in-app route changes are
      // navigations on the same origin and must be allowed.
      if (target.origin !== 'app://localhost') {
        if (target.protocol === 'https:') shell.openExternal(url).catch(() => {});
        event.preventDefault();
      }
      return;
    }
    if (target.origin !== origin) event.preventDefault();
  });

  bus = new EipcBus();
  consent = new ConsentManager({ parentWindow: win, ipcMain });
  consent.register();
  detachServices = registerDesktopServices({
    bus,
    mainWindow: win,
    sessions: server.sessions,
    mode,
    consent,
  });

  // The shipped frontend's bridge surface. Registered for every view so that
  // whichever document is loaded, the same channel set answers.
  if (!cliGovernor) {
    cliGovernor = require('./cli-governor.cjs').createCliGovernor({
      countActive: () => [...ownedCcbBackends].reduce((count, backend) => count + backend.getActiveProcesses().length, 0),
      ...createGovernorVictimHandlers({
        backends: ownedCcbBackends,
        getBridge: () => bridge,
        warn: (...args) => console.error(...args),
      }),
      warn: (message) => console.error('[cli-governor]', message),
    });
    cliGovernor.start();
  }
  bridge = registerBridgeServices({
    updateService,
    showUpdates,
    onModelCatalogChanged: () => modelRuntimeRestart.request(),
    onMainFeatureSourceChanged: () => {
      cliMcpGateSource.invalidate();
      cowork3pMemoryIdentity?.observe();
      resolveCoworkMemoryIdentity.observe();
      syncHybridAuthSource();
      mainFeatures?.refreshSource().catch(() => {});
    },
    getBootstrapAuthStatus: () => {
      const config = bridge?.getMainGrowthBookSourceConfig();
      const hybrid = !!config && require('./growthbook-mode-backend.cjs').hybridEnabled(config.bootstrap, { packaged: app.isPackaged });
      if (!hybrid) return { hybrid: false, needsInteractiveAuth: false };
      try {
        const oidc = require('./hybrid-oidc-session.cjs').deriveHybridOidc(config.bootstrap.url);
        const known = hybridAuthResults.get(oidc.storeKey);
        const present = !!hybridSlotStore?.read(oidc.storeKey)?.accessToken;
        return { hybrid: true, needsInteractiveAuth: known === 'auth' || !present };
      } catch { return { hybrid: true, needsInteractiveAuth: true }; }
    },
    triggerBootstrapAuth: async args => {
      if (!hybridLogin) throw new Error('Bootstrap authentication is not ready');
      if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw new Error('Invalid bootstrap authentication arguments');
      const config = bridge.getMainGrowthBookSourceConfig();
      const url = args?.bootstrapUrl ?? config.bootstrap?.url;
      if (!url) throw new Error('bootstrap is not configured');
      if (!require('./growthbook-mode-backend.cjs').hybridEnabled({ url, enabled: true }, { packaged: app.isPackaged })) {
        throw new Error('A supported hybrid bootstrap URL is required');
      }
      const controller = bootstrapAuthAbort ??= new AbortController();
      const generation = bootstrapAuthGeneration;
      try {
        await hybridLogin.signIn(require('./hybrid-oidc-session.cjs').deriveHybridOidc(url), {
          signal: controller.signal, isCurrent: () => !controller.signal.aborted && bootstrapAuthGeneration === generation,
        });
      } catch (error) {
        if (error instanceof AggregateError && error.message === 'OAuth login failed and slot rollback failed') throw error;
        const cancelledMessages = ['gateway SSO device grant cancelled', 'external IdP grant cancelled',
          'Bedrock SSO grant cancelled', 'Foundry Entra device grant cancelled'];
        if (controller.signal.aborted || bootstrapAuthGeneration !== generation || (error instanceof Error &&
            (error.name === 'AbortError' || cancelledMessages.includes(error.message)))) return;
        throw error;
      } finally { if (bootstrapAuthAbort === controller) bootstrapAuthAbort = null; }
      if (controller.signal.aborted || bootstrapAuthGeneration !== generation) return;
      hybridOidcSession.invalidate(); hybridAuthResults.clear(); hybridAuthRequests.clear();
      if (bridge.getMainGrowthBookSourceConfig().mode === '3p') await mainFeatures.refreshSource();
    },
    resetWindowBounds: () => windowState.reset(),
    relaunchApp: () => appLifecycle.relaunchApp(),
    enablePreviewHost: true,
    mediaProtocol: protocol,
    schedulerPowerMonitor: powerMonitor,
    coworkMemoryUserDataDir: app.getPath('userData'),
    storageUserDataDir: app.getPath('userData'),
    storageRuntimeRoots: [path.join(process.resourcesPath || path.dirname(app.getAppPath()), 'agent-core')],
    resolveCoworkMemoryIdentity,
    schedulerIsOnline: () => net.isOnline(),
    schedulerDispatchThrottle: cliGovernor.dispatchThrottle,
    consumePreviewUserGesture: sender => previewActivation.consume(sender),
    ipcMain,
    bridgeMap,
    // The subscription sign-in sends the user's own browser to Anthropic's authorize page.
    // The bridge only ever passes https URLs through this.
    openExternal: (url) => shell.openExternal(url),
    // "Reveal in folder" for the file panel. Electron resolves the path to its containing
    // folder and selects it there; the bridge validates the path against the session roots
    // first, so the renderer cannot ask the host to reveal an arbitrary location.
    showItemInFolder: (target) => shell.showItemInFolder(target),
    getMainWindow: () => mainWindow,
    settings: {
      // Observed on a running original: the stored mode is "epitaxy", which is
      // what the shipped E4n() maps from "code" when it builds the far side.
      sidebarMode: 'epitaxy',
      coworkScheduler: { powerMonitor },
      themeMode: 'system',
      projectPath: process.env.CLAUDE_WORKSPACE || process.cwd(),
      // Preferences and the session store live together in a workspace-local data
      // directory, because app-data is not writable from this process (see
      // resolveStorePath above).
      dataDir: path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data'),
      supportedFeatures: withPackagingState(bridgeMap.__desktopBootFeatures || {}),
      // The secure-VM preference follows the same declared packaging state; see
      // the comment on secureVmFeaturesEnabled in bridge-services.cjs.
      secureVmFeaturesEnabled: packagingState().isMsix,
      sessions: () => [],
      detectedProjects: [],
      // Whether this process can change the OS login item at all.
      //
      // Measured on this host (tools/probe-login-item.cjs, tools/probe-token.cjs):
      // Electron's main process runs with a Restricted token at LOW integrity
      // (token RID 4096; plain node in the same shell is 8192), because the workspace
      // directory itself carries "Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)" and
      // children inherit it. A LOW process may not write HKCU, so
      // app.setLoginItemSettings() returns without error and changes nothing --
      // getLoginItemSettings().launchItems stays empty and the Run key is untouched.
      //
      // Asking for the capability is therefore the only honest source: a packaged build
      // launched from Program Files has a normal token, where the API does work.
      // Applying the tray switch immediately rather than on next launch: the bridge
      // handler has no window access of its own.
      applyTray: (enabled) => {
        if (!tray) return { enabled: Boolean(enabled), available: false, reason: 'no tray controller' };
        return tray.setEnabled(Boolean(enabled));
      },
      loginItemSupported: () => {
        try {
          const { app } = require('electron');
          if (typeof app.setLoginItemSettings !== 'function') return false;
          // A LOW-integrity token cannot write HKCU, so the registration would silently
          // do nothing. Detect it rather than promise a feature that never lands.
          const { execFileSync } = require('node:child_process');
          const groups = execFileSync('whoami', ['/groups'], {
            encoding: 'utf8', timeout: 4000, windowsHide: true,
          });
          return !/S-1-16-4096\b/.test(String(groups));
        } catch { return false; }
      },
      // API support does not establish Windows registration or delivery.
      notificationsSupported: () => {
        try {
          const { Notification } = require('electron');
          return Boolean(Notification && Notification.isSupported());
        } catch { return false; }
      },
      showNotification: (...args) => notificationService.show(...args),
      // Code settings the Settings pane writes through
      // ClaudeCode.patchUserSettings. They share the account-settings overlay so a
      // change survives a restart; the interceptor reads the same file for
      // PATCH /api/account/settings.
      readCodeSettings: () => {
        const file = path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data', 'code-settings.json');
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch { return {}; }
      },
      patchCodeSettings: (patch) => {
        const file = path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data', 'code-settings.json');
        let current = {};
        try { current = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { current = {}; }
        const merged = { ...current, ...patch };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
        return merged;
      },
      // Which backend runs a turn.
      //
      // CCB is preferred when its bundled runtime is available:
      //   CLAUDE_AGENT_KERNEL=ccb    ask for CCB; falls back with a stated reason if unavailable
      //   CLAUDE_AGENT_KERNEL=local  force the in-process loop
      //
      // The probe is read-only (does it see a bun binary and a bundle?) so it costs nothing at
      // startup, and a missing kernel degrades to the local loop instead of failing to boot.
      //
      kernelChoice: () => chooseKernel(),
      // The session kernel.
      //
      // Two paths, one contract (desktop/kernel-backend.cjs):
      //   * local: the in-process agent loop (desktop/agent.cjs), passed as createAgent;
      //   * ccb:   a claude-code-best child process over stream-json, passed as backend.
      //
      // The choice above is only worth reporting if it is ACTED ON. An earlier draft logged
      // "backend=ccb" while this factory still built the local kernel — a log line that
      // disagrees with the wiring is worse than no log line, because it makes the fallback
      // invisible. So the decision is read here, once, and it determines which path is built.
      kernelFactory: ({ emit }) => {
        const choice = chooseKernel();
        let backend = null;
        if (choice.id === 'ccb') {
          try {
            backend = createCcbBackend({
              cwd: process.env.CLAUDE_WORKSPACE || process.cwd(),
              log: (msg) => { if (process.env.CLAUDE_FRONTEND_LOG === '1') console.log('[ccb]', msg); },
            });
          } catch (error) {
            const unavailable = probeCcb({ env: process.env, root: require('./ccb-runtime-paths.cjs').resolveAgentRoot() });
            // Propagate or fall back — the decision lives in kernel-fallback.cjs, where it is asserted as BEHAVIOUR
            // rather than as four regular expressions matched against this file's text.
            if (fallbackDecision(unavailable) === 'propagate') throw error;
            kernelSelection = selectKernel({ requested: choice.requested, probes: [unavailable, probeLocal({ hasAgent: true })] });
            console.error('[kernel] ' + FALLBACK_LOG + ':', error && error.message);
            backend = null;
          }
        }
        if (backend) ownedCcbBackends.add(backend);
        const useBackend = Boolean(backend);
        console.log('[kernel] turn path = ' + (useBackend ? 'ccb (child process)' : 'local (in-process)'));
        return createSessionKernel({
          emit,
          cliMcpDiscovery,
          readFeatureValue: (key, fallback) => mainFeatures ? mainFeatures.getFeatureValue(key, fallback) : fallback,
          readFeatureOn: (key, fallback) => mainFeatures?.getFeatureOn(key, fallback) ?? fallback,
          // Forward BOTH the mode and the model: a session that switches model needs a runner
          // built for that model, and getAgent is keyed on the pair.
          ...(useBackend ? { backend } : {
            createAgent: (opts) => getAgent(
              opts && opts.permissionMode,
              opts && opts.model,
            ),
          }),
          // Persist sessions so the conversation list survives a restart instead of
          // emptying on every launch.
        //
        // Measured on this host (tools/probe-store-write.cjs): Electron's main
        // process gets EPERM writing anywhere outside the workspace — userData,
        // %APPDATA%, %TEMP% and the home directory all fail, while the workspace
        // and a subdirectory of it succeed. Chromium reports the same refusal for
        // its own DevToolsActivePort and disk cache, so it is a property of the
        // process, not of the file's ACL (which grants FullControl).
        //
        // The store therefore goes in a workspace-local data directory, and falls
        // back to app data only if that is not writable.
          storePath: resolveStorePath(),
          log: (msg) => { if (process.env.CLAUDE_FRONTEND_LOG === '1') console.log('[kernel]', msg); },
        });
      },
    },
    frontend: { root: frontendRoot },
  });

  // Source selection belongs to the mode backend; hybrid OIDC acquisition is
  // intentionally separate from the inference provider's credentials.
  const { deriveHybridOidc, createHybridOidcSession } = require('./hybrid-oidc-session.cjs');
  hybridSlotStore = require('./hybrid-oidc-store.cjs').createHybridOidcStore({
    userData: app.getPath('userData'), safeStorage,
  });
  hybridOidcSession = createHybridOidcSession({ storage: hybridSlotStore,
    fetch: (...args) => session.fromPartition('custom3p-probe').fetch(...args),
  });
  const identityConfigPath = bridge.getHybridIdentityConfigPath();
  const launchFeatureConfig = bridge.getMainGrowthBookSourceConfig();
  syncHybridAuthSource();
  const coworkMemoryContext = () => {
    const config = bridge?.getMainGrowthBookSourceConfig();
    if (config?.mode !== '3p') return { mode: config?.mode };
    const bootstrap = config.bootstrap;
    if (!bootstrap?.url || bootstrap.enabled === false) return { mode: '3p' };
    const trusted = require('./growthbook-mode-backend.cjs').hybridEnabled(bootstrap, { packaged: app.isPackaged });
    return { mode: '3p', hybrid: { url: bootstrap.url, trusted } };
  };
  if (launchFeatureConfig.mode === '3p') {
    const installId = require('./bootstrap-service.cjs').syntheticIdentity(process.env.CLAUDE_INSTALL_SEED || app.getPath('userData'));
    cowork3pMemoryIdentity = require('./cowork-3p-identity.cjs').createCowork3pStartupIdentity({
      installId, launchContext: coworkMemoryContext(), getCurrentContext: coworkMemoryContext,
    });
  }

  const launchHybrid = launchFeatureConfig.mode === '3p' && require('./growthbook-mode-backend.cjs').hybridEnabled(launchFeatureConfig.bootstrap, {packaged: app.isPackaged});
  const launchSlot = launchHybrid ? deriveHybridOidc(launchFeatureConfig.bootstrap.url).storeKey : undefined;
  const identityStore = identityConfigPath ? require('./hybrid-identity-store.cjs').createHybridIdentityStore({file:identityConfigPath}) : {read:()=>undefined, record:()=>{throw new Error('identity store unavailable');}};
  const hybridIdentity = require('./hybrid-identity-controller.cjs').createHybridIdentityController({launchSlot, store:identityStore,
    invalidateBearer: () => { hybridOidcSession.invalidate(); hybridAuthResults.clear(); hybridAuthRequests.clear(); },
    relaunch: () => appLifecycle.relaunchApp(), warn: () => console.warn('[hybrid] identity persistence failed'),
  });
  hybridLogin = require('./hybrid-oidc-login.cjs').createHybridOidcLogin({
    openBrowser: url => shell.openExternal(url),
    fetch: (...args) => session.fromPartition('custom3p-probe').fetch(...args),
    slotStore: hybridSlotStore,
    beforePersist: hybridIdentity.beforePersist,
    afterPersist: hybridIdentity.afterPersist,
    assertTokenBoundToHybridOrg: require('./hybrid-org-binding.cjs').assertTokenBoundToHybridOrg,
  });
  const hybridAuthedFetch = require('./hybrid-control-fetch.cjs').createHybridControlFetch({
    electronSession: session, oidcFor: deriveHybridOidc,
    resolveBearer: async oidc => {
      const owner = Symbol('hybrid-auth-resolution'); hybridAuthRequests.set(oidc.storeKey, owner);
      try {
        const result = await hybridOidcSession.getBearer(oidc);
        if (hybridAuthRequests.get(oidc.storeKey) === owner) hybridAuthResults.set(oidc.storeKey, result.ok ? 'ready' : result.kind);
        return result;
      } finally { if (hybridAuthRequests.get(oidc.storeKey) === owner) hybridAuthRequests.delete(oidc.storeKey); }
    },
  });
  const featureModeBackend = require('./growthbook-mode-backend.cjs').createGrowthBookModeBackend({
    hybridAuthedFetch, getConfig: () => bridge.getMainGrowthBookSourceConfig(), netFetch: (...args) => net.fetch(...args),
    appVersion: app.getVersion(), totalMemoryBytes: require('node:os').totalmem(),
    whenReady: () => app.whenReady(), packaged: app.isPackaged,
  });
  mainFeatures = require('./main-growthbook-runtime.cjs').createMainGrowthBookRuntime({
    getContext: () => featureModeBackend.getContext(), userData: app.getPath('userData'),
  });
  cliMcpGateSource.attach(mainFeatures);
  await mainFeatures.init();

  // Diagnostic channel: the preload's bridge objects are frozen by contextBridge,
  // so a renderer-side patch of a bridge method silently does nothing. Measurement
  // has to happen here, where the handlers actually run.
  ipcMain.handle('$diag$_bridge_calls', () => bridge.topCalls(40));
  // Which channels the frontend needed but this build has no handler for. A guess-shaped
  // fallback keeps the UI alive, so a missing handler is otherwise invisible: this is the
  // answer to "what is still unimplemented" from the running app, not from reading source.
  ipcMain.handle('$diag$_bridge_fallbacks', () => bridge.fallbackCalls());
  ipcMain.handle('$diag$_bridge_reset', () => { bridge.resetCounts(); return true; });

  // Announce the chosen backend once, at startup, whether or not anyone asks.
  //
  // The kernelChoice hook is only reached when something calls it; without this line a
  // launched app logs nothing about which kernel it is on, and "we are on the local loop" has
  // to be inferred from behaviour. A single startup line turns that into a fact in the log.
  try {
    const choice = bridge.kernelChoice();
    console.log('[kernel] backend=' + choice.id + ' (' + choice.reason + ')');
    if (choice.fellBack) console.log('[kernel] fell back from ' + choice.requested);
  } catch (error) {
    console.error('[kernel] backend probe failed:', error && error.message);
  }

  // The session kernel is reachable only through the bridge's closures, so a
  // question like "did start() actually create a session in the object that the
  // sidebar reads?" cannot be answered from the renderer. This answers it from the
  // same instance the handlers use.
  // Which bridge channels answered a guessed shape. The app already counted them; this makes
  // the count readable, so "is any visible feature silently unimplemented" is answerable from
  // a running instance rather than inferred from source.
  ipcMain.handle('$diag$_fallback_report', () => {
    const report = bridge.fallbackReport;
    return typeof report === 'function' ? report() : { error: 'no fallback report hook' };
  });
  ipcMain.handle('$diag$_kernel_state', () => {
    const diagnose = bridge.diagnose;
    return typeof diagnose === 'function' ? diagnose() : { error: 'no diagnose hook' };
  });
  ipcMain.handle('$diag$_kernel_call', (_e, method, args) => {
    const call = bridge.callKernel;
    return typeof call === 'function' ? call(method, args) : { error: 'no call hook' };
  });
  ipcMain.handle('$diag$_kernel_write', () => {
    const flush = bridge.flushKernel;
    return typeof flush === 'function' ? flush() : { error: 'no flush hook' };
  });
  // Which backend would run a turn here, and on what grounds. Reading it from the same
  // function the wiring uses is the point: a diagnostic that reimplements the decision can
  // agree with itself while disagreeing with the app.
  ipcMain.handle('$diag$_kernel_backend', () => {
    const choose = bridge.kernelChoice;
    return typeof choose === 'function' ? choose() : { error: 'no kernelChoice hook' };
  });

  // Dump the histogram to disk on demand so a measurement can be read without a
  // renderer round trip (the page has no ipcRenderer).
  const diagDir = path.resolve(__dirname, '..', 'evidence', 'live');
  const writeHistogram = (label) => {
    try {
      fs.mkdirSync(diagDir, { recursive: true });
      // The kernel's own view is dumped alongside the histogram: the renderer
      // cannot reach ipcMain, so this file is the only way to see whether the
      // object the bridge writes to is the one the sidebar lists.
      const kernelState = typeof bridge.diagnose === 'function' ? bridge.diagnose() : null;
      fs.writeFileSync(
        path.join(diagDir, `bridge-calls-${label}.json`),
        JSON.stringify({
          at: new Date().toISOString(),
          label,
          top: bridge.topCalls(60),
          total: [...bridge.callCounts().values()].reduce((a, b) => a + b, 0),
          distinct: bridge.callCounts().size,
          kernel: kernelState,
        }, null, 2),
      );
    } catch (error) {
      console.error('[diag] histogram write failed', error && error.message);
    }
  };
  if (process.env.CLAUDE_DIAG === '1') {
    writeHistogram('boot');
    setInterval(() => writeHistogram('live'), 5000);
    try {
      process.env.CLAUDE_PROBE_USERDATA = app.getPath('userData');
      require(path.resolve(__dirname, '..', 'tools', 'probe-store-write.cjs'));
    } catch (error) { console.error('[diag] store probe failed', error && error.message); }
  }

  if (useFrontend) {
    if (!fs.existsSync(path.join(frontendRoot, 'index.html'))) {
      // Say WHY, not just what. The usual cause is a junction into the MSIX package
      // whose target was deleted by an in-place app upgrade, and the plain
      // "index.html is missing" message sends you looking for a missing checkout.
      let detail = '';
      try {
        const link = fs.lstatSync(frontendRoot);
        if (link.isSymbolicLink()) {
          detail = `; ${frontendRoot} is a link and its target no longer exists` +
            ' (the installed Claude app was probably upgraded in place)';
        }
      } catch { /* not a link, or not present at all */ }
      throw new Error(
        `frontend view requested but ${path.join(frontendRoot, 'index.html')} is missing${detail}; ` +
        'set CLAUDE_FRONTEND_ROOT or CLAUDE_RESOURCES',
      );
    }
    // Account-scoped settings that the Settings UI writes with
    // PATCH /api/account/settings. They live beside the session store because the
    // bootstrap document is read-only; the interceptor layers these over it.
    //
    // The directory must be the same one resolveStorePath proved writable: Electron's
    // main process cannot write under userData/appdata in this environment, and the
    // session store already lives in the workspace.
    //
    // Declared BEFORE the bootstrap responder on purpose: the language the user picked
    // in Settings is one of these settings, and the responder must advertise it so the
    // choice survives a restart.
    const accountDataDir = path.join(process.env.CLAUDE_WORKSPACE || process.cwd(), '.data');
    const accountSettingsPath = path.join(accountDataDir, 'account-settings.json');
    const readAccountSettings = () => {
      try {
        const raw = fs.readFileSync(accountSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch { return {}; }
    };
    const writeAccountSettings = (patch) => {
      const merged = { ...readAccountSettings(), ...patch };
      fs.mkdirSync(accountDataDir, { recursive: true });
      fs.writeFileSync(accountSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      return merged;
    };

    /**
     * The UI locale to advertise, in precedence order:
     *   1. CLAUDE_APP_LOCALE (explicit operator override),
     *   2. the language picked in Settings (persisted by PATCH /api/account/settings),
     *   3. the vendored catalog default (zh-Hans when resources/i18n-overlay is present).
     *
     * Without step 2 the picker's choice was lost on every restart: the frontend writes
     * it to the account, the interceptor stores it in account-settings.json, but the
     * bootstrap document -- which seeds the boot locale -- kept advertising the default.
     */
    const resolveAccountLocale = () => {
      const env = process.env.CLAUDE_APP_LOCALE;
      if (env) return env;
      const picked = readAccountSettings().locale;
      if (typeof picked === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(picked)) return picked;
      return undefined;
    };

    // The bootstrap responder is built once and shared: the protocol handler
    // answers the document from it, and the API interceptor reads the same
    // payload to answer /api/account_profile, so both describe one account.
    const bootstrapResponder = createBootstrapResponder({
      templatePath: process.env.CLAUDE_BOOTSTRAP_TEMPLATE || undefined,
      seed: process.env.CLAUDE_INSTALL_SEED || app.getPath('userData'),
      locale: resolveAccountLocale(),
    });

    installAppProtocol({
      protocol,
      root: frontendRoot,
      // A runtime asset patch that no longer matches the shipped chunk means the frontend
      // moved (usually a package upgrade). The app still boots, so without this line the
      // patched behaviour -- Chinese locale selection, the usage-panel gate -- just stops
      // working with no trace anywhere.
      onPatchMiss: ({ name, path }) => {
        console.error(`[patch] ${name} did not match ${path}; the shipped chunk changed and this patch is inert`);
      },
      // The bootstrap document is answered locally: this is how an original
      // instance paints its Code surface in 3p mode without a claude.ai
      // account.
      bootstrap: bootstrapResponder,
      // Local answers for the handful of API paths the shipped handler also
      // intercepts before forwarding (its Jgn stage). This build has no backend,
      // so without them every API call 503'd and the app behaved as permanently
      // offline.
      intercept: createApiInterceptors({
        bootstrap: () => bootstrapResponder.payload(),
        readSettings: readAccountSettings,
        writeSettings: writeAccountSettings,
        // The Settings language picker saves its choice as PUT /api/account_profile
        // { locale }; accepting it is what makes the choice survive a restart (the
        // bootstrap then advertises it). Every other profile write still forwards.
        acceptLocaleWrites: true,
      }),
      // Everything else that targets the service is rewritten /edge-api/* ->
      // /api/* and forwarded, exactly as the shipped handler does.
      forward: createBackendProxy({
        backendOrigin: process.env.CLAUDE_BACKEND_ORIGIN || null,
        onForward: (info) => {
          if (process.env.CLAUDE_PROXY_LOG === '1') console.log('[proxy]', JSON.stringify(info));
        },
      }),
    });
  }

  await win.loadURL(useFrontend ? FRONTEND_URL : origin);

  // Layout fix for the shipped frontend: its notification-permission banner renders on top of the
  // composer's trailing controls, so clicks aimed at the send button land on the banner instead.
  // Measured: with the banner present, clicking send produces no `sendMessage`; hiding it and clicking
  // the same point sends. The rule is scoped to that banner's own data-testid and only affects pointer
  // events, so it is safe to inject regardless of view. See desktop/frontend-layout-patches.cjs.
  {
    const patched = await require('./frontend-layout-patches.cjs')
      .applyFrontendLayoutPatches(win, message => console.warn(message));
    if (patched.applied.length) console.log(`[layout] applied ${patched.applied.join(', ')}`);
  }

  if (process.env.CLAUDE_BACKGROUND_CHECK === '1') {
    require('./background-check.cjs').runBackgroundCheck({ app, win, appMenu, cliGovernor, previewActivation, settleMainFeatures: () => mainFeatures.waitForSourceSettled(), proveHybridSlotStorage: () => {
      if (process.env.CLAUDE_BACKGROUND_CHECK !== '1') throw new Error('proof is not enabled');
      const slot = 'hybrid:https://isolated-proof.invalid:unknown';
      const credential = { accessToken: 'synthetic-encrypted-slot-only', expiresAt: 1 };
      hybridSlotStore.write(slot, credential);
      const disk = fs.readFileSync(path.join(app.getPath('userData'), 'custom3p-bootstrap-oidc.json'), 'utf8');
      hybridSlotStore.clearMemory();
      return { encrypted: !disk.includes(credential.accessToken), roundTripped: hybridSlotStore.read(slot)?.accessToken === credential.accessToken,
        encryptionAvailable: safeStorage.isEncryptionAvailable() };
    }, getMainFeatureProof: () => {
      const context = featureModeBackend.getContext();
      return { mode: context.mode, sourceKind: context.source.kind, hybrid: context.source.hybrid === true,
        staticCount: context.source.kind === 'static' ? Object.keys(context.source.features).length : null,
        browserGate: mainFeatures.getFeatureValue('17519066', null), loaded: mainFeatures.areFeaturesLoaded(),
        fresh: mainFeatures.isGrowthBookFreshForCurrentAccount(),
        idleTimeout: require('./session-idle-policy.cjs').resolveIdleTimeout({unattended:false}, mainFeatures.getFeatureValue) };
    }, getWarmLifecycleState: sessionId => bridge?.getWarmLifecycleState(sessionId), evictResourceProofSession: sessionId => { const backend = [...ownedCcbBackends].find(item => item.getActiveProcesses().some(child => child.sessionId === sessionId)); if (!backend) throw new Error('No live actor for proof'); return backend.evictSession(sessionId); }, createResourceProofBackend: acquireSlot => { const backend = createCcbBackend({ cwd: process.env.CLAUDE_WORKSPACE || process.cwd(), acquireSlot, log: () => {} }); ownedCcbBackends.add(backend); return backend; }, getActiveCcbProcesses: () => [...ownedCcbBackends].flatMap(backend => backend.getActiveProcesses()), getCcbRuntimeInfo: () => ({ adapter: ccbRuntime?.adapter || 'none', source: ccbRuntime?.source || 'default', parentBaseURL: process.env.ANTHROPIC_BASE_URL || '', childBaseURL: ccbRuntime?.env?.ANTHROPIC_BASE_URL || '', model: process.env.CLAUDE_AGENT_MODEL || '', selection: chooseKernel() }) });
  }

  app.on('activate', () => singleInstance.activate());
}).catch(error => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => app.quit());

const appLifecycle = require('./app-lifecycle.cjs').createAppLifecycle({ app,
  prepareForQuit: async () => {
    modelRuntimeRestart.dispose();
    require('./startup-defaults.cjs').clearStartupDefaultsForRelaunch();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => bridge?.flushKernel?.()),
      Promise.resolve().then(() => bridge?.disposeShells?.()),
      ...[...ownedCcbBackends].map(backend => Promise.resolve().then(() => backend.dispose())),
      Promise.resolve().then(() => ccbRuntime?.stop()),
    ]);
    results.forEach((result, index) => { if (result.status === 'rejected') console.error('[quit] cleanup failed', index); });
  },
  quiesce: async () => {
    const windowWrites = windowState?.flush();
    windowState?.unmanage();
    await Promise.allSettled([
      windowWrites,
      Promise.resolve().then(() => bridge?.flushKernel?.()),
    ]);
  },
});

app.on('before-quit', (event) => {
  if (event?.defaultPrevented) return;
  // The tray icon outlives the window on purpose (that is the point of the feature), so
  // it must be released here or the process would keep a ghost icon in the tray.
  try { tray?.dispose(); } catch { /* already gone */ }
  // Terminal panes own real child processes; kill them here so quitting the app
  // does not leave shells behind.
  try { bridge?.disposeShells?.(); } catch { /* best effort */ }
  // Write the session store BEFORE tearing the bridge down.
  //
  // Mutations are coalesced behind a 50 ms timer, so the last change made in the final
  // moments of a session is still only in memory. Measured before this line existed:
  // `flushKernel` was reachable only through the `$diag$_kernel_write` diagnostic channel,
  // which no user path calls — so quitting within 50 ms of an edit silently discarded it.
  // Putting the flush after dispose() would be too late: the bridge owns the kernel.
  try { bridge?.flushKernel?.(); } catch { /* best effort; never block quitting */ }
  consent?.dispose();
  if (server) {
    server.closeAllConnections();
    server.close();
  }
});

// The renderer can still issue its final visibility/state requests while windows
// close. Removing IPC in before-quit made those calls fail with "No handler".
app.on('will-quit', (event) => {
  if (event?.defaultPrevented) return;
  hybridAuthStopped = true;
  bootstrapAuthGeneration++;
  bootstrapAuthAbort?.abort();
  hybridLogin?.invalidate();
  hybridOidcSession?.invalidate();
  cliMcpGateSource.dispose();
  mainFeatures?.dispose();
  cliGovernor?.stop();
  cliProtectionClock.stop();
  previewActivation.dispose();
  for (const backend of ownedCcbBackends) backend.dispose().catch(error => console.error('[ccb] shutdown:', error.message));
  ccbRuntime?.stop().catch(() => {});
  if (typeof detachServices === 'function') detachServices();
  bridge?.dispose();
  bus?.dispose();
});
