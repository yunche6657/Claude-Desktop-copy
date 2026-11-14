// Agent loop.
//
// This is the piece that was missing: a real tool-use cycle. Earlier revisions
// disabled tools (`--tools ''`) and called the local file/exec/MCP modules only
// from UI buttons, so the model could never drive anything.
//
// The loop follows the Anthropic Messages protocol:
//
//   1. POST /v1/messages with the tool definitions.
//   2. If `stop_reason === "tool_use"`, every `tool_use` block is a request.
//   3. For each request: decide whether it needs approval, ask, then run it.
//   4. Append a `user` turn carrying one `tool_result` per `tool_use` block.
//   5. Repeat until the model stops asking for tools or the turn budget is spent.
//
// Tool execution is delegated: this module never touches the filesystem or a
// child process itself. That keeps the approval gate in one place and lets the
// callers reuse the existing, already-tested executors.
'use strict';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TURNS = 24;
const API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 180_000;

class AgentError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Normalises a base URL: strips a trailing slash and a trailing /v1. */
function normaliseBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new AgentError('invalid-base-url', 'a base URL is required');
  }
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1$/, '');
  return url;
}

/**
 * How an effort level maps onto the request.
 *
 * The composer offers an effort picker (low / medium / high). The session record stores the
 * choice, and the bridge comment claimed "the agent runner forwards whatever the caller
 * picks" - but the request body had no thinking field at all, so picking a level changed the
 * label and nothing else.
 *
 * The budget is a FRACTION of max_tokens rather than a fixed number: the default max_tokens
 * is 4096, so a hard-coded 8192 for 'high' could never fit and thinking would silently
 * vanish at the exact level the user most expects it. Extended thinking also requires the
 * budget to stay below max_tokens, so the fraction leaves headroom for the answer itself.
 */
const THINKING_FRACTION_BY_EFFORT = { low: 0, medium: 0.25, high: 0.5 };

function thinkingFor(effort, maxTokens) {
  const fraction = THINKING_FRACTION_BY_EFFORT[String(effort || '').toLowerCase()];
  if (!fraction || fraction <= 0) return null;
  if (!maxTokens || maxTokens <= 0) return null;
  // Leave room for the reply: at least 1024 tokens, and never more than the budget.
  const budget = Math.floor(maxTokens * fraction);
  if (budget < 1024) return null;
  return { type: 'enabled', budget_tokens: budget };
}

function thinkingOptions(model, effort, maxTokens) {
  const level = String(effort || '').toLowerCase();
  if (!Object.hasOwn(THINKING_FRACTION_BY_EFFORT, level)) return {};
  // Current Claude models use adaptive thinking and reject the old enabled/budget
  // form (measured on Sonnet 5.5). Older Claude and other gateways retain it.
  // Source: https://platform.claude.com/docs/en/build-with-claude/thinking
  const adaptive = /^claude-(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5|haiku-5-5)(?:-|$)/.test(String(model || ''));
  if (adaptive) return { thinking: { type: 'adaptive' }, output_config: { effort: level } };
  const thinking = thinkingFor(effort, maxTokens);
  return thinking ? { thinking } : {};
}
function messagesEndpoint(baseUrl) {
  return `${normaliseBaseUrl(baseUrl)}/v1/messages`;
}

/**
 * One API call. Returns the parsed message body.
 * `fetchImpl` is injectable so tests can run without network.
 */
async function callMessages({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  tools,
  maxTokens = DEFAULT_MAX_TOKENS,
  effort,
  signal,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) throw new AgentError('missing-key', 'an API key is required');
  if (!model) throw new AgentError('missing-model', 'a model id is required');

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools } : {}),
    // Extended thinking, driven by the session's stored effort level.
    ...thinkingOptions(model, effort, maxTokens),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();

  let response;
  let text;
  try {
    response = await fetchImpl(messagesEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Receiving headers does not finish the request. Keep cancellation and the
    // deadline active until the response body has actually arrived.
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AgentError('aborted', signal?.aborted ? 'the run was cancelled' : 'the request timed out');
    }
    // A configuration error must not be relabelled as a network failure.
    //
    // messagesEndpoint(baseUrl) sits INSIDE this try, so a missing base URL threw
    // 'invalid-base-url' and was immediately rewritten to 'network'. MEASURED: runAgent with
    // no baseUrl reported { code: 'network', message: 'request failed: a base URL is required' }
    // — the right sentence under the wrong code, which sends the caller looking at the network
    // instead of its own config.
    if (error instanceof AgentError) throw error;
    throw new AgentError('network', `request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  if (!response.ok) {
    const detail = parsed?.error?.message || text.slice(0, 400) || `HTTP ${response.status}`;
    // Classify by status, not just by 'api-error'. A caller that cannot tell 401 (bad key)
    // from 429 (rate limited) from 5xx (gateway down) has to pattern-match the message text,
    // which is exactly the coupling that breaks when a provider rewords its error. The
    // message keeps the full detail; the code carries the classification.
    const kind = response.status === 401 || response.status === 403 ? 'auth'
      : response.status === 429 ? 'rate-limit'
        : response.status >= 500 ? 'server'
          : response.status === 404 ? 'not-found'
            : 'api-error';
    throw new AgentError(kind, `API ${response.status}: ${detail}`, parsed);
  }
  if (!parsed || parsed.type !== 'message' || !Array.isArray(parsed.content)) {
    throw new AgentError('bad-response', 'the API returned an unexpected body', text.slice(0, 400));
  }
  return parsed;
}

/** Pulls the tool_use blocks out of an assistant message. */
function toolRequests(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter(block => block && block.type === 'tool_use' && typeof block.name === 'string')
    .map(block => ({ id: block.id, name: block.name, input: block.input || {} }));
}

/** Concatenates the text blocks of an assistant message. */
function assistantText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

/**
 * Runs the loop.
 *
 * `tools` is the API-facing list: [{name, description, input_schema}].
 * `execute` is async (request) => { content, isError } and is expected to apply
 * whatever approval policy the caller owns.
 * `onEvent` receives {type, ...} updates as the run proceeds.
 */
async function runAgent({
  baseUrl,
  apiKey,
  model,
  effort,
  system,
  messages: initialMessages,
  tools = [],
  execute,
  onEvent = () => {},
  maxTokens = DEFAULT_MAX_TOKENS,
  maxTurns = DEFAULT_MAX_TURNS,
  signal,
  fetchImpl = fetch,
}) {
  if (typeof execute !== 'function') {
    throw new AgentError('missing-executor', 'an execute function is required');
  }

  const messages = initialMessages.map(message => ({ ...message }));
  let turns = 0;
  let finalText = '';

  while (turns < maxTurns) {
    if (signal?.aborted) throw new AgentError('aborted', 'the run was cancelled');
    turns++;

    onEvent({ type: 'turn', turn: turns });
    const message = await callMessages({
      baseUrl, apiKey, model, effort, system, messages, tools, maxTokens, signal, fetchImpl,
    });
    const text = assistantText(message);
    if (text) {
      finalText += text;
      onEvent({ type: 'text', text });
    }

    // The assistant turn must be echoed back verbatim, including the tool_use
    // blocks, or the following tool_result has nothing to attach to.
    messages.push({ role: 'assistant', content: message.content });

    const requests = toolRequests(message);
    if (!requests.length) {
      onEvent({ type: 'done', stopReason: message.stop_reason, text: finalText, turnCount: turns });
      return { text: finalText, messages, turns, stopReason: message.stop_reason };
    }

    const results = [];
    for (const request of requests) {
      if (signal?.aborted) throw new AgentError('aborted', 'the run was cancelled');
      onEvent({ type: 'tool_request', id: request.id, name: request.name, input: request.input });
      let outcome;
      try {
        outcome = await execute(request);
      } catch (error) {
        // Keep the same shape the approval executor uses ("Tool failed [code]: detail").
        // This branch only fires for tools that throw before the executor catches them, but a
        // model that learns to read [code] from one path must not find it missing on another.
        const code = error && typeof error.code === 'string' ? error.code : null;
        outcome = {
          content: code ? `Tool failed [${code}]: ${error.message}` : `Tool failed: ${error.message}`,
          isError: true,
        };
        onEvent({ type: 'tool_error', id: request.id, name: request.name, message: error.message });
      }
      const isError = Boolean(outcome?.isError);
      onEvent({
        type: 'tool_result', id: request.id, name: request.name,
        isError, preview: String(outcome?.content ?? '').slice(0, 400),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: request.id,
        content: typeof outcome?.content === 'string' ? outcome.content : JSON.stringify(outcome?.content ?? ''),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  throw new AgentError('turn-budget', `the run exceeded ${maxTurns} turns without finishing`);
}

module.exports = {
  AgentError,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  normaliseBaseUrl,
  messagesEndpoint,
  callMessages,
  toolRequests,
  assistantText,
  thinkingFor,
  thinkingOptions,
  runAgent,
};
