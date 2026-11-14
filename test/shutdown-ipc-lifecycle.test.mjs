import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');

function lifecycle() {
  const handlers = new Map();
  const calls = [];
  let ipcAvailable = true;
  const sandbox = {
    app: { on: (name,fn)=>handlers.set(name,fn) },
    tray: { dispose: ()=>calls.push('tray') },
    detachServices: ()=>calls.push('detach'),
    bridge: { disposeShells() {}, flushKernel: ()=>calls.push('flush'), dispose: ()=>{ipcAvailable=false;calls.push('dispose');} },
    consent: null, bus: { dispose: ()=>calls.push('bus') }, server: null,
    ccbRuntime: { stop: () => { calls.push('ccb-stop'); return Promise.resolve(); } },
    bootstrapAuthAbort: { abort: () => calls.push('auth-abort') }, bootstrapAuthGeneration: 0,
    hybridLogin: { invalidate: () => calls.push('login-invalidate') },
    hybridOidcSession: { invalidate: () => calls.push('hybrid-invalidate') },
    cliMcpGateSource: { dispose: () => calls.push('cli-gate-dispose') },
    mainFeatures: { dispose: () => calls.push('features-dispose') },
    cliGovernor: { stop: () => calls.push('governor-stop') },
    cliProtectionClock: { stop: () => calls.push('protection-clock-stop') },
    previewActivation: { dispose: () => calls.push('activation-dispose') },
    ownedCcbBackends: new Set([{ dispose: () => { calls.push('backend-dispose'); return Promise.resolve(); } }]),
  };
  // Execute the real production handlers against a small app lifecycle double.
  vm.runInNewContext(main.slice(main.indexOf("app.on('before-quit'")), sandbox);
  return { handlers, calls, available: ()=>ipcAvailable };
}

test('the renderer can finish its final IPC calls after before-quit flushes persistence', () => {
  const h = lifecycle();
  h.handlers.get('before-quit')();
  assert.ok(h.calls.includes('flush'));
  assert.equal(h.available(), true, 'before-quit removed handlers while the renderer still exists');
});

test('IPC is disposed after window teardown and after the persistence flush', () => {
  const h = lifecycle();
  h.handlers.get('before-quit')();
  h.handlers.get('will-quit')();
  assert.equal(h.available(), false);
  assert.ok(h.calls.indexOf('dispose') > h.calls.indexOf('flush'));
  assert.ok(h.calls.includes('detach') && h.calls.includes('bus'));
  assert.ok(h.calls.includes('ccb-stop'));
  assert.ok(h.calls.includes('features-dispose'));
  assert.ok(h.calls.indexOf('cli-gate-dispose') < h.calls.indexOf('features-dispose'));
  assert.ok(h.calls.includes('hybrid-invalidate')); 
  assert.ok(h.calls.includes('protection-clock-stop'));
  assert.ok(h.calls.indexOf('protection-clock-stop') > h.calls.indexOf('flush'));
  assert.ok(h.calls.includes('governor-stop') && h.calls.includes('activation-dispose') && h.calls.includes('backend-dispose'));
  assert.ok(h.calls.indexOf('backend-dispose') > h.calls.indexOf('flush'));
});
