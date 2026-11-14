'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { createTestRunPlan } = require('./test-run-plan.cjs');
let plan;
try {
  plan = createTestRunPlan(root, process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  return;
}
const { tests, batches, options } = plan;
const preload = path.join(__dirname, 'test-no-console.cjs');
const env = { ...process.env };
if (process.platform === 'win32') {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim();
}

/**
 * ONE `node --test` INVOCATION SILENTLY STOPS AFTER ABOUT 478 FILES, AND EVERY "FULL SUITE" REPORT WAS SHORT.
 *
 * MEASURED (R542)
 *   Passing all 734 test paths to a single `node --test --test-concurrency=2` run executed only the first 478 in
 *   alphabetical order and then exited 0. Nothing in stdout said so: the last line was a passing test, there was no
 *   summary, and the exit code was 0.
 *
 *     all 734 in one run                     2615 tests   (stops after packaging-signals.test.mjs, index 478)
 *     files 0..477                            2615 tests
 *     files 478..733                          1407 pass, 25 fail, 1432 total
 *     declared test() calls across all files  4026
 *
 *   2615 is exactly the cumulative declaration count of the first 478 files, which is what identified the cut as a
 *   PREFIX rather than lost output: the run covered 65% of the suite.
 *
 *   So every "0 failing, N passing" report this repository produced was about 65% of its tests, and the 256 files
 *   never executed include 25 REAL failures that reproduce when run alone (selfmatch-baseline-r522, test-hygiene,
 *   tool-absence-r500, tool-relation-r493, unparsed-candidates-r529, websearch-count-r430).
 *
 * FIX: ONE CHILD PROCESS PER BATCH, AND EVERY BATCH MUST EXIT 0
 *   A first attempt spawned batches sequentially from THIS process and still stopped at 2615: the ceiling is per
 *   PROCESS, not per invocation, and the parent was the one accumulating. Measured again with each batch in its own
 *   OS process: 1192 + 997 + 1126 + 736 = 4051 executions, 4028 distinct names, 26 failures — matching the 4026
 *   declarations plus a few dynamically generated tests.
 *
 *   `BATCH = 100` stays far below the observed ceiling even if every file were dense with tests. Each batch announces
 *   itself, a non-zero exit from ANY batch makes the run non-zero, and the final line reports how many failed. A
 *   regression that drops a batch appears as a missing "batch k/n" line rather than as a quietly smaller pass count.
 */
const argv = ['--test', '--test-concurrency=2', '--test-timeout=60000', ...options];

function runBatch(batch, index) {
  return new Promise((resolve) => {
    if (batches.length > 1) console.error(`[run-tests] batch ${index + 1}/${batches.length} — ${batch.length} files`);
    const child = spawn(process.execPath, [...argv, ...batch],
      { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', (error) => { console.error(error.message); resolve(1); });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let completedBatches = 0;
let finished = false;
let worst = 0;
// An unresolved Promise alone does not keep Node alive. If lifecycle events
// disappear, fail closed instead of letting a partial run inherit exit 0.
process.once('exit', () => {
  if (!finished) {
    console.error(`[run-tests] incomplete run: ${completedBatches}/${batches.length} batches completed`);
    process.exitCode = worst || 1;
  }
});

(async () => {
  for (let i = 0; i < batches.length; i += 1) {
    const code = await runBatch(batches[i], i);
    if (code !== 0) worst = code;
    completedBatches += 1;
    process.exitCode = worst;
  }
  finished = true;
  if (batches.length > 1) {
    console.error(`[run-tests] ${batches.length} batch(es), ${tests.length} files, exit ${worst}`);
  }
  process.exitCode = worst;
})();
