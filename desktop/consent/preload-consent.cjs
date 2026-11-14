// Preload for the local-execution consent window.
//
// Mirrors .vite/build/localExecConsent.js from the shipped app.asar, which
// exposes exactly one bridge:
//
//   globalThis["claude.internal.localExecConsent"].LocalExecConsent.choose(decision)
//
// and nothing else.
//
// The original also guards the bridge on the page being a top-level frame on
// localhost (unpackaged) or file: (packaged). That guard lives in the MAIN
// process here (`ConsentManager.isTrustedSender`) instead of in the preload,
// because a sandboxed preload can run before `window.location` reflects the
// document it will host, which made a preload-side check silently refuse to
// expose the bridge. Validating the sender frame on the receiving side is the
// stronger check anyway: it inspects the frame that actually sent the message.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EIPC_NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const CHOOSE_CHANNEL =
  `$eipc_message$_${EIPC_NAMESPACE}_$_claude.internal.localExecConsent_$_LocalExecConsent_$_choose`;

// Decisions the original accepts; anything else is dropped before it reaches
// the main process.
const DECISIONS = new Set(['allow', 'cancel']);

contextBridge.exposeInMainWorld('claude.internal.localExecConsent', {
  LocalExecConsent: {
    choose(decision) {
      if (!DECISIONS.has(decision)) {
        return Promise.reject(new Error(`Unsupported consent decision: ${String(decision)}`));
      }
      return ipcRenderer.invoke(CHOOSE_CHANNEL, decision);
    },
  },
});
