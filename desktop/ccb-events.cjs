// CCB stream-json frames -> transcript entries + UI events.
//
// Why this module exists: the shipped frontend renders a conversation from transcript
// entries shaped like the CLI's stream-json events (see session-kernel.cjs, which builds
// them from a finished turn). CCB streams the same information live, but in a different
// rhythm, and getting that rhythm wrong is what produces the classic "the reply appears
// three times" or "the reply never appears" bugs:
//
//   * ONE assistant API message arrives as SEVERAL frames. Measured (evidence/
//     agent-core-round100.md §2.2): a thinking block, then a tool_use block, both carrying
//     the SAME message.id and different uuids. Writing one entry per frame splits one reply
//     into two conversation rows.
//   * A tool round is assistant(tool_use) -> user(tool_result) -> assistant(text), so the
//     transcript is not "one user turn, one assistant turn"; it alternates.
//   * A result frame closes the turn, and the process then stays alive for the next turn.
//
// So this is a pure, deterministic mapper: frames in, entries + events out, no I/O, no
// clock, no process state. That makes the ordering rules testable against captured real
// frames instead of against a live model.
'use strict';

const DEFAULT_VERSION = '2.42304.0';

/** A stable identifier for a frame, so replaying the same capture cannot duplicate rows. */
function frameKey(frame) {
  if (frame && typeof frame.uuid === 'string' && frame.uuid) return `uuid:${frame.uuid}`;
  if (frame && frame.type === 'result' && typeof frame.session_id === 'string') {
    return `result:${frame.session_id}:${frame.num_turns}:${frame.duration_ms}`;
  }
  if (frame && frame.type === 'system' && frame.subtype === 'init') {
    return `init:${frame.session_id}:${frame.uuid || ''}`;
  }
  return null;
}

/** Blocks of an assistant/user message, defensively normalised. */
function contentBlocks(message) {
  if (!message) return [];
  if (Array.isArray(message.content)) return message.content.filter((b) => b && typeof b.type === 'string');
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return [];
}

/**
 * @param {{cwd?: string, sessionId?: string, version?: string, clock?: () => string}} opts
 */
function createCcbTranscriptMapper(opts = {}) {
  const cwd = opts.cwd || null;
  const sessionId = opts.sessionId || null;
  const version = opts.version || DEFAULT_VERSION;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();

  /** Transcript entries for the current turn, in order. Mutated in place as frames arrive. */
  let entries = [];
  /** uuid -> entry, so an assistant entry can be extended when a later frame carries more blocks. */
  const byUuid = new Map();
  /** assistant message.id -> entry, for merging a message that spans frames. */
  const byMessageId = new Map();
  /** tool_use_id -> { name, entryUuid } so a tool_result can be labelled. */
  const toolUses = new Map();
  /** Keys of frames already applied. */
  const seen = new Set();
  const steers = new Set();
  let meta = null;
  let unknownFrames = 0;
  let lastParentUuid = null;
  let usageBoundary = 0;

  function stamp() {
    try { return clock(); } catch { return null; }
  }

  function newEntry({ type, message, uuid, parentUuid }) {
    const entry = {
      parentUuid: parentUuid === undefined ? lastParentUuid : parentUuid,
      isSidechain: false,
      promptId: sessionId,
      type,
      message,
      uuid,
      timestamp: stamp(),
      cwd,
      sessionId,
      version,
    };
    lastParentUuid = uuid;
    return entry;
  }

  function assistantEntryFor(frame) {
    const messageId = frame.message && frame.message.id;
    if (messageId) {
      const existing = byMessageId.get(messageId);
      if (existing) return existing;
    } else if (frame.uuid) {
      // No message id but a frame uuid: the same frame resending more blocks must not create a
      // second row. (Real kernels always send message.id; this keeps a kernel that does not
      // from turning one reply into one row per block.)
      const existing = byMessageId.get(`uuid:${frame.uuid}`);
      if (existing) return existing;
    } else {
      // Neither id nor uuid: consecutive assistant frames are the same logical message.
      // A user/tool_result frame in between breaks the run, which is what makes the
      // tool-using turn lay out as user / assistant(tool_use) / user(tool_result) / assistant.
      const last = entries[entries.length - 1];
      if (last && last.type === 'assistant' && last.message && !last.message.id) return last;
    }
    const uuid = frame.uuid || `assistant-${entries.length}`;
    const entry = newEntry({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
      uuid,
    });
    if (messageId) byMessageId.set(messageId, entry);
    byUuid.set(entry.uuid, entry);
    entries.push(entry);
    return entry;
  }

  /** True when the block is already in the entry, so a re-sent frame is a no-op. */
  function hasBlock(entry, block) {
    return entry.message.content.some((existing) => {
      if (existing.type !== block.type) return false;
      if (block.type === 'text') return existing.text === block.text;
      if (block.type === 'tool_use') return existing.id === block.id;
      if (block.type === 'thinking') return existing.thinking === block.thinking;
      return JSON.stringify(existing) === JSON.stringify(block);
    });
  }

  // The shipped renderer consumes native stream-json envelopes via `message`, not
  // the legacy text_delta callback. Keep thinking/signature/tool deltas untouched.
  const activeStreams = new Map();
  const streamedText = new Set();
  function applyStream(frame) {
    const event = frame.event;
    if (!event || typeof event.type !== 'string') return [];
    const lane = frame.parent_tool_use_id || '';
    if (event.type === 'message_start') activeStreams.set(lane, event.message?.id);
    // The renderer stream store distinguishes null (top-level) from undefined.
    const envelope = { ...frame, session_id: frame.session_id || sessionId, parent_tool_use_id: frame.parent_tool_use_id ?? null };
    const events = [{ type: 'message', sessionId, message: envelope }];
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      const id = activeStreams.get(lane);
      if (id) streamedText.add(id);
      if (!lane) events.push({ type: 'text_delta', sessionId, text: event.delta.text });
    }
    return events;
  }

  function applyAssistant(frame) {
    const entry = assistantEntryFor(frame);
    const message = frame.message || {};
    // Provider accounting belongs to the API message, including usage-only updates.
    if (message.id) entry.message.id = message.id;
    if (message.model) entry.message.model = message.model;
    for (const key of ['stop_reason', 'stop_sequence']) {
      if (key in message) entry.message[key] = message[key];
    }
    for (const key of ['parent_tool_use_id', 'isApiErrorMessage']) {
      if (key in frame) entry[key] = frame[key];
    }
    if (message.usage && typeof message.usage === 'object') entry.message.usage = { ...entry.message.usage, ...message.usage };
    const events = [];
    const added = [];
    for (const block of contentBlocks(frame.message)) {
      if (hasBlock(entry, block)) continue;
      entry.message.content.push(block);
      added.push(block);

      if (block.type === 'text' && typeof block.text === 'string' && block.text && !streamedText.has(message.id)) {
        events.push({ type: 'text_delta', sessionId, text: block.text });
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        toolUses.set(block.id, { name: block.name, entryUuid: entry.uuid });
        events.push({ type: 'tool_request', sessionId, id: block.id, name: block.name, input: block.input || {} });
      }
    }
    // The message.id may not have been known when the entry was created (a frame without
    // one), so record it now for the next frame to find. The uuid fallback mirrors
    // assistantEntryFor, otherwise a later frame with the same uuid would miss the entry.
    if (frame.message && frame.message.id) byMessageId.set(frame.message.id, entry);
    else if (frame.uuid) byMessageId.set(`uuid:${frame.uuid}`, entry);
    return { changed: added.length || message.usage || 'stop_reason' in message || frame.isApiErrorMessage ? [entry] : [], events };
  }

  function applyUser(frame) {
    const blocks = contentBlocks(frame.message);
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    if (!toolResults.length) {
      // A plain user frame is the echo of what the host sent; the host already wrote its
      // own user entry, so recording it again would duplicate the prompt.
      return { changed: [], events: [] };
    }
    const uuid = frame.uuid || `toolresult-${entries.length}`;
    // The capture may split several results into one frame; keep them together, which is
    // what the transcript view expects (one user turn answering all pending tool_use).
    const entry = newEntry({
      type: 'user',
      message: { role: 'user', content: toolResults.map((block) => ({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        ...(block.is_error ? { is_error: true } : {}),
      })) },
      uuid,
    });
    byUuid.set(entry.uuid, entry);
    entries.push(entry);

    const events = [];
    for (const block of toolResults) {
      const known = toolUses.get(block.tool_use_id);
      events.push({
        type: 'tool_result',
        sessionId,
        id: block.tool_use_id,
        name: known ? known.name : undefined,
        isError: block.is_error === true,
        preview: String(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')).slice(0, 400),
      });
    }
    return { changed: [entry], events };
  }

  /**
   * Apply one frame.
   * @returns {{entries: object[], changed: object[], events: object[], done: boolean,
   *            unknown: boolean, duplicate: boolean, summary: object|null}}
   */
  function apply(frame) {
    const result = { entries, changed: [], events: [], done: false, unknown: false, duplicate: false, summary: null };
    if (!frame || typeof frame !== 'object') {
      unknownFrames++;
      result.unknown = true;
      return result;
    }

    const key = frameKey(frame);
    if (key) {
      if (seen.has(key)) {
        result.duplicate = true;
        return result;
      }
      seen.add(key);
    }

    switch (frame.type) {
      case 'stream_event':
        result.events = applyStream(frame);
        return result;
      case 'assistant': {
        const applied = applyAssistant(frame);
        result.changed = applied.changed;
        result.events = applied.events;
        return result;
      }
      case 'user': {
        const applied = applyUser(frame);
        result.changed = applied.changed;
        result.events = applied.events;
        return result;
      }
      case 'system': {
        if (frame.subtype === 'init') {
          meta = {
            sessionId: typeof frame.session_id === 'string' ? frame.session_id : sessionId,
            model: frame.model || null,
            tools: Array.isArray(frame.tools) ? frame.tools.slice() : [],
            permissionMode: frame.permissionMode || null,
            slashCommands: Array.isArray(frame.slash_commands) ? frame.slash_commands.slice() : [],
            claudeCodeVersion: frame.claude_code_version || null,
          };
          result.events = [{ type: 'meta', sessionId, meta }];
          return result;
        }
        // Other system frames (compaction status, hook events) carry no conversation
        // content; surfacing them as errors would make every run look broken.
        return result;
      }
      case 'result': {
        // CCB emits assistant frames before trailing message_delta usage arrives.
        // result.usage is per turn; modelUsage is session-cumulative and must not be summed.
        if (frame.usage && typeof frame.usage === 'object') {
          const assistants = entries.slice(usageBoundary).filter(entry => entry.type === 'assistant');
          if (assistants.length) {
            const last = assistants[assistants.length - 1];
            const turnId = frame.uuid || `${frame.session_id}:${frame.num_turns}:${frame.duration_ms}:${last.uuid}`;
            for (const entry of assistants) entry.ccdUsageTurnId = turnId;
            last.ccdTurnUsage = { ...frame.usage };
            result.changed = assistants;
          }
        }
        usageBoundary = entries.length;
        result.done = true;
        result.summary = {
          stopReason: frame.stop_reason || (frame.is_error ? 'error' : 'end_turn'),
          subtype: frame.subtype || null,
          isError: frame.is_error === true,
          numTurns: typeof frame.num_turns === 'number' ? frame.num_turns : null,
          usage: frame.usage || null,
          costUsd: typeof frame.total_cost_usd === 'number' ? frame.total_cost_usd : null,
          text: typeof frame.result === 'string' ? frame.result : '',
          sessionId: typeof frame.session_id === 'string' ? frame.session_id : sessionId,
        };
        result.events = [{
          type: 'turn_finished',
          sessionId,
          stopReason: result.summary.stopReason,
          text: result.summary.text,
          numTurns: result.summary.numTurns,
          costUsd: result.summary.costUsd,
        }];
        return result;
      }
      case 'control_response':
        // The initialize handshake. Worth exposing (the UI wants the model list) but it is
        // not conversation content.
        result.events = [{ type: 'control_response', sessionId, response: frame.response || null }];
        return result;
      default:
        unknownFrames++;
        result.unknown = true;
        return result;
    }
  }

  /** Finish the turn: the entries stay, the per-turn indexes reset so the next turn starts clean. */
  function resetTurn() {
    entries = [];
    byUuid.clear();
    byMessageId.clear();
    toolUses.clear();
    // The replay guard must reset too. It exists to stop the SAME capture being applied twice,
    // which is a per-turn property; keeping it across turns makes turn 2's frames look like
    // duplicates of turn 1's and silently drops them. A second turn that reuses a frame uuid
    // (a kernel restarting a session, or two turns from the same capture) is not a replay.
    seen.clear();
    activeStreams.clear();
    streamedText.clear();
    steers.clear();
    lastParentUuid = null;
    usageBoundary = 0;
  }

  function snapshot() {
    return {
      entries: entries.slice(),
      meta,
      unknownFrames,
      toolUses: new Map(toolUses),
    };
  }

  function appendSteer(frame) {
    if (steers.has(frame.uuid)) return;
    steers.add(frame.uuid);
    entries.push(newEntry({type:'user',uuid:frame.uuid,message:frame.message}));
  }
  return { apply, appendSteer, isSteer:uuid=>steers.has(uuid), resetTurn, snapshot, get entries() { return entries; } };
}

module.exports = { createCcbTranscriptMapper, DEFAULT_VERSION, frameKey, contentBlocks };
