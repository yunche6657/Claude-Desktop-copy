import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyAttendance, warmUnattended } = require('../desktop/session-attendance.cjs');
const reference = 'C:/Users/Administrator/Desktop/注册号 逆向/ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js';

function chain(length, tail = {}) {
  const nodes = new Map();
  for (let i = 0; i < length; i++) nodes.set(i, i === length - 1 ? tail : { dispatchParentId: i + 1 });
  return nodes;
}

const cases = [
  ['missing', new Map(), 'unresolvable', true],
  ['plain', new Map([[0, {}]]), 'plain', false],
  ['routine', new Map([[0, { scheduledTaskId: 'T' }]]), 'routine', true],
  ['continued', new Map([[0, { scheduledTaskId: 'T', scheduledRunContinued: true }]]), 'routineContinued', true],
  ['continued without routine', new Map([[0, { scheduledRunContinued: true }]]), 'plain', false],
  ['missing parent', new Map([[0, { dispatchParentId: 1 }]]), 'dispatchedHere', false],
  ['routine missing parent', new Map([[0, { scheduledTaskId: 'T', dispatchParentId: 1 }]]), 'unresolvable', true],
  ['orphan', new Map([[0, { dispatchParentOrigin: 'local' }]]), 'orphan', true],
  ['routine orphan', new Map([[0, { scheduledTaskId: 'T', dispatchParentOrigin: 'local' }]]), 'unresolvable', true],
  ['remote priority', new Map([[0, { scheduledTaskId: 'T', dispatchParentId: 1, dispatchParentOrigin: 'remote' }]]), 'remoteDispatched', true],
  ['ancestor continued', new Map([[0, { dispatchParentId: 1 }], [1, { scheduledTaskId: 'T', scheduledRunContinued: true }]]), 'routineContinued', true],
  ['17 nodes', chain(17), 'plain', false],
  ['18 nodes', chain(18), 'unresolvable', true],
  ['cycle', new Map([[0, { dispatchParentId: 0 }]]), 'unresolvable', true],
  ['null task counts', new Map([[0, { scheduledTaskId: null }]]), 'routine', true],
  ['null origin counts', new Map([[0, { dispatchParentOrigin: null }]]), 'orphan', true],
  ['null parent counts', new Map([[0, { dispatchParentId: null }]]), 'dispatchedHere', false],
];

test('reference attendance classifications and warm predicate', () => {
  for (const [name, nodes, expected, unattended] of cases) {
    const get = id => nodes.get(id);
    assert.equal(classifyAttendance(0, get), expected, name);
    assert.equal(warmUnattended(0, get), unattended, name);
  }
  assert.equal(warmUnattended(undefined, () => { throw Error('unexpected lookup'); }), false);
});

test('differential against extracted reference functions', { skip: !fs.existsSync(reference) }, () => {
  const source = fs.readFileSync(reference, 'utf8');
  const start = source.indexOf('var DHa=16;function $5(e,t)');
  const end = source.indexOf('var PHa=', start);
  assert.ok(start >= 0 && end > start, 'reference attendance functions found');
  const original = vm.runInNewContext(`${source.slice(start, end)};({ classify: $5, unattended: NHa })`);
  for (const [name, nodes] of cases) {
    const get = id => nodes.get(id);
    assert.equal(classifyAttendance(0, get), original.classify(0, get), name);
    assert.equal(warmUnattended(0, get), original.unattended(0, get), name);
  }
  // Additional combinations exercise exact undefined/null/truthiness behavior.
  const values = [undefined, null, '', 'local', 'remote'];
  for (const task of values) for (const continued of [undefined, false, true, 1])
    for (const origin of values) for (const parent of [undefined, null, 1]) {
      const nodes = new Map([[0, { scheduledTaskId: task, scheduledRunContinued: continued, dispatchParentOrigin: origin, dispatchParentId: parent }], [1, {}]]);
      const get = id => nodes.get(id);
      assert.equal(classifyAttendance(0, get), original.classify(0, get), JSON.stringify({ task, continued, origin, parent }));
      assert.equal(warmUnattended(0, get), original.unattended(0, get));
    }
});
