'use strict';
// Frontend layout patches — CSS injected into the shipped frontend at load time.
//
// WHY THIS EXISTS
//   resources/ion-dist renders a notification-permission banner with
//       data-testid="desktop-notification-permission-banner"
//       data-cds-covers-content=""
//   In this reconstruction it occupies rect [764, 676, 420, 108], which fully contains the send button
//   at [1096, 733, 24, 24], so clicks aimed at send land on the banner. R477 proved this is the sole
//   cause: with the banner present a click produces no `sendMessage`; hiding the banner and clicking the
//   same point produces `sendMessage ["local_f59b7601-…", …]` and a rendered turn.
//
// THE FIRST ATTEMPT MADE IT WORSE, AND THAT IS WHY THE RULE LOOKS LIKE THIS
//   v1 was:
//       [data-testid=…banner], [data-testid=…banner] * { pointer-events: none !important }
//       [data-testid=…banner] button, … { pointer-events: auto !important }
//   Measured live: the banner became transparent (good), the CTA stayed clickable (good), but
//       sendPointerEvents: "none"
//   — the send button itself turned transparent. It is a DESCENDANT of the banner subtree in the
//   rendered DOM, so the `*` selector reached it. The click still did not work, and now for a second,
//   self-inflicted reason.
//
//   That is a real lesson about this layout: the banner's box overlaps the composer because the composer
//   is rendered INSIDE the banner's subtree, not as a sibling beneath it. Blanket-disabling the subtree
//   therefore disables the composer.
//
// THE CORRECT RULE
//   Disable pointer events only on the banner's own layer, and re-enable everything inside it that is
//   interactive — including the composer. Concretely: turn off the banner element itself, then turn
//   pointer events back on for its ITEMS (buttons, links, inputs, the editor and any element that
//   already declared itself interactive), leaving only the banner's own padding/box inert.
//
//   `:where()` keeps specificity flat so the second rule reliably wins over the first without needing
//   ever-higher `!important` chains.
//
// WHY CSS AND NOT A BUNDLE PATCH
//   app-protocol.cjs's existing patches rewrite literals (a boolean, a locale array) inside named
//   chunks. Those anchors survive minification. A layout overlap has no such literal, and rewriting
//   minified layout code would break on every rebuild. A rule keyed on a data attribute is independent
//   of chunk hashes.

const BANNER_SELECTOR = '[data-testid="desktop-notification-permission-banner"]';

/**
 * The stylesheet text.
 *
 * Rule 1 makes the banner box itself transparent to input.
 * Rule 2 restores input on everything within it that a user is meant to interact with — the composer
 *       lives inside this subtree, so this is load-bearing, not a nicety.
 *
 * @returns {string}
 */
function bannerPointerEventsCss() {
  return [
    `/* injected by desktop/frontend-layout-patches.cjs */`,
    // 1. the banner's own box stops intercepting clicks
    `${BANNER_SELECTOR} {`,
    `  pointer-events: none !important;`,
    `}`,
    // 2. but everything interactive inside it keeps working. The send button and the editor are in
    //    here, which is why a blanket `*` rule broke them in the first attempt.
    `:where(${BANNER_SELECTOR}) :where(`,
    `  button, a, input, textarea, select, [role="button"], [role="textbox"], [contenteditable="true"],`,
    `  [data-testid="code-prompt-input"], [data-testid="code-prompt-send"]`,
    `) {`,
    `  pointer-events: auto !important;`,
    `}`,
    ``,
  ].join('\n');
}

/**
 * Apply the layout patches to a window.
 *
 * Injected unconditionally: the rule is scoped to one testid, so on a page where the banner never
 * renders it has no effect at all.
 *
 * Failures are reported rather than swallowed — a silently un-applied patch is the failure mode that
 * left the usage panel hidden for a while (see patchUsagePanelGate's comment in app-protocol.cjs).
 *
 * @param {{webContents: {insertCSS: Function}}} win
 * @param {(message: string) => void} [log]
 * @returns {Promise<{applied: string[], failed: string[]}>}
 */
async function applyFrontendLayoutPatches(win, log = () => {}) {
  const applied = [];
  const failed = [];
  try {
    await win.webContents.insertCSS(bannerPointerEventsCss(), { cssOrigin: 'user' });
    applied.push('notification-banner-pointer-events');
  } catch (error) {
    failed.push('notification-banner-pointer-events');
    log(`[layout] could not inject ${BANNER_SELECTOR} rule: ${error && error.message}`);
  }
  return { applied, failed };
}

module.exports = { applyFrontendLayoutPatches, bannerPointerEventsCss, BANNER_SELECTOR };
