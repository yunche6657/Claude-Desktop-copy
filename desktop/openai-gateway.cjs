'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createOpenAIUsageUpdater } = require('./openai-usage.cjs');

const REQUEST_LIMIT = 8 * 1024 * 1024;
const RESPONSE_LIMIT = 32 * 1024 * 1024;

function endpoint(base, protocol) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid upstream URL');
  url.hash = ''; url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/(chat\/completions|responses)$/.test(path) ? path : `${path}${path.endsWith('/v1') ? '' : '/v1'}/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`;
  return url;
}

function text(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
}
function imageUrl(source) {
  if (source?.type === 'base64') return `data:${source.media_type};base64,${source.data}`;
  if (source?.type === 'url') return source.url;
  throw new Error('Unsupported image source');
}
function convertRequest(body, protocol, capabilityProfile = {}) {
  if (!body || !Array.isArray(body.messages) || typeof body.model !== 'string') throw new Error('model and messages are required');
  const chat = protocol === 'openai-chat';
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: text(body.system) });
  for (const message of body.messages) {
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Invalid message role');
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw new Error('Invalid message content');
    let pending = [], reasoning = '';
    const flush = () => {
      if (!pending.length && !reasoning) return;
      messages.push({ role: message.role, content: pending.length ? pending : null, ...(reasoning ? { reasoning_content: reasoning } : {}) }); pending = []; reasoning = '';
    };
    const calls = [];
    const toolImages = [];
    for (const block of blocks) {
      if (block.type === 'text') pending.push(chat ? { type: 'text', text: block.text } : { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
      else if (block.type === 'image') {
        if (message.role !== 'user') throw new Error('Images require user role');
        pending.push(chat ? { type: 'image_url', image_url: { url: imageUrl(block.source) } } : { type: 'input_image', image_url: imageUrl(block.source) });
      } else if (block.type === 'tool_use') {
        if (message.role !== 'assistant') throw new Error('tool_use requires assistant role');
        if (chat) calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
        else { flush(); messages.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) }); }
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user') throw new Error('tool_result requires user role');
        flush();
        let output;
        if (typeof block.content === 'string' || block.content == null) output = block.content || '';
        else if (block.content.some(b => b.type !== 'text')) {
          if (chat) {
            // Chat tool messages carry text. Preserve images in a following user
            // message, after acknowledging the tool result with its original ID.
            const images = block.content.filter(b => b.type === 'image');
            if (block.content.some(b => !['text', 'image'].includes(b.type))) throw new Error('Unsupported tool result block');
            messages.push({ role: 'tool', tool_call_id: block.tool_use_id,
              content: text(block.content) || 'Image returned by tool; see the following image message.' });
            toolImages.push(...images.map(b => ({ type: 'image_url', image_url: { url: imageUrl(b.source) } })));
            continue;
          }
          output = block.content.map(b => b.type === 'image' ? { type: 'input_image', image_url: imageUrl(b.source) } : { type: 'input_text', text: b.text });
        } else output = text(block.content);
        messages.push(chat ? { role: 'tool', tool_call_id: block.tool_use_id, content: output } : { type: 'function_call_output', call_id: block.tool_use_id, output });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        if (message.role !== 'assistant') throw new Error('thinking requires assistant role');
        // Chat providers can require the original reasoning alongside tool calls.
        // Responses reasoning replay requires native item IDs/encrypted content;
        // an Anthropic thinking block has neither. Never invent that provenance
        // or turn reasoning/redacted payloads into ordinary assistant text.
        if (chat && block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
      } else throw new Error('Unsupported content block');
    }
    if (chat && calls.length) { messages.push({ role: 'assistant', content: pending.length ? pending : null, tool_calls: calls, ...(reasoning ? { reasoning_content: reasoning } : {}) }); pending = []; reasoning = ''; }
    if (toolImages.length) pending.unshift(...toolImages);
    flush();
  }
  const out = { model: body.model, stream: true, [chat ? 'messages' : 'input']: messages };
  if (chat) out.stream_options = { include_usage: true };
  if (body.max_tokens != null) out[chat ? 'max_tokens' : 'max_output_tokens'] = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  // Keep effort explicit; a token budget is not an effort level.
  const effort = body.output_config?.effort ?? body.reasoning_effort ?? body.reasoning?.effort;
  if (effort != null) {
    const capabilities = require('./model-capabilities.cjs');
    if (!capabilities.EFFORT_VALUES.includes(effort)) throw new Error('Invalid reasoning effort');
    const supported = capabilities.resolveModelCapabilities(body.model, capabilityProfile);
    // The SDK can synthesize a default even after its inline effort flag is
    // cleared. No capability declaration means no effort field on the wire.
    if (supported.supportedEfforts.length) {
      if (capabilities.validateModelEffort(body.model, effort, capabilityProfile) === undefined) throw new Error('Unsupported reasoning effort for selected model');
      if (chat) out.reasoning_effort = effort;
      else out.reasoning = { effort };
    }
  }
  if (body.stop_sequences?.length) {
    if (!chat) throw new Error('Responses does not support stop_sequences');
    out.stop = body.stop_sequences;
  }
  if (body.tools) out.tools = body.tools.map(t => chat ? { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } } : { type: 'function', name: t.name, description: t.description, parameters: t.input_schema });
  if (body.tool_choice) {
    const choice = body.tool_choice;
    const mapped = { auto: 'auto', any: 'required', none: 'none' }[choice.type];
    if (choice.type === 'tool') out.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (mapped) out.tool_choice = mapped;
    else throw new Error('Unsupported tool_choice');
    if (choice.disable_parallel_tool_use != null) out.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  return out;
}

async function* sse(response) {
  const decoder = new TextDecoder();
  let buffer = '', size = 0;
  const parse = raw => {
    const lines = raw.split('\n');
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    return data;
  };
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > RESPONSE_LIMIT) throw new Error('Upstream response too large');
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    // CRLF may straddle transport chunks; normalize after combining as well.
    buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const data = parse(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
  buffer += decoder.decode();
  const data = parse(buffer);
  if (data && data !== '[DONE]') yield JSON.parse(data);
}

async function startOpenAIGateway({ upstreamBaseUrl, apiKey, protocol = 'openai-chat', host = '127.0.0.1', timeoutMs = 120000, onDiagnostic, capabilityProfile } = {}) {
  if (!['openai-chat', 'openai-responses'].includes(protocol)) throw new Error('Invalid protocol');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Gateway host must be loopback');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout');
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new Error('Invalid API key');
  const sanitize = value => String(value || '').replaceAll(apiKey || '\0', '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/[\r\n\x00-\x1f]+/g, ' ').slice(0, 1000);
  const upstreamMessage = (error, fallback) => {
    // Only structured error fields, never raw HTML or the echoed request body.
    if (apiKey && String(error?.message || '').includes(apiKey)) return fallback;
    const detail = sanitize(error?.message);
    return detail ? `${fallback}: ${detail}` : fallback;
  };
  const diagnose = value => { try { onDiagnostic?.(value); } catch {} };
  const upstream = endpoint(upstreamBaseUrl, protocol);
  const controllers = new Set();
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages') { res.writeHead(404).end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    let expired = false, streaming = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); if (!req.complete) req.destroy(); }, timeoutMs);
    timer.unref?.();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    req.on('aborted', () => controller.abort());
    const sendError = (status, type, message) => {
      if (res.destroyed || res.writableEnded) return;
      const error = { type: 'error', error: { type, message } };
      if (streaming) { res.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`); res.end(); }
      else { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(error)); }
    };
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > REQUEST_LIMIT) { sendError(413, 'invalid_request_error', 'Request too large'); return; } chunks.push(chunk); }
      let body, request;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); request = convertRequest(body, protocol, typeof capabilityProfile === 'function' ? capabilityProfile() : capabilityProfile || require('./model-capabilities.cjs').currentCapabilityProfile()); }
      catch (error) { diagnose({ stage: 'invalid_request', reason: sanitize(error?.message) }); sendError(400, 'invalid_request_error', 'Invalid or unsupported messages request'); return; }
      diagnose({stage:'request',protocol,model:body.model,bytes:size,tools:body.tools?.length || 0,maxTokens:body.max_tokens});
      const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request), signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        let error;
        const chunks = []; let length = 0;
        for await (const chunk of response.body || []) {
          length += chunk.length;
          if (length > 16384) break;
          chunks.push(chunk);
        }
        try { error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error; } catch {}
        const status = response.status >= 400 && response.status < 600 ? response.status : 502;
        sendError(status, status === 400 ? 'invalid_request_error' : 'api_error', upstreamMessage(error, `Upstream HTTP ${response.status}`)); return;
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); sendError(502, 'api_error', 'Upstream must return an SSE stream'); return; }
      const message = { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      const emit = async (type, data) => {
        if (!body.stream) return;
        if (controller.signal.aborted) throw new Error('Aborted');
        if (!res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)) await new Promise((resolve, reject) => {
          const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
          const drained = () => { cleanup(); resolve(); };
          const closed = () => { cleanup(); reject(new Error('Disconnected')); };
          const failed = () => { cleanup(); reject(new Error('Response failed')); };
          res.once('drain', drained); res.once('close', closed); res.once('error', failed);
        });
      };
      let started = false;
      const startMessage = async () => {
        if (started) return;
        started = true;
        if (body.stream) { streaming = true; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders(); }
        await emit('message_start', { message: { ...message, content: [], usage: { ...message.usage } } });
      };
      const states = new Map(), reasoningSeen = new Set(), pendingOutput = []; let opened = null, bufferingTools = false, finished = false, reason = 'end_turn';
      const close = async state => {
        if (!state || state.closed || state.index == null) return;
        if (state.tool) { try { state.block.input = JSON.parse(state.args || '{}'); } catch { throw new Error('Invalid tool arguments'); } }
        await emit('content_block_stop', { index: state.index });
        state.closed = true;
      };
      const ensure = async state => {
        if (state.index != null) return;
        await close(opened);
        opened = state;
        state.index = message.content.length;
        state.block = state.tool ? { type: 'tool_use', id: state.id || `call_${randomUUID()}`, name: state.name || '', input: {} } : state.thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        message.content.push(state.block);
        await emit('content_block_start', { index: state.index, content_block: state.block });
      };
      const delta = async (state, value) => {
        await ensure(state);
        if (state.tool) { state.args = (state.args || '') + value; await emit('content_block_delta', { index: state.index, delta: { type: 'input_json_delta', partial_json: value } }); }
        else if (state.thinking) { state.block.thinking += value; await emit('content_block_delta', { index: state.index, delta: { type: 'thinking_delta', thinking: value } }); }
        else { state.block.text += value; await emit('content_block_delta', { index: state.index, delta: { type: 'text_delta', text: value } }); }
      };
      const tool = key => {
        if (!states.has(key)) {
          const state = { tool: true, id: '', name: '', args: '', fragments: [] };
          states.set(key, state); pendingOutput.push({ state }); bufferingTools = true;
        }
        return states.get(key);
      };
      // Tool metadata and parallel arguments may interleave with later text.
      // Retain first-observed block order, then emit complete sequential tool
      // blocks at completion. Text/reasoning before the first tool stays live.
      const textual = async (key, value, thinking = false, replay = false) => {
        if (typeof value !== 'string' || !value) return;
        if (bufferingTools && !replay) { pendingOutput.push({ key, value, thinking }); return; }
        let state = states.get(key);
        if (!state || state.closed) { state = { thinking }; states.set(key, state); }
        await delta(state, value);
      };
      const updateUsage = createOpenAIUsageUpdater(message.usage);
      for await (const event of sse(response)) {
        diagnose({stage:'event',type:event.type || (event.error ? 'error' : 'chat'),finish:event.choices?.[0]?.finish_reason || undefined,errorCode:event.error?.code,message:event.error?.message ? String(event.error.message).replaceAll(apiKey || '\0','[REDACTED]').slice(0,240) : undefined});
        if (event.error || event.type === 'error' || event.type === 'response.failed') {
          const upstreamError = event.error || event.response?.error || {};
          const code = String(upstreamError.code || '').toLowerCase();
          const status = Number(upstreamError.status);
          const invalid = status === 400 || code === 'invalid_request' || code === 'invalid_request_error';
          const error = new Error(upstreamMessage(upstreamError, invalid ? `Upstream rejected request (${code || 'invalid_request'})` : 'Upstream stream error'));
          error.status = invalid ? 400 : [401,403,404,429].includes(status) ? status : 502;
          error.apiType = invalid ? 'invalid_request_error' : 'api_error';
          throw error;
        }
        await startMessage();
        if (protocol === 'openai-chat') {
          updateUsage(event.usage);
          const choice = event.choices?.find(c => c.index === 0) || event.choices?.[0];
          if (!choice) continue;
          // Providers that put both fields in one chunk conventionally send
          // reasoning before the answer. Across chunks preserve observed order.
          if (choice.delta?.reasoning_content) await textual('chat:thinking', choice.delta.reasoning_content, true);
          if (choice.delta?.content) await textual('chat:text', choice.delta.content);
          for (const part of choice.delta?.tool_calls || []) {
            await close(opened);
            const state = tool(`chat:${part.index ?? 0}`);
            const mergeMetadata = (previous, next) => !previous ? next : next === previous ? previous : next.startsWith(previous) ? next : previous + next;
            if (part.id) state.id = mergeMetadata(state.id, part.id);
            if (part.function?.name) state.name = mergeMetadata(state.name, part.function.name);
            if (part.function?.arguments) { state.fragments ||= []; state.fragments.push(part.function.arguments); }
          }
          if (choice.finish_reason) { finished = true; reason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call' ? 'tool_use' : 'end_turn'; }
        } else {
          const key = `responses:${event.output_index ?? event.item?.id ?? event.item_id}`;
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') { await close(opened); const state = tool(key); state.id = event.item.call_id || event.item.id; state.name = event.item.name || ''; }
          if (event.type === 'response.output_text.delta') await textual(`text:${event.output_index ?? 0}:${event.content_index ?? 0}`, event.delta);
          const reasoningKey = `thinking:${event.output_index ?? 0}:${event.summary_index ?? event.content_index ?? 0}`;
          if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
            if (typeof event.delta === 'string' && event.delta) { reasoningSeen.add(reasoningKey); await textual(reasoningKey, event.delta, true); }
          }
          const doneReasoning = event.type === 'response.reasoning_summary_part.done' && event.part?.type === 'summary_text' ? event.part.text : event.type === 'response.reasoning_summary_text.done' || event.type === 'response.reasoning_text.done' ? event.text : null;
          if (!reasoningSeen.has(reasoningKey) && typeof doneReasoning === 'string' && doneReasoning) {
            reasoningSeen.add(reasoningKey); await textual(reasoningKey, doneReasoning, true);
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') {
            for (const [index, part] of (event.item.summary || []).entries()) {
              const rk = `thinking:${event.output_index ?? 0}:${index}`;
              if (part.type === 'summary_text' && !reasoningSeen.has(rk) && typeof part.text === 'string' && part.text) { reasoningSeen.add(rk); await textual(rk, part.text, true); }
            }
          }
          if (event.type === 'response.function_call_arguments.delta') tool(key).fragments.push(event.delta || '');
          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') { const state = tool(key); state.id ||= event.item.call_id || event.item.id; state.name ||= event.item.name || ''; if (!state.args && !state.fragments.length && event.item.arguments) state.fragments.push(event.item.arguments); }
          if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            if (event.response?.error || (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason !== 'max_output_tokens')) throw new Error('Upstream error');
            updateUsage(event.response?.usage); finished = true;
            reason = event.type === 'response.incomplete' ? 'max_tokens' : [...states.values()].some(s => s.tool) ? 'tool_use' : 'end_turn';
          }
        }
      }
      if (!finished) throw new Error('Upstream ended before completion');
      for (const part of pendingOutput) {
        if (part.state) {
          for (const fragment of part.state.fragments) await delta(part.state, fragment);
          await ensure(part.state);
          await close(part.state);
        } else await textual(part.key, part.value, part.thinking, true);
      }
      await close(opened);
      message.stop_reason = reason;
      await emit('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { ...message.usage } });
      await emit('message_stop', {});
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); } else res.end();
    } catch (error) { diagnose({stage:'failure',type:error.name,message:String(error.message).replaceAll(apiKey || '\0','[REDACTED]').slice(0,160)}); sendError(expired ? 504 : error.status || 502, error.apiType || 'api_error', expired ? 'Upstream request timed out' : error.status ? error.message : 'Upstream request failed'); }
    finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host === 'localhost' ? '127.0.0.1' : host, resolve); });
  const address = server.address(); let stopped;
  return { baseUrl: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`, stop() { if (!stopped) stopped = new Promise(resolve => { for (const c of controllers) c.abort(); server.close(resolve); for (const socket of sockets) socket.destroy(); }); return stopped; } };
}

module.exports = { startOpenAIGateway, convertAnthropicRequest: convertRequest };
