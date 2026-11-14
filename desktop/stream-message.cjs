'use strict';

// Aggregate Anthropic SSE into one non-streaming Message. Errors intentionally
// contain protocol codes only: neither thinking nor upstream text is logged.
class MessageStreamError extends Error {
  constructor(code) { super(code); this.name = 'MessageStreamError'; this.code = code; }
}
const bad = code => { throw new MessageStreamError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function createMessageAccumulator({ maxBytes = 16 * 1024 * 1024,
  maxEventBytes = 2 * 1024 * 1024, maxBlocks = 1024 } = {}) {
  for (const limit of [maxBytes, maxEventBytes, maxBlocks]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('invalid stream aggregation limit');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let buffer = '';
  let eventBytes = 0;
  let eventName = '';
  let data = [];
  let message;
  let stopped = false;
  let ended = false;
  let failed = false;
  const blocks = new Map();
  const checked = operation => {
    if (failed || ended) bad('stream_accumulator_closed');
    try { return operation(); } catch (error) { failed = true; throw error; }
  };
  function frame(value) {
    if (!object(value) || typeof value.type !== 'string') bad('invalid_sse_frame');
    if (eventName && eventName !== value.type) bad('sse_event_type_mismatch');
    if (value.type === 'ping') return;
    if (value.type === 'error') bad('upstream_error_event');
    if (stopped) bad('event_after_message_stop');
    if (value.type === 'message_start') {
      if (message) bad('duplicate_message_start');
      const start = value.message;
      if (!object(start) || start.type !== 'message' || start.role !== 'assistant' ||
          typeof start.id !== 'string' || !start.id || typeof start.model !== 'string' ||
          !Array.isArray(start.content) || start.content.length !== 0) bad('invalid_message_start');
      if (start.usage !== undefined && !object(start.usage)) bad('invalid_message_usage');
      message = { ...start, content: [] };
      return;
    }
    if (!message) bad('missing_message_start');
    if (value.type === 'content_block_start') {
      if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= maxBlocks || blocks.has(value.index))
        bad('invalid_content_block_index');
      const block = value.content_block;
      if (!object(block) || typeof block.type !== 'string') bad('invalid_content_block');
      if (block.type === 'text' && typeof block.text !== 'string') bad('invalid_text_block');
      if (block.type === 'thinking' && typeof block.thinking !== 'string') bad('invalid_thinking_block');
      if (block.type === 'thinking' && block.signature !== undefined && typeof block.signature !== 'string') bad('invalid_signature_delta');
      if (['tool_use', 'server_tool_use'].includes(block.type) && !object(block.input)) bad('invalid_tool_input');
      blocks.set(value.index, { block: { ...block }, json: '', hasJson: false, closed: false });
      return;
    }
    if (value.type === 'content_block_delta' || value.type === 'content_block_stop') {
      const state = blocks.get(value.index);
      if (!Number.isSafeInteger(value.index) || !state || state.closed) bad('unknown_or_closed_content_block');
      const block = state.block;
      if (value.type === 'content_block_stop') {
        if (state.hasJson) {
          let input;
          try { input = JSON.parse(state.json); } catch { bad('invalid_tool_json_delta'); }
          if (!object(input)) bad('invalid_tool_input');
          block.input = input;
        }
        state.closed = true;
        return;
      }
      const delta = value.delta;
      if (!object(delta)) bad('invalid_content_delta');
      if (delta.type === 'text_delta') {
        if (block.type !== 'text' || typeof delta.text !== 'string') bad('invalid_text_delta');
        block.text += delta.text;
      } else if (delta.type === 'thinking_delta') {
        if (block.type !== 'thinking' || typeof delta.thinking !== 'string') bad('invalid_thinking_delta');
        block.thinking += delta.thinking;
      } else if (delta.type === 'signature_delta') {
        if (block.type !== 'thinking' || typeof delta.signature !== 'string') bad('invalid_signature_delta');
        block.signature = (block.signature || '') + delta.signature;
      } else if (delta.type === 'input_json_delta') {
        if (!['tool_use', 'server_tool_use'].includes(block.type) || typeof delta.partial_json !== 'string') bad('invalid_tool_json_delta');
        state.hasJson = true;
        state.json += delta.partial_json;
      } else if (delta.type === 'citations_delta') {
        if (block.type !== 'text' || !object(delta.citation)) bad('invalid_citations_delta');
        block.citations = [...(block.citations || []), delta.citation];
      } else bad('unsupported_content_delta');
      return;
    }
    if (value.type === 'message_delta') {
      if (!object(value.delta) || (value.usage !== undefined && !object(value.usage))) bad('invalid_message_delta');
      for (const key of ['id', 'role', 'model', 'type', 'content', 'usage']) {
        if (Object.hasOwn(value.delta, key)) bad('invalid_message_delta');
      }
      Object.assign(message, value.delta);
      if (value.usage) message.usage = { ...(message.usage || {}), ...value.usage };
      return;
    }
    if (value.type === 'message_stop') {
      for (let index = 0; index < blocks.size; index++) {
        const state = blocks.get(index);
        if (!state || !state.closed) bad('incomplete_content_blocks');
        message.content.push(state.block);
      }
      stopped = true;
      return;
    }
    bad('unsupported_sse_event');
  }
  function line(value, newlineBytes) {
    eventBytes += Buffer.byteLength(value, 'utf8') + newlineBytes;
    if (eventBytes > maxEventBytes) bad('sse_event_too_large');
    if (value === '') {
      if (data.length) {
        let value;
        try { value = JSON.parse(data.join('\n')); } catch { bad('invalid_sse_json'); }
        frame(value);
      }
      data = []; eventName = ''; eventBytes = 0;
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventName = content;
    else if (field === 'data') data.push(content);
  }
  function consume(final = false) {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (!final && match[0] === '\r' && match.index === buffer.length - 1)) break;
      const value = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      line(value, match[0].length);
    }
    if (Buffer.byteLength(buffer, 'utf8') + eventBytes > maxEventBytes) bad('sse_event_too_large');
  }
  return {
    push(chunk) {
      return checked(() => {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += input.length;
        if (bytes > maxBytes) bad('sse_response_too_large');
        try { buffer += decoder.decode(input, { stream: true }); } catch { bad('invalid_sse_utf8'); }
        consume();
      });
    },
    finish() {
      return checked(() => {
        try { buffer += decoder.decode(); } catch { bad('invalid_sse_utf8'); }
        consume(true);
        if (buffer || data.length || eventName) bad('truncated_sse_event');
        if (!message) bad('missing_message_start');
        if (!stopped) bad('missing_message_stop');
        ended = true;
        return message;
      });
    },
  };
}

module.exports = { createMessageAccumulator, MessageStreamError };
