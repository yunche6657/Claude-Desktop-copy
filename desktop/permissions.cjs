// Permission modes.
//
// The shipped app uses these mode names (observed in index.chunk-5wlbAX53.js and
// index.chunk-0q54qGlJ.js): `ask`, `acceptEdits`, `bypassPermissions`, `plan`,
// `follow_a_plan`. One behaviour is directly observable and worth reproducing:
// the desktop downgrades `bypassPermissions` to `acceptEdits` for bridge
// sessions (`i && (e.permissionMode = "acceptEdits"), { downgraded: i }`).
//
// This module is the single place that decides, for a given mode and action,
// whether the user must be asked. Nothing else in the codebase should infer a
// policy from a mode string.
'use strict';

const MODES = Object.freeze({
  ASK: 'ask',
  ACCEPT_EDITS: 'acceptEdits',
  BYPASS: 'bypassPermissions',
  PLAN: 'plan',
  // AUTO is a real shipped mode, not a display label.
  //
  // The frontend handles it explicitly in several places, e.g. in
  // c058fad4e-C-AvRBJf.js:
  //   F = e => e === "auto" || e === "bypassPermissions" ? e : void 0
  // and c0fd2fda3-CQ1-2UEl.js routes it the same way. Leaving it out of this set made
  // 27 valid session records look illegal, and setPermissionMode("auto") refused a
  // mode the UI actually offers.
  AUTO: 'auto',
  // The scheduled-task views also carry "default" for "follow the account default".
  DEFAULT: 'default',
  // DONT_ASK is in the protocol's mode enum, though THIS build's picker never lists it.
  //
  // Two facts worth keeping apart, because conflating them is what made the first
  // write-up of this fix wrong:
  //
  //   1. The shipped enum (shared-0-ByI5P0CP.js, `Wy`) carries it:
  //        { Default:"default", AcceptEdits:"acceptEdits", Plan:"plan",
  //          Bypass:"bypassPermissions", DontAsk:"dontAsk", Auto:"auto" }
  //      with a label and description in shared-8-PHXy9B6B.js:
  //        label: "Don't ask"
  //        description: "Deny actions that aren't pre-approved, without prompting"
  //
  //   2. The picker is built from a different table that does NOT include it:
  //        TL = { local:["default","acceptEdits","plan"], remote:[...], bridge:[...],
  //               cowork:[...], hub:[...] }
  //        EL(e,t) = [...TL[e]] + (t.auto ? "auto" : []) + (t.bypass ? "bypassPermissions" : [])
  //      A running check of the real menu showed five items: Auto / Manual /
  //      Accept edits / Plan / Bypass permissions.
  //
  // Omitting it from VALID_MODES made the bridge refuse a value the protocol defines.
  // That is wrong regardless of whether this build's own picker can produce it: a
  // stored record, another surface, or a future menu can all carry it.
  DONT_ASK: 'dontAsk',
});

const VALID_MODES = new Set(Object.values(MODES));

// Actions, ordered from least to most consequential.
const ACTIONS = Object.freeze({
  READ: 'read',
  EDIT: 'edit',
  EXEC: 'exec',
});

function assertMode(mode) {
  if (!VALID_MODES.has(mode)) throw new Error(`Unknown permission mode: ${String(mode)}`);
  return mode;
}

/**
 * Decides whether an action needs an explicit prompt.
 * Returns { prompt: boolean, reason: string, downgraded?: boolean }.
 */
function decide(mode, action, { isBridge = false } = {}) {
  let effective = assertMode(mode);
  let downgraded = false;

  // The original never honours a blanket bypass over a bridge session; it
  // downgrades instead of refusing so the session still works.
  if (effective === MODES.BYPASS && isBridge) {
    effective = MODES.ACCEPT_EDITS;
    downgraded = true;
  }

  const result = (prompt, reason) => ({ prompt, reason, effective, ...(downgraded ? { downgraded: true } : {}) });

  switch (effective) {
    case MODES.PLAN:
      // Plan mode may look but never change anything.
      if (action === ACTIONS.READ) return result(false, 'plan mode reads freely');
      return result(true, 'plan mode never mutates; the change is proposed instead');

    case MODES.ASK:
      // Reading a file is not an action on the workspace; prompting for it
      // would make every tool call unusable. The prompt covers changes:
      // edits and command execution.
      if (action === ACTIONS.READ) return result(false, 'reads are never prompted');
      return result(true, 'ask mode prompts before edits and commands');

    case MODES.ACCEPT_EDITS:
      if (action === ACTIONS.READ) return result(false, 'reads are not prompted in acceptEdits');
      if (action === ACTIONS.EDIT) return result(false, 'acceptEdits applies file edits without a prompt');
      return result(true, 'acceptEdits still prompts before running commands');

    case MODES.BYPASS:
      return result(false, 'bypassPermissions prompts for nothing');

    // "Auto — Recommended. Claude handles permissions" (the composer's own label).
    //
    // It is NOT a blanket bypass: the shipped app downgrades a bridge session's
    // bypass to acceptEdits, and auto is treated as a peer of bypass in the same
    // branches. Here it applies edits and reads without asking but still prompts
    // before executing commands, which is the conservative reading of "Claude
    // handles permissions" — an unattended shell command is the one thing the user
    // cannot undo.
    case MODES.AUTO:
      if (action === ACTIONS.READ) return result(false, 'auto mode reads freely');
      if (action === ACTIONS.EDIT) return result(false, 'auto mode applies edits without a prompt');
      return result(true, 'auto mode still confirms commands');

    // "default" means "follow the account default", which this build does not have a
    // separate source for, so it resolves to ask — the safe end of the range.
    case MODES.DEFAULT:
      if (action === ACTIONS.READ) return result(false, 'reads are never prompted');
      return result(true, 'the account default resolves to ask here');

    // "Don't ask" — the shipped description is
    //   "Deny actions that aren't pre-approved, without prompting"
    // so it must NOT prompt. Contrast with ask mode, which prompts and lets the user
    // decide; here the absence of approval means the action is denied outright.
    //
    // Reads stay allowed: denying a read would break every tool call without the user
    // having asked for anything, which is not what "deny unapproved actions" means.
    case MODES.DONT_ASK:
      if (action === ACTIONS.READ) return result(false, 'dontAsk reads freely');
      // `prompt: true` here does NOT mean "show a dialog".
      //
      // Read the flag as "this action is not pre-approved, so it cannot run on its own".
      // tool-approval.cjs turns that into:
      //     if (!policy.prompt) { auto-allow; run() }
      //     else { ask the user }
      // and in this build there is no approval surface for dontAsk, so the action is denied.
      //
      // Verified the hard way: setting this to false made dontAsk behave exactly like
      // bypassPermissions — edit and exec ran without any approval at all, because the
      // caller only distinguishes 'may run unattended' from 'needs approval'. That is a
      // security regression dressed up as fixing a comment, so the original value stays and
      // the REASON is corrected instead.
      return result(true, 'dontAsk: not pre-approved, and this mode never prompts to approve');

    default:
      return result(true, 'unknown mode falls back to prompting');
  }
}

/** True when the mode permits the action outright. */
function isAllowedWithoutPrompt(mode, action, options) {
  return decide(mode, action, options).prompt === false;
}

// The three outcomes a mode can express, named instead of inferred.
//
// `decide()` returns a single boolean, and every caller has had to remember that
//   prompt === false  means "run it unattended". 
// That works today because all five call sites read it the same way, but it is one
// misreading away from a security hole: round 182 nearly set dontAsk to prompt:false,
// which would have turned "deny unapproved actions" into "run them without asking" —
// identical to bypassPermissions. Only reading tool-approval.cjs caught it.
//
// This function makes the distinction explicit without changing `decide()`, so existing
// callers keep working. New code should prefer it: a typo in `=== 'deny'` fails loudly,
// whereas a flipped boolean silently permits.
const DECISIONS = Object.freeze({
  ALLOW: 'allow',   // pre-approved: run without asking anyone
  ASK: 'ask',       // needs approval; a caller with no UI must treat this as DENY
  DENY: 'deny',     // this mode never grants it
});

/**
 * Classify a decision into allow / ask / deny.
 *
 * dontAsk is the interesting case: its own description is "deny actions that aren't
 * pre-approved, without prompting", so it maps to DENY for edits and commands and to
 * ALLOW for reads. It must never map to ASK, because this build offers no approval
 * surface for that mode — an ASK would strand the action.
 */
function classify(mode, action, options) {
  const decision = decide(mode, action, options);
  if (decision.prompt === false) return DECISIONS.ALLOW;
  if (decision.effective === MODES.DONT_ASK) return DECISIONS.DENY;
  return DECISIONS.ASK;
}

module.exports = { MODES, ACTIONS, VALID_MODES, DECISIONS, assertMode, decide, classify, isAllowedWithoutPrompt };
