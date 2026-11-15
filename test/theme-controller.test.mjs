// The theme controller: one JSON file, twenty shipped scenes, and a watcher.
//
// Every assertion here is about observable behaviour of the contract the bridge and the
// renderer depend on: the canonical state shape, what a partial setTheme is allowed to change,
// what an invalid value is not allowed to change, and what happens when something outside this
// process writes the file — including writing garbage.
//
// The scenes are not synthesised by this module. They were extracted from
// anthropics/claude-plugins-official `plugins/theme-examples` (Apache-2.0, commit recorded in
// desktop/themes/catalog.json) with their CSS animations intact, and the tests below pin that
// they are real: 20 of them, each a well-formed SVG with its own @keyframes, each with a
// light/dark mode, and each reachable by id through setTheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ThemeController } = require('../desktop/theme-controller.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_DIR = path.join(ROOT, 'desktop', 'themes');

const DEFAULTS = {
  version: 1,
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

const SCRATCH = [];

function scratch() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoke-theme-'));
  SCRATCH.push(directory);
  return directory;
}

test.after(() => {
  for (const directory of SCRATCH) fs.rmSync(directory, { recursive: true, force: true });
});

function readTheme(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'theme.json'), 'utf8'));
}

async function waitFor(predicate, { timeout = 5000, what = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
}

function recorder() {
  const events = [];
  const onChange = (state, info) => events.push({ state, info });
  return { events, onChange };
}

// ---------------------------------------------------------------- the shipped scenes

test('the shipped catalogue holds twenty real scenes, each with its animation', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, 'catalog.json'), 'utf8'));
  assert.equal(catalog.scenes.length, 20);
  assert.equal(catalog.version, 1);
  assert.equal(catalog.source.repository, 'https://github.com/anthropics/claude-plugins-official');
  assert.match(catalog.source.commit, /^[0-9a-f]{40}$/, 'the source commit must be pinned');
  assert.equal(catalog.source.plugin, 'plugins/theme-examples');
  assert.equal(catalog.source.license, 'Apache-2.0');
  const ids = catalog.scenes.map((scene) => scene.id);
  assert.equal(new Set(ids).size, 20, 'scene ids must be unique');
  const modes = new Set();
  for (const scene of catalog.scenes) {
    const file = path.join(SCENE_DIR, `${scene.id}.svg`);
    assert.ok(fs.existsSync(file), `${scene.id}.svg is missing`);
    const svg = fs.readFileSync(file, 'utf8');
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), `${scene.id} is not an SVG document`);
    assert.match(svg, /viewBox="0 0 1600 1000"/, `${scene.id} has no viewBox`);
    assert.match(svg, /@keyframes/, `${scene.id} lost its animation`);
    assert.match(svg, /prefers-reduced-motion/, `${scene.id} lost its reduced-motion rule`);
    assert.equal(/<script|javascript:|\son\w+=/i.test(svg), false, `${scene.id} carries script`);
    assert.equal(typeof scene.title, 'string', `${scene.id} has no title`);
    assert.ok(scene.title.length > 0);
    assert.ok(scene.mode === 'light' || scene.mode === 'dark', `${scene.id} has no window mode`);
    modes.add(scene.mode);
    assert.match(scene.sha256, /^[0-9a-f]{64}$/, `${scene.id} has no digest`);
  }
  assert.deepEqual([...modes].sort(), ['dark', 'light'], 'both kinds of window must be offered');
});

test('the Apache licence travels with the extracted scenes', () => {
  const licence = fs.readFileSync(path.join(SCENE_DIR, 'LICENSE'), 'utf8');
  assert.match(licence, /Apache License/);
  assert.match(licence, /Version 2\.0, January 2004/);
});

// ---------------------------------------------------------------- shape and defaults

test('a fresh directory starts on the documented defaults, without writing anything', () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  assert.deepEqual(controller.getState(), DEFAULTS);
  assert.equal(controller.getThemeFile(), path.join(directory, 'theme.json'));
  assert.equal(controller.getError(), null);
  assert.equal(fs.existsSync(path.join(directory, 'theme.json')), false, 'reading a default must not create the file');
  assert.deepEqual(events, [], 'nothing changed, so nothing was announced');
  controller.close();
});

test('listScenes returns id, title, mode and svg per scene and nothing else', () => {
  const controller = new ThemeController({ directory: scratch() });
  const scenes = controller.listScenes();
  assert.equal(scenes.length, 20);
  for (const scene of scenes) {
    assert.deepEqual(Object.keys(scene).sort(), ['id', 'mode', 'svg', 'title']);
    assert.equal(typeof scene.id, 'string');
    assert.equal(typeof scene.title, 'string');
    assert.ok(scene.mode === 'light' || scene.mode === 'dark');
    assert.ok(scene.svg.startsWith('<svg'));
    assert.match(scene.svg, /@keyframes/);
  }
  assert.equal(new Set(scenes.map((scene) => scene.id)).size, 20);
  controller.close();
});

test('getState hands out a copy, so a caller cannot edit the live theme', () => {
  const controller = new ThemeController({ directory: scratch() });
  const state = controller.getState();
  state.colors.light.background = '#000000';
  state.glass.blur = 40;
  state.mode = 'dark';
  assert.deepEqual(controller.getState(), DEFAULTS);
  controller.close();
});

// ---------------------------------------------------------------- persistence

test('setTheme merges a partial patch, writes canonically and announces once', () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  const next = controller.setTheme({ scene: 'aurora', glass: { blur: 18 }, name: 'Night watch' });
  assert.equal(next.scene, 'aurora');
  assert.equal(next.name, 'Night watch');
  assert.deepEqual(next.glass, { blur: 18, opacity: 0, tint: '#000000' }, 'a partial glass merge keeps the other keys');
  assert.equal(next.mode, 'system', 'unmentioned fields are preserved');
  assert.deepEqual(next.colors, DEFAULTS.colors);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].state, next);
  assert.equal(events[0].info.reason, 'set');
  assert.equal(events[0].info.error, null);
  assert.deepEqual(readTheme(directory), next, 'the file holds exactly the canonical state');
  assert.equal(fs.readFileSync(path.join(directory, 'theme.json'), 'utf8').endsWith('}\n'), true, 'the file ends with a newline');
  controller.close();
});

test('a saved theme survives a restart', () => {
  const directory = scratch();
  const first = new ThemeController({ directory });
  const saved = first.setTheme({
    name: 'Ember evening',
    mode: 'dark',
    scene: 'ember',
    motion: false,
    glass: { blur: 12, opacity: 0.3, tint: '#2a0d12' },
    colors: { dark: { background: '#101012', text: '#f5efe6', muted: '#8a827a', accent: '#ff7a2a' } },
  });
  first.close();
  const second = new ThemeController({ directory });
  assert.deepEqual(second.getState(), saved);
  assert.equal(second.getError(), null);
  second.close();
});

test('setTheme accepts every shipped scene id', () => {
  const controller = new ThemeController({ directory: scratch() });
  for (const scene of controller.listScenes()) {
    const state = controller.setTheme({ scene: scene.id });
    assert.equal(state.scene, scene.id, `scene ${scene.id} was refused`);
  }
  controller.close();
});

test('reset restores the defaults and persists them', () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  controller.setTheme({ name: 'Custom', mode: 'light', scene: 'koi-mosaic' });
  const state = controller.reset();
  assert.deepEqual(state, DEFAULTS);
  assert.deepEqual(readTheme(directory), DEFAULTS);
  assert.equal(events.length, 2);
  assert.equal(events[1].info.reason, 'reset');
  controller.close();
});

test('the theme directory holds the theme file and nothing else', () => {
  const directory = scratch();
  const controller = new ThemeController({ directory });
  controller.setTheme({ scene: 'blueprint' });
  const names = fs.readdirSync(directory);
  assert.deepEqual(names, ['theme.json'], 'an atomic write leaves no temp file and stores no credentials');
  controller.close();
});

// ---------------------------------------------------------------- invalid input

const REFUSED = [
  ['a colour that is not hex', { colors: { light: { background: 'rgb(1,2,3)' } } }, /six-digit hex/],
  ['a named colour', { colors: { dark: { text: 'black' } } }, /six-digit hex/],
  ['a three-digit hex', { glass: { tint: '#abc' } }, /six-digit hex/],
  ['a CSS function smuggled into a colour', { colors: { light: { accent: 'url(javascript:alert(1))' } } }, /six-digit hex/],
  ['an unknown mode', { mode: 'dim' }, /mode must be/],
  ['an unknown scene', { scene: 'not-a-scene' }, /not one of the 20 available scenes/],
  ['a path as a scene', { scene: '../../etc/passwd' }, /scene must be null or a scene id/],
  ['blur above 64', { glass: { blur: 65 } }, /between 0 and 64/],
  ['blur below 0', { glass: { blur: -1 } }, /between 0 and 64/],
  ['opacity above 1', { glass: { opacity: 1.5 } }, /between 0 and 1/],
  ['a non-boolean motion', { motion: 'no' }, /true or false/],
  ['an arbitrary javascript field', { script: 'alert(1)' }, /unsupported field "script"/],
  ['an arbitrary html field', { html: '<img onerror=alert(1)>' }, /unsupported field "html"/],
  ['a field inside glass', { glass: { url: 'https://example.com/bg.png' } }, /unsupported field "url"/],
  ['a field inside a colour layer', { colors: { light: { border: '#ffffff' } } }, /unsupported field/],
  ['a name containing html', { name: '<b>bold</b>' }, /must not contain HTML/],
  ['an empty name', { name: '   ' }, /must not be empty/],
  ['a future version', { version: 2 }, /version must be 1/],
  ['an array where an object belongs', [], /must be an object/],
  ['a string where an object belongs', 'aurora', /must be an object/],
  ['null', null, /must be an object/],
];

for (const [label, patch, expected] of REFUSED) {
  test(`setTheme refuses ${label} without touching the file or the live theme`, () => {
    const directory = scratch();
    const { events, onChange } = recorder();
    const controller = new ThemeController({ directory, onChange });
    controller.setTheme({ name: 'Kept', scene: 'aurora' });
    const before = readTheme(directory);
    const eventsBefore = events.length;
    assert.throws(() => controller.setTheme(patch), expected);
    assert.deepEqual(controller.getState(), { ...DEFAULTS, name: 'Kept', scene: 'aurora' });
    assert.deepEqual(readTheme(directory), before, 'a refused write must not reach the disk');
    assert.equal(events.length, eventsBefore, 'a refused write must not announce a change');
    controller.close();
  });
}

test('a refused patch names the field it refused', () => {
  const controller = new ThemeController({ directory: scratch() });
  let error;
  try {
    controller.setTheme({ colors: { light: { muted: 'grey' } } });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'E_THEME_INVALID');
  assert.equal(error.field, 'colors.light.muted');
  assert.match(error.message, /colors\.light\.muted/);
  controller.close();
});

// ---------------------------------------------------------------- a file that is already unreadable

test('a corrupt theme file at start falls back to the defaults and reports the fault', () => {
  const directory = scratch();
  fs.writeFileSync(path.join(directory, 'theme.json'), '{ this is not json', 'utf8');
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  assert.deepEqual(controller.getState(), DEFAULTS);
  const error = controller.getError();
  assert.equal(error.code, 'E_THEME_JSON');
  assert.match(error.message, /not valid JSON/);
  assert.equal(events.length, 1);
  assert.equal(events[0].info.reason, 'error');
  assert.equal(events[0].info.error.code, 'E_THEME_JSON');
  controller.close();
});

test('a theme file with an invalid field at start falls back to the defaults and reports the field', () => {
  const directory = scratch();
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify({ ...DEFAULTS, mode: 'sepia' }), 'utf8');
  const controller = new ThemeController({ directory });
  assert.deepEqual(controller.getState(), DEFAULTS);
  assert.equal(controller.getError().code, 'E_THEME_INVALID');
  assert.match(controller.getError().message, /mode must be/);
  controller.close();
});

// ---------------------------------------------------------------- external writes

test('an external rewrite of the file is picked up while watching', async () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  controller.watch();
  const authored = {
    ...DEFAULTS,
    name: 'Model authored',
    mode: 'dark',
    scene: 'night-reef',
    glass: { blur: 14, opacity: 0.4, tint: '#0a1430' },
  };
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify(authored, null, 2) + '\n', 'utf8');
  await waitFor(() => controller.getState().scene === 'night-reef', { what: 'the external theme to load' });
  assert.deepEqual(controller.getState(), authored);
  assert.equal(controller.getError(), null);
  assert.ok(events.length >= 1);
  const last = events[events.length - 1];
  assert.equal(last.info.reason, 'external');
  assert.deepEqual(last.state, authored);
  controller.close();
});

test('an external write with broken JSON keeps the last valid theme and exposes the error', async () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  const good = controller.setTheme({ name: 'Good', mode: 'light', scene: 'paper-garden' });
  controller.watch();
  fs.writeFileSync(path.join(directory, 'theme.json'), '{"version":1,"name":', 'utf8');
  await waitFor(() => controller.getError() !== null, { what: 'the parse fault to be reported' });
  assert.deepEqual(controller.getState(), good, 'a broken write must not replace a good theme');
  assert.equal(controller.getError().code, 'E_THEME_JSON');
  assert.match(controller.getError().message, /not valid JSON/);
  const last = events[events.length - 1];
  assert.equal(last.info.reason, 'error');
  assert.equal(last.info.error.code, 'E_THEME_JSON');
  assert.deepEqual(last.state, good, 'the announced state is still the last valid one');
  controller.close();
});

test('an external write with an invalid value keeps the last valid theme and exposes the field', async () => {
  const directory = scratch();
  const controller = new ThemeController({ directory });
  const good = controller.setTheme({ name: 'Good', scene: 'vector-range' });
  controller.watch();
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify({ ...DEFAULTS, scene: 'vector-range', colors: { light: { text: 'red' } } }), 'utf8');
  await waitFor(() => controller.getError() !== null, { what: 'the validation fault to be reported' });
  assert.deepEqual(controller.getState(), good);
  assert.equal(controller.getError().code, 'E_THEME_INVALID');
  assert.match(controller.getError().message, /colors\.light\.text/);
  controller.close();
});

test('a good external write after a bad one clears the error', async () => {
  const directory = scratch();
  const controller = new ThemeController({ directory });
  controller.watch();
  fs.writeFileSync(path.join(directory, 'theme.json'), 'not json at all', 'utf8');
  await waitFor(() => controller.getError() !== null, { what: 'the fault to be reported' });
  assert.equal(controller.getError().code, 'E_THEME_JSON');
  const recovered = { ...DEFAULTS, name: 'Recovered', scene: 'halftone-dusk', mode: 'dark' };
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify(recovered, null, 2) + '\n', 'utf8');
  await waitFor(() => controller.getError() === null && controller.getState().name === 'Recovered', {
    what: 'the recovery',
  });
  assert.deepEqual(controller.getState(), recovered);
  controller.close();
});

test('a theme file created after the watcher started is picked up', async () => {
  // 'missing' is a state the poll compares against, not a hole: a model can author the first
  // theme after the window is already open, and it must appear without a restart.
  const directory = scratch();
  const controller = new ThemeController({ directory });
  assert.equal(controller.getState().name, 'Default');
  controller.watch();
  assert.equal(fs.existsSync(path.join(directory, 'theme.json')), false);
  const authored = { ...DEFAULTS, name: 'First theme', scene: 'honu-lagoon' };
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify(authored, null, 2) + '\n', 'utf8');
  await waitFor(() => controller.getState().name === 'First theme', { what: 'the new file to be read' });
  assert.deepEqual(controller.getState(), authored);
  assert.equal(controller.getError(), null);
  controller.close();
});

test('a deleted theme file is reported and leaves the last valid theme in place', async () => {
  const directory = scratch();
  const controller = new ThemeController({ directory });
  const good = controller.setTheme({ name: 'Kept', scene: 'snow-pines' });
  controller.watch();
  fs.rmSync(path.join(directory, 'theme.json'));
  await waitFor(() => controller.getError() !== null, { what: 'the missing file to be reported' });
  assert.equal(controller.getError().code, 'E_THEME_MISSING');
  assert.deepEqual(controller.getState(), good);
  controller.close();
});

// ---------------------------------------------------------------- no self-driven loop

test('the watcher ignores the controller\'s own writes instead of looping on them', async () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  controller.watch();
  controller.setTheme({ name: 'Once', mode: 'dark', scene: 'departure-board' });
  // Give a watcher that WOULD echo all the time it needs to echo.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(events.length, 1, `writing once must announce once, not ${events.length} times`);
  assert.equal(events[0].info.reason, 'set');
  assert.equal(events.filter((event) => event.info.reason === 'external').length, 0);
  controller.close();
});

test('two writes announce two changes, and neither echoes back as external', async () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  controller.watch();
  controller.setTheme({ scene: 'halftone-dawn' });
  controller.setTheme({ scene: 'dither-dunes' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.info.reason), ['set', 'set']);
  assert.equal(controller.getState().scene, 'dither-dunes');
  controller.close();
});

// ---------------------------------------------------------------- lifetime

test('close stops the watcher: a later external write changes nothing', async () => {
  const directory = scratch();
  const { events, onChange } = recorder();
  const controller = new ThemeController({ directory, onChange });
  controller.watch();
  controller.close();
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify({ ...DEFAULTS, name: 'Ignored' }), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(controller.getState().name, 'Default');
  assert.deepEqual(events, []);
  controller.close();
});

test('watch is idempotent and a closed controller refuses writes', () => {
  const controller = new ThemeController({ directory: scratch() });
  controller.watch();
  controller.watch();
  controller.close();
  controller.close();
  assert.throws(() => controller.setTheme({ scene: 'aurora' }), /closed/);
  assert.throws(() => controller.reset(), /closed/);
});

test('a controller without a directory is refused, and without onChange it still works', () => {
  assert.throws(() => new ThemeController({}), /directory/);
  assert.throws(() => new ThemeController(), /directory/);
  const controller = new ThemeController({ directory: scratch() });
  const state = controller.setTheme({ scene: 'ember' });
  assert.equal(state.scene, 'ember');
  controller.close();
});

test('a name longer than the renderer keeps is refused, not silently shortened', () => {
  // theme-renderer.cjs cuts a name to 60 characters before it reaches the DOM. Accepting 61 here
  // would mean the saved theme and the shown theme disagree, so the cap is enforced at the source.
  const controller = new ThemeController({ directory: scratch() });
  const sixty = 'n'.repeat(60);
  assert.equal(controller.setTheme({ name: sixty }).name, sixty);
  assert.throws(() => controller.setTheme({ name: 'n'.repeat(61) }), /at most 60 characters/);
  controller.close();
});
