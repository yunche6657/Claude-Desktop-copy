'use strict';

const fs = require('node:fs');
const path = require('node:path');

const optionsWithValue = new Set([
  '--test-name-pattern', '--test-skip-pattern', '--test-reporter',
  '--test-reporter-destination', '--test-timeout', '--test-concurrency',
  '--test-shard', '--test-isolation', '--test-rerun-failures',
  '--test-global-setup', '--test-coverage-include', '--test-coverage-exclude',
  '--test-coverage-lines', '--test-coverage-branches', '--test-coverage-functions',
]);

function createTestRunPlan(root, requested, batchSize = 100) {
  const options = [];
  const files = [];
  let literal = false;
  for (let i = 0; i < requested.length; i++) {
    const value = requested[i];
    if (!literal && value === '--') { literal = true; continue; }
    if (!literal && value.startsWith('-')) {
      options.push(value);
      if (optionsWithValue.has(value)) {
        if (i + 1 >= requested.length) throw new Error(`Missing value for ${value}`);
        options.push(requested[++i]);
      }
    } else files.push(value);
  }
  const missing = files.filter(value => !/[*?\[\]{}]/.test(value) && !fs.existsSync(path.resolve(root, value)));
  if (missing.length) throw new Error('Requested test path not found: ' + missing.join(', '));
  const tests = files.length ? files : fs.readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
  const batches = [];
  for (let i = 0; i < tests.length; i += batchSize) batches.push(tests.slice(i, i + batchSize));
  return { options, tests, batches };
}

module.exports = { createTestRunPlan };
