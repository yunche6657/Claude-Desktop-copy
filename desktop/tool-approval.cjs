// Approval gate for tool calls.
//
// The original gates tool use through the SDK's `canUseTool` callback, which
// returns `{ behavior: "allow" | "deny", message }`. This module is the same
// seam for our own loop: it takes a tool request plus the permission mode and
// decides whether to ask, then routes the prompt to the consent surface.
//
// Keeping this separate from agent.cjs matters: the loop must not know how a
// decision is obtained, and the consent window must not know about tools.
'use strict';

const { ACTIONS, DECISIONS, decide, classify } = require('./permissions.cjs');

// Tool name → permission action. Anything unlisted is treated as an edit, which
// is the conservative default: an unknown tool prompts.
const TOOL_ACTIONS = Object.freeze({
  Read: ACTIONS.READ,
  List: ACTIONS.READ,
  Glob: ACTIONS.READ,
  // Skill only ever reads: it resolves a name against the skill catalogue and returns
  // text. Leaving it out of this table made it fall back to EDIT, so opening a skill
  // raised an approval card — measured live: asking the agent to open "docx" showed
  // "允许 Claude 运行 Skill 吗？" instead of just reading it.
  Skill: ACTIONS.READ,
  Write: ACTIONS.EDIT,
  Edit: ACTIONS.EDIT,
  Bash: ACTIONS.EXEC,
});

function actionFor(toolName) {
  return TOOL_ACTIONS[toolName] || ACTIONS.EDIT;
}

/** A short, single-line summary of what a tool call will do, for the prompt. */
function describeRequest(request) {
  const input = request.input || {};
  switch (request.name) {
    case 'Read':
      return `Read ${input.path}`;
    case 'List':
      return `List ${input.path || '.'}`;
    case 'Glob':
      return `Find files matching ${input.pattern}`;
    case 'Write':
      return `Write ${input.path}`;
    case 'Edit':
      return `Edit ${input.path}`;
    case 'Skill':
      return input && input.name
        ? `Read the "${input.name}" skill`
        : 'List the installed skills';
    case 'Bash':
      return `Run: ${input.command}`;
    default:
      return `${request.name} ${JSON.stringify(input).slice(0, 120)}`;
  }
}

/**
 * The practical constructor: combine the gate with the tool handlers.
 *
 * `ask` is async (request) => 'allow' | 'cancel' | 'timeout' | 'error'.
 * `mode` is a permissions.MODES value.
 */
function createApprovalExecutor({ mode, ask, tools, onEvent = () => {}, isBridge = false }) {
  const run = async request => {
    const tool = tools.find(candidate => candidate.name === request.name);
    if (!tool) {
      return { content: `Unknown tool: ${request.name}`, isError: true };
    }
    try {
      return await tool.handler(request.input || {});
    } catch (error) {
      // Keep the error CODE, not just the sentence.
      //
      // file-tools.cjs raises ToolError with a stable code (no-match, ambiguous-match,
      // outside-roots, invalid-match...). Flattening it to `${error.message}` threw that
      // away, so the model saw one undifferentiated string: it could not tell 「找不到这段」
      // from 「这段出现两次，需要更多上下文」, which call for opposite fixes (search again
      // vs. add context). Measured: an Edit with a missing string produced exactly
      // 「Tool failed: oldText was not found in the file」 with the code gone.
      const code = error && typeof error.code === 'string' ? error.code : null;
      const detail = error && error.message ? error.message : String(error);
      return {
        content: code ? `Tool failed [${code}]: ${detail}` : `Tool failed: ${detail}`,
        isError: true,
        ...(code ? { errorCode: code } : {}),
      };
    }
  };

  return async function execute(request) {
    // Refuse an unknown tool BEFORE asking the user.
    //
    // `run` already rejects one, but it is only reached after the approval prompt, so an
    // unknown tool raised a dialog, collected a decision, and only then reported that it
    // could not run anyway — asking the user to authorize something that does not exist.
    if (!tools.some((candidate) => candidate.name === request.name)) {
      onEvent({ type: 'tool_unknown', name: request.name });
      return { content: `Unknown tool: ${request.name}`, isError: true };
    }

    const action = actionFor(request.name);
    const policy = decide(mode, action, { isBridge });
    const verdict = classify(mode, action, { isBridge });

    // DENY is not the same as ASK.
    //
    // dontAsk means "deny actions that aren't pre-approved, without prompting". Reading only
    // `policy.prompt` collapsed it into ASK, so this mode opened an approval card and waited
    // for a click — the one thing its description says it never does. The user picked
    // "Don't ask" and was then asked.
    //
    // No card is shown and no wait happens: the call fails immediately with a reason the
    // model can act on.
    if (verdict === DECISIONS.DENY) {
      onEvent({ type: 'tool_denied', name: request.name, decision: 'denied-by-mode' });
      return {
        content: `${request.name} was not run: ${policy.reason}`,
        isError: true,
      };
    }

    if (verdict === DECISIONS.ALLOW) {
      onEvent({ type: 'tool_auto_allowed', name: request.name, reason: policy.reason });
      return await run(request);
    }

    onEvent({ type: 'tool_approval_needed', name: request.name, reason: policy.reason, command: describeRequest(request) });
    let decision = 'cancel';
    try {
      // The request carries what the renderer's card needs.
      //
      // The consumer (shared-11-Ci0VQatJ.js) maps the payload through
      //   Om(sessionId, request) => ({ toolName: t.toolName, input: Gr(t.input),
      //                                description: t.description, ... })
      // and shows `description`/`input`. Sending only {kind, command, toolName} left
      // `input` undefined and `description` absent, so the card had nothing to render
      // and never appeared even though the request was delivered.
      decision = await ask({
        kind: 'run-command',
        command: describeRequest(request),
        toolName: request.name,
        // The exact arguments, so the card can show what will change.
        input: request.input || {},
        description: describeRequest(request),
        decisionReason: policy.reason,
      });
    } catch {
      decision = 'error';
    }

    if (decision !== 'allow') {
      onEvent({ type: 'tool_denied', name: request.name, decision });
      return {
        content: decision === 'timeout'
          ? `The user did not respond in time, so ${request.name} was not run.`
          : decision === 'error'
          ? `The approval prompt failed, so ${request.name} was not run.`
          : `The user declined to run ${request.name}.`,
        isError: true,
      };
    }
    onEvent({ type: 'tool_allowed', name: request.name });
    return await run(request);
  };
}

module.exports = { TOOL_ACTIONS, actionFor, describeRequest, createApprovalExecutor };
