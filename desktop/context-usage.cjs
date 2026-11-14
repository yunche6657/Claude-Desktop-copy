'use strict';

// One instance per turn: an incomplete stream never survives a failed/cancelled turn.
function createRequestUsageTracker(onComplete) {
  let pending = null;
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  function merge(usage) {
    if (!usage || typeof usage !== 'object') return;
    for (const key of fields) {
      const value = usage[key];
      if (Number.isSafeInteger(value) && value >= 0 &&
          (key === 'output_tokens' || value > 0 || pending.usage[key] === undefined)) {
        pending.usage[key] = value;
      }
    }
  }
  return {
    observe(frame) {
      if (!frame || frame.type !== 'stream_event' || frame.parent_tool_use_id != null) return;
      const event = frame.event;
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        pending = { messageId: event.message?.id ?? null, model: event.message?.model ?? null, usage: {}, hasDeltaOutput: false };
        merge(event.message?.usage);
      } else if (event.type === 'message_delta' && pending) {
        merge(event.usage);
        if (Number.isSafeInteger(event.usage?.output_tokens) && event.usage.output_tokens >= 0) pending.hasDeltaOutput = true;
      } else if (event.type === 'message_stop' && pending) {
        const current = pending;
        pending = null;
        if (current.hasDeltaOutput && Number.isSafeInteger(current.usage.input_tokens)) {
          delete current.hasDeltaOutput;
          onComplete(current);
        }
      }
    },
  };
}
module.exports = { createRequestUsageTracker };
