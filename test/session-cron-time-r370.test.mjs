import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actual = require('../desktop/session-cron-time.cjs');
const sourcePath = new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const parser = source.slice(source.indexOf('function Y2('), source.indexOf('function xra('));
const next = source.slice(source.indexOf('function kra('), source.indexOf('function Ara('));
assert.ok(parser.startsWith('function Y2(') && parser.includes('function e4('));
assert.ok(next.startsWith('function kra('));

function reference(now) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return +now; }
  }
  return vm.runInNewContext(`${parser}\n${next}\n({Y2,hra,e4,kra})`, { Date: FixedDate });
}

test('original parser, validation and matching differential', () => {
  const ref = reference(new Date('2026-01-01T00:00:00Z'));
  const expressions = [
    '* * * * *', '*/7 0-23/3 1-31/2 */2 0,7', '4 5 13 * 1', '4 5 */2 * 1',
    '0 0 * * 7', '0 0 * * 0', '1/5 3/4 * * *', '0 0 31 2 *',
    '60 0 * * *', '5abc 0 * * *', '*/0 * * * *', '1-2-3 * * * *',
    '*/2/3 * * * *', ',1 * * * *', '1,,2 * * * *', '3-1 * * * *',
    'a * * * *', '0 0 * * 8', '0 0 * * 1,7',
  ];
  for (const expression of ['1 2 3 4', '']) {
    assert.equal(actual.validateCron(expression), ref.hra(expression), expression);
    assert.throws(() => actual.parseCron(expression), /expected 5 fields/);
  }
  for (const expression of expressions) {
    assert.equal(actual.validateCron(expression), ref.hra(expression), expression);
    assert.deepEqual(actual.parseCron(expression), { ...ref.Y2(expression) });
    for (let i = 0; i < 200; i++) {
      const date = new Date(Date.UTC(2025, 0, 1) + i * 157323000);
      assert.equal(actual.matchCron(expression, date), ref.e4(ref.Y2(expression), date), `${expression} ${date.toISOString()}`);
    }
  }
});

test('next run agrees with original across time zones and DST transitions', () => {
  const originalTZ = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = tz;
      for (const [expression, time] of [
        ['* * * * *', '2026-03-08T09:59:59.999Z'],
        ['30 2 * * *', '2026-03-08T09:59:00Z'],
        ['30 1 * * *', '2026-11-01T08:31:00Z'],
        ['0 0 13 * 1', '2026-10-28T09:34:15Z'],
        ['0 0 29 2 *', '2026-03-01T00:00:17.123Z'],
        ['60 * * * *', '2026-01-01T00:00:17.123Z'],
      ]) {
        const now = new Date(time);
        assert.equal(+actual.nextCronTime(expression, now), +reference(now).kra(expression), `${tz} ${expression}`);
      }
    }
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
});
