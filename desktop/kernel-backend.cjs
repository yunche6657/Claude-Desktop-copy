// Agent kernel backend contract.
//
// A "kernel" is whatever actually produces a turn: today that is our own
// agent loop (desktop/agent.cjs against an Anthropic-compatible endpoint), and
// the planned V6 backend is a claude-code-best child process driven over
// stream-json. Both must be interchangeable from the bridge's point of view, so
// the shape they have to satisfy lives here as data, not as an abstract class.
//
// Why a factory/duck-typed contract instead of an ES class:
//   - the project is plain CommonJS (.cjs) with no build step;
//   - the two implementations already exist as closures (createAgentRunner,
//     createCcbKernel), so a class hierarchy would only add an adapter layer;
//   - tests can hand in a three-line stub without inheriting anything.
//
// Boundary (this is the part that is easy to get wrong):
//
//   backend     -> runs exactly ONE turn: takes the conversation so far, streams
//                  events, resolves with the assistant's text and stop reason.
//   session-kernel -> owns everything durable: the session record, the
//                  stream-json transcript, tool-approval bookkeeping, cancel,
//                  persistence to disk, and the events the renderer consumes.
//
// Concretely: a backend never writes a store, never invents transcript uuids,
// never decides what the sidebar shows. If a backend needs to remember
// something across turns it may (ccb-kernel keeps its child process alive), but
// that state is a cache, not the record of truth.
//
// Interface:
//
//   {
//     id: string,                                    // 'local' | 'ccb' | ...
//     start(opts): any,                              // register a session; may spawn
//     sendMessage(sessionId, message, opts): Promise<{text, stopReason}>
//     cancel(sessionId): any,                        // idempotent
//     onEvent(cb): () => void,                       // returns an unsubscribe fn
//     dispose(): any,                                // release processes/handles
//   }
//
// Event envelope: every event a backend emits is a plain object with a string
// `type` and the `sessionId` it belongs to. The types the renderer path
// understands are the ones desktop/agent.cjs already produced (text,
// tool_request, tool_result, tool_error, error, ...); a backend may emit more,
// the session kernel forwards unknown types untouched.
'use strict';

/**
 * The methods a backend must implement. Kept as the single source of truth so
 * kernel-backend, local-kernel, ccb-kernel and the tests cannot drift apart.
 */
const KERNEL_METHODS = Object.freeze(['start', 'sendMessage', 'cancel', 'onEvent', 'dispose']);

/**
 * Event types the bridge/transcript path understands today. A backend is free
 * to emit additional types; this list is what must keep its shape.
 */
const KERNEL_EVENT_TYPES = Object.freeze([
  'text',        // { text }                      streaming assistant text
  'tool_request',// { id, name, input }           a tool is about to run
  'tool_result', // { id, name, content }         the outcome
  'tool_error',  // { id, name, message }         the tool failed
  'error',       // { message }                   the turn failed
  'turn',        // { turn }                      loop bookkeeping (ignored downstream)
  'done',        // { stopReason, text }          agent-loop completion
]);

const isFunction = (value) => typeof value === 'function';

/** True when `value` satisfies the contract's method surface. */
function isKernelBackend(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  return KERNEL_METHODS.every((name) => isFunction(value[name]));
}

/**
 * Validate a backend and hand it back unchanged.
 *
 * Throws a TypeError naming the first missing piece, because the alternative —
 * a facade that silently no-ops a missing method — turns "the kernel is wired
 * wrong" into "the UI is quiet", which is the failure mode this project has
 * spent several rounds digging out of.
 */
function assertKernelBackend(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('agent kernel backend must be an object');
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new TypeError('agent kernel backend needs a non-empty string id');
  }
  for (const name of KERNEL_METHODS) {
    if (!isFunction(value[name])) {
      throw new TypeError(`agent kernel backend "${value.id}" is missing ${name}()`);
    }
  }
  return value;
}

/**
 * The event channel every backend exposes.
 *
 * A tiny hub instead of EventEmitter: subscribers get a plain object, an
 * unsubscribe closure, and — critically — a throwing subscriber cannot break
 * the turn (one bad listener would otherwise kill the kernel mid-turn and leave
 * the session marked running). The failure is reported through `onListenerError`
 * so it is visible in logs rather than swallowed.
 *
 * @param {{ onListenerError?: (error: Error) => void }} [options]
 */
function createKernelEventHub({ onListenerError = null } = {}) {
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set();

  return {
    /** Subscribe. Returns the unsubscribe function (safe to call twice). */
    onEvent(callback) {
      if (!isFunction(callback)) throw new TypeError('onEvent needs a function');
      listeners.add(callback);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(callback);
      };
    },
    /** Broadcast one event to every subscriber. */
    emit(event) {
      if (!event || typeof event !== 'object') return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          if (isFunction(onListenerError)) onListenerError(error);
        }
      }
    },
    /** How many subscribers are attached (used by tests and diagnostics). */
    get size() { return listeners.size; },
    /** Drop every subscriber, e.g. on dispose(). */
    clear() { listeners.clear(); },
  };
}

/** The turn result every backend must resolve with. */
function normaliseTurnResult(result, fallbackText = '') {
  const text = result && typeof result.text === 'string' ? result.text : fallbackText;
  const stopReason = result && typeof result.stopReason === 'string' && result.stopReason
    ? result.stopReason
    : 'end_turn';
  return { text, stopReason };
}

module.exports = {
  KERNEL_METHODS,
  KERNEL_EVENT_TYPES,
  isKernelBackend,
  assertKernelBackend,
  createKernelEventHub,
  normaliseTurnResult,
};
