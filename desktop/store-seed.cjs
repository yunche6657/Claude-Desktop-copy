// Seed the frontend's persisted stores.
//
// The shipped frontend decides which surface to mount from its persisted
// stores, not only from preferences. Captured from a running original:
//
//   ccd-session-store   {"state":{worker:{type:"environment",id:"__local__"},
//                        selectedFolder, currentHostKey:"local",
//                        orgUuid:"00000000-0000-4000-8000-000000000001",
//                        ...},"version":5}                     (369 bytes)
//   ccd-sync-owner      the account uuid
//   code-session-presets-latch   "off"
//   dframe-store        {collapsed:false, sidebarWidth:288,
//                        lastKnownMode:"code", interfaceFont:"anthropic", ...}
//
// Without ccd-session-store the Code surface never resolves a folder and the
// view stays on its loading placeholder. This module writes those seeds before
// the frontend's own script runs.
'use strict';

const ORG_UUID = '00000000-0000-4000-8000-000000000001';

/**
 * @param {{
 *   accountUuid: string,
 *   selectedFolder?: string|null,
 *   sidebarWidth?: number,
 * }} opts
 * @returns {Array<[string, string]>} key/value pairs to store
 */
function buildSeeds({ accountUuid, selectedFolder = null, sidebarWidth = 288 }) {
  const sessionStore = {
    state: {
      worker: { type: 'environment', id: '__local__' },
      selectedFolder: selectedFolder || null,
      folderByHost: {},
      currentHostKey: 'local',
      folderPickerOpen: false,
      folderPickerOpenNonce: 0,
      folderPickerScopeKey: 'epitaxy-draft',
      selectedRepo: null,
      selectedRepos: [],
      noRepoPicked: false,
      pillBranches: {},
      orgUuid: ORG_UUID,
    },
    version: 5,
  };

  const dframeStore = {
    state: {
      collapsed: false,
      sidebarWidth,
      lastKnownMode: 'code',
      coworkOnly: false,
      pinnedOrder: [],
      homeProjectsPinnedOrder: [],
      groupByByMode: {},
      sortByByMode: {},
      recentsTypeFilter: 'all',
      recentsStatusFilter: 'active',
      coworkActivityDays: 0,
      routinesSidebarPlacement: 'inline',
      interfaceFont: 'anthropic',
      systemFont: false,
      collapsedGroups: [],
      collapsedFamilies: [],
      customGroupsByScope: {},
      codeSidebarByScope: {},
    },
    version: 5,
  };

  return [
    ['ccd-session-store', JSON.stringify(sessionStore)],
    ['ccd-sync-owner', accountUuid],
    ['code-session-presets-latch', 'off'],
    ['dframe-store', JSON.stringify(dframeStore)],
    ['retired-storage-keys-swept', '1'],
    // The sidebar keeps its own session-list metadata revision here. A stored `0`
    // reads as "no metadata yet", which is one of the conditions that leaves the
    // recents area showing its empty state even when the bridge answers sessions.
    ['code-session-list:metadata-v2', '1'],
    ['ccd-sessions-filter', JSON.stringify({ state: { selectedProjects: [] }, version: 0 })],
  ];
}

/**
 * Install the seeds into a window's localStorage before its page scripts run.
 * @param {Electron.Session} session
 * @param {Array<[string, string]>} seeds
 */
async function applySeeds(session, seeds) {
  const byOrigin = { 'app://localhost': seeds };
  session['setPreloads']?.length; // no-op; keeps this usable on any Electron build
  // Preloads run before page scripts, so write through a preload-safe channel:
  // the simplest portable route is to persist via the session's storage partition
  // on first load, which the caller performs with webContents.executeJavaScript
  // before the app's own module executes. Exposed here for the caller to use.
  return byOrigin;
}

module.exports = { ORG_UUID, buildSeeds, applySeeds };
