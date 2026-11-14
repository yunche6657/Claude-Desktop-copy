// LocalKernel: the existing in-process agent loop, seen through the
// AgentKernelBackend contract (desktop/kernel-backend.cjs).
//
// This is deliberately a very thin adapter. It does not reimplement anything:
// the turn is still desktop/agent.cjs's loop, with the same tool set, the same
// approval gate and the same event names. That is the whole point — the
// contract must be able to describe what we already have before it can describe
// a claude-code-best child process.
//
// What this layer adds:
//
//   - `id`: lets the caller record which kernel produced a session, so a
//     fallback ("CCB unavailable, using LocalKernel") is observable instead of
//     imaginary;
//   - an event hub with unsubscribe, so the session kernel can detach;
//   - per-session AbortControllers, because the backend contract's
//     cancel(sessionId) has to work even though agent.cjs takes a signal;
//   - dispose(), which aborts in-flight turns and detaches listeners.
//
// What it deliberately does NOT do: session records, transcript entries,
// persistence, approval bookkeeping. Those stay in session-kernel.cjs, which is
// the boundary documented in kernel-backend.cjs.
'use strict';

const {
  createKernelEventHub,
  normaliseTurnResult,
  assertKernelBackend,
} = require('./kernel-backend.cjs');

const KERNEL_ID = 'local';

/**
 * @param {{
 *   createAgent?: (opts: object) => object,  // -> { run({messages, signal, requestApproval, onEvent}) }
 *   log?: (msg: string) => void,
 * }} [opts]
 *
 * `createAgent` is injected rather than required here: desktop/main.cjs owns the
 * singleton runner (it is built lazily from the provider settings), and tests
 * inject a stub. Requiring agent-config.cjs directly would make this module
 * demand network credentials just to be loaded.
 */
function createLocalKernel({ createAgent = null, log = () => {} } = {}) {
  const hub = createKernelEventHub({ onListenerError: (error) => log(`event listener threw: ${error && error.message}`) });

  /** sessionId -> AbortController for the turn in flight. */
  const running = new Map();
  /** Sessions this backend was told about through start(). */
  const started = new Set();
  let disposed = false;

  const now = () => Date.now();

  function start(opts = {}) {
    if (disposed) throw new Error('kernel backend has been disposed');
    if (opts && typeof opts.sessionId === 'string' && opts.sessionId) started.add(opts.sessionId);
    // The local kernel needs nothing spawned up front; the agent runner is
    // already live in the main process.
    return { id: KERNEL_ID, sessionId: (opts && opts.sessionId) || null, startedAt: now() };
  }

  async function sendMessage(sessionId, message, opts = {}) {
    if (disposed) throw new Error('kernel backend has been disposed');
    if (!createAgent) throw new Error('local kernel has no createAgent');
    if (running.has(sessionId)) throw new Error('a turn is already running for this session');

    // The session kernel passes its own approval hook down; it is the one that
    // knows how to render a card in the app.
    const requestApproval = typeof opts.requestApproval === 'function' ? opts.requestApproval : undefined;
    // The session's permission mode travels with the turn. Without it the runner
    // fell back to the process config (ask), so a session set to 自动 still raised an
    // approval card for every gated tool — measured: Bash in auto mode reported
    // "ask mode prompts before edits and commands".
    const permissionMode = typeof opts.permissionMode === 'string' ? opts.permissionMode : undefined;
    // The effort picker stores its choice on the session; the request needs it too.
    const effortLevel = typeof opts.effortLevel === 'string' ? opts.effortLevel : undefined;
    const agent = createAgent({ sessionId, requestApproval, permissionMode, effortLevel });

    const controller = new AbortController();
    running.set(sessionId, controller);
    // An AbortSignal from the caller (session-kernel's cancel path) is honoured
    // too. `run` is given the merged one so agent.cjs sees a single signal.
    const externalSignal = opts.signal;
    const forwardAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else if (typeof externalSignal.addEventListener === 'function') externalSignal.addEventListener('abort', forwardAbort);
    }

    let text = '';
    const onEvent = (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'text' && typeof event.text === 'string') text += event.text;
      hub.emit({ sessionId, ...event });
    };

    try {
      const result = await agent.run({
        messages: opts.messages || [],
        signal: controller.signal,
        requestApproval,
        permissionMode,
        effortLevel,
        onEvent,
      });
      const normalised = normaliseTurnResult(result, text);
      return { ...normalised, turn: result && result.turnCount, agent: agent.model };
    } finally {
      running.delete(sessionId);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', forwardAbort);
      }
    }
  }

  function cancel(sessionId) {
    const controller = running.get(sessionId);
    if (!controller) return { ok: false, reason: 'no running turn' };
    controller.abort();
    running.delete(sessionId);
    return { ok: true };
  }

  function onEvent(callback) {
    return hub.onEvent(callback);
  }

  function dispose() {
    if (disposed) return { ok: true, alreadyDisposed: true };
    disposed = true;
    for (const controller of running.values()) controller.abort();
    running.clear();
    started.clear();
    hub.clear();
    return { ok: true };
  }

  const backend = {
    id: KERNEL_ID,
    start,
    sendMessage,
    cancel,
    onEvent,
    dispose,
    /** True while a turn is in flight (diagnostics only). */
    isRunning: (sessionId) => running.has(sessionId),
  };

  return assertKernelBackend(backend);
}

module.exports = { createLocalKernel, KERNEL_ID };
