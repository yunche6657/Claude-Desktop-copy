import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveIdleTimeout } = require('../desktop/session-idle-policy.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = path.join(root, '..', 'ccd-ref', 'asar', '.vite', 'build', 'index.chunk-Bn6onBlX.js');
let match;
function original(unattended, value, calls) {
  const context = { t: { zZ: (key, fallback) => { calls.push([key, fallback]); return value; } } };
  return vm.runInNewContext(`${match[0]}; ap(${unattended ? 'true' : 'false'} === true ? {unattended:true} : {unattended:false})`, context);
}

test('policy matches extracted original across types and numeric boundaries', { skip: !fs.existsSync(reference) ? 'reference artifact is absent' : false }, () => {
  match = fs.readFileSync(reference, 'utf8').match(/var np=9e5,rp=6e4,ip=2\*\*31-1;function ap\(e\)\{[^}]+\}/);
  assert.ok(match, 'original ap must be extracted from the reference artifact');
  const values = [undefined, null, false, true, '', '60000', {}, [], NaN, -Infinity, Infinity,
    -1, -0, 0, Number.MIN_VALUE, 0.49, 0.5, 59999, 60000, 60000.4, 60000.5,
    2147483646.4, 2147483646.5, 2147483647, 2147483648, Number.MAX_VALUE];
  for (const unattended of [false, true]) for (const value of values) {
    const refCalls = [], calls = [];
    const expected = original(unattended, value, refCalls);
    const actual = resolveIdleTimeout({ unattended }, (key, fallback) => { calls.push([key, fallback]); return value; });
    assert.equal(actual, expected, `unattended=${unattended}, value=${String(value)}`);
    assert.deepEqual(calls, refCalls);
  }
});

test('default reader returns zero; unattended never reads; reader errors propagate', () => {
  assert.equal(resolveIdleTimeout({ unattended: false }), 0);
  assert.equal(resolveIdleTimeout({ unattended: true }, () => { throw new Error('unexpected read'); }), 900000);
  assert.throws(() => resolveIdleTimeout({ unattended: false }, () => { throw new Error('reader error'); }), /reader error/);
});
