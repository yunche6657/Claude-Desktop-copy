import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { createWindowState } = createRequire(import.meta.url)('../desktop/window-state.cjs');

async function fixture(seed, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccd-window-test-'));
  const file = path.join(dir, 'window-state.json');
  if (seed !== undefined) await fs.writeFile(file, seed);
  const app = { getPath: name => { assert.equal(name, 'userData'); return dir; } };
  const errors = [];
  const manager = await createWindowState({ app, onError: e => errors.push(e), ...options });
  return { dir, file, manager, errors, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
class WindowMock extends EventEmitter {
  constructor(bounds = { x: 4, y: 8, width: 1400, height: 900 }) { super(); this.bounds = bounds; this.max = false; this.full = false; this.min = false; this.destroyed = false; }
  getBounds() { return this.bounds; }
  isMaximized() { return this.max; }
  isFullScreen() { return this.full; }
  isMinimized() { return this.min; }
  isDestroyed() { return this.destroyed; }
  maximize() { this.max = true; }
  setFullScreen(value) { this.full = value; }
}

test('reads and validates persisted bounds, defaults, and fullscreen state', async () => {
  for (const [seed, expected] of [
    ['bad json', { width: 1200, height: 800 }],
    [JSON.stringify({width: -1, height: 600}), {width:1200,height:800}],
    [JSON.stringify({width: 1400,height: 900,x: 5,y: -20,isMaximized:true}), {x:5,y:-20,width:1400,height:900}],
    [JSON.stringify({width: 0,height: 5,x: 5,y: 6,isFullScreen:true}), {width:1200,height:800}],
    [JSON.stringify({width: 700,height: 600,x: 5,y: 1.1}), {width:700,height:600}],
  ]) {
    const f = await fixture(seed);
    try { assert.deepEqual(f.manager.getOptions(), expected); } finally { await f.cleanup(); }
  }
  const f = await fixture(JSON.stringify({width:1300,height:800,isMaximized:true,isFullScreen:true,displayBounds:{x:0,y:0,width:1920,height:1080}}));
  try { const w = new WindowMock(); f.manager.manage(w); assert.equal(w.max,true); assert.equal(w.full,true); assert.deepEqual(f.manager.getState().displayBounds,{x:0,y:0,width:1920,height:1080}); } finally { f.manager.unmanage(); await f.cleanup(); }
});

test('events debounce and close flushes latest geometry; maximized retains normal bounds', async () => {
  const pending = new Map(); let id = 0;
  const timers = { setTimeout(fn) { pending.set(++id, fn); return id; }, clearTimeout(id) { pending.delete(id); } };
  const screen = { getDisplayMatching: () => ({bounds:{x:0,y:0,width:1920,height:1080}}) };
  const f = await fixture(undefined, {timers, screen});
  try {
    const w = new WindowMock(); f.manager.manage(w);
    w.emit('move'); w.bounds = {x:10,y:20,width:1500,height:900}; w.emit('resize');
    assert.equal(pending.size, 1);
    w.emit('close'); await f.manager.flush();
    assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')), {...w.bounds,isMaximized:false,isFullScreen:false,displayBounds:{x:0,y:0,width:1920,height:1080}});
    w.max = true; w.bounds = {x:0,y:0,width:1920,height:1080}; w.emit('maximize'); await f.manager.flush();
    const saved = JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.equal(saved.width, 1500); assert.equal(saved.isMaximized, true);
  } finally { f.manager.unmanage(); await f.cleanup(); }
});

test('discard waits for in-flight write then removes file and detaches without resizing', async () => {
  let release, started;
  const active = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const io = { ...fs, async writeFile(...args) { started(); await gate; return fs.writeFile(...args); } };
  const f = await fixture(undefined, {fs:io});
  try {
    const w = new WindowMock(); f.manager.manage(w); w.emit('resize');
    const saving = f.manager.flush(); await active;
    const discard = f.manager.discard();
    assert.deepEqual(f.manager.getOptions(), {width:1200,height:800});
    assert.equal(w.listenerCount('resize'),0); assert.equal(w.bounds.width,1400);
    release(); await saving; await discard;
    await assert.rejects(fs.access(f.file), {code:'ENOENT'});
  } finally { await f.cleanup(); }
});

test('reset deletes flag first, tolerates failure, and discards file without touching other store fields', async () => {
  const calls=[];
  const f = await fixture(JSON.stringify({width:900,height:700}), {deleteSignedInFlag: async () => { calls.push('flag'); throw Error('store failure'); }});
  try { await f.manager.reset(); assert.deepEqual(calls,['flag']); assert.equal(f.errors.length,1); await assert.rejects(fs.access(f.file), {code:'ENOENT'}); assert.deepEqual(f.manager.getOptions(),{width:1200,height:800}); } finally { await f.cleanup(); }
});


test('disabling presentation restoration still binds and saves window events', async () => {
  const f = await fixture(JSON.stringify({width:1300,height:800,isMaximized:true,isFullScreen:true}));
  try {
    const w = new WindowMock();
    f.manager.manage(w, { restorePresentation: false });
    assert.equal(w.max, false);
    assert.equal(w.full, false);
    assert.equal(w.listenerCount('resize'), 1);
    w.emit('resize');
    await f.manager.flush();
    const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.equal(saved.width, 1400);
    assert.equal(saved.isMaximized, false);
    assert.equal(saved.isFullScreen, false);
  } finally { f.manager.unmanage(); await f.cleanup(); }
});

// Compare against the extracted shipped functions, executed in a separate VM.
test('display placement matches shipped algorithm across display changes', async t => {
  const vm = await import('node:vm');
  const sourcePath = path.resolve('..', 'ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js');
  let source;
  try { source = await fs.readFile(sourcePath, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return t.skip('shipped reference bundle is unavailable');
    throw e;
  }
  const extract = name => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing original ${name}`);
    const open = source.indexOf('{', start); let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw Error(`unclosed original ${name}`);
  };
  const original = ['Jbe','Xbe','Zbe','Qbe','rSe','iSe','aSe','oSe','sSe'].map(extract).join('\n');
  const { placeOnDisplays } = createRequire(import.meta.url)('../desktop/window-state.cjs');
  const display = (x, y, width, height, workArea = {x, y, width, height}) => ({bounds:{x,y,width,height}, workArea});
  const primary = display(0, 0, 1920, 1080, {x:0,y:0,width:1920,height:1040});
  const right = display(1920, 0, 1920, 1080, {x:1920,y:0,width:1920,height:1040});
  const left = display(-1920, 0, 1920, 1080, {x:-1920,y:40,width:1920,height:1040});
  const saved = {x:3840,y:0,width:1920,height:1080};
  const base = {x:4000,y:40,width:1000,height:800,isMaximized:true,isFullScreen:false,displayBounds:saved};
  const cases = [
    [{width:1200,height:800,isMaximized:false}, [primary], primary],
    [{...base, displayBounds:right.bounds, x:1700, y:-20, width:2200, height:1400}, [primary,right], right],
    [{...base, x:1850, y:100}, [primary,right], right],
    [base, [primary,right], right],
    [{...base, displayBounds:{x:0,y:0,width:1600,height:900}}, [primary,right], primary],
    [{...base, displayBounds:{x:0,y:0,width:1600,height:900}, width:4000,height:3000}, [primary], primary],
    [{...base, x:-5000, displayBounds:{x:0,y:0,width:1920,height:1080}}, [left,right], left],
    [{...base, x:1920+1920, displayBounds:undefined}, [primary,right], primary],
    [{...base, x:1919, y:100, displayBounds:undefined}, [primary,right], right],
  ];
  for (const [state, displays, matching] of cases) {
    const screen = { getAllDisplays: () => displays, getPrimaryDisplay: () => primary, getDisplayMatching: () => matching };
    const context = vm.createContext({a:{screen}, N:{info(){}}});
    const expected = vm.runInContext(`${original}\nrSe(${JSON.stringify(state)})`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(placeOnDisplays(state, screen))), JSON.parse(JSON.stringify(expected)));
  }
});

test('manager places saved frame and retains presentation restoration', async () => {
  const bounds = {x:0,y:0,width:1280,height:720};
  const screen = {getAllDisplays:()=>[{bounds,workArea:bounds}],getPrimaryDisplay:()=>({bounds,workArea:bounds}),getDisplayMatching:()=>({bounds,workArea:bounds})};
  const f = await fixture(JSON.stringify({x:4000,y:50,width:1500,height:900,isMaximized:true}), {screen});
  try {
    f.manager.placeOnDisplays();
    assert.deepEqual(f.manager.getOptions(), {x:0,y:0,width:1280,height:720});
    const w = new WindowMock(); f.manager.manage(w, {restorePresentation:false});
    assert.equal(w.max,false);
  } finally { f.manager.unmanage(); await f.cleanup(); }
});
