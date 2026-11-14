import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const { createKeepAwakeClaims } = createRequire(import.meta.url)('../desktop/keep-awake-claims.cjs');

test('shared keep-awake claims track fixed original across managed gate transitions', () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const start = source.indexOf('var oV=new Set,sV=null;function vCr(');
  const end = source.indexOf('var bCr="keepAwakeEnabled"', start);
  assert.ok(start >= 0 && end > start);
  function harness(original) {
    let allowed = true, next = 0;
    const actions = [];
    const blocker = { start(type) { actions.push(['start', type]); return ++next; }, stop(id) { actions.push(['stop', id]); } };
    const beforeStop = () => actions.push(['beforeStop']);
    let api;
    if (original) {
      const ctx = { a: { powerSaveBlocker: blocker }, $B: () => allowed, fKe: beforeStop, N: { info() {} } };
      api = vm.runInNewContext(source.slice(start, end) + ';({claim:cV,release:lV,reconcile:vCr,isBlocking:yCr})', ctx);
    } else api = createKeepAwakeClaims({ powerSaveBlocker: blocker, isAllowed: () => allowed, beforeStop });
    return { api, actions, setAllowed(value) { allowed = value; } };
  }
  const reference = harness(true), replica = harness(false);
  for (const h of [reference, replica]) {
    h.api.claim('manual'); h.api.claim('turn'); h.api.claim('turn');
    h.api.release('manual'); h.setAllowed(false); h.api.reconcile();
    h.api.claim('other'); h.setAllowed(true); h.api.reconcile();
    h.api.release('turn'); h.api.release('missing'); h.api.release('other');
    assert.equal(h.api.isBlocking(), false);
  }
  assert.deepEqual(replica.actions, reference.actions);
  assert.deepEqual(replica.actions, [['start','prevent-app-suspension'], ['beforeStop'], ['stop',1], ['start','prevent-app-suspension'], ['beforeStop'], ['stop',2]]);
});
