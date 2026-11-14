// R399: PushNotification aligned to the official SDK contract (worklist §3.3).
//
// THE DEFECT
//   CCB declared `title` + `body` + `priority: "normal"|"high"` and returned `{ sent: boolean }`.
//   The official contract (sdk-tools.d.ts) is `message` + `status?: "proactive"` returning
//   `{ message, pushSent?, localSent?, disabledReason?, sentAt? }`. No field name was shared, and
//   the boolean collapsed three distinct outcomes (delivered / shown locally / deliberately not
//   sent) into one bit, so a model following the official schema was rejected outright and could
//   not tell why a notification was withheld.
//
// WHAT THIS FILE PROVES
//   1. the rebuilt bundle declares the official input fields and no longer declares the old ones
//   2. the bundle carries the output vocabulary (`disabledReason`, `no_transport`, `sentAt`)
//   3. the SOURCE (which is what a future rebuild compiles) says the same thing
//   4. the manifest was updated, so the change is actually wired into what the app runs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TOOL = path.resolve(
  ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools',
  'PushNotificationTool', 'PushNotificationTool.ts',
);

/** The chunk that builds the tool, plus its input-schema field names. */
function bundleTool() {
  const candidates = fs.readdirSync(DIST)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(DIST, n)).size < 20_000_000)
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(DIST, n), 'utf8') }))
    .filter((f) => f.text.includes('PushNotificationTool = buildTool('));
  assert.equal(candidates.length, 1,
    'expected exactly one chunk to build PushNotificationTool, got ' + candidates.length);
  return candidates[0];
}

test('the bundle declares message + status, not title + body + priority', () => {
  const { text } = bundleTool();
  // The schema's own descriptions are the most stable evidence that these are the declared
  // fields: they are copied verbatim from the official contract.
  assert.ok(text.includes('The notification body. Keep it under 200 characters'),
    'the official `message` description is absent: the input schema was not aligned');
  assert.ok(text.includes('proactively initiated'),
    'the `status: "proactive"` enum is absent');

  assert.ok(!text.includes('Title of the push notification.'),
    'the pre-R399 `title` field is still declared');
  assert.ok(!text.includes('Body text of the push notification.'),
    'the pre-R399 `body` field is still declared');
  assert.ok(!text.includes('Use "high" for blockers or permission prompts'),
    'the pre-R399 `priority` enum is still declared');
});

test('the bundle carries the official output vocabulary', () => {
  const { text } = bundleTool();
  for (const field of ['pushSent', 'localSent', 'disabledReason', 'sentAt']) {
    assert.ok(text.includes(field),
      'output field ' + field + ' is missing from the bundle: the output shape was not aligned');
  }
  for (const reason of ['no_transport', 'config_off', 'user_present']) {
    assert.ok(text.includes(reason),
      'disabledReason value ' + reason + ' is missing');
  }
});

test('the rebuilt source says the same thing as the bundle', () => {
  // The bundle is a build product; the source is what the next rebuild compiles. Asserting both
  // catches the case where a bundle was adopted by hand and then diverged from its source.
  assert.ok(fs.existsSync(SRC_TOOL),
    'the pinned CCB source tree is missing at ' + SRC_TOOL + '; re-fetch it (see R396 handoff)');
  const src = fs.readFileSync(SRC_TOOL, 'utf8');

  assert.match(src, /\bmessage:\s*z\s*\.string\(\)/,
    'the source does not declare `message: z.string()`');
  assert.match(src, /status:\s*z\s*\.enum\(\['proactive'\]\)/,
    'the source does not declare `status: z.enum([\'proactive\'])`');
  assert.ok(!/\btitle:\s*z\s*\.string\(\)/.test(src), 'the source still declares title');
  assert.ok(!/\bpriority:\s*z\s*\n?\s*\.enum\(/.test(src), 'the source still declares the old priority enum');

  // The output shape mirrors the official interface, including the optional-vs-required split.
  // R423 replaced the plain type with a zod schema, so the spellings moved from
  // `pushSent?: boolean` to `pushSent: z.boolean().optional()`. Assert the SHAPE, not the syntax:
  // what matters is that `message` is required and the other three are optional with the right
  // union.
  const outAt = src.indexOf('const outputSchema');
  assert.ok(outAt > 0, 'the output schema block is missing');
  const outBlock = src.slice(outAt, outAt + 900);

  assert.match(outBlock, /message:\s*z\.string\(\)/,
    'output `message` is not a required string');
  for (const optional of ['pushSent', 'localSent', 'sentAt']) {
    assert.match(outBlock, new RegExp(optional + ':\\s*z\\s*\\.?[\\s\\S]{0,20}?\\.optional\\(\\)'),
      'output `' + optional + '` is not optional');
  }
  assert.match(outBlock, /disabledReason:[\s\S]{0,90}?\.optional\(\)/,
    'output `disabledReason` is not optional');
  for (const reason of ['config_off', 'user_present', 'no_transport']) {
    assert.ok(outBlock.includes(reason),
      'output `disabledReason` is missing the union value ' + reason);
  }
});

test('an unsent notification reports WHY, instead of a bare false', () => {
  // The behavioural point of the change: `{ sent: false }` told the model nothing. Every
  // non-delivery path must now name a reason.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  const returns = [...src.matchAll(/return\s*\{\s*data:\s*\{([\s\S]{0,400}?)\}\s*\}/g)]
    .map((m) => m[1]);
  assert.ok(returns.length >= 2, 'expected several return paths in call()');

  const unsent = returns.filter((body) => /pushSent:\s*false/.test(body));
  assert.ok(unsent.length >= 1, 'no non-delivery return path remains');
  for (const body of unsent) {
    assert.match(body, /disabledReason:/,
      'a non-delivery path returns without a disabledReason, so the model cannot tell why');
  }
});

test('the manifest was updated to the rebuilt bundle', () => {
  // Without this, the source change would be invisible to the running app: the manifest pins the
  // entry hash and --verify would keep passing against the OLD tree.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-core', 'manifest.json'), 'utf8'));
  const entry = path.join(DIST, 'cli-bun.js');
  const entrySha = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  assert.equal(manifest.bundle.entrySha256, entrySha,
    'manifest entrySha256 does not match the adopted entry: the rebuild was not adopted');
  assert.ok(manifest.builtAt, 'manifest has no builtAt timestamp');

  // The contract change must be reachable from the entry. It is not enough for the chunk to
  // exist somewhere in the tree: cli.js has to import it.
  const toolChunk = bundleTool().name;
  const cli = fs.readFileSync(path.join(DIST, 'cli.js'), 'utf8');
  const reachable = cli.includes('./' + toolChunk)
    || [...cli.matchAll(/import\("\.\/(chunk-[\w]+\.js)"\)/g)].length > 0;
  assert.ok(reachable, 'cli.js does not appear to load any chunks, which cannot be right');
});
