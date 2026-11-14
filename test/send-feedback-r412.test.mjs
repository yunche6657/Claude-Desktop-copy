// R412: SendFeedback implemented — the last doable item in §2.
//
// WHAT MADE IT POSSIBLE
//   CCB already had a real submission path: submitFeedback() posted to
//   https://api.anthropic.com/api/claude_cli_feedback with OAuth refresh, auth headers, a 30s
//   timeout, abort handling and 403/ZDR classification. It lived inside a React component, so no
//   tool could reach it. R412 lifted it into src/services/feedback/ — the submission code itself
//   is unchanged, only its address moved. Reimplementing it would have meant duplicating
//   credential handling.
//
// THE PART THAT IS NOT MECHANICAL
//   The /feedback command shows an interactive consent step before sending. A tool has no dialog,
//   so this tool CANNOT provide it. Two consequences are asserted below rather than papered over:
//     1. the enable gate mirrors the command's exactly, so a deployment that switched /feedback
//        off cannot silently regain model-initiated reporting;
//     2. no transcript is sent — the official schema asks for title/details, and shipping a
//        conversation the user never agreed to share is the precise harm consent exists to stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOL = path.join(
  SRC, 'packages', 'builtin-tools', 'src', 'tools', 'SendFeedbackTool', 'SendFeedbackTool.ts',
);
const SERVICE = path.join(SRC, 'src', 'services', 'feedback', 'submitFeedback.ts');
const COMMAND = path.join(SRC, 'src', 'commands', 'feedback', 'index.ts');

const src = () => fs.readFileSync(TOOL, 'utf8');

/**
 * The source with comments removed.
 *
 * Needed because the fixes here are DOCUMENTED in place: the header comment names the endpoint
 * (`claude_cli_feedback`) and the transcript fields it deliberately omits. A raw substring check
 * therefore matched the explanation instead of the code, and failed on a correct tool. This is
 * the same trap that bit R398 — statements must be judged on code, not on prose describing it.
 */
function code() {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i < 0) return line;
      const before = line.slice(0, i);
      // Only strip when the // is not inside a string on that line.
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
}

test('the bundle declares SendFeedback with the official field set', () => {
  const { text } = findChunk('SendFeedbackTool = buildTool(');
  assert.ok(text.includes('"SendFeedback"'), 'the literal tool name is missing');
  // Descriptions copied from sdk-tools.d.ts are the most stable evidence of the declared fields.
  assert.ok(text.includes('Short, specific one-line summary of the issue'),
    'the official `title` description is absent');
  assert.ok(text.includes('What kind of feedback this is'),
    'the official `type` description is absent');
  for (const mode of ['instruction_following', 'subagent_overspawn', 'tone_or_preachiness']) {
    assert.ok(text.includes(mode), 'failure_mode value missing from the bundle: ' + mode);
  }
  for (const cat of ['code_edit', 'debug', 'review']) {
    assert.ok(text.includes(cat), 'task_category value missing from the bundle: ' + cat);
  }
});

test('it reuses the existing submission path instead of reimplementing it', () => {
  // The load-bearing decision. A fresh axios.post here would duplicate OAuth + ZDR handling.
  const s = src();
  assert.match(s, /import \{ submitFeedback \} from 'src\/services\/feedback\/submitFeedback\.js'/,
    'the tool does not import the extracted submission function');
  const c = code();
  assert.ok(!/axios/.test(c),
    'the tool speaks HTTP directly: it should go through submitFeedback');
  assert.ok(!/claude_cli_feedback/.test(c),
    'the endpoint is hardcoded in the tool instead of living in the service');

  // And the service must still be the real thing (endpoint + credential refresh + ZDR branch).
  const svc = fs.readFileSync(SERVICE, 'utf8');
  assert.ok(svc.includes('claude_cli_feedback'), 'the service lost its endpoint');
  assert.ok(svc.includes('checkAndRefreshOAuthTokenIfNeeded'), 'the service lost OAuth refresh');
  assert.ok(svc.includes('isZdrOrg'), 'the service lost its ZDR classification');
});

test('the enable gate mirrors /feedback exactly', () => {
  // A build that disabled the command must not regain reporting through the model.
  const toolText = src();
  const cmdText = fs.readFileSync(COMMAND, 'utf8');
  const switches = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'DISABLE_FEEDBACK_COMMAND',
    'DISABLE_BUG_COMMAND',
  ];
  for (const sw of switches) {
    assert.ok(cmdText.includes(sw), 'the command gate changed: ' + sw + ' no longer checked');
    assert.ok(toolText.includes(sw),
      'the tool gate omits ' + sw + ', so a deployment that disabled /feedback could still '
      + 'report via the tool');
  }
  for (const shared of ['isEssentialTrafficOnly', 'allow_product_feedback', "USER_TYPE === 'ant'"]) {
    assert.ok(toolText.includes(shared), 'the tool gate omits ' + shared);
  }
});

test('no transcript is sent — the consent step cannot be reproduced by a tool', () => {
  // The official schema asks for title/details. Shipping the conversation would be the exact
  // harm the interactive consent step exists to prevent, and a tool has no dialog.
  const c = code();
  assert.match(c, /transcript: \[\]/,
    'the tool now sends a transcript: it has no way to obtain user consent for that');
  assert.ok(!/rawTranscriptJsonl/.test(c), 'rawTranscriptJsonl must not be populated by the tool');
  assert.ok(!/subagentTranscripts/.test(c), 'subagentTranscripts must not be populated');
  assert.match(c, /latestAssistantMessageId: null/,
    'the tool is attaching session identifiers the user did not agree to send');
});

test('the ZDR outcome is reported as a policy answer, not a retryable failure', () => {
  const s = src();
  assert.match(s, /result\.isZdrOrg/,
    'the ZDR branch is gone, so a policy refusal would look like a transient error');
  assert.match(s, /Do not retry/,
    'the ZDR message no longer tells the caller to stop retrying');
});

test('it is exported from the barrel and registered in the tool table', () => {
  const barrel = fs.readFileSync(
    path.join(SRC, 'packages', 'builtin-tools', 'src', 'index.ts'), 'utf8',
  );
  assert.match(barrel, /export \{ SendFeedbackTool \} from '\.\/tools\/SendFeedbackTool\/SendFeedbackTool\.js'/,
    'SendFeedbackTool is not exported from the package barrel');

  const tableFile = fs.readdirSync(DIST)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(DIST, n)).size < 20_000_000)
    .find((n) => fs.readFileSync(path.join(DIST, n), 'utf8').includes('function getAllBaseTools()'));
  assert.ok(tableFile, 'the tool table is missing');
  const table = fs.readFileSync(path.join(DIST, tableFile), 'utf8');
  assert.ok(table.includes('SendFeedbackTool'),
    'SendFeedbackTool is not in the tool table, so the model cannot reach it');
});

test('the extraction left the /feedback UI working', () => {
  // The service was lifted out of a React component. If the component no longer imports back
  // from the new address, the slash command would be broken at runtime.
  const cmd = fs.readFileSync(COMMAND, 'utf8');
  assert.match(cmd, /load: \(\) => import\('\.\/feedback\.js'\)/,
    'the /feedback command no longer loads its implementation');

  const feedbackTsx = fs.readFileSync(
    path.join(SRC, 'src', 'components', 'Feedback.tsx'), 'utf8',
  );
  assert.match(feedbackTsx, /from 'src\/services\/feedback\/submitFeedback\.js'/,
    'Feedback.tsx does not import the extracted service');
  assert.ok(!/async function submitFeedback/.test(feedbackTsx),
    'a second submitFeedback definition came back: the two copies would drift');
  // redactSensitiveInfo deliberately STAYS in the component: a second copy of the redaction
  // rules would drift, and drift stops redacting a key format on whichever path went stale.
  assert.match(feedbackTsx, /export function redactSensitiveInfo/,
    'redactSensitiveInfo moved out of Feedback.tsx; a second copy must not exist elsewhere');
});
