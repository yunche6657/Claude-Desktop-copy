// R404: ScheduleWakeup needs a /loop subsystem that CCB does not have.
//
// THE MISPREDICTION THIS CORRECTS
//   R403's handoff guessed this tool would be "mechanism present, entry point missing" like
//   ProposeGoal and RefreshMcpTools, because CCB has SleepTool and CronCreate/Delete/List.
//   Investigating first showed the opposite: the thing this tool drives does not exist.
//
//   The official `prompt` field's own doc says: "The /loop input to fire on wake-up. Pass the
//   same /loop input verbatim each turn so the next firing re-enters the skill". So the tool's
//   job is to keep a loop alive across turns. Measured:
//
//     wakeup / Wakeup / dynamicLoop / autonomous-loop in src+packages (excl tests) -> 0 hits
//     src/commands/loop                                                          -> absent
//     SleepTool    = blocking wait inside the current turn (duration_seconds)
//     CronCreate   = 5-field cron, minute granularity, recurring/one-shot flag
//
//   Neither is a substitute: one waits in-turn, the other is a schedule rule rather than a
//   stateful turn-spanning loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test('CCB has no wakeup or dynamic-loop implementation at all', () => {
  // The blocker, stated as a measurement. If this ever finds something, the verdict changes.
  const files = [...walk(path.join(SRC, 'src')), ...walk(path.join(SRC, 'packages'))];
  assert.ok(files.length > 500, 'expected a large source tree, got ' + files.length + ' files');

  const pattern = /wakeup|dynamicLoop|dynamic-loop|autonomous-loop/i;
  const hits = files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => path.relative(SRC, f)), [],
    'a wakeup/dynamic-loop implementation appeared: ScheduleWakeup may now be implementable, '
    + 'so revisit this blocker instead of leaving the test green');
});

test('there is no /loop command for the wakeup to re-enter', () => {
  const commandsDir = path.join(SRC, 'src', 'commands');
  assert.ok(fs.existsSync(commandsDir), 'the commands directory moved');
  const dirs = fs.readdirSync(commandsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(!dirs.includes('loop'),
    'a /loop command appeared: the official `prompt` field now has a target, revisit the blocker');
  assert.ok(!dirs.includes('wakeup'),
    'a /wakeup command appeared: revisit the blocker');

  // Contrast: the commands that DO exist, so the assertion is not vacuous.
  assert.ok(dirs.includes('goal'), 'the goal command vanished, so the tree looks wrong');
  assert.ok(dirs.includes('schedule'), 'the schedule command vanished');
});

test('SleepTool waits inside the turn and is not a wakeup substitute', () => {
  const p = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'SleepTool', 'SleepTool.ts');
  assert.ok(fs.existsSync(p), 'SleepTool is gone; re-derive the comparison');
  const src = fs.readFileSync(p, 'utf8');
  // duration_seconds + interruptible = an in-turn pause, not a scheduled future turn.
  assert.match(src, /duration_seconds/, 'SleepTool no longer takes duration_seconds');
  assert.match(src, /interruptBehavior\(\)\s*\{\s*return 'cancel'/, 'SleepTool lost its interrupt behaviour');
  // A wakeup would have to persist a schedule; SleepTool has no such field.
  assert.ok(!/scheduledFor|delaySeconds/.test(src),
    'SleepTool grew scheduling fields: re-derive whether it can serve as a wakeup');
});

test('CronCreate cannot express a relative second-level delay', () => {
  // Four contract differences; the two structural ones are stop/noop.
  const p = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'ScheduleCronTool', 'CronCreateTool.ts');
  assert.ok(fs.existsSync(p), 'CronCreateTool is gone; re-derive the comparison');
  const src = fs.readFileSync(p, 'utf8');

  assert.match(src, /cron: z/, 'CronCreate no longer takes a cron expression');
  assert.match(src, /Standard 5-field cron expression in local time/,
    'the cron granularity description changed');
  // Note `.test(src)`: `assert.ok(!/delaySeconds/)` negates the RegExp OBJECT, which is always
  // truthy, so the assertion could never fail. That typo made this test report a false positive.
  assert.ok(!/delaySeconds/.test(src),
    'CronCreate gained a relative delay, so the comparison needs redoing');
  // stop/noop describe a stateful turn-spanning loop; cron describes a rule.
  assert.ok(!/cancelledWakeups/.test(src), 'CronCreate gained wakeup cancellation semantics');
  assert.ok(!/noop/.test(src), 'CronCreate gained the noop streak concept');
});

test('the tool is still absent from the bundle', () => {
  const dist = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
  const tableFile = fs.readdirSync(dist)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(dist, n)).size < 20_000_000)
    .find((n) => fs.readFileSync(path.join(dist, n), 'utf8').includes('function getAllBaseTools()'));
  assert.ok(tableFile, 'the tool table is missing');
  const table = fs.readFileSync(path.join(dist, tableFile), 'utf8');
  assert.ok(!table.includes('ScheduleWakeupTool'),
    'ScheduleWakeupTool is registered: §2 was implemented, update the worklist and this file');
  // Contrast with the two additions that DID happen, so the count in R393 stays meaningful.
  assert.ok(table.includes('ProposeGoalTool') && table.includes('RefreshMcpToolsTool'),
    'an earlier addition vanished');
});
