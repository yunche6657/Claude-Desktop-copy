'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const EVENTS = ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'];
const DEFAULTS = Object.freeze({ width: 1200, height: 800, isMaximized: false, isFullScreen: false });
const positive = n => Number.isInteger(n) && n > 0;
function validBounds(value) {
  return value && Number.isInteger(value.x) && Number.isInteger(value.y) && positive(value.width) && positive(value.height)
    ? { x: value.x, y: value.y, width: value.width, height: value.height } : undefined;
}
function parseState(value) {
  if (!value || typeof value !== 'object') return undefined;
  const sizeValid = positive(value.width) && positive(value.height);
  const isMaximized = value.isMaximized === true;
  const isFullScreen = value.isFullScreen === true;
  if (!sizeValid && !isMaximized && !isFullScreen) return undefined;
  return {
    ...(sizeValid && Number.isInteger(value.x) && Number.isInteger(value.y) ? { x: value.x, y: value.y } : {}),
    width: sizeValid ? value.width : DEFAULTS.width,
    height: sizeValid ? value.height : DEFAULTS.height,
    isMaximized, isFullScreen, displayBounds: validBounds(value.displayBounds),
  };
}

function placeOnDisplays(state, screen) {
  if (state.x === undefined || state.y === undefined) return state;
  const frame = { x: state.x, y: state.y, width: state.width, height: state.height };
  const displays = screen.getAllDisplays(), saved = state.displayBounds;
  const equal = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const exact = saved && displays.find(display => equal(display.bounds, saved));
  let replacement;
  if (saved) for (const display of displays) {
    if (display.bounds.width === saved.width && display.bounds.height === saved.height &&
        (!replacement || distance(display.bounds, saved) < distance(replacement.bounds, saved))) replacement = display;
  }
  const fit = (bounds, area) => {
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    return { width, height, x: Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - width)),
      y: Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - height)) };
  };
  const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  let placed;
  if (exact) placed = fit(frame, exact.workArea);
  else if (displays.some(display => intersects(frame, display.bounds))) {
    placed = fit(frame, (screen.getDisplayMatching(frame) || screen.getPrimaryDisplay()).workArea);
  } else if (saved && replacement) {
    placed = fit({ ...frame, x: frame.x + replacement.bounds.x - saved.x, y: frame.y + replacement.bounds.y - saved.y }, replacement.workArea);
  } else {
    const primary = screen.getPrimaryDisplay();
    const width = Math.min(frame.width, primary.workArea.width), height = Math.min(frame.height, primary.workArea.height);
    const area = (screen.getDisplayMatching(primary.bounds) || screen.getPrimaryDisplay()).workArea;
    placed = { width, height, x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
      y: area.y + Math.max(0, Math.floor((area.height - height) / 2)) };
  }
  return { ...state, ...placed };
}

async function createWindowState({ app, screen, deleteSignedInFlag, onError = error => console.warn('[window-state]', error), timers = { setTimeout, clearTimeout }, debounceMs = 1000, fs: io = fs } = {}) {
  if (!app || typeof app.getPath !== 'function') throw new TypeError('app.getPath is required');
  const file = path.join(app.getPath('userData'), 'window-state.json');
  let state = { ...DEFAULTS }, win, timer, queue = Promise.resolve(), writeFailed = false;
  function report(error) { try { onError(error); } catch {} }
  try { state = parseState(JSON.parse(await io.readFile(file, 'utf8'))) ?? state; }
  catch (error) { if (error.code !== 'ENOENT') report(error); }
  async function atomicWrite(snapshot) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await io.writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      await io.rename(temp, file);
    } finally { await io.rm(temp, { force: true }).catch(() => {}); }
  }
  function scheduleWrite() {
    const snapshot = { ...state };
    queue = queue.then(() => atomicWrite(snapshot)).then(() => { writeFailed = false; }, error => { writeFailed = true; report(error); });
    return queue;
  }
  function capture(window) {
    if (window.isDestroyed() || window.isMinimized()) return false;
    const bounds = window.getBounds();
    const maximized = window.isMaximized(), fullScreen = window.isFullScreen();
    const display = screen?.getDisplayMatching?.(bounds) ?? screen?.getPrimaryDisplay?.();
    const next = { ...state, ...(!maximized && !fullScreen ? bounds : {}), isMaximized: maximized, isFullScreen: fullScreen, displayBounds: display?.bounds };
    const changed = writeFailed || ['x', 'y', 'width', 'height', 'isMaximized', 'isFullScreen'].some(key => next[key] !== state[key]);
    state = next;
    return changed;
  }
  function flushNow() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    if (win && capture(win)) scheduleWrite();
    return queue;
  }
  function onChange() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(flushNow, debounceMs);
  }
  function unmanage() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    if (!win) return;
    for (const event of EVENTS) win.removeListener(event, onChange);
    win.removeListener('close', flushNow);
    win.removeListener('closed', unmanage);
    win = undefined;
  }
  function manage(window, { restorePresentation = true } = {}) {
    unmanage();
    if (restorePresentation && state.isMaximized) window.maximize();
    if (restorePresentation && state.isFullScreen) window.setFullScreen(true);
    win = window;
    for (const event of EVENTS) window.on(event, onChange);
    window.on('close', flushNow);
    window.on('closed', unmanage);
  }
  async function discard() {
    unmanage();
    state = { ...DEFAULTS };
    await queue;
    await io.rm(file, { force: true }).catch(() => {});
  }
  async function reset() {
    if (typeof deleteSignedInFlag === 'function') {
      try { await deleteSignedInFlag(); } catch (error) { report(error); }
    }
    await discard();
  }
  return {
    placeOnDisplays() { state = placeOnDisplays(state, screen); },
    getOptions() { const { x, y, width, height } = state; return { ...(x !== undefined && y !== undefined ? { x, y } : {}), width, height }; },
    getState() { return { ...state }; }, manage, unmanage, flush: flushNow, discard, reset,
    saveState(window) { capture(window); return scheduleWrite(); },
  };
}
module.exports = { createWindowState, parseState, placeOnDisplays };
