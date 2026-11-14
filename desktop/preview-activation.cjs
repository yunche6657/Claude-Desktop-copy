'use strict';
// Native lzaSYO3Q @3096506 pM/szn, ozn immediately above it:
// transient click/activation-key capture is main-side, one-shot, 1500ms.
const ACTIVATION_MS = 1500, CLICK_PAIR_MS = 5000;
function createPreviewActivation({ now = Date.now } = {}) {
  const states = new Map();
  function track(contents, suppress) {
    if (!contents || typeof contents.on !== 'function') throw new TypeError('A real webContents event source is required');
    const previous = states.get(contents);
    if (previous) { if (suppress) previous.suppressors.add(suppress); return previous.dispose; }
    const state = { down: 0, up: 0, key: 0, suppressors: new Set(suppress ? [suppress] : []) };
    const suppressed = () => { for (const fn of state.suppressors) { try { if (fn() === true) return true; } catch { return true; } } return false; };
    const beforeInput = (_event, input) => {
      if (suppressed()) return;
      if (input.type === 'keyDown' && ['Enter', ' ', 'Space'].includes(input.key) && !input.isAutoRepeat) state.key = now();
    };
    const inputEvent = (_event, input) => {
      if (suppressed()) { state.down = 0; return; }
      if (['keyUp','keyDown','rawKeyDown'].includes(input.type)) return;
      const nonPrimary = input.modifiers?.some(value => ['rightbuttondown','middlebuttondown'].includes(value.toLowerCase())) ?? false;
      if (input.type === 'mouseDown') state.down = nonPrimary ? 0 : now();
      else if (input.type === 'mouseUp') {
        const time = now();
        if (!nonPrimary && state.down > 0 && time - state.down <= CLICK_PAIR_MS) state.up = time;
        state.down = 0;
      }
    };
    state.dispose = () => { contents.removeListener('before-input-event', beforeInput); contents.removeListener('input-event', inputEvent); contents.removeListener('destroyed', state.dispose); states.delete(contents); };
    states.set(contents, state);
    contents.on('before-input-event', beforeInput); contents.on('input-event', inputEvent); contents.once('destroyed', state.dispose);
    return state.dispose;
  }
  function consume(contents) {
    const state = states.get(contents);
    if (!state) return false;
    const time = now();
    if (state.up !== 0 && time - state.up <= ACTIVATION_MS) { state.up = 0; return true; }
    if (state.key === 0 || time - state.key > ACTIVATION_MS) return false;
    state.key = 0; return true;
  }
  return { track, consume, dispose() { for (const state of [...states.values()]) state.dispose(); } };
}
module.exports = { createPreviewActivation, ACTIVATION_MS, CLICK_PAIR_MS };
