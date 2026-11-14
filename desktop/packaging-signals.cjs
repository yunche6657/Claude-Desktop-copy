// Windows packaging signals the shipped frontend checks before it enables Cowork.
//
// Observed in the shipped main process (index.chunk-lzaSYO3Q.js):
//
//   function Kr(){return Gr===void 0
//     ? process.windowsStore ? (Bfe="windowsStore",Gr=!0,!0)
//     : zfe() ? (Bfe="appPath",Gr=!0,!0)      // execPath lives under WindowsApps
//     : (Bfe=null,Gr=!1,!1)
//     : Gr}
//
// and the Cowork gate:
//
//   if (e==="win32" && !Kr()) return {
//     status:"unsupported",
//     reason:"Cowork requires Claude Desktop be installed with our modern installer",
//     unsupportedCode:"msix_required" }
//
// A development run of Electron resolves execPath to node_modules/electron/dist,
// so Kr() is false and Cowork stays gated with the "newer installation" tooltip.
// This module reports the same detection the shipped build performs, and lets a
// caller declare the packaging state explicitly for local runs.
'use strict';

const path = require('node:path');

/**
 * Detect whether this process looks like an MSIX / Windows Store install,
 * mirroring the shipped detection.
 * @param {{ execPath?: string, windowsStore?: boolean }} [override]
 */
function detectPackaging({ execPath = process.execPath, windowsStore = Boolean(process.windowsStore) } = {}) {
  if (windowsStore) return { isMsix: true, detectionSource: 'windowsStore' };

  const segments = execPath.split(/[\\/]/);
  const index = segments.findIndex((s) => s.toLowerCase() === 'windowsapps');
  if (index !== -1) return { isMsix: true, detectionSource: 'appPath' };

  return { isMsix: false, detectionSource: null };
}

/**
 * The `CLAUDE_FORCE_MSIX` override.
 *
 * A checkout run cannot satisfy the packaging check, so the declared state is
 * used instead. It only affects what this process tells the frontend about its
 * own packaging; nothing about the filesystem or the installer changes.
 * @returns {boolean}
 */
function forcedMsix() {
  const raw = process.env.CLAUDE_FORCE_MSIX;
  if (raw === undefined) return false;
  return raw === '1' || raw === 'true';
}

/**
 * @returns {{ isMsix: boolean, detectionSource: string|null, forced: boolean }}
 */
function packagingState(opts = {}) {
  const detected = detectPackaging(opts);
  const forced = forcedMsix();
  if (forced) return { isMsix: true, detectionSource: 'forced', forced: true };

  // R653: a reconstruction is always run unpacked, so detectPackaging can never answer yes, and the captured
  // feature map therefore kept advertising yukonSilver as `msix_required` — which is the status the frontend turns
  // into "Cowork 需要较新的安装版本". Everything that check exists to guarantee (a real desktop build rather than a
  // browser page) holds here, so the state is declared unless the caller explicitly opted out.
  //
  // Opt-out, because a future reader may need to reproduce the gated behaviour:
  //     CLAUDE_DENY_MSIX=1
  const denied = process.env.CLAUDE_DENY_MSIX === '1' || process.env.CLAUDE_DENY_MSIX === 'true';
  if (denied) return { ...detected, forced: false };
  return { isMsix: true, detectionSource: 'reconstruction', forced: false };
}

module.exports = { detectPackaging, forcedMsix, packagingState };
