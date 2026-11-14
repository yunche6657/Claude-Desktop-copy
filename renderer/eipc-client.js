// Renderer transport adapter.
//
// The same renderer runs in two hosts:
//   1. Electron desktop shell, where the preload exposes window.claudeAppBindings
//      and the original EIPC channel template is used.
//   2. A plain browser against server.mjs, where the HTTP + SSE API is used.
//
// Callers get one async surface and never branch on the host themselves.
'use strict';

export const hasDesktopBridge = () =>
  typeof window !== 'undefined' && Boolean(window.claudeAppBindings && window.electronWindowControl);

async function http(path, data) {
  const response = await fetch('/api' + path, data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export const transport = {
  isDesktop: hasDesktopBridge,

  // ---- sessions ----
  async listSessions() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.listSessions();
    return (await http('/sessions')).sessions;
  },
  async createSession(config) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.createSession(config);
    return await http('/sessions', config);
  },
  async getSession(id) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.getSession(id);
    return await http('/sessions/' + id);
  },
  async sendPrompt(sessionId, text) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.sendPrompt(sessionId, text);
    return await http(`/sessions/${sessionId}/messages`, { text });
  },
  async abortSession(sessionId) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.abortSession(sessionId);
    return await http(`/runs/${sessionId}/cancel`, {});
  },

  // ---- archive / resume ----
  async archiveSession(sessionId) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.archiveSession(sessionId);
    throw new Error('归档仅在桌面宿主中可用。');
  },
  async unarchiveSession(sessionId) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.unarchiveSession(sessionId);
    throw new Error('取消归档仅在桌面宿主中可用。');
  },
  async listArchivedSessions() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.listArchivedSessions();
    return [];
  },

  // ---- settings ----
  async getSettings() {
    if (hasDesktopBridge()) return await window.claudeAppSettings.getSettings();
    return JSON.parse(localStorage.getItem('codeDesktop.settings') || '{}');
  },
  async updateSettings(patch) {
    if (hasDesktopBridge()) return await window.claudeAppSettings.updateSettings(patch);
    const next = { ...(await transport.getSettings()), ...patch };
    localStorage.setItem('codeDesktop.settings', JSON.stringify(next));
    return next;
  },

  // ---- local execution ----
  async runCommand(request) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.runCommand(request);
    const response = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  },
  async getExecutionPolicy() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.getExecutionPolicy();
    return { allowedRoots: null, requiresConsent: true, host: 'browser' };
  },
  onCommandFinished(callback) {
    if (hasDesktopBridge()) return window.claudeAppBindings.onCommandFinished(callback);
    return () => {};
  },

  // ---- files ----
  async readFile(filePath) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.readFile(filePath);
    throw new Error('文件读取仅在桌面宿主中可用。');
  },
  async previewWrite(filePath, content) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.previewWrite(filePath, content);
    throw new Error('文件预览仅在桌面宿主中可用。');
  },
  async writeFile(filePath, content) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.writeFile(filePath, content);
    throw new Error('文件写入仅在桌面宿主中可用。');
  },
  async replaceInFile(filePath, oldText, newText) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.replaceInFile(filePath, oldText, newText);
    throw new Error('文件替换仅在桌面宿主中可用。');
  },

  // ---- permissions ----
  async getPermissionMode() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.getPermissionMode();
    return localStorage.getItem('codeDesktop.permissionMode') || 'ask';
  },
  async setPermissionMode(next) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.setPermissionMode(next);
    localStorage.setItem('codeDesktop.permissionMode', next);
    return next;
  },

  // ---- workspace tree ----
  async listWorkspaceTree(options) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.listWorkspaceTree(options);
    return { root: null, entries: [], truncated: false, unavailable: true };
  },
  async listWorkspaceDirectory(relative) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.listWorkspaceDirectory(relative);
    return [];
  },
  async selectWorkspaceFolder() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.selectWorkspaceFolder();
    throw new Error('选择工作区目录仅在桌面宿主中可用。');
  },

  // ---- MCP ----
  async getMcpConfigStatus() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.getMcpConfigStatus();
    return { loaded: false, configPath: null, servers: [], accepted: [], rejected: [] };
  },
  async listMcpServers() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.listMcpServers();
    return [];
  },

  // ---- file dialogs (settings import/export) ----
  async saveTextFile(defaultName, text) {
    if (hasDesktopBridge()) return await window.claudeAppBindings.saveTextFile(defaultName, text);
    // A browser has no save dialog; the blob download is equivalent for a preview.
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = defaultName;
    link.click();
    URL.revokeObjectURL(url);
    return { ok: true, path: defaultName, viaDownload: true };
  },
  async openTextFile() {
    if (hasDesktopBridge()) return await window.claudeAppBindings.openTextFile();
    return { ok: false, reason: 'browser' };
  },

  // ---- window chrome (no-op in a browser) ----
  window: {
    minimize: () => window.electronWindowControl?.minimize?.(),
    toggleMaximize: () => window.electronWindowControl?.toggleMaximize?.(),
    close: () => window.electronWindowControl?.close?.(),
    onStateChange: callback =>
      window.electronWindowControl?.onWindowStateChanged?.(callback) ?? (() => {}),
  },
};
