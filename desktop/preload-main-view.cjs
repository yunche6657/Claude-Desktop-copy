// Preload for the content view.
//
// Mirrors .vite/build/mainView.js from the shipped app.asar. The original
// exposes eleven globals through contextBridge; this reconstruction implements
// the four the reconstructed renderer actually consumes and keeps the same
// names and shapes:
//
//   electronWindowControl  - title bar buttons and window-state events
//   claudeAppSettings      - sidebar mode / theme / permission mode
//   claudeAppBindings      - workspace, session, git and MCP services
//   desktopBootFeatures    - boot-time feature flags
//
// The remaining originals (buddyBle, claudeAppSettings extras, process,
// desktopManagedConfig, desktopEnterpriseConfig, desktopTelemetryConfig,
// desktopDeviceClass, desktopPreferredLanguages, electronIntl) belong to
// enterprise/telemetry surfaces that this reconstruction does not implement.
// They are recorded as unknown rather than stubbed with plausible-looking data.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EIPC_NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';

const messageChannel = (domain, service, method) =>
  `$eipc_message$_${EIPC_NAMESPACE}_$_${domain}_$_${service}_$_${method}`;

const eventChannel = (domain, service, eventName) =>
  `$eipc_event$_${EIPC_NAMESPACE}_$_${domain}_$_${service}_$_${eventName}`;

const invoke = (domain, service, method, ...args) =>
  ipcRenderer.invoke(messageChannel(domain, service, method), ...args);

// Returns an unsubscribe function, matching the original's
// `registerBinding` shape where a disposer is handed back.
function subscribe(domain, service, eventName, callback) {
  const channel = eventChannel(domain, service, eventName);
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronWindowControl', {
  minimize: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'minimize'),
  maximize: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'maximize'),
  unmaximize: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'unmaximize'),
  toggleMaximize: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'toggleMaximize'),
  close: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'close'),
  getWindowState: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'getWindowState'),
  // The renderer opens Settings through this; without it Cmd/Ctrl+, silently did
  // nothing because the call site uses optional chaining.
  openSettingsWindow: () => invoke('claude.internal.ui', 'MainWindowTitleBar', 'openSettingsWindow'),
  onWindowStateChanged: callback =>
    subscribe('claude.internal.ui', 'MainWindowTitleBar', 'windowStateChanged', callback),
});

contextBridge.exposeInMainWorld('claudeAppSettings', {
  getSettings: () => invoke('claude.web', 'AppFeatures', 'getSettings'),
  updateSettings: patch => invoke('claude.web', 'AppFeatures', 'updateSettings', patch),
  getSidebarMode: () => invoke('claude.web', 'AppFeatures', 'getSidebarMode'),
  setSidebarMode: mode => invoke('claude.web', 'AppFeatures', 'setSidebarMode', mode),
  onSettingsChanged: callback => subscribe('claude.web', 'AppFeatures', 'settingsChanged', callback),
});

contextBridge.exposeInMainWorld('claudeAppBindings', {
  // workspace
  listWorkspaces: () => invoke('claude.web', 'WorkspaceManager', 'listWorkspaces'),
  selectWorkspaceFolder: () => invoke('claude.web', 'WorkspaceManager', 'selectWorkspaceFolder'),
  inspectGitRepository: folderPath =>
    invoke('claude.web', 'WorkspaceManager', 'inspectGitRepository', folderPath),
  listWorkspaceTree: options => invoke('claude.web', 'WorkspaceManager', 'listWorkspaceTree', options),
  listWorkspaceDirectory: relative => invoke('claude.web', 'WorkspaceManager', 'listDirectory', relative),

  // local code sessions
  listSessions: () => invoke('claude.web', 'LocalAgentSessions', 'listSessions'),
  createSession: config => invoke('claude.web', 'LocalAgentSessions', 'createSession', config),
  getSession: sessionId => invoke('claude.web', 'LocalAgentSessions', 'getSession', sessionId),
  deleteSession: sessionId => invoke('claude.web', 'LocalAgentSessions', 'deleteSession', sessionId),
  sendPrompt: (sessionId, text) =>
    invoke('claude.web', 'LocalAgentSessions', 'sendPrompt', sessionId, { text }),
  abortSession: sessionId => invoke('claude.web', 'LocalAgentSessions', 'abortSession', sessionId),
  onSessionEvent: callback => subscribe('claude.web', 'LocalAgentSessions', 'sessionEvent', callback),

  // archive / resume
  archiveSession: sessionId => invoke('claude.web', 'LocalAgentSessions', 'archiveSession', sessionId),
  unarchiveSession: sessionId => invoke('claude.web', 'LocalAgentSessions', 'unarchiveSession', sessionId),
  listArchivedSessions: () => invoke('claude.web', 'LocalAgentSessions', 'listArchivedSessions'),
  getResumePolicy: (sessionId, options) =>
    invoke('claude.web', 'LocalAgentSessions', 'getResumePolicy', sessionId, options),
  prepareResume: (sessionId, options) =>
    invoke('claude.web', 'LocalAgentSessions', 'prepareResume', sessionId, options),
  onSessionsChanged: callback => subscribe('claude.web', 'LocalAgentSessions', 'sessionsChanged', callback),

  // MCP host
  listMcpServers: () => invoke('claude.web', 'McpHost', 'listServers'),
  getMcpConfigStatus: () => invoke('claude.web', 'McpHost', 'getConfigStatus'),
  connectMcpServer: name => invoke('claude.web', 'McpHost', 'connectServer', name),
  disconnectMcpServer: name => invoke('claude.web', 'McpHost', 'disconnectServer', name),
  restartMcpServer: name => invoke('claude.web', 'McpHost', 'restartServer', name),
  callMcpTool: (name, toolName, args) => invoke('claude.web', 'McpHost', 'callTool', name, toolName, args),
  onMcpServersChanged: callback => subscribe('claude.web', 'McpHost', 'serversChanged', callback),

  // local execution (consent-gated)
  runCommand: request => invoke('claude.web', 'LocalExecution', 'runCommand', request),
  getExecutionPolicy: () => invoke('claude.web', 'LocalExecution', 'getPolicy'),
  onConsentResolved: callback => subscribe('claude.web', 'LocalExecution', 'consentResolved', callback),
  onCommandFinished: callback => subscribe('claude.web', 'LocalExecution', 'commandFinished', callback),

  // files
  readFile: filePath => invoke('claude.web', 'Files', 'read', filePath),
  previewWrite: (filePath, content) => invoke('claude.web', 'Files', 'previewWrite', filePath, content),
  writeFile: (filePath, content) => invoke('claude.web', 'Files', 'write', filePath, content),
  replaceInFile: (filePath, oldText, newText) =>
    invoke('claude.web', 'Files', 'replace', filePath, oldText, newText),
  onFileChanged: callback => subscribe('claude.web', 'Files', 'fileChanged', callback),

  // permissions
  getPermissionMode: () => invoke('claude.web', 'Permissions', 'getMode'),
  setPermissionMode: next => invoke('claude.web', 'Permissions', 'setMode', next),
  getPermissionModes: () => invoke('claude.web', 'Permissions', 'getModes'),

  // file dialogs for settings import/export
  saveTextFile: (defaultName, text) => invoke('claude.web', 'Dialogs', 'saveTextFile', defaultName, text),
  openTextFile: () => invoke('claude.web', 'Dialogs', 'openTextFile'),
});

contextBridge.exposeInMainWorld('desktopBootFeatures', {
  // Values are supplied by the main process through additionalArguments so the
  // renderer sees the same boot payload shape as the original.
  get: () => invoke('claude.web', 'AppFeatures', 'getBootFeatures'),
});
