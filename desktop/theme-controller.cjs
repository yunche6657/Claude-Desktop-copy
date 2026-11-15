'use strict';

// Editable Code-tab themes: one JSON file, twenty shipped SVG scenes, and a watcher so a model
// can write the file and the window follows.
//
// The controller owns exactly one file — `<directory>/theme.json` — and nothing else. It writes
// only that path (atomically, via a sibling temp file it removes), it never reads or writes
// credentials, and the state it hands out carries no code: no JavaScript, no HTML, no URLs, no
// remote references. Every user-supplied string is either a known scene id, one of three modes,
// or a six-digit hex colour; anything else is refused by name.
//
// Scene art is not synthesised here. `desktop/themes/` holds the twenty scenes extracted from
// anthropics/claude-plugins-official `plugins/theme-examples` at the commit recorded in
// `desktop/themes/catalog.json`, with their original CSS animations intact, under Apache-2.0
// (see `desktop/themes/LICENSE`). This module only reads those bytes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 1;
const THEME_FILE_NAME = 'theme.json';
const SCENE_DIRECTORY = path.join(__dirname, 'themes');
const CATALOG_FILE = 'catalog.json';
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEX = /^#[0-9a-f]{6}$/i;
// theme-renderer.cjs sanitises a name to 60 characters before it reaches the DOM; capping here
// at the same number means a name the controller accepts is never silently shortened later.
const MAX_NAME = 60;
const WATCH_DEBOUNCE_MS = 25;
const WATCH_POLL_MS = 200;

// The app's own measured palette, so an untouched theme looks like the stock window:
// light body background rgb(252,252,251) with near-black text, dark body rgb(21,21,21) with
// rgb(240,239,236) text (both measured from the shipped stylesheet; see theme-application tests).
// muted and accent are this module's own neutral defaults.
const DEFAULT_STATE = {
  version: STATE_VERSION,
  name: 'Default',
  mode: 'system',
  scene: null,
  motion: true,
  glass: { blur: 0, opacity: 0, tint: '#000000' },
  colors: {
    light: { background: '#fcfcfb', text: '#151515', muted: '#6f6e6a', accent: '#c96442' },
    dark: { background: '#151515', text: '#f0efec', muted: '#8d8b86', accent: '#d97757' },
  },
};

const TOP_FIELDS = new Set(['version', 'name', 'mode', 'scene', 'motion', 'glass', 'colors']);
const GLASS_FIELDS = new Set(['blur', 'opacity', 'tint']);
const COLORS_FIELDS = new Set(['light', 'dark']);
const ROLE_FIELDS = new Set(['background', 'text', 'muted', 'accent']);
const MODES = new Set(['system', 'light', 'dark']);

class ThemeError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
    if (field) this.field = field;
  }
}

function invalid(message, field) {
  return new ThemeError('E_THEME_INVALID', message, field);
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function checkFields(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw invalid(
        `${where}: unsupported field ${JSON.stringify(key)} — a theme carries only ${[...allowed].join(', ')}`,
        where === 'theme' ? key : `${where}.${key}`,
      );
    }
  }
}

function checkName(value) {
  if (typeof value !== 'string') throw invalid('name must be a string', 'name');
  const name = value.trim();
  if (!name) throw invalid('name must not be empty', 'name');
  if (name.length > MAX_NAME) throw invalid(`name must be at most ${MAX_NAME} characters`, 'name');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('name must not contain control characters', 'name');
  if (/[<>]/.test(name)) throw invalid('name must not contain HTML', 'name');
  return name;
}

function checkMode(value) {
  if (typeof value !== 'string' || !MODES.has(value)) {
    throw invalid(`mode must be 'system', 'light' or 'dark', not ${JSON.stringify(value)}`, 'mode');
  }
  return value;
}

function checkHex(value, field) {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw invalid(`${field} must be a six-digit hex colour like '#1a2b3c', not ${JSON.stringify(value)}`, field);
  }
  return value.toLowerCase();
}

function checkNumberInRange(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${field} must be a number, not ${JSON.stringify(value)}`, field);
  }
  if (value < min || value > max) throw invalid(`${field} must be between ${min} and ${max}, not ${value}`, field);
  return value;
}

function checkBoolean(value, field) {
  if (typeof value !== 'boolean') throw invalid(`${field} must be true or false, not ${JSON.stringify(value)}`, field);
  return value;
}

function checkScene(value, sceneIds) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SCENE_ID.test(value)) {
    throw invalid(`scene must be null or a scene id such as 'aurora', not ${JSON.stringify(value)}`, 'scene');
  }
  if (!sceneIds.has(value)) {
    throw invalid(`scene ${JSON.stringify(value)} is not one of the ${sceneIds.size} available scenes`, 'scene');
  }
  return value;
}

function mergeGlass(base, patch) {
  if (!isPlainObject(patch)) throw invalid('glass must be an object', 'glass');
  checkFields(patch, GLASS_FIELDS, 'glass');
  const out = { ...base };
  if (own(patch, 'blur')) out.blur = checkNumberInRange(patch.blur, 'glass.blur', 0, 64);
  if (own(patch, 'opacity')) out.opacity = checkNumberInRange(patch.opacity, 'glass.opacity', 0, 1);
  if (own(patch, 'tint')) out.tint = checkHex(patch.tint, 'glass.tint');
  return out;
}

function mergeColors(base, patch) {
  if (!isPlainObject(patch)) throw invalid('colors must be an object', 'colors');
  checkFields(patch, COLORS_FIELDS, 'colors');
  const out = { light: { ...base.light }, dark: { ...base.dark } };
  for (const mode of ['light', 'dark']) {
    if (!own(patch, mode)) continue;
    const layer = patch[mode];
    if (!isPlainObject(layer)) throw invalid(`colors.${mode} must be an object`, `colors.${mode}`);
    checkFields(layer, ROLE_FIELDS, `colors.${mode}`);
    for (const role of ROLE_FIELDS) {
      if (own(layer, role)) out[mode][role] = checkHex(layer[role], `colors.${mode}.${role}`);
    }
  }
  return out;
}

/** Apply a partial theme over `base` and return a complete, canonical, frozen-ready state. */
function applyPatch(base, patch, sceneIds) {
  if (!isPlainObject(patch)) throw invalid('a theme must be an object', 'theme');
  checkFields(patch, TOP_FIELDS, 'theme');
  const out = {
    version: STATE_VERSION,
    name: base.name,
    mode: base.mode,
    scene: base.scene,
    motion: base.motion,
    glass: { ...base.glass },
    colors: { light: { ...base.colors.light }, dark: { ...base.colors.dark } },
  };
  if (own(patch, 'version') && patch.version !== STATE_VERSION) {
    throw invalid(`version must be ${STATE_VERSION}, not ${JSON.stringify(patch.version)}`, 'version');
  }
  if (own(patch, 'name')) out.name = checkName(patch.name);
  if (own(patch, 'mode')) out.mode = checkMode(patch.mode);
  if (own(patch, 'scene')) out.scene = checkScene(patch.scene, sceneIds);
  if (own(patch, 'motion')) out.motion = checkBoolean(patch.motion, 'motion');
  if (own(patch, 'glass')) out.glass = mergeGlass(base.glass, patch.glass);
  if (own(patch, 'colors')) out.colors = mergeColors(base.colors, patch.colors);
  return out;
}

function sleepSync(milliseconds) {
  // A tiny synchronous pause for the rename retry: no timers, no event loop re-entry.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Write `text` to `file` through a sibling temp file and a rename, so a reader never sees half a
 * theme. Windows refuses the rename while another handle is open on the target (a watcher, an
 * indexer, an editor), so it retries briefly before giving up; the temp file never survives.
 */
function writeFileAtomic(file, text) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, text, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code)) break;
      sleepSync(15 * (attempt + 1));
    }
  }
  try { fs.unlinkSync(temporary); } catch { /* already gone */ }
  throw new ThemeError('E_THEME_WRITE', `could not replace ${file}: ${lastError && lastError.message}`, 'theme.json');
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class ThemeController {
  constructor(options = {}) {
    const directory = options && options.directory;
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('ThemeController: { directory } is required; it names the folder that holds theme.json');
    }
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, THEME_FILE_NAME);
    this._onChange = typeof options.onChange === 'function' ? options.onChange : null;

    fs.mkdirSync(this.directory, { recursive: true });

    this._state = Object.freeze(clone(DEFAULT_STATE));
    this._error = null;
    this._scenes = null;
    this._watcher = null;
    this._poll = null;
    this._timer = null;
    this._closed = false;
    this._writing = false;
    // Digest of the bytes this controller last wrote: an event carrying them is our own echo.
    this._writtenDigest = null;
    this._seenDigest = null;

    this._readInitial();
  }

  // ---------------------------------------------------------------- reads

  /** The canonical theme in effect: always complete, always frozen-copied, never partial. */
  getState() {
    return clone(this._state);
  }

  /** The last rejected write's own words, or null. The theme in effect does not change on error. */
  getError() {
    return this._error ? { ...this._error } : null;
  }

  /** The one file this controller owns; a model edits it to author a theme. */
  getThemeFile() {
    return this.file;
  }

  /** Every shipped scene, in catalog order: `[{ id, title, mode, svg }]`. */
  listScenes() {
    return this._sceneIndex().list.map((scene) => ({
      id: scene.id,
      title: scene.title,
      mode: scene.mode,
      svg: scene.svg,
    }));
  }

  // ---------------------------------------------------------------- writes

  /**
   * Validate a partial theme over the current one, persist it atomically, and announce it.
   * Returns the new state. An invalid field throws before anything is written or announced,
   * so a rejected edit leaves both the file and the live theme exactly as they were.
   */
  setTheme(input) {
    this._assertOpen();
    const next = applyPatch(this._state, input, this._sceneIds());
    return this._commit(next, 'set');
  }

  /** Back to the defaults, persisted like any other theme. */
  reset() {
    this._assertOpen();
    return this._commit(clone(DEFAULT_STATE), 'reset');
  }

  // ---------------------------------------------------------------- watching

  /**
   * Follow `<directory>/theme.json` while a model (or a text editor) writes it. A native watcher
   * plus a light mtime poll: the watcher is immediate but can miss an atomic rename on some file
   * systems, and the poll closes that gap. A change whose bytes are the ones this controller just
   * wrote is ignored, so a UI that writes on change cannot drive itself in a loop.
   */
  watch() {
    this._assertOpen();
    if (this._watcher || this._poll) return;
    const check = () => this._schedule();
    try {
      this._watcher = fs.watch(this.directory, { persistent: false }, check);
      this._watcher.on('error', (error) => {
        this._fail('E_THEME_WATCH', `theme watcher failed: ${error.message}`);
      });
    } catch (error) {
      this._watcher = null;
      this._fail('E_THEME_WATCH', `theme watcher could not start: ${error.message}`);
    }
    this._poll = setInterval(() => {
      if (this._fileMoved()) this._schedule();
    }, WATCH_POLL_MS);
    if (typeof this._poll.unref === 'function') this._poll.unref();
    this._rememberFile();
  }

  /** Stop watching. The theme in effect and the file stay. Safe to call more than once. */
  close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* already closed */ }
      this._watcher = null;
    }
  }

  // ---------------------------------------------------------------- internals

  _assertOpen() {
    if (this._closed) throw new ThemeError('E_THEME_CLOSED', 'this theme controller is closed');
  }

  _sceneIndex() {
    if (this._scenes) return this._scenes;
    let catalog;
    try {
      catalog = JSON.parse(fs.readFileSync(path.join(SCENE_DIRECTORY, CATALOG_FILE), 'utf8'));
    } catch (error) {
      throw new ThemeError('E_THEME_CATALOG', `shipped scene catalog unreadable: ${error.message}`);
    }
    if (!catalog || !Array.isArray(catalog.scenes) || catalog.scenes.length !== 20) {
      throw new ThemeError('E_THEME_CATALOG', 'shipped scene catalog must describe exactly 20 scenes');
    }
    const list = catalog.scenes.map((entry) => {
      const id = entry && entry.id;
      const mode = entry && entry.mode;
      if (typeof id !== 'string' || !SCENE_ID.test(id)) throw new ThemeError('E_THEME_CATALOG', `bad scene id ${JSON.stringify(id)}`);
      if (mode !== 'light' && mode !== 'dark') throw new ThemeError('E_THEME_CATALOG', `scene ${id} has no light/dark mode`);
      if (typeof entry.title !== 'string' || !entry.title) throw new ThemeError('E_THEME_CATALOG', `scene ${id} has no title`);
      if (typeof entry.file !== 'string' || entry.file !== `${id}.svg`) throw new ThemeError('E_THEME_CATALOG', `scene ${id} points at ${JSON.stringify(entry.file)}`);
      let svg;
      try {
        svg = fs.readFileSync(path.join(SCENE_DIRECTORY, entry.file), 'utf8');
      } catch (error) {
        throw new ThemeError('E_THEME_CATALOG', `scene ${id} is missing: ${error.message}`);
      }
      if (!svg.startsWith('<svg')) throw new ThemeError('E_THEME_CATALOG', `scene ${id} is not an SVG document`);
      if (/<script|javascript:|\son\w+=/i.test(svg)) throw new ThemeError('E_THEME_CATALOG', `scene ${id} carries script`);
      return { id, title: entry.title, mode, svg };
    });
    const ids = new Set(list.map((scene) => scene.id));
    if (ids.size !== list.length) throw new ThemeError('E_THEME_CATALOG', 'shipped scene catalog repeats an id');
    this._scenes = { list, ids };
    return this._scenes;
  }

  _sceneIds() {
    return this._sceneIndex().ids;
  }

  _readInitial() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._rememberFile();
        return; // No theme authored yet: the defaults stand, and that is not an error.
      }
      this._fail('E_THEME_READ', `could not read ${this.file}: ${error.message}`);
      return;
    }
    this._seenDigest = digest(raw);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this._fail('E_THEME_JSON', `${THEME_FILE_NAME} is not valid JSON: ${error.message}`);
      return;
    }
    try {
      this._state = Object.freeze(applyPatch(clone(DEFAULT_STATE), parsed, this._sceneIds()));
    } catch (error) {
      this._fail(error.code || 'E_THEME_INVALID', `existing ${THEME_FILE_NAME} was refused: ${error.message}`);
    }
    this._rememberFile();
  }

  _commit(next, reason) {
    const state = clone(next);
    const text = JSON.stringify(state, null, 2) + '\n';
    this._writing = true;
    try {
      writeFileAtomic(this.file, text);
    } finally {
      this._writing = false;
    }
    const hash = digest(text);
    this._writtenDigest = hash;
    this._seenDigest = hash;
    this._state = Object.freeze(state);
    this._error = null;
    this._rememberFile();
    this._emit(state, { reason, error: null });
    return clone(state);
  }

  _emit(state, info) {
    if (!this._onChange) return;
    try {
      this._onChange(clone(state), { ...info });
    } catch {
      // A listener that throws is the listener's problem: the theme is already saved and live.
    }
  }

  _fail(code, message) {
    const error = { code, message, at: Date.now() };
    this._error = error;
    this._emit(this._state, { reason: 'error', error: { ...error } });
  }

  // The poll compares a signature rather than only a timestamp: 'missing' is a state too, so a
  // theme file that appears after the controller started is picked up even if fs.watch missed it.
  _rememberFile() {
    try {
      const stat = fs.statSync(this.file);
      this._fileStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this._fileStamp = 'missing';
    }
  }

  _fileMoved() {
    try {
      const stat = fs.statSync(this.file);
      return `${stat.mtimeMs}:${stat.size}` !== this._fileStamp;
    } catch {
      return this._fileStamp !== 'missing';
    }
  }

  _schedule() {
    if (this._closed) return;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._check();
    }, WATCH_DEBOUNCE_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Re-read the file after an external change. A bad file never replaces a good theme. */
  _check() {
    if (this._closed) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      this._rememberFile();
      if (error.code === 'ENOENT') {
        this._fail('E_THEME_MISSING', `${THEME_FILE_NAME} is gone; the last valid theme is still in effect`);
      } else {
        this._fail('E_THEME_READ', `could not read ${THEME_FILE_NAME}: ${error.message}`);
      }
      return;
    }
    const hash = digest(raw);
    this._rememberFile();
    if (hash === this._writtenDigest) return; // our own write, echoing back
    if (hash === this._seenDigest) return; // already dealt with
    this._seenDigest = hash;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this._fail('E_THEME_JSON', `${THEME_FILE_NAME} is not valid JSON: ${error.message}`);
      return;
    }
    let next;
    try {
      next = applyPatch(clone(DEFAULT_STATE), parsed, this._sceneIds());
    } catch (error) {
      this._fail(error.code || 'E_THEME_INVALID', `${THEME_FILE_NAME} was refused: ${error.message}`);
      return;
    }
    this._state = Object.freeze(next);
    this._error = null;
    this._emit(next, { reason: 'external', error: null });
  }
}

module.exports = { ThemeController };
