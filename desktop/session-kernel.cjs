// Agent kernel bridge.
//
// The project already has a working kernel (desktop/agent.cjs driving an
// Anthropic-compatible endpoint with a tool set). Up to now it was only reachable
// from the hand-drawn view over HTTP (/api/run). The shipped frontend never saw
// it, because that frontend talks over EIPC bridge methods instead.
//
// This module adapts the existing kernel to the bridge contract the frontend
// uses:
//
//   LocalAgentModeSessions.start(info)              -> create a session
//   LocalAgentModeSessions.sendMessage(sessionId, message, ...) -> run one turn
//   LocalAgentModeSessions.getSession(sessionId)    -> read it back
//   LocalAgentModeSessions.getAll()                 -> list sessions
//
// and streams the turn back through the `onEvent` event channel.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { assertKernelBackend } = require('./kernel-backend.cjs');
// Frames -> transcript rows for the backend path. Without this the CCB path records only the
// user text and the final reply: a tool-using turn would reopen as "the assistant answered
// without looking", which is the exact bug the legacy path had before tool_use blocks were
// written into the transcript.
const { createCcbTranscriptMapper } = require('./ccb-events.cjs');
const { userContent } = require('./session-images.cjs');
const {warmUnattended} = require('./session-attendance.cjs');
const {resolveIdleTimeout} = require('./session-idle-policy.cjs');
const { projectMcpStatus } = require('./mcp-status-projection.cjs');
const { formatMcpError } = require('./mcp-error.cjs');
const { createMcpAuthBindingRegistry } = require('./mcp-auth-binding.cjs');
const { createMcpConfigEpochs } = require('./mcp-config-epochs.cjs');
const { createMcpSessionAuth } = require('./mcp-session-auth.cjs');
const { createMcpControlGate } = require('./mcp-control-gate.cjs');
const { createMcpSessionVerbs } = require('./mcp-session-verbs.cjs');
const { projectToolDisplayEvent, projectTranscriptEntry } = require('./tool-display.cjs');

/**
 * @param {{
 *   createAgent?: () => object,           // legacy path: returns { model, run, tools }
 *   backend?: object,                     // AgentKernelBackend (desktop/kernel-backend.cjs)
 *   emit: (event: object) => void,        // pushes to the onEvent channel
 *   log?: (msg: string) => void,
 *   storePath?: string,                   // where sessions persist across restarts
 * }} opts
 *
 * One of `createAgent` / `backend` must be supplied. Supplying both is refused
 * rather than silently preferring one: a caller that thinks it is driving the
 * CCB kernel while the local loop answers is the exact kind of quiet
 * mis-wiring this module has already been bitten by.
 */
/**
 * Collapse consecutive same-role messages into one.
 *
 * The transcript stores one row per BLOCK (an assistant tool_use, then the user's
 * tool_result, then the next assistant text), so mapping rows straight to messages produces
 * long runs of the same role. The Messages API requires alternating roles and rejects the
 * whole request otherwise:
 *
 *   API 400: tool calls and tool results do not match, please start a new conversation
 *
 * MEASURED on the real store: 42 of 149 sessions had such runs (the worst had 182 in 479 rows),
 * and sending to that session failed with the 400 above. Sessions under ~10 rows were fine,
 * which is why this went unnoticed — a short conversation never accumulates a run.
 *
 * Merging keeps every block and only removes the role boundary between them, which is the
 * shape the API wants for a tool_use / tool_result pair anyway: the assistant message carries
 * the tool_use, the following user message carries the tool_result.
 */
function mergeAdjacentRoles(messages) {
  const out = [];
  for (const m of messages) {
    const last = out.length ? out[out.length - 1] : null;
    if (!last || last.role !== m.role) {
      out.push({ role: m.role, content: Array.isArray(m.content) ? [...m.content] : m.content });
      continue;
    }
    // Same role: concatenate the blocks. A string content becomes a text block first so the
    // merged message keeps a uniform array shape.
    const toBlocks = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]);
    last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
  }
  return out;
}
function createSessionKernel({ createAgent = null, backend = null, emit, log = () => {}, storePath = null, idleTimeoutMs = null, idleClock = null, readFeatureValue = undefined, readFeatureOn = () => false, cliMcpDiscovery = null, mcpPollClock = null, historyImportResumeHost = null, trackCliInputObservations = false }) {
  if (backend === null && typeof createAgent !== 'function') {
    throw new TypeError('createSessionKernel needs a createAgent() or a backend');
  }
  if (backend !== null && typeof createAgent === 'function') {
    throw new TypeError('createSessionKernel takes createAgent() or a backend, not both');
  }
  if (backend !== null) assertKernelBackend(backend);
  const emitRaw = emit;
  emit = event => emitRaw(projectToolDisplayEvent(event));
  // Which kernel produced each session, so the UI can say it (and so a fallback
  // to LocalKernel is observable instead of invisible).
  const backendId = backend ? backend.id : null;
  /** sessionId -> session record */
  const sessions = new Map();
  // Transient observations; never substitute cumulative result.usage or estimates.
  const contextUsage = new Map();
  // SDK detail is expensive (multiple upstream token counts). Cache failures too.
  const contextDetail = new Map();
  const contextDetailIntervalMs = 60_000;
  async function getContextUsageDetail(id) {
    if (disposed || !sessions.has(id) || typeof backend?.getContextUsage !== 'function') return null;
    let actor;
    try { actor = backend.getInfo?.(id)?.actorToken; } catch { return null; }
    if (typeof actor !== 'string' || !actor) return null;
    const owner = sessionGenerations.get(id);
    const current = () => !disposed && sessions.has(id) && sessionGenerations.get(id) === owner && currentActorMatches(id, actor);
    let entry = contextDetail.get(id);
    if (entry?.actor !== actor || entry?.owner !== owner) {
      entry = { actor, owner, started: 0, promise: null, value: null };
      contextDetail.set(id, entry);
    }
    if (entry.promise) return entry.promise;
    if (entry.started && Date.now() - entry.started < contextDetailIntervalMs) return current() ? entry.value : null;
    entry.started = Date.now();
    entry.promise = (async () => {
      try {
        const value = await Promise.resolve().then(() => backend.getContextUsage(id, actor));
        if (!current() || contextDetail.get(id) !== entry || value?.actorToken !== actor) return null;
        entry.value = value;
        return value;
      } catch {
        if (contextDetail.get(id) === entry) entry.value = null;
        return null;
      } finally { entry.promise = null; }
    })();
    return entry.promise;
  }
  const draftWarms = new Map();
  const warming = new Map();
  const visibility = new Map();
  const pendingVisibility = new Map();
  const activity = new Map();
  // Actor-scoped status is transient and is never a CLI-app authorization list.
  const cliMcpStatuses = new Map();
  const scheduledWarms = new Map();
  let nextWarmSlot = 0;
  let disposed = false;
  const idleLifecycle = require('./warm-idle-lifecycle.cjs').createWarmIdleLifecycle({
    isQueryActive: id => hasActiveQuery(id) === true,
    getTimeoutMs: id => idleTimeoutMs !== null
      ? (typeof idleTimeoutMs === 'function' ? idleTimeoutMs(id) : idleTimeoutMs)
      : resolveIdleTimeout({unattended: warmUnattended(id, attendanceRecord)}, readFeatureValue),
    ...(idleClock ? {now: idleClock.now, setTimer: idleClock.setTimer, clearTimer: idleClock.clearTimer} : {
      setTimer: (fn, ms) => {const timer = setTimeout(fn, ms); timer.unref?.(); return timer;},
    }),
    onState: (id, state) => {if (state) activity.set(id, {...activity.get(id), ...state});},
    onDisconnect: async id => {
      if (disposed || !sessions.has(id) || isVisible(id) || warming.has(id) || pendingTurns.has(id) || sessions.get(id).isRunning || typeof backend?.evictSession !== 'function') return;
      const child = backend.getActiveProcesses().find(item => item.sessionId === id && item.idleEligible);
      if (!child) return;
      await backend.evictSession(id, {reason: 'idle_timeout', pid: child.pid, actorToken: child.actorToken, protectionVersion: child.protection?.version,
        validate: () => !disposed && sessions.has(id) && !isVisible(id) && !warming.has(id) && !pendingTurns.has(id) && !sessions.get(id).isRunning});
    },
  });
  function attendanceRecord(id) {
    const session = sessions.get(id);
    if (!session) return undefined;
    // Old replica stores use null for absent scheduler fields. Only this
    // boundary normalizes those values; the native pure predicate does not.
    return {...session, scheduledTaskId: session.scheduledTaskId ?? undefined,
      dispatchParentId: session.dispatchParentId ?? undefined,
      dispatchParentOrigin: session.dispatchParentOrigin ?? undefined};
  }
  // Serialize model changes and turns per session, preserving call order.
  const modelTurnQueues = new Map();
  const pendingTurns = new Map();
  // Both paths share ordering and withdrawal. start waits for admission to the
  // next turn. Ordinary busy sends acknowledge after their user echo is published.
  const deferredStarts = new Map();
  const heldAfterError = new Map();
  const maxDeferredStarts = 32;
  const sessionGenerations = new Map();
  // In-memory diagnostic only: an echo means the CLI reported seeing a UUID,
  // not that a model consumed it or that it is safe to replay.
  const cliInputObservations = new Map();
  function currentActorMatches(sessionId, actorToken) {
    try { return typeof actorToken === 'string' && !!actorToken && backend?.getInfo?.(sessionId)?.actorToken === actorToken; }
    catch { return false; }
  }
  const importConfirmations = new Map();
  const detachImportActorEvents = backendId === 'ccb' && typeof historyImportResumeHost?.confirm === 'function' && typeof backend?.onEvent === 'function' ? backend.onEvent(event => {
    const pending = importConfirmations.get(event?.sessionId);
    if (pending && ['query_installed', 'query_closed', 'actor_paused'].includes(event.type)) pending.invalid = true;
  }) : null;
  const heldMcpVerbs = new Map();
  const modelSelections = new Map();
  function generation(sessionId) {
    if (!sessionGenerations.has(sessionId)) sessionGenerations.set(sessionId, {});
    return sessionGenerations.get(sessionId);
  }
  function enqueueSession(sessionId, action) {
    const previous = modelTurnQueues.get(sessionId);
    let result;
    if (previous) result = previous.catch(() => {}).then(action);
    else {
      try { result = Promise.resolve(action()); }
      catch (error) { result = Promise.reject(error); }
    }
    const tail = result.then(() => {}, () => {});
    modelTurnQueues.set(sessionId, tail);
    tail.then(() => { if (modelTurnQueues.get(sessionId) === tail) modelTurnQueues.delete(sessionId); });
    return result;
  }
  function rejectDeferredStarts(id, reason) {
    const queue = deferredStarts.get(id);
    deferredStarts.delete(id);
    for (const entry of queue || []) entry.reject?.(new Error(reason));
  }
  function enqueueDeferredMessage(id, message, options, publishEcho = false) {
    const queue = deferredStarts.get(id) || [];
    const held = heldAfterError.get(id) || [];
    if (queue.length + held.length >= maxDeferredStarts) return Promise.reject(new Error('session start queue is full'));
    const pendingUuid = pendingTurns.get(id)?.messageUuid;
    const used = pendingUuid === options.messageUuid || backend?.getSteerUuids?.(id).includes(options.messageUuid) ||
      [...queue,...held].some(item => item.options.messageUuid === options.messageUuid);
    if (!publishEcho && used) return Promise.reject(new Error('message UUID is already pending'));
    if (publishEcho && (used || transcripts.get(id)?.some(row => row?.uuid === options.messageUuid))) {
      options.messageUuid = newRowUuid();
    }
    const entry = {owner:generation(id), message, options};
    if (!publishEcho) {
      deferredStarts.set(id, queue);
      return new Promise((resolve, reject) => queue.push({...entry, resolve, reject}));
    }
    options.images = structuredClone(options.images);
    const [text, ...images] = userContent(message, options.images);
    options.queuedAt = now();
    queue.push(entry);
    deferredStarts.set(id, queue);
    emit({type:'message', sessionId:id, message:{type:'user', uuid:options.messageUuid,
      session_id:sessions.get(id).cliSessionId || id, parent_tool_use_id:null, client_platform:'desktop_app',
      timestamp:options.queuedAt, message:{role:'user', content:images.length ? [...images, ...(text.text.trim() ? [text] : [])] : message}}});
    return Promise.resolve();
  }
  // The original coalesces ordinary deferred text at drain time. The first
  // wire UUID survives. Keep constituents addressable until this turn starts.
  function coalesceDeferredText(id, message, options) {
    const queue = deferredStarts.get(id);
    if (!options.queuedAt || !queue?.length) return message;
    const eligible = (text, opts) => opts.queuedAt && opts.plainInput && !opts.images?.length &&
      typeof text === 'string' && !text.includes('<session-mentions>') &&
      !/^[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB\uD800-\uDFFF]*[/!]/u.test(text);
    if (!eligible(message, options) || !queue.every(entry => eligible(entry.message, entry.options))) return message;
    deferredStarts.delete(id);
    return [message, ...queue.map(entry => entry.message)].filter(text => text.trim()).join('\n\n');
  }
  function unstartedTurn(id) {
    const pending = pendingTurns.get(id);
    return !disposed && pending && !pending.started && !pending.cancelled &&
      sessionGenerations.get(id) === pending.generation ? pending : null;
  }
  function getQueuedMessages(id) {
    const pending = unstartedTurn(id);
    return [
      ...(pending && !pending.promoted ? [{uuid:pending.messageUuid}] : []),
      ...(backend?.getSteerUuids?.(id) || []).map(uuid=>({uuid})),
      ...(deferredStarts.get(id) || []).map(entry => ({uuid:entry.options.messageUuid})),
      ...(heldAfterError.get(id) || []).map(entry => ({uuid:entry.options.messageUuid})),
    ];
  }
  // Admission to the serialized turn lane is not backend submission. A message
  // waiting behind setModel must remain cancellable until runMessage begins.
  function cancelQueuedMessage(id, uuid) {
    if (backend?.getSteerUuids?.(id).includes(uuid)) {
      const withdrawn = backend.withdrawSteer(id, uuid);
      // Written CCB steer cancellation returns a Promise; its existence does
      // not mean the CLI has acknowledged cancel_async_message. Only publish
      // withdrawal after an explicit successful result, never on a pending
      // or failed request.
      if (withdrawn && typeof withdrawn.then === 'function') {
        return Promise.resolve(withdrawn).then(confirmed => {
          if (confirmed === true) announceWithdrawn(id, uuid);
          return confirmed === true;
        });
      }
      if (withdrawn === true) announceWithdrawn(id, uuid);
      return withdrawn === true;
    }
    const active = pendingTurns.get(id);
    if (active?.started && active.promoted && active.messageUuid === uuid) return false;
    const pending = unstartedTurn(id);
    if (pending && pending.messageUuid === uuid) {
      pending.cancelled = true;
      const error = new Error('queued message cancelled'); error.name = 'QueuedMessageCancelledError';
      pending.rejectCancelled(error);
      if (!pending.promoted) { announceWithdrawn(id, uuid); return true; }
    }
    const held = heldAfterError.get(id);
    const source = held?.some(entry => entry.options.messageUuid === uuid) ? heldAfterError : deferredStarts;
    const queue = source.get(id);
    const index = queue?.findIndex(entry => entry.options.messageUuid === uuid) ?? -1;
    if (index < 0) return false;
    const [entry] = queue.splice(index, 1);
    if (!queue.length) source.delete(id);
    const error = new Error('queued message cancelled'); error.name = 'QueuedMessageCancelledError';
    entry.reject?.(error);
    if (source === heldAfterError) announceHeld(id);
    announceWithdrawn(id, uuid);
    return true;
  }
  /**
   * Tell the renderer a queued message was taken back.
   *
   * Without this the row stays visible: the transport maps the event to
   * `{kind:'held_withdrawn', uuids}` and the store's reducer (KE in c06cf64bb-CdJdJuVd.js)
   * tombstones those uuids, drops them from `heldInput`/`queuedSteered`/`queuedDeferred`, and
   * calls `messages.replaceAll` to rebuild the conversation without them. Returning `true` from
   * cancelQueuedMessage alone only tells the CALLER it succeeded; the conversation itself is
   * driven by this event, which the pinned original emits from three separate withdrawal paths.
   *
   * `session` is included for the same reason the original includes it: the reducer that clears
   * `heldHostRedial`/`heldLostNotice` runs off the event payload, and a session_updated alone
   * does not carry the withdrawal.
   */
  function announceWithdrawn(id, uuid) {
    const session = getSession(id);
    emit({ type: 'held_input_withdrawn', sessionId: id, withdrawnUuids: [uuid], session });
  }
  function reorderQueuedMessage(id, uuid, overUuid) {
    const held = heldAfterError.get(id);
    const queue = held?.some(entry => entry.options.messageUuid === uuid) ? held : deferredStarts.get(id);
    if (!queue) return false;
    const from = queue.findIndex(entry => entry.options.messageUuid === uuid);
    const to = queue.findIndex(entry => entry.options.messageUuid === overUuid);
    if (from < 0 || to < 0 || from === to) return false;
    const [entry] = queue.splice(from, 1);
    const target = queue.findIndex(item => item.options.messageUuid === overUuid);
    queue.splice(from < to ? target + 1 : target, 0, entry);
    if (queue === held) announceHeld(id);
    return true;
  }
  function announceHeld(id) {
    emit({type:'session_updated',sessionId:id,session:getSession(id)});
  }
  function rejoinHeld(id) {
    const held = heldAfterError.get(id);
    if (!held?.length || !running.has(id)) return false;
    heldAfterError.delete(id);
    deferredStarts.set(id,[...held,...(deferredStarts.get(id) || [])]);
    announceHeld(id);
    return true;
  }
  async function promoteHeldMessage(id, uuid) {
    const held = heldAfterError.get(id);
    const entry = held?.find(row => row.options.messageUuid === uuid);
    if (!entry || disposed || pendingTurns.has(id) || deferredStarts.has(id)) return false;
    if (typeof backend?.warm === 'function') await warmSession(id);
    const session = sessions.get(id);
    if (!session || session.isArchived || session.stoppedUntilPersonSends || (session.importedFrom && !session.resumeConfirmed) ||
        disposed || sessionGenerations.get(id) !== entry.owner || heldAfterError.get(id) !== held ||
        !held.includes(entry) || pendingTurns.has(id) || deferredStarts.has(id)) return false;
    // Keep it held while waiting behind model selection. A withdrawal during
    // that wait cancels admission, and a failed admission preserves the entry.
    return new Promise((resolve,reject) => {
      sendMessage(id,entry.message,{...entry.options,promotedEntry:entry},()=>{
        held.splice(held.indexOf(entry),1);
        if (!held.length) heldAfterError.delete(id);
        if (!rejoinHeld(id)) announceHeld(id);
        resolve(true);
      }).then(()=>resolve(false),error=>error.name==='QueuedMessageCancelledError'?resolve(false):reject(error));
    });
  }
  function drainDeferredStarts(id) {
    if (disposed || pendingTurns.has(id)) return;
    const queue = deferredStarts.get(id);
    if (!queue?.length) { deferredStarts.delete(id); return; }
    const entry = queue.shift();
    if (!queue.length) deferredStarts.delete(id);
    if (!sessions.has(id) || sessionGenerations.get(id) !== entry.owner) {
      entry.reject?.(new Error('session deleted'));
      queueMicrotask(() => drainDeferredStarts(id));
      return;
    }
    beginExistingStart(id, entry.message, entry.options).then(
      value => { entry.resolve?.(value); queueMicrotask(() => drainDeferredStarts(id)); },
      error => {
        if (entry.reject) entry.reject(error);
        else if (!disposed && entry.owner === sessionGenerations.get(id) && error.name !== 'QueuedMessageCancelledError') {
          emit({type:'error',sessionId:id,message:error.message});
        }
        queueMicrotask(() => drainDeferredStarts(id));
      },
    );
  }
  function beginExistingStart(id, message, options) {
    return new Promise((resolve, reject) => {
      let started = false;
      const turn = sendMessage(id, message, options, () => {
        started = true;
        resolve(publicSession(sessions.get(id)));
      });
      turn.then(result => {
        if (!started) reject(new Error(result?.error || result?.reason || 'session start did not deliver the message'));
      }, error => { if (!started) reject(error); else log(`existing session turn failed: ${error && error.message}`); });
    });
  }
  /** sessionId -> array of transcript entries (conversation content) */
  const transcripts = new Map();
  /** sessionId -> AbortController for the in-flight turn */
  const running = new Map();
  /**
   * sessionIds whose current turn has already produced output.
   *
   * Read by discardPendingTurn to decide whether a turn can still be taken back. Kept separate
   * from the session record because it is per-turn state that must not survive a restart: after
   * a relaunch there is no turn to unsend.
   */
  const turnProducedOutput = new Map();
  // Open tool-approval prompts: requestId -> entry, and requestId -> resolver.
  // A gated tool's promise settles only when the renderer answers or the turn is
  // cancelled, so both maps are cleared on cancel.
  const pendingApprovals = new Map();
  const approvalWaiters = new Map();
  let approvalSeq = 0;
  // How long a gated tool waits for a human. Without a bound, an approval nobody
  // answers (window closed mid-prompt) blocks the turn forever.
  const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

  const now = () => new Date().toISOString();
  // Timestamps in the session record are epoch milliseconds, not ISO strings:
  // a running original reports lastActivityAt as e.g. 1792319394134. The sidebar
  // sorts and groups by this value, so an ISO string leaves the list unable to
  // order entries and it renders the empty state instead.
  const nowMs = () => Date.now();
  const newId = () => `local_${crypto.randomUUID()}`;

  // ---- transcript row ids ---------------------------------------------------
  //
  // Transcript rows need a uuid, and the shape is not cosmetic: the shipped
  // frontend decides whether a message may be rewound or forked by testing it
  // against a canonical-UUID regex (c06cf64bb-CdJdJuVd.js, jN):
  //
  //   function jN(e){ return e.waitingLane!=="parked" && ps.test(e.id) }
  //   var ps=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  //
  // Rows used to be named "${sessionId}-${n}", which never matches, so the message
  // context menu never offered "Rewind to here" and forking from a message was gated
  // off. Measured in a running replica: canonicalCount 0, and the menu showed only
  // copy / attach-as-context. A real CLI transcript uses canonical uuids for the same
  // reason -- cli-transcript.cjs passes record.uuid straight through, so imported rows
  // already looked like this.
  //
  // These are plain random v4 uuids, NOT derived from the row index. The index was
  // never a contract: nothing sorts by uuid or parses its suffix, and conversation
  // order lives in the parentUuid chain plus array order. Deriving the id from
  // `existing.length` also produced DUPLICATE uuids inside a single turn, because
  // every row of that turn computed its suffix from the same stale length.
  const newRowUuid = () => crypto.randomUUID();

  // Old stores still hold "${sessionId}-${n}" ids, and they are left EXACTLY as they
  // are. Rewriting someone's on-disk history to change an id format is a migration with
  // no upside -- nothing here needs the new shape to READ a row -- and it would break
  // every parentUuid that pointed at an old value. Reading is format-agnostic:
  // parentUuid is compared as an opaque string, so a conversation written by the
  // previous build keeps rendering, rewinding and forking as before. Only rows created
  // from now on get the new shape.

  // A session record exposed to the renderer must not carry `messages`: the
  // original's session objects do not, and the detail view reads conversation
  // content from getTranscript instead.
  const publicSession = (session) => {
    const { updatedAt, loops: _transientLoops, sdkMcpServers: _transientMcp, ...rest } = session;
    delete rest.sendsHeldAfterError;
    const held = heldAfterError.get(session.sessionId);
    if (held?.length) rest.sendsHeldAfterError = held.map(entry => entry.options.messageUuid);
    if (typeof backend?.collectSessionLoops === 'function') rest.loops = backend.collectSessionLoops(session.sessionId);
    const mcpStatus = getCliMcpStatus(session.sessionId);
    if (mcpStatus) {
      const held=heldMcpVerbs.get(session.sessionId), seen=new Set();
      rest.sdkMcpServers=mcpStatus.servers.map(row=>{
        const first=!seen.has(row.name);seen.add(row.name);
        const item=first && row.status!=='pending' ? held?.get(row.name) : undefined;
        const pending=item?.actorToken===mcpStatus.actorToken && item?.generation===sessionGenerations.get(session.sessionId) ? item : undefined;
        const action=pending?.verb==='mcpClearAuth'?'clear-auth':pending?.verb==='mcpEnableServer'?'turn-on':
          pending?.verb==='mcpReconnect'||pending?.verb==='mcpRetryConnection'?'reconnect':undefined;
        return action ? {...row,pendingAction:action,...(pending.running?{pendingActionRunning:true}:{})} : row;
      });
    }
    // A session created without a folder has cwd/workingDir/originCwd === null, and the session
    // route cannot render that: MEASURED on the live store, opening such a session throws
    //
    //   TypeError: Cannot read properties of null (reading 'replace')
    //   [BOOTSTRAP] Fatal error boundary triggered  route=/epitaxy/$sessionId
    //
    // and the whole pane is replaced by "ran into a problem". 43 of the 198 stored sessions are
    // in that state (34 of them have real transcript rows), so this is not a corner case.
    //
    // `start({})` legitimately omits the folder, so the fix belongs on the way OUT rather than
    // on the way in: the record keeps its honest nulls in the store, and the renderer receives
    // the workspace root instead. The 34 null-checks already present in the shipped bundles all
    // read `cwd ?? null`, so a real path is strictly easier for them to handle than null.
    //
    // `folderless` is carried alongside so a caller that genuinely needs to know the session has
    // no folder can still tell — the substitution does not destroy that information.
    // Normalize each path independently: legacy cwd can be valid while workingDir is null.
    return require('./session-path-projection.cjs').projectSessionPaths(rest);
  };

  // Actor-owned loop changes can arrive while no foreground turn subscribes.
  const detachLoopEvents = typeof backend?.collectSessionLoops === 'function' ? backend.onEvent(event => {
    if (disposed || event?.type !== 'loops_changed' || !sessions.has(event.sessionId)) return;
    if (event.actorToken !== (backend.getInfo?.(event.sessionId)?.actorToken ?? null)) return;
    emit({type: 'session_updated', sessionId: event.sessionId, session: getSession(event.sessionId)});
  }) : null;

  const detachIdleEvents = typeof backend?.getActiveProcesses === 'function' ? backend.onEvent(event => {
    if (disposed || !sessions.has(event?.sessionId)) return;
    if (!['query_installed','query_closed','actor_paused'].includes(event.type)) return;
    if (event.actorToken !== (backend.getInfo?.(event.sessionId)?.actorToken ?? null)) return;
    if (event.type === 'query_installed') {replayPendingVisibility(event.sessionId); idleLifecycle.onQueryInstalled(event.sessionId);}
    else {
      idleLifecycle.markDisconnected(event.sessionId);
      if (event.type === 'actor_paused') {
        record(event.sessionId, {isRunning: false});
        emit({type: 'paused', sessionId: event.sessionId, session: getSession(event.sessionId)});
      }
    }
  }) : null;

  const mcpRepollDelays = [2000, 5000, 15000, 30000, 60000];
  const setMcpPollTimer = mcpPollClock?.setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; });
  const clearMcpPollTimer = mcpPollClock?.clearTimer ?? clearTimeout;
  function clearCliMcpRepoll(state) {
    if (state?.repoll?.timer !== undefined) clearMcpPollTimer(state.repoll.timer);
    if (state) state.repoll = undefined;
  }
  function scheduleCliMcpRepoll(sessionId, state, servers, firstOfProcess) {
    const repoll = state.repoll ??= { timer: undefined, nextAttempt: 0 };
    if (!(firstOfProcess && repoll.nextAttempt < 1) && !servers.some(server => server.status === 'pending')) {
      clearCliMcpRepoll(state);
      return;
    }
    if (repoll.timer !== undefined) return;
    const delay = mcpRepollDelays[repoll.nextAttempt];
    if (delay === undefined) { state.repoll = undefined; return; }
    repoll.timer = setMcpPollTimer(() => {
      repoll.timer = undefined;
      repoll.nextAttempt++;
      if (!disposed && cliMcpStatuses.get(sessionId) === state && state.repoll === repoll &&
          backend.getInfo?.(sessionId)?.actorToken === state.actorToken) refreshCliMcpStatus(sessionId).catch(() => {});
    }, delay);
  }

  function revokeCliMcpApps(sessionId, state) {
    if (!state) return;
    state.projection = (state.projection || 0) + 1;
    if (state.apps !== null && state.apps !== undefined) {
      const hadApps = state.apps.length > 0;
      state.apps = null;
      state.snapshot = null;
      if (hadApps) emit({ type: 'session_cli_mcp_servers', sessionId, sessionCliMcpServers: [] });
    }
  }

  function revokeIfCliMcpSourceStale(sessionId, state) {
    if (!state?.apps) return;
    try { if (cliMcpDiscovery?.isCurrent(state.snapshot) === true) return; } catch { /* source unavailable */ }
    revokeCliMcpApps(sessionId, state);
  }

  async function refreshCliMcpStatus(sessionId) {
    if (disposed || !sessions.has(sessionId) || typeof backend?.mcpServerStatus !== 'function') return false;
    const actorToken = backend.getInfo?.(sessionId)?.actorToken;
    if (typeof actorToken !== 'string' || !actorToken) return false;
    let state = cliMcpStatuses.get(sessionId);
    if (!state || state.actorToken !== actorToken) {
      const hadPublished = !!state?.servers;
      clearCliMcpRepoll(state);
      revokeCliMcpApps(sessionId, state);
      state = { actorToken, poll: 0, servers: null, configEpochs: createMcpConfigEpochs() };
      cliMcpStatuses.set(sessionId, state);
      if (hadPublished) emit({ type:'session_updated', sessionId, session:publicSession(sessions.get(sessionId)) });
    }
    const poll = ++state.poll;
    revokeIfCliMcpSourceStale(sessionId, state);
    try {
      const result = await backend.mcpServerStatus(sessionId, actorToken);
      if (disposed || !sessions.has(sessionId) || cliMcpStatuses.get(sessionId) !== state ||
          backend.getInfo?.(sessionId)?.actorToken !== actorToken || result?.actorToken !== actorToken || !Array.isArray(result.servers)) return false;
      if (state.poll !== poll) {
        // A newer in-flight poll may never finish. The original still schedules
        // its first follow-up when an older request succeeds for the same query.
        if (state.servers === null) scheduleCliMcpRepoll(sessionId, state, result.servers.filter(row => row && typeof row.status === 'string'), true);
        return false;
      }
      // Expose only a diagnostic projection; app descriptors remain unavailable
      // until the complete host/tenancy/plugin conflict sources are implemented.
      const firstOfProcess = state.servers === null;
      const previous = state.servers;
      const raw = structuredClone(result.servers);
      const projected = raw.filter(row => row && typeof row.name === 'string' && typeof row.status === 'string')
        .map(projectMcpStatus);
      state.configEpochs.update(raw);
      state.servers = projected;
      state.raw = raw;
      if (!isDeepStrictEqual(previous, projected)) emit({ type:'session_updated', sessionId, session:publicSession(sessions.get(sessionId)) });
      scheduleCliMcpRepoll(sessionId, state, state.servers, firstOfProcess);
      await refreshCliMcpApps(sessionId);
      flushHeldMcpVerbs(sessionId);
      return true;
    } catch {
      if (cliMcpStatuses.get(sessionId) === state && state.poll === poll) revokeIfCliMcpSourceStale(sessionId, state);
      return false;
    }
  }

  async function refreshCliMcpApps(sessionId) {
    const state = cliMcpStatuses.get(sessionId), session = sessions.get(sessionId);
    if (!state || !session || !state.raw || !cliMcpDiscovery || typeof cliMcpDiscovery.getSnapshot !== 'function' ||
        typeof cliMcpDiscovery.isCurrent !== 'function' || typeof cliMcpDiscovery.subscribe !== 'function') return false;
    revokeIfCliMcpSourceStale(sessionId, state);
    const poll = state.poll, token = state.actorToken, projection = state.projection = (state.projection || 0) + 1;
    const current = () => !disposed && sessions.get(sessionId) === session && cliMcpStatuses.get(sessionId) === state &&
      state.poll === poll && state.projection === projection && backend.getInfo?.(sessionId)?.actorToken === token;
    try {
      const snapshot = await cliMcpDiscovery.getSnapshot({ sessionId, actorToken: token });
      if (!current() || !snapshot || snapshot.complete !== true || snapshot.featureEnabled !== true || snapshot.sessionAllowed !== true ||
          !['coordinator', 'config', 'reserved', 'identities', 'session', 'tenantHistory', 'plugins'].every(key => snapshot.coverage?.[key] === true) ||
          !snapshot.tenancy || !['accountId', 'orgId'].every(key => Object.hasOwn(snapshot.tenancy, key) &&
            (snapshot.tenancy[key] === null || typeof snapshot.tenancy[key] === 'string')) ||
          // A SHAPE CHECK, NOT THE STRICTER RULE IN desktop/snapshot-shape.cjs — AND THE DIFFERENCE IS MEASURED
          //   That module rejects `NaN`, `Infinity`, `1.5`, `''` and a non-callable `isCurrent`; this line accepts all
          //   five (R556 measured 7 disagreements over 13 inputs). It is not the same rule: `snapshot.version` is never
          //   READ in this file — it appears here and nowhere else — so what this guard needs is "does the snapshot look
          //   like the kind I understand", while the stricter clauses protect a value a resumed import will persist and
          //   compare. Tightening this would reject snapshots for no benefit, since the extra clauses guard a value
          //   this file does not use.
          !['string', 'number'].includes(typeof snapshot.version) ||
          typeof snapshot.conflicts !== 'function' || typeof snapshot.cliRunsAsThisUser !== 'boolean' ||
          cliMcpDiscovery.isCurrent(snapshot) !== true) {
        if (current()) revokeIfCliMcpSourceStale(sessionId, state);
        return false;
      }
      const { filterCliMcpApps } = require('./cli-mcp-app-filter.cjs');
      const apps = filterCliMcpApps(state.raw, snapshot.conflicts).map(app => ({ ...app, tools: app.tools.map(tool => {
        const meta = tool._meta, ui = meta?.ui;
        return { ...tool, _meta: { ...(ui && typeof ui === 'object' ? { ui: Object.fromEntries(Object.entries(ui)
          .filter(([key]) => ['resourceUri', 'visibility', 'prefersBorder'].includes(key) || snapshot.cliRunsAsThisUser && key === 'csp')) } : {}),
          ...(meta?.['ui/resourceUri'] !== undefined ? { 'ui/resourceUri': meta['ui/resourceUri'] } : {}) } };
      }) }));
      if (JSON.stringify(apps).length > 1048576 || !current() || cliMcpDiscovery.isCurrent(snapshot) !== true) return false;
      const previous = Array.isArray(session.cliMcpAppServerNames) || session.cliMcpAppServerNames instanceof Set ? [...session.cliMcpAppServerNames] : [];
      const names = new Set();
      const register = name => {
        if (typeof name !== 'string') return false;
        if (!names.has(name) && names.size < 64 && name.length <= 256 && /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(name)) names.add(name);
        return names.has(name);
      };
      for (const name of previous) register(name);
      const accepted = apps.filter(app => register(app.name));
      const savedNames = [...names];
      if (!isDeepStrictEqual(savedNames, previous)) { session.cliMcpAppServerNames = savedNames; save(); }
      const changed = !isDeepStrictEqual(state.apps ?? [], accepted);
      state.apps = structuredClone(accepted);
      state.snapshot = snapshot;
      if (changed) emit({ type: 'session_cli_mcp_servers', sessionId, sessionCliMcpServers: structuredClone(accepted) });
      return true;
    } catch {
      if (current()) revokeIfCliMcpSourceStale(sessionId, state);
      return false;
    }
  }

  function getCliMcpApps(sessionId) {
    const state = cliMcpStatuses.get(sessionId);
    if (!state?.apps || disposed || !sessions.has(sessionId)) return null;
    if (backend?.getInfo?.(sessionId)?.actorToken !== state.actorToken) { revokeCliMcpApps(sessionId, state); return null; }
    try { if (cliMcpDiscovery?.isCurrent(state.snapshot) !== true) { revokeCliMcpApps(sessionId, state); return null; } }
    catch { revokeCliMcpApps(sessionId, state); return null; }
    return structuredClone(state.apps);
  }

  async function readCliMcpAppResource(sessionId, serverName, uri) {
    const unavailable = () => ({ contents: [], unavailable: 'not_connected' });
    const failed = () => ({ contents: [], unavailable: 'read_failed' });
    const state = cliMcpStatuses.get(sessionId), session = sessions.get(sessionId);
    if (!state || !session || !getCliMcpApps(sessionId) || typeof backend?.readMcpResource !== 'function') return unavailable();
    const app = state.apps.find(item => item.name === serverName);
    if (!app) return unavailable();
    if (typeof uri !== 'string' || !app.tools.some(tool => (tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri']) === uri)) return failed();
    const token = state.actorToken, poll = state.poll, projection = state.projection, snapshot = state.snapshot;
    const current = () => {
      try { return !disposed && sessions.get(sessionId) === session && cliMcpStatuses.get(sessionId) === state &&
        state.actorToken === token && state.poll === poll && state.projection === projection && state.snapshot === snapshot &&
        backend.getInfo?.(sessionId)?.actorToken === token && cliMcpDiscovery.isCurrent(snapshot) === true; }
      catch { return false; }
    };
    if (!current()) return unavailable();
    const { readCliMcpResource } = require('./cli-mcp-resource.cjs');
    const result = await readCliMcpResource({ serverName, uri, cliRunsAsThisUser: snapshot.cliRunsAsThisUser,
      read: async (name, resource) => {
        const reply = await backend.readMcpResource(sessionId, token, name, resource);
        if (reply?.actorToken !== token) throw new Error('stale MCP actor');
        return reply;
      } });
    return current() ? result : unavailable();
  }

  const detachMcpDiscovery = typeof cliMcpDiscovery?.subscribe === 'function' ? cliMcpDiscovery.subscribe(() => {
    for (const [sessionId, state] of cliMcpStatuses) {
      revokeCliMcpApps(sessionId, state);
      refreshCliMcpApps(sessionId).catch(() => {});
    }
  }) : null;

  function getCliMcpStatus(sessionId) {
    const state = cliMcpStatuses.get(sessionId);
    if (!state || disposed || !sessions.has(sessionId) || backend?.getInfo?.(sessionId)?.actorToken !== state.actorToken || !state.servers) return null;
    return { actorToken: state.actorToken, servers: state.servers.map(row => ({ ...row })) };
  }

  // This tracks changes visible in successful status polls only. It must not be
  // mistaken for an authoritative config-store generation between polls.
  function getCliMcpConfigEpoch(sessionId, actorToken, serverName) {
    const state = cliMcpStatuses.get(sessionId);
    if (!state || disposed || !sessions.has(sessionId) || state.actorToken !== actorToken ||
        backend?.getInfo?.(sessionId)?.actorToken !== actorToken) return undefined;
    return state.configEpochs.get(serverName);
  }

  // The full SDK status is private to this adapter; the public diagnostic
  // projection deliberately removes configuration and credentials.
  function getMcpVerbStatus(id) {
    const state = cliMcpStatuses.get(id);
    if (disposed || !sessions.has(id) || !state?.raw || backend?.getInfo?.(id)?.actorToken !== state.actorToken) return null;
    return { actorToken: state.actorToken, servers: state.raw.map(row => {
      const copy = structuredClone(row);
      if (!copy || typeof copy !== 'object') return copy;
      const projection = projectMcpStatus(copy);
      copy.transport = projection.transport;
      // Native origin classification needs the desktop coordinator, which is
      // not wired here. Do not treat an unknown dynamic source as a plugin.
      if (projection.scope === 'dynamic') copy.origin = 'unavailable';
      return copy;
    }) };
  }
  // Plugin URLs are accepted only after the current CCB status matches the
  // renderer claim, following the original session authentication contract.
  let mcpSessionAuth;
  const mcpAuthBindings = createMcpAuthBindingRegistry({
    getActor(id) {
      if (disposed || !sessions.has(id)) return null;
      return { actorToken: backend?.getInfo?.(id)?.actorToken, generation: generation(id) };
    },
    issueConfigAuth: proof => mcpSessionAuth?.getConfigAuthProof(proof),
    issueVerified: proof => mcpSessionAuth?.getPluginAuthProof(proof),
  });
  const mcpControlGate = createMcpControlGate({
    isCurrent: (id, token) => !disposed && sessions.has(id) && backend?.getInfo?.(id)?.actorToken === token,
  });
  const mcpControl = (method, id, token, name, ...args) =>
    mcpControlGate.run(id, token, name, () => {
      const item=heldMcpVerbs.get(id)?.get(name);
      if (method==='clearMcpAuth' && item?.verb==='mcpClearAuth' && item.running && item.actorToken===token) item.sent=true;
      return backend[method](id, token, name, ...args);
    });
  function queueMcpVerb(item) {
    if (disposed || !sessions.has(item.sessionId) || sessionGenerations.get(item.sessionId) !== item.generation ||
        backend?.getInfo?.(item.sessionId)?.actorToken !== item.actorToken) return false;
    let held=heldMcpVerbs.get(item.sessionId);
    if (!held) heldMcpVerbs.set(item.sessionId,held=new Map());
    let old=held.get(item.serverName);
    if (old && (old.actorToken!==item.actorToken || old.generation!==item.generation)) {
      held.delete(item.serverName);
      if (old.verb==='mcpClearAuth' && !old.sent) emit({type:'session_mcp_held_verb_failed',sessionId:item.sessionId,data:JSON.stringify({serverName:item.serverName,verb:'clear-auth',error:'Session not running',at:Date.now()})});
      old=undefined;
    }
    // Native queue keeps an existing clear ahead of a later reconnect.
    if (old && item.verb==='mcpReconnect' && old.verb==='mcpClearAuth') return true;
    if (!old || old.verb!==item.verb || old.running) {
      held.set(item.serverName,{...item,blockedBy:old?.running?old:old?.blockedBy});
      emit({type:'session_updated',sessionId:item.sessionId,session:publicSession(sessions.get(item.sessionId))});
    }
    return true;
  }
  mcpSessionAuth = createMcpSessionAuth({
    getActor(id) {
      if (disposed || !sessions.has(id)) return null;
      return { actorToken: backend?.getInfo?.(id)?.actorToken, generation: generation(id) };
    },
    getStatus: getMcpVerbStatus,
    getConfigRevision(id, name, token, owner) {
      return sessions.has(id) && sessionGenerations.get(id) === owner ? getCliMcpConfigEpoch(id, token, name) : undefined;
    },
    getAuthBinding: (id, name, token) => mcpAuthBindings.get(id, name, token),
    establishVerified: (id, name, token) => mcpAuthBindings.establishVerified(id, name, token),
    resetConfigAuth: (id, name, token, owner) => mcpAuthBindings.resetConfigAuth(id, name, token, owner),
    async refreshStatus(id, token) {
      if (backend?.getInfo?.(id)?.actorToken !== token || !await refreshCliMcpStatus(id)) return null;
      return getMcpVerbStatus(id);
    },
    isLocal(id) {
      const session = sessions.get(id);
      return !!session && backendId === 'ccb' && !session.remoteTarget && !session.backend?.remoteTarget;
    },
    controlRequestsWait: id => !!pendingTurns.get(id) || !!running.get(id) || !!sessions.get(id)?.isRunning,
    queue: queueMcpVerb,
    ...(typeof backend?.authenticateMcpServer === 'function' ? { authenticate: (...args) => mcpControl('authenticateMcpServer', ...args) } : {}),
    ...(typeof backend?.submitMcpOAuthCallback === 'function' ? { submitCallback: (...args) => mcpControl('submitMcpOAuthCallback', ...args) } : {}),
    ...(typeof backend?.clearMcpAuth === 'function' ? { clear: (...args) => mcpControl('clearMcpAuth', ...args) } : {}),
    formatError: formatMcpError,
  });
  async function mcpAuthenticateConfigServer(id, name) {
    const token = backend?.getInfo?.(id)?.actorToken, owner = sessionGenerations.get(id);
    const result = await mcpSessionAuth.mcpAuthenticateConfigServer(id, name);
    if (result?.error !== undefined) return result;
    if (!mcpAuthBindings.establishConfigAuth(id, name, token)) {
      mcpSessionAuth.invalidate(id, name, token, owner);
      return { error: "Couldn't verify server config. Click Connect first." };
    }
    return result;
  }
  async function mcpClearAuth(id, name) {
    const token = backend?.getInfo?.(id)?.actorToken;
    const before = mcpAuthBindings.get(id, name, token);
    const result = await mcpSessionAuth.mcpClearAuth(id, name);
    if (backend?.getInfo?.(id)?.actorToken === token && (!result?.error || (before?.kind === 'config-auth' && !before.isCurrent()))) {
      mcpAuthBindings.revoke(id, name, token);
      if (!result?.error) await refreshCliMcpStatus(id);
    }
    return result;
  }
  const mcpVerbs = createMcpSessionVerbs({
    formatError: formatMcpError,
    getSession: id => sessions.get(id),
    getActorToken: id => backend?.getInfo?.(id)?.actorToken,
    getSessionGeneration: id => sessions.has(id) ? generation(id) : undefined,
    isSupportedSession: (_id, session) => backendId === 'ccb' && !session.remoteTarget && !session.backend?.remoteTarget,
    getStatus: getMcpVerbStatus,
    async refreshStatus(id, token) {
      if (backend?.getInfo?.(id)?.actorToken !== token || !await refreshCliMcpStatus(id)) return null;
      return getMcpVerbStatus(id);
    },
    controlRequestsWait: id => !!pendingTurns.get(id) || !!running.get(id) || !!sessions.get(id)?.isRunning,
    queue: queueMcpVerb,
    ...(typeof backend?.toggleMcpServer === 'function' ? { toggle: (...args) => mcpControl('toggleMcpServer', ...args) } : {}),
    ...(typeof backend?.reconnectMcpServer === 'function' ? { reconnect: (...args) => mcpControl('reconnectMcpServer', ...args) } : {}),
    getAuthBinding: (id, name, token) => mcpAuthBindings.get(id, name, token),
    completeReconnect(id, name, token, binding) {
      const completed = mcpAuthBindings.completeReconnect(id, name, token, binding);
      if (completed) mcpSessionAuth.invalidate(id, name, token, sessionGenerations.get(id));
      return completed;
    },
  });
  function flushHeldMcpVerbs(id) {
    const held = heldMcpVerbs.get(id), status = getMcpVerbStatus(id);
    if (!held || !status || pendingTurns.has(id) || running.has(id) || sessions.get(id)?.isRunning) return;
    for (const [name, item] of held) {
      if (item.running) continue;
      if (item.blockedBy?.running) continue;
      item.blockedBy = undefined;
      if (sessionGenerations.get(id) !== item.generation || status.actorToken !== item.actorToken) {
        held.delete(name);
        if (item.verb==='mcpClearAuth') emit({type:'session_mcp_held_verb_failed',sessionId:id,data:JSON.stringify({serverName:name,verb:'clear-auth',error:'Session not running',at:Date.now()})});
        emit({type:'session_updated',sessionId:id,session:publicSession(sessions.get(id))});
        continue;
      }
      const row = status.servers.find(server => server?.name === name);
      if (row?.status === 'pending') continue;
      if (item.verb==='mcpClearAuth' && row && !row.transport) continue;
      if (!row) {
        held.delete(name);
        if (item.verb==='mcpClearAuth'||item.verb==='mcpEnableServer') emit({type:'session_mcp_held_verb_failed',sessionId:id,data:JSON.stringify({serverName:name,verb:item.verb==='mcpClearAuth'?'clear-auth':'turn-on',error:'Unknown MCP server for this session',at:Date.now()})});
        emit({type:'session_updated',sessionId:id,session:publicSession(sessions.get(id))});
        continue;
      }
      item.running = true;
      emit({type:'session_updated',sessionId:id,session:publicSession(sessions.get(id))});
      const invoke=item.verb==='mcpClearAuth'?mcpClearAuth:mcpVerbs[item.verb];
      Promise.resolve(invoke(id, name)).then(result => {
        item.running = false;
        if (held.get(name) === item) held.delete(name);
        if (result?.error && !result.queued && sessions.has(id) && sessionGenerations.get(id) === item.generation && backend?.getInfo?.(id)?.actorToken === item.actorToken) {
          emit({ type: 'session_mcp_held_verb_failed', sessionId: id,
            data: JSON.stringify({ serverName: name, verb: item.verb==='mcpClearAuth'?'clear-auth':item.verb==='mcpEnableServer'?'turn-on':'reconnect', error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}), at: Date.now() }) });
        }
        if (sessions.has(id)) emit({type:'session_updated',sessionId:id,session:publicSession(sessions.get(id))});
        if (!held.size && heldMcpVerbs.get(id) === held) heldMcpVerbs.delete(id);
        else if (heldMcpVerbs.get(id) === held) flushHeldMcpVerbs(id);
      }).catch(() => {
        item.running = false;
        if (held.get(name) === item) held.delete(name);
        if (sessions.has(id)) emit({type:'session_updated',sessionId:id,session:publicSession(sessions.get(id))});
        if (!held.size && heldMcpVerbs.get(id) === held) heldMcpVerbs.delete(id);
        else if (heldMcpVerbs.get(id) === held) flushHeldMcpVerbs(id);
      });
    }
    if (!held.size && heldMcpVerbs.get(id) === held) heldMcpVerbs.delete(id);
  }

  const detachMcpEvents = typeof backend?.mcpServerStatus === 'function' ? backend.onEvent(event => {
    if (disposed || !sessions.has(event?.sessionId)) return;
    if (event.type === 'query_installed') {
      if (event.actorToken && event.actorToken === backend.getInfo?.(event.sessionId)?.actorToken) {
        refreshCliMcpStatus(event.sessionId).catch(() => {});
      }
    } else if ((event.type === 'query_closed' || event.type === 'actor_paused') &&
      event.actorToken === (backend.getInfo?.(event.sessionId)?.actorToken ?? null)) {
      const held=heldMcpVerbs.get(event.sessionId);
      if (held) for (const [name,item] of held) if (item.verb==='mcpClearAuth' && !item.sent) {
        emit({type:'session_mcp_held_verb_failed',sessionId:event.sessionId,data:JSON.stringify({serverName:name,verb:'clear-auth',error:'Session not running',at:Date.now()})});
      }
      heldMcpVerbs.delete(event.sessionId);
      mcpAuthBindings.retireSession(event.sessionId);
      mcpSessionAuth.retireSession(event.sessionId);
      mcpControlGate.retireSession(event.sessionId);
      clearCliMcpRepoll(cliMcpStatuses.get(event.sessionId));
      revokeCliMcpApps(event.sessionId, cliMcpStatuses.get(event.sessionId));
      cliMcpStatuses.delete(event.sessionId);
      emit({ type:'session_updated', sessionId:event.sessionId, session:publicSession(sessions.get(event.sessionId)) });
    }
  }) : null;

  // How many records load() had to backfill; acted on once save() is in scope.
  let loadBackfilled = 0;

  // Sessions used to live only in memory, so every restart silently discarded the
  // conversation list and the sidebar showed "Sessions you start will show up here"
  // while the kernel had nothing to offer. Persist them next to the app data.
  const load = () => {
    if (!storePath) return;
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      let backfilled = 0;
      for (const s of parsed.sessions || []) {
        if (s && s.sessionId) {
          // Backfill workingDir/originCwd for records written before those fields
          // existed. Without this, sessions created by an older build keep an empty
          // Files tree even though their cwd is on disk and listable.
          const dir = s.cwd ?? null;
          const needsBackfill = s.workingDir === undefined || s.originCwd === undefined;
          if (needsBackfill) backfilled += 1;
          sessions.set(s.sessionId, {
            ...s,
            ...(s.desktopGoal?.status === 'active' ? {desktopGoal:{...s.desktopGoal,status:'paused'}} : {}),
            ...(s.workingDir === undefined ? { workingDir: dir } : {}),
            ...(s.originCwd === undefined ? { originCwd: dir } : {}),
            isRunning: false,
            // An approval request lives in the RUNNING kernel, not on disk. After a restart
            // nothing can answer it, so a persisted one is permanently stuck: the session
            // shows "needs input" forever and respondToToolPermission answers
            // {ok:false, reason:'no such request'} because the request it names does not
            // exist in this process. Measured: one session sat "needs input" for 34 minutes
            // across three restarts, with pendingToolPermissions holding ["perm_1"].
            //
            // Clearing it is the only honest state: the tool call it belonged to died with
            // the previous process (the turn cannot still be running — isRunning is forced
            // false right here).
            pendingToolPermissions: [],
          });
        }
      }
      for (const [id, entries] of Object.entries(parsed.transcripts || {})) {
        if (Array.isArray(entries)) transcripts.set(id, entries);
      }
      log(`loaded ${sessions.size} session(s) from store`);
      // The backfill above only lived in memory: `save()` is triggered by record(), which
      // load never calls. Without this the fields were re-added on every start and never
      // written, so the next process would backfill the same records again.
      loadBackfilled = backfilled;
    } catch (error) {
      log(`session store unreadable: ${error && error.message}`);
    }
  };

  // Writes are coalesced and atomic.
  //
  // `record()` fires on every mutation, and one turn mutates several times, so a
  // naive writeFileSync raced against itself and failed with
  //   EPERM: operation not permitted, open '...kernel-sessions.json'
  // even though the file was writable. A pending flag collapses bursts into one
  // write, and writing to a temp file then renaming avoids a half-written store.
  let saveTimer = null;
  let savePending = false;
  // Set when a write fails and cleared by the next successful one, so the renderer hears
  // about an unwritable store once rather than on every mutation.
  let persistFailureReported = false;

  const writeNow = () => {
    savePending = false;
    if (!storePath) return true;
    const tmp = `${storePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const payload = {
        version: 2,
        savedAt: now(),
        sessions: [...sessions.values()].map((s) => ({
          ...s,
          // A turn cannot still be running after a restart.
          isRunning: false,
        })),
        transcripts: Object.fromEntries(transcripts),
      };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, storePath);
      if (persistFailureReported) {
        persistFailureReported = false;
        emit({ type: 'persist_recovered', sessionId: null, path: storePath });
      }
      return true;
    } catch (error) {
      log(`session store write failed: ${error && error.message}`);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
      // Tell the renderer, once per failure streak.
      //
      // Measured before this existed: a store that could not be written logged two lines and
      // emitted NO event. The turn completed normally, so the user had every reason to
      // believe it was saved — and found the whole conversation gone after a restart.
      //
      // Emitted at most once until a write succeeds, so a full disk does not produce one event
      // per keystroke.
      if (!persistFailureReported) {
        persistFailureReported = true;
        emit({
          type: 'persist_failed',
          sessionId: null,
          reason: error && error.message ? String(error.message) : 'unknown error',
          path: storePath,
        });
      }
      return false;
    }
  };

  const save = () => {
    if (!storePath) return;
    if (savePending) return;
    savePending = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, 50);
  };

  /** Flush any pending write immediately (used on shutdown). */
  const flush = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (savePending) writeNow();
  };

  load();
  for (const id of sessions.keys()) idleLifecycle.register(id);

  // Persist a backfill so it is not repeated on every start.
  //
  // `load()` runs before `save()` exists in source order but after it is defined at call
  // time, so the count is collected in `load()` and acted on here.
  if (loadBackfilled > 0) {
    log(`backfilled workingDir/originCwd on ${loadBackfilled} session(s); persisting`);
    save();
  }

  function record(id, patch) {
    const base = sessions.get(id);
    if (!base) return null;
    const next = { ...base, ...patch, updatedAt: nowMs() };
    sessions.set(id, next);
    // Every mutation funnels through here, so one save keeps the store in step
    // with the sidebar and survives a restart.
    save();
    return next;
  }

  /**
   * Create a session. `info` is whatever the frontend passes to start(); the
   * fields that matter here are the working folder, the title and — critically —
   * the first message.
   *
   * The landing composer does NOT call sendMessage after start(). It passes the
   * text as `message` inside the start payload and expects the session to begin
   * with that turn, streaming events for the transcript it already opened. An
   * earlier version dropped `message` on the floor, which is why creating a
   * session from the landing page produced a session with an empty transcript and
   * no reply: everything looked created, and nothing was ever asked.
   */
  // The model a new session starts on.
  //
  // MEASURED BUG: this used to be the hard-coded literal 'claude-sonnet-5-5'. On a gateway that
  // does not serve that model, EVERY new session failed its first message with
  //   API 503: No available channel for model claude-sonnet-5-5
  // while the process config was correctly pointing at a working model. The launcher already
  // sets CLAUDE_AGENT_MODEL from the resolved profile; the kernel simply never read it.
  //
  // Order: the environment (which the launcher fills from the provider profile), then the
  // conventional ANTHROPIC_MODEL, then the literal only as a last resort so the field is never
  // empty — an empty model would be rejected later with a vaguer error.
  function defaultSessionModel() {
    const fromEnv = [process.env.CLAUDE_AGENT_MODEL, process.env.ANTHROPIC_MODEL]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find(Boolean);
    return fromEnv || 'claude-sonnet-5-5';
  }

  function start(info = {}) {
    if (disposed) return Promise.reject(new Error('session kernel disposed'));
    // The composer prewarms a session first and then passes that prewarm id back
    // in as `sessionId`. Honouring it keeps the id the renderer is already
    // displaying as its route; inventing a fresh one made the route and the kernel
    // disagree about which session was open.
    const requested = typeof info.sessionId === 'string' && info.sessionId ? info.sessionId : null;
    const id = requested || newId();
    // The original resumes an existing session for an exact ID. Preserve its
    // record and transcript. The existing turn queue and import gate apply to
    // resumed sends just as they do to sendMessage.
    const existing = sessions.get(id);
    if (existing) {
      const first = typeof info.message === 'string' ? info.message : '';
      if (first.trim() || (Array.isArray(info.images) && info.images.length)) {
        const refusal = importedSendRefusal(existing, {});
        if (refusal) return refusal;
        let options;
        try {
          userContent(first, info.images);
          const supplied = info.messageUuid;
          options = {messageUuid:typeof supplied === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supplied) ? supplied : newRowUuid(), images:structuredClone(info.images)};
        }
        catch (error) { return Promise.reject(error); }
        if (pendingTurns.has(id) || deferredStarts.has(id)) {
          return enqueueDeferredMessage(id, first, options);
        }
        return beginExistingStart(id, first, options);
      }
      return publicSession(sessions.get(id));
    }
    let draft = draftWarms.get(id);
    if (draft) {
      draftWarms.delete(id);
      const desiredCwd = info.cwd || info.folder || (Array.isArray(info.userSelectedFolders) && info.userSelectedFolders[0]) || null;
      const desiredModel = info.model || defaultSessionModel();
      const desiredMode = info.permissionMode === 'default' || !info.permissionMode ? 'acceptEdits' : info.permissionMode;
      if (draft.cwd !== desiredCwd || draft.model !== desiredModel || draft.permissionMode !== desiredMode) {
        backend?.removeSession?.(id);
        draft = null;
      }
    }
    const folder = typeof info.cwd === 'string' ? info.cwd
      : typeof info.folder === 'string' ? info.folder
      : (Array.isArray(info.userSelectedFolders) && info.userSelectedFolders[0]) || null;

    // Field set matched to a running original's session object. The detail view and
    // the sidebar read these by name; a session carrying only {sessionId, cwd, ...}
    // renders as an empty shell. The original has no `messages` field at all —
    // conversation content comes from getTranscript.
    const session = {
      sessionId: id,
      cwd: folder,
      // workingDir / originCwd: the same directory under the names the frontend reads.
      //
      // The Files pane resolves its tree root as (cccc2cf0a-JnTR9JZB.js, `Nx`):
      //   A = lister?.root ?? data?.workingDir ?? landingRoot ?? ""
      // This build has no `lister` (that is the unimplemented Launch surface) and no
      // landingRoot for a normal session, so with `workingDir` missing the root became ""
      // and the tree rendered "Folder is empty" while FileSystem.listDirectory answered 65
      // entries for the very same path.
      //
      // The shipped record carries both names (c5da7eb42-C19nHyJe.js):
      //   { ..., originCwd: e.session_context?.cwd || e.bridge_spawn_path,
      //         workingDir: e.session_context?.cwd || e.bridge_spawn_path }
      // and c73f45bc3-C_1lE02e.js lists them among the session fields it keys on.
      // `cwd` stays as well: other call sites read it directly.
      workingDir: folder,
      originCwd: folder,
      // The original always has a CLI session id: it is the Claude Code session
      // this local session is attached to. A null here reads as "not yet started".
      cliSessionId: info.ccbResume?.cliSessionId || draft?.cliSessionId || crypto.randomUUID(),
      ...(info.ccbResume ? {ccbResume:info.ccbResume} : {}),
      userSelectedFolders: folder ? [folder] : [],
      isRunning: false,
      createdAt: nowMs(),
      lastActivityAt: nowMs(),
      model: info.model || defaultSessionModel(),
      effortLevel: info.effortLevel || 'medium',
      // The composer shows "Fast mode off/on" from this. Absent meant the control had
      // nothing to read, so it always rendered off and setFastMode had nowhere to write.
      fastMode: info.fastMode === true,
      // The composer sends 'default' when the user has not overridden the folder's
      // mode. 'default' means 'follow the account default', which this build has no
      // source for, so it resolved to ask and every Write prompted — while the
      // composer's own label could read 自动. Recording the resolved mode instead keeps
      // the session record and the approval decision in agreement.
      permissionMode: info.permissionMode === 'default' || !info.permissionMode ? 'acceptEdits' : info.permissionMode,
      chromePermissionMode: null,
      isArchived: false,
      title: typeof info.title === 'string' ? info.title : undefined,
      homePath: folder,
      folderExists: folder ? true : null,
      pendingToolPermissions: [],
      error: null,
      // The original reports an empty string here, not null.
      initialMessage: '',
      enabledMcpTools: [],
      withheldConnectorHosts: [],
      scheduledTaskId: typeof info.scheduledTaskId === 'string' ? info.scheduledTaskId : null,
      ...(typeof info.dispatchParentId === 'string' ? {dispatchParentId: info.dispatchParentId} : {}),
      ...(typeof info.dispatchParentOrigin === 'string' ? {dispatchParentOrigin: info.dispatchParentOrigin} : {}),
      ...(typeof info.scheduledTaskId === 'string' ? {scheduledRunContinued: info.scheduledRunContinued === true || info.scheduledTaskManualStart === true} : {}),
      spaceId: null,
      spaceIdSetBy: null,
      userSelectedProjectUuids: [],
      isStarred: false,
      sessionType: 'local',
      // Which kernel runs this session. Null on the legacy path, so a record
      // written before this field existed still reads truthfully.
      kernelBackend: backendId,
      parentSessionId: null,
      mountedProjects: [],
      cuSelectedDisplayId: null,
      hostLoopMode: null,
      servesUiSurface: false,
      needsResumeConfirm: false,
      // Kept out of the public shape: the original does not expose it.
      updatedAt: nowMs(),
    };
    const pendingImport = importConfirmations.get(id);
    if (pendingImport) pendingImport.replaced = true;
    sessions.set(id, session);
    idleLifecycle.register(id);
    replayPendingVisibility(id);
    // Conversation content lives apart from the session record, mirroring the
    // original's split between the session list and getTranscript.
    transcripts.set(id, Array.isArray(info.initialTranscript) ? structuredClone(info.initialTranscript) : []);
    // Let the backend know about the session up front. A backend that has to
    // spawn something (the CCB child process) can do it here rather than paying
    // the cost on the first turn; a backend that needs nothing answers instantly.
    if (backend) {
      try {
        backend.start({ sessionId: id, cwd: backendId === 'ccb' ? folder || process.env.CLAUDE_WORKSPACE || process.cwd() : folder,
          model: session.model, permissionMode: session.permissionMode,
          ...(backendId === 'ccb' ? { cliSessionId: session.cliSessionId,
            ...(info.ccbResume ? {ccbResume:info.ccbResume,resume:true} : {}) } : {}),
        });
      } catch (error) {
        // A backend that cannot start must not lose the session record: the
        // renderer is already navigating to it. The failure surfaces on the turn
        // and through the session's error field.
        log(`backend start failed: ${error && error.message}`);
        record(id, { error: String(error && error.message) });
      }
    }
    save();
    log(`session created ${id}`);
    // The renderer keys its transcript off `start` (not a synthetic
    // session_started), then waits for `message` events carrying stream-json
    // entries. Both are pushed so an already-mounted detail view attaches.
    emit({ type: 'start', sessionId: id, session });
    emit({ type: 'session_updated', sessionId: id, session });

    // The first turn. The composer only sends it here, so a start without this
    // leaves a created-but-empty session and the UI waiting forever for a reply.
    const first = typeof info.message === 'string' ? info.message : '';
    if (first.trim() || (Array.isArray(info.images) && info.images.length)) {
      // Deliberately not awaited: start() must resolve the session record promptly
      // (the caller paints from its return value), while the turn streams through
      // the event channel exactly as a later sendMessage would.
      sendMessage(id, first, { messageUuid: info.messageUuid, images: info.images }).catch((error) => {
        log(`first turn failed: ${error && error.message}`);
      });
    }
    return publicSession(session);
  }

  /**
   * Run one turn through whichever kernel is wired in.
   *
   *   legacy  : one agent instance, `agent.run` streams through the callback;
   *   backend : `backend.sendMessage` owns the turn and streams through its own
   *             event hub, which is subscribed for exactly this turn.
   *
   * Both must answer `{ text, stopReason }`. Everything durable — transcript,
   * session record, approvals, persistence — stays below in sendMessage; that is
   * the boundary documented in kernel-backend.cjs.
   */
  async function runTurn({ agent, sessionId, message, turnOptions, controller, onEvent, sessionGeneration }) {
    if (!backend) {
      // Local runners can ignore abort. Release this turn on cancellation while
      // discarding any late events from the abandoned run.
      turnOptions.onEvent = (event) => { if (!controller.signal.aborted) onEvent(event); };
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('aborted'));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try { return await Promise.race([agent.run(turnOptions), aborted]); }
      finally { controller.signal.removeEventListener('abort', onAbort); }
    }
    // Subscribed per turn: a backend outlives a turn, but its events are only
    // interesting to the turn currently running. Sending events for another
    // session through this callback would corrupt this transcript.
    const unsubscribe = backend.onEvent((event) => {
      if (!event || typeof event !== 'object' || sessionGenerations.get(sessionId) !== sessionGeneration || ['loops_changed','query_installed','query_closed','actor_paused'].includes(event.type)) return;
      // A backend may tag its own sessionId. One tagged for a *different* session
      // is dropped: a backend that outlives a turn (the CCB child process does)
      // must not leak a stale turn's output into the transcript being built now.
      // An untagged event belongs to the only turn in flight.
      if (event.sessionId !== undefined && event.sessionId !== null && event.sessionId !== sessionId) return;
      if (event.type === 'user_input_observed') {
        if (trackCliInputObservations === true && backendId === 'ccb' && !controller.signal.aborted &&
            running.get(sessionId) === controller && event.sessionId === sessionId &&
            event.messageUuid === turnOptions.messageUuid && currentActorMatches(sessionId, event.actorToken)) {
          cliInputObservations.set(sessionId, {messageUuid:event.messageUuid, actorToken:event.actorToken, owner:sessionGeneration});
        }
        return;
      }
      if (event.type === 'init') persistCcbIdentity(sessionId);
      onEvent(event.sessionId === undefined || event.sessionId === null ? { ...event, sessionId } : event);
    });
    try {
      const result = await backend.sendMessage(sessionId, message, {
        messages: turnOptions.messages,
        images: turnOptions.images,
        messageUuid: turnOptions.messageUuid,
        signal: controller.signal,
        requestApproval: turnOptions.requestApproval,
        ...(backendId === 'ccb' ? {
          ownsSteering:()=>!disposed && sessionGenerations.get(sessionId)===sessionGeneration && running.get(sessionId)===controller,
          model: sessions.get(sessionId)?.model,
          permissionMode: sessions.get(sessionId)?.permissionMode,
          effortLevel: selectedEffort(sessions.get(sessionId)?.model, sessions.get(sessionId)?.effortLevel),
          cwd: sessions.get(sessionId)?.cwd || sessions.get(sessionId)?.ccbResume?.cwd || process.env.CLAUDE_WORKSPACE || process.cwd(),
          cliSessionId: sessions.get(sessionId)?.cliSessionId,
          ccbResume: sessions.get(sessionId)?.ccbResume || null,
          resume: (transcripts.get(sessionId) || []).some(row => row && row.message),
        } : {}),
        // Effort is independent: ccb-kernel applies only effortLevel through
        // apply_flag_settings, never a permission-mode override.
      });
      persistCcbIdentity(sessionId);
      return result || {};
    } finally {
      unsubscribe();
    }
  }

  // The renderer's session ID and the native CLI UUID are different identities.
  // Persist the latter only after an actual native init confirmed it, alongside
  // the launch directories needed to locate the same CLI transcript after restart.
  function persistCcbIdentity(sessionId) {
    if (backendId !== 'ccb' || typeof backend.getInfo !== 'function') return;
    const info = backend.getInfo(sessionId);
    const saved = info?.persistence;
    if (!saved || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.cliSessionId || '')) return;
    if (info.init?.sessionId !== saved.cliSessionId || !saved.homeDir || !saved.cwd) return;
    record(sessionId, { kernelBackend: 'ccb', cliSessionId: saved.cliSessionId, ccbResume: {
      cliSessionId: saved.cliSessionId,
      cwd: saved.cwd,
      homeDir: saved.homeDir,
      scratchDir: saved.scratchDir,
      transcriptPath: saved.transcriptPath || null,
    } });
  }

  /**
   * Run one turn. Returns once the turn finishes; streaming happens through
   * `emit`.
   */
  const goalEngine = require('./session-goal.cjs');
  const goalTimers = new Map();
  function scheduleGoal(sessionId) {
    if (goalTimers.has(sessionId) || disposed) return;
    const timer = setTimeout(() => {
      goalTimers.delete(sessionId);
      const session = sessions.get(sessionId), goal = session?.desktopGoal;
      if (disposed || goal?.status !== 'active' || pendingTurns.has(sessionId) || deferredStarts.has(sessionId)) return;
      if (goal.turns >= goalEngine.MAX_TURNS) { record(sessionId, {desktopGoal:{...goal,status:'max_turns'}}); flush(); return; }
      const next = {...goal,turns:goal.turns+1};
      record(sessionId,{desktopGoal:next});
      sendMessage(sessionId,goalEngine.prompt(next),{goalContinuation:true}).catch(error=>{
        const current=sessions.get(sessionId)?.desktopGoal;
        if(current?.status==='active')record(sessionId,{desktopGoal:{...current,status:'paused',lastError:String(error.message||error)}});
        flush();
      });
    }, 100);
    timer.unref?.(); goalTimers.set(sessionId,timer);
  }
  function goalCommand(sessionId, message, options) {
    const match = typeof message === 'string' && message.match(/^\/goal(?:\s+([\s\S]*))?\s*$/i);
    if (!match) return null;
    const session=sessions.get(sessionId), result=goalEngine.command(session.desktopGoal,match[1]||'');
    record(sessionId,{desktopGoal:result.goal});
    const rows=transcripts.get(sessionId)||[], stamp=now();
    const user={type:'user',uuid:options.messageUuid||newRowUuid(),parentUuid:rows.at(-1)?.uuid||null,timestamp:stamp,sessionId,promptId:sessionId,message:{role:'user',content:[{type:'text',text:message}]}};
    const answer={type:'assistant',uuid:newRowUuid(),parentUuid:user.uuid,timestamp:now(),sessionId,promptId:sessionId,message:{role:'assistant',model:'<synthetic>',content:[{type:'text',text:result.text}]}};
    transcripts.set(sessionId,[...rows,user,answer]);
    emit({type:'message',sessionId,message:user});emit({type:'message',sessionId,message:answer});
    emit({type:'session_updated',sessionId,session:getSession(sessionId)});
    if(!pendingTurns.has(sessionId))emit({type:'close',sessionId,code:0});
    flush(); if(result.run)scheduleGoal(sessionId);
    return Promise.resolve({ok:true,sessionId,text:result.text,stopReason:'end_turn'});
  }
  function sendMessage(sessionId, message, options = {}, onStarted = null) {
    if (disposed) return Promise.reject(new Error('session kernel disposed'));
    if (!sessions.has(sessionId)) return Promise.reject(new Error(`unknown session: ${sessionId}`));
    const localGoal = goalCommand(sessionId, message, options);
    if (localGoal) return localGoal;
    const refusal = importedSendRefusal(sessions.get(sessionId), options);
    if (refusal) return refusal;
    const supplied = options.messageUuid;
    const held = heldAfterError.get(sessionId);
    const reusedHeld = (!options.promotedEntry && held?.some(entry => entry.options.messageUuid === supplied)) ||
      backend?.hasWrittenInputUuid?.(sessionId,supplied);
    const messageUuid = !reusedHeld && typeof supplied === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supplied) ? supplied : newRowUuid();
    options = {...options, messageUuid};
    if (pendingTurns.has(sessionId) && (options.priority==='now' || options.priority==='next') &&
        typeof backend?.acceptSteer==='function') {
      if (getQueuedMessages(sessionId).some(row=>row.uuid===messageUuid) || transcripts.get(sessionId)?.some(row=>row?.uuid===messageUuid)) {
        options.messageUuid=newRowUuid();
      }
      if (backend.acceptSteer(sessionId,message,options)) return Promise.resolve();
      options.deferIfBusy=true;
    }
    const rejoinOnAdmission = options.rejoinHeldAfterPress && held;
    delete options.rejoinHeldAfterPress;
    if (options.deferIfBusy && (pendingTurns.has(sessionId) || deferredStarts.has(sessionId))) {
      // Drain re-enters sendMessage. Only the renderer invocation may accept a
      // new queue entry, never the dispatch of one already accepted.
      options.deferIfBusy = false;
      try {
        const accepted = enqueueDeferredMessage(sessionId, message, options, true);
        if (!rejoinOnAdmission) return accepted;
        return accepted.then(() => { if (heldAfterError.get(sessionId) === held) rejoinHeld(sessionId); });
      }
      catch (error) { return Promise.reject(error); }
    }
    if (pendingTurns.has(sessionId)) return Promise.reject(new Error('a turn is already running for this session'));
    const token = { started: false, cancelled: false, generation: generation(sessionId), messageUuid, promoted:!!options.promotedEntry };
    const cancelled = new Promise((resolve, reject) => { token.resolveCancelled = resolve; token.rejectCancelled = reject; });
    pendingTurns.set(sessionId, token);
    idleLifecycle.onMessageSent(sessionId);
    const queued = enqueueSession(sessionId, () => {
      if (disposed || token.cancelled || sessionGenerations.get(sessionId) !== token.generation) {
        return { ok: false, sessionId, error: disposed ? 'session kernel disposed' : 'cancelled' };
      }
      const refusal = importedSendRefusal(sessions.get(sessionId), options);
      if (refusal) return refusal;
      if (options.promotedEntry && !heldAfterError.get(sessionId)?.includes(options.promotedEntry)) {
        return {ok:false,sessionId,error:'held message withdrawn'};
      }
      token.started = true;
      // Whether this message is what started the turn, as opposed to joining one already up.
      // Captured here because runMessage records isRunning before it can report anything.
      const heldReleaseStartsTurn = sessions.get(sessionId)?.isRunning !== true;
      return runMessage(sessionId, message, { ...options, heldReleaseStartsTurn }, token.generation, rejoinOnAdmission ? () => {
        onStarted?.();
        if (heldAfterError.get(sessionId) === held) rejoinHeld(sessionId);
      } : onStarted);
    });
    return Promise.race([queued, cancelled])
      .then(result => {
        const goal=sessions.get(sessionId)?.desktopGoal;
        if(goal?.status==='active')record(sessionId,{desktopGoal:goalEngine.afterTurn(goal,result)});
        return result;
      }, error => {
        const goal=sessions.get(sessionId)?.desktopGoal;
        if(goal?.status==='active')record(sessionId,{desktopGoal:{...goal,status:'paused',lastError:String(error.message||error)}});
        throw error;
      })
      .finally(() => { if (pendingTurns.get(sessionId) === token) pendingTurns.delete(sessionId); flushHeldMcpVerbs(sessionId); drainDeferredStarts(sessionId); scheduleGoal(sessionId); });
  }

  // Native Code cold starts throw ImportedResumeGateError before starting an
  // unconfirmed import. Originated (internal) sends return a delivery refusal.
  function importedSendRefusal(session, options) {
    if (!session?.importedFrom || session.resumeConfirmed) return null;
    const previousProfile = typeof session.importedFrom === 'string' && session.importedFrom.startsWith('previous-profile-');
    const message = previousProfile
      ? 'This session was carried over from Claude data already on this computer. Continue to pick up from its history.'
      : 'This session was imported. Resuming lets Claude act on its history — trust it to continue.';
    const error = new Error(message);
    error.name = 'ImportedResumeGateError';
    return options?.origin
      ? Promise.resolve({ delivered: false, reason: message, cause: error })
      : Promise.reject(error);
  }

  async function runMessage(sessionId, message, options = {}, sessionGeneration, onStarted = null) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    cliInputObservations.delete(sessionId);
    if (session.isRunning) throw new Error('a turn is already running for this session');
    const submittedText = message;
    message = coalesceDeferredText(sessionId, message, options);
    const publishCompletedPrompt = !options.queuedAt || submittedText !== message;
    const content = userContent(message, options.images);
    // Preserve submission order when the completed prompt replaces its optimistic
    // renderer row. Completion time can be later than every assistant block.
    const userSubmittedAt = options.queuedAt || now();
    let submittedPromptPublished = false;
    // Native Gk accepts an RFC-shaped UUID verbatim and mints one otherwise.
    // Select once so the CLI frame and durable prompt row share one identity.
    const userMessageUuid = typeof options.messageUuid === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.messageUuid)
      ? options.messageUuid : newRowUuid();

    // Legacy path: the agent is told which session it is running for and how to
    // ask the user for permission, so a gated tool can raise an in-app approval
    // request instead of blocking on a native modal the renderer knows nothing
    // about. Built per turn so a provider/mode change is picked up by the
    // next turn. With a backend the turn is delegated wholesale and the backend
    // owns whatever process or client it needs internally.
    const agent = backend ? null : createAgent({
      sessionId,
      requestApproval: (request) => requestApproval(sessionId, request),
      // The session's own mode, so the composer's 自动/手动 choice takes effect. The
      // runner used to read only the process config, which meant a session set to 自动
      // still raised an approval card for every Write.
      permissionMode: session.permissionMode,
      effortLevel: selectedEffort(session.model, session.effortLevel),
      // The session's own model, so the composer's model picker takes effect.
      //
      // MEASURED BEFORE THIS: setModel() wrote session.model and the UI showed the new name,
      // but this call did not forward it and main.cjs's factory was keyed on permissionMode
      // alone, so every request used the process-config model. Switching a session to
      // 'definitely-not-a-real-model-xyz' still produced a normal reply — which is how the
      // gap was found.
      model: session.model,
    });
    // The backend path builds rows from the kernel's own frames, so a tool round lands in the
    // transcript with its tool_use/tool_result pairing intact. Reset per turn: the mapper keeps
    // per-turn state (message id -> entry, tool_use id -> name) and one turn's leftovers must
    // not leak into the next.
    const mapper = backend ? createCcbTranscriptMapper({ cwd: session.cwd, sessionId }) : null;
    const liveRowIds = new Map();
    const liveRowId = entry => {
      if (mapper.isSteer(entry.uuid)) return entry.uuid;
      if (!liveRowIds.has(entry.uuid)) liveRowIds.set(entry.uuid, newRowUuid());
      return liveRowIds.get(entry.uuid);
    };
    let nativeResult, primaryTerminal;
    const emitTurnBoundary = () => {
      const heldIds = heldAfterError.get(sessionId)?.map(entry => entry.options.messageUuid);
      if (nativeResult && heldIds?.length) {
        const waiting = (deferredStarts.get(sessionId) || []).filter(entry=>entry.options.queuedAt);
        emit({type:'message',sessionId,message:{...nativeResult,heldQueuedSendUuids:[...heldIds,...waiting.map(entry=>entry.options.messageUuid)],
          unreadInputUuids:[],sendsHeldAfterError:heldIds}});
        announceHeld(sessionId);
      } else {
        // `close` is transport state; the renderer ends its pending turn on the
        // native result envelope. Always deliver it, including successful turns.
        if (nativeResult) emit({type:'message',sessionId,message:nativeResult});
        emit({type:'close',sessionId});
        if (heldIds?.length) announceHeld(sessionId);
      }
    };
    const controller = new AbortController();
    running.set(sessionId, controller);
    // Whether this turn has produced anything the model can already act on.
    //
    // The original tracks this as pendingCycle.hadFirstResponse and uses it to refuse an
    // "unsend": once the model has output, taking the prompt back would leave the transcript
    // showing a prompt with no turn. This replica had no such state at all — pendingTurn /
    // responseStarted are never written here — so the guard in the bridge read a field that
    // only a test could set. Tracked from the same events the UI already consumes.
    turnProducedOutput.delete(sessionId);

    record(sessionId, { isRunning: true });
    emit({ type: 'turn_started', sessionId });
    if (disposed || controller.signal.aborted || running.get(sessionId) !== controller ||
        sessionGenerations.get(sessionId) !== sessionGeneration || !sessions.has(sessionId)) {
      if (disposed && running.get(sessionId) === controller) {
        controller.abort();
        running.delete(sessionId);
        const current = sessions.get(sessionId);
        if (current && sessionGenerations.get(sessionId) === sessionGeneration) sessions.set(sessionId, {...current,isRunning:false});
      }
      return {ok:false, sessionId, error:disposed ? 'session kernel disposed' : 'cancelled'};
    }
    onStarted?.();
    // A message that was being held is now the running turn: tell the renderer.
    //
    // Before this, moving a held/deferred message into a turn emitted only `turn_started`, so
    // the store never learned the row had left `heldInput`. The reducer for held_input_released
    // does two things and both matter here:
    //
    //   case"held_released": { r = t.heldInput.filter(e => !n.uuids.includes(e)); ...
    //     return !n.startsTurn || t.pendingTurn !== null ? i
    //       : (U.reset(e), K.begin(e), W.clear(e), W.takeRevealStats(e),
    //          { ...i, pendingTurn: { startTime, armedAt, endTurnSeen:false, ... } }) }
    //
    // i.e. it drops the uuid from `heldInput` AND, when startsTurn, arms the turn display.
    //
    // `startsTurn` is true here, and in this replica it is always true on this path — but by
    // construction, not by luck: both ways a held row can reach this point require that nothing
    // was running. `drainDeferredStarts` returns early when `pendingTurns.has(id)`, and
    // `promoteHeldMessage` returns false under the same condition. So this message IS what
    // starts the turn, and the reducer's `t.pendingTurn !== null` guard cannot make the flag
    // moot. The original also has a startsTurn:false case (noteCliTookInput, for a row the CLI
    // accepted mid-turn); this replica has no held-across-loss model, so it has no such path.
    //
    // The value is passed in rather than hardcoded so a future held-across-loss path cannot
    // silently inherit `true` and reset the renderer's pendingTurn out from under a live turn.
    if (options.promotedEntry || options.queuedAt) {
      emit({ type: 'held_input_released', sessionId, releasedUuids: [userMessageUuid].filter(Boolean),
        startsTurn: options.heldReleaseStartsTurn === true, session: getSession(sessionId) });
    }

    // The conversation lives in the transcript, not on the session record.
    const prior = transcripts.get(sessionId) || [];
    // A transcript row can be malformed on disk (null, a bare string, an object with no
    // message). Mapping straight over them threw `Cannot read properties of null` and made the
    // session permanently unusable: every send failed, and the only fix was to delete it.
    // MEASURED: a store seeded with [null] loaded fine but sendMessage threw at this line.
    // Dropping the unusable rows keeps the conversation going; a missing turn is recoverable,
    // an unusable session is not.
    const usable = prior.filter((e) => e && typeof e === 'object' && e.message && typeof e.message === 'object');
    const history = mergeAdjacentRoles([
      ...usable.map((e) => ({ role: e.message.role || 'user', content: e.message.content })),
      { role: 'user', content: options.images?.length ? content : message },
    ]);

    let text = '';
    // Tool calls made during this turn, in order. Collected so the transcript can
    // record them; without this the conversation lost every tool_use/tool_result
    // and a reopened session showed the assistant answering without looking.
    const toolCalls = [];
    const byToolId = new Map();
    // The approval hook is shared by both paths: a gated tool asks through this,
    // so the approval renders inside the app rather than blocking on a native
    // modal the renderer cannot see.
    const askApproval = (request) => controller.signal.aborted ? Promise.resolve('cancelled') : requestApproval(sessionId, request);
    const turnOptions = {
      messages: history,
      images: options.images,
      messageUuid: userMessageUuid,
      signal: controller.signal,
      requestApproval: askApproval,
      onEvent: null,
      // The session's effort level, so the composer's effort picker takes effect.
      //
      // MEASURED BEFORE THIS: this object did not carry it, and agent-config's run() reads
      // effortLevel from HERE (not from the factory options), so `effort: effortLevel` was
      // always undefined and the level only changed a label. Third instance of the same bug in
      // this chain: the value exists on the session record, and one hop drops it.
      effortLevel: selectedEffort(session.model, session.effortLevel),
    };
    // A backend may expose an actor-bound, non-secret capacity snapshot. Never
    // resolve the current profile here: an existing actor can outlive a switch.
    let requestActor = null, requestCapacity = null;
    const usageTracker = require('./context-usage.cjs').createRequestUsageTracker(usage => {
      if (!controller.signal.aborted && sessionGenerations.get(sessionId) === sessionGeneration &&
          (!requestActor || currentActorMatches(sessionId, requestActor))) {
        contextUsage.set(sessionId, { ...usage, contextWindow: requestCapacity?.model === usage.model ? requestCapacity.contextWindow : null });
        // A same-actor detail cache describes an older transcript after this
        // request completes. Removing its entry also rejects any stale in-flight
        // response through getContextUsageDetail's entry-identity check.
        contextDetail.delete(sessionId);
      }
    });
    if (backend && !submittedPromptPublished) {
      submittedPromptPublished = true;
      emit({type:'message',sessionId,message:{
        parentUuid:transcripts.get(sessionId)?.at(-1)?.uuid||null,isSidechain:false,
        promptId:sessionId,type:'user',message:{role:'user',content},uuid:userMessageUuid,
        timestamp:userSubmittedAt,cwd:session.cwd,sessionId,version:'2.42304.0',
      }});
    }
    try {
      const result = await runTurn({
        agent, backend, sessionId, message, turnOptions, controller, sessionGeneration,
        onEvent: (event) => {
          if (sessionGenerations.get(sessionId) !== sessionGeneration) return;
          if (['steer_accepted','steer_observed','steer_parked','steers_rekeyed','steer_escalating'].includes(event.type)) {
            if (running.get(sessionId)!==controller || controller.signal.aborted || !currentActorMatches(sessionId,event.actorToken)) return;
            const frame=event.frame;
            if (event.type==='steer_accepted') {
              emit({type:'message',sessionId,message:frame});
            } else if (event.type==='steer_observed') {
              mapper?.appendSteer(frame);
            } else if (event.type==='steer_parked') {
              const blocks=frame.message.content;
              const images=blocks.filter(b=>b.type==='image').map(b=>({base64:b.source.data,mimeType:b.source.media_type}));
              const queue=deferredStarts.get(sessionId) || [];
              queue.unshift({owner:sessionGeneration,message:blocks.find(b=>b.type==='text')?.text || '',
                options:{images,messageUuid:frame.uuid,queuedAt:frame.timestamp,plainInput:false}});
              deferredStarts.set(sessionId,queue);
            } else {
              const {actorToken,...uiEvent}=event;
              emit(uiEvent);
            }
            return;
          }
          // The backend path also records the raw frames it saw, so the transcript can be
          // built from the kernel's own stream-json instead of from the tool callback trail.
          // `raw` carries the frame verbatim; anything else here keeps the existing shape.
          if (mapper && event && event.type === 'raw' && event.frame) {
            if (!controller.signal.aborted) {
              const stream = event.frame.type === 'stream_event' && event.frame.parent_tool_use_id == null ? event.frame.event : null;
              if (stream?.type === 'message_start') {
                requestActor = null;
                requestCapacity = null;
                try {
                  const info = backend.getInfo?.(sessionId);
                  const actor = info?.actorToken;
                  const model = stream.message?.model;
                  const snapshot = info?.contextCapacity;
                  if (typeof actor === 'string' && actor) requestActor = actor;
                  if (requestActor && snapshot?.actorToken === actor && snapshot.model === model &&
                      Number.isSafeInteger(snapshot.contextWindow) && snapshot.contextWindow > 0) {
                    requestCapacity = { model, contextWindow: snapshot.contextWindow };
                  }
                } catch { /* an unavailable actor binding leaves capacity unknown */ }
              }
              if (!requestActor || currentActorMatches(sessionId, requestActor)) usageTracker.observe(event.frame);
            }
            if (event.frame.type === 'result' && !event.frame.parent_tool_use_id) {
              nativeResult = event.frame;
              if (event.primaryForNativeCycle === true) primaryTerminal=event.frame;
            }
            if (controller.signal.aborted) return;
            const applied = mapper.apply(event.frame);
            // Publish committed blocks during the turn, not only after sendMessage
            // resolves. Reuse these UUIDs in the final transcript so reconciliation
            // replaces rows instead of appending duplicate assistant/tool messages.
            if (event.frame.type === 'assistant' || event.frame.type === 'user') {
              if (!submittedPromptPublished && applied.changed.length) {
                submittedPromptPublished = true;
                const previousRows = transcripts.get(sessionId) || [];
                emit({ type: 'message', sessionId, message: {
                  parentUuid: previousRows.at(-1)?.uuid || null, isSidechain: false,
                  promptId: sessionId, type: 'user', message: { role: 'user', content },
                  uuid: userMessageUuid, timestamp: userSubmittedAt, cwd: session.cwd,
                  sessionId, version: '2.42304.0',
                } });
              }
              for (const entry of applied.changed) {
                emit({ type: 'message', sessionId, message: {
                  ...entry, uuid: liveRowId(entry), promptId: sessionId,
                  cwd: session.cwd, sessionId,
                  message: { ...entry.message, content: entry.message.content.slice() },
                } });
              }
            }
            for (const mapped of applied.events) {
              if (mapped.type === 'text_delta' && mapped.text) turnProducedOutput.set(sessionId, true);
              if (mapped.type === 'turn_finished') continue; // runTurn owns the committed turn boundary
              emit({ ...mapped, sessionId });
            }
            return;
          }
          if (event.type === 'init') {
            emit({ type: 'initialization_status', sessionId, initializationStatus: { step: 'starting', isComplete: true } });
            return;
          }
          if (event.type === 'upstream_retry') {
            emit({ type: 'initialization_status', sessionId, initializationStatus: { step: 'connect_retry', isComplete: false, message: `模型服务重试（HTTP ${event.errorStatus || '未知'}），等待 ${Math.ceil((event.retryDelayMs || 0) / 1000)} 秒` } });
            return;
          }
          if (event.type === 'text') {
            text += event.text;
            emit({ type: 'text_delta', sessionId, text: event.text });
            // Non-empty assistant text is the model answering: from here the prompt is no
            // longer unsendable, which is what discardPendingTurn reads.
            if (event.text) turnProducedOutput.set(sessionId, true);
            return;
          }
          // The agent emits `tool_request` for a tool_use block; an earlier version
          // only forwarded `tool_use`, which the agent never sends, so tool calls
          // were invisible in the conversation even though they ran.
          if (event.type === 'tool_request' || event.type === 'tool_use') {
            const call = { id: event.id, name: event.name, input: event.input, content: '', isError: false };
            toolCalls.push(call);
            if (event.id !== undefined) byToolId.set(event.id, call);
            // A tool call is the model acting on the prompt, so the turn is past the point
            // where taking the prompt back would be honest.
            turnProducedOutput.set(sessionId, true);
            emit({ type: 'tool_request', sessionId, id: event.id, name: event.name, input: event.input });
            return;
          }
          if (event.type === 'tool_result' || event.type === 'tool_error') {
            // Attach the outcome to the call it belongs to so the transcript can
            // pair them up. The agent reports the result separately from the
            // request, keyed by the tool_use id.
            // The agent's event carries the outcome as `preview` (a bounded copy), not
            // `content`. Reading only `content`/`message` recorded an EMPTY string for every
            // tool result: the transcript then showed a tool call with no output, even though
            // the model had received the real output and answered from it. `preview` is the
            // fallback that was missing.
            const outcomeText = event.content ?? event.message ?? event.preview ?? '';
            const call = event.id !== undefined ? byToolId.get(event.id) : undefined;
            if (call) {
              call.content = outcomeText;
              call.isError = event.type === 'tool_error' || event.isError === true;
            } else {
              // A result with no matching request still belongs in the record.
              toolCalls.push({
                id: event.id,
                name: event.name || 'tool',
                input: {},
                content: outcomeText,
                isError: event.type === 'tool_error' || event.isError === true,
              });
            }
            emit({ ...event, sessionId });
            return;
          }
          if (event.type === 'error') {
            // Forward the classification as well as the text. The agent distinguishes
            // 'network', 'api-error', 'bad-response', 'aborted' and 'missing-executor',
            // and folds the HTTP status into the message ('API 401: ...'). Passing `code`
            // through lets the renderer branch on the KIND of failure instead of pattern-
            // matching a string. Measured before this: the event carried only `message`,
            // so 401, 429 and 500 were indistinguishable to any caller.
            emit({
              type: 'error',
              sessionId,
              message: event.message,
              ...(event.code ? { code: event.code } : {}),
            });
            return;
          }
          emit({ ...event, sessionId });
        },
      });

      if (sessionGenerations.get(sessionId) !== sessionGeneration) return { ok: false, sessionId, error: 'session deleted' };

      // Append the finished turn to the transcript as stream-json entries, the
      // shape a running original serves from getTranscript.
      //
      // Tool calls belong in here too. They were previously dropped entirely: the
      // agent ran the tool and streamed a `tool_request` event, but the transcript
      // recorded only the user text and the final reply, so reopening the session
      // showed a conversation in which the assistant had magically answered without
      // looking anything up. A stream-json assistant message carries its tool_use
      // blocks inline and the following user message carries the matching
      // tool_result blocks, which is what the transcript view renders.
      const queuedEntries = deferredStarts.get(sessionId);
      if (queuedEntries?.some(entry => entry.options.queuedAt) && !disposed && !controller.signal.aborted &&
          running.get(sessionId) === controller && !session.remoteTarget && !session.backend?.remoteTarget &&
          (!session.backend?.kind || session.backend.kind === 'local') &&
          require('./queue-result-health.cjs').shouldHoldAfterResult(nativeResult,result.stopReason) &&
          !readFeatureOn('4122449738',false)) {
        const held = heldAfterError.get(sessionId) || [];
        heldAfterError.set(sessionId,held.concat(queuedEntries.filter(entry=>entry.options.queuedAt)));
        const others = queuedEntries.filter(entry=>!entry.options.queuedAt);
        if (others.length) deferredStarts.set(sessionId,others); else deferredStarts.delete(sessionId);
      }
      const reply = result.text || (primaryTerminal?.is_error ? '' : text);
      const existing = transcripts.get(sessionId) || [];
      // `existing` can contain a malformed row (null) on a corrupted store; reading .uuid off
      // it threw and the turn failed. Fall back to null, which the transcript treats as a root.
      const lastExisting = existing.length ? existing[existing.length - 1] : null;
      let parentUuid = lastExisting && lastExisting.uuid ? lastExisting.uuid : null;
      const stamp = now();
      const userEntry = {
        parentUuid,
        isSidechain: false,
        promptId: sessionId,
        type: 'user',
        message: { role: 'user', content },
        uuid: userMessageUuid,
        timestamp: userSubmittedAt,
        cwd: session.cwd,
        sessionId,
        version: '2.42304.0',
      };

      // The backend path already has richer rows than the callback trail can express: the
      // mapper saw the kernel's own frames, so a message the kernel split across several
      // frames is ONE row (with all its blocks), and tool_use/tool_result are paired by the
      // kernel's own ids. Prefer those and skip the synthetic tool entries below — doing both
      // would list every tool call twice.
      // Only when the mapper actually saw frames. A backend may speak the event vocabulary
      // without forwarding raw frames at all (the stub ones in tests do exactly that), and
      // taking this branch with an empty mapper would drop every tool row on the floor.
      const mapped = mapper ? mapper.entries.filter((entry) => entry && entry.message) : [];
      if (mapped.length) {
        const rows = [];
        const lastExistingRow = existing.length ? existing[existing.length - 1] : null;
        let parent = lastExistingRow && lastExistingRow.uuid ? lastExistingRow.uuid : null;
        const mappedIds = new Set();
        // The user's own prompt first: the kernel does not echo it back as a frame.
        const promptEntry = { ...userEntry, parentUuid: parent };
        rows.push(promptEntry);
        parent = promptEntry.uuid;
        for (const entry of mapped) {
          const row = {
            ...entry,
            parentUuid: parent,
            promptId: sessionId,
            cwd: session.cwd,
            sessionId,
            version: '2.42304.0',
            timestamp: entry.timestamp || stamp,
            uuid: liveRowId(entry),
          };
          rows.push(row);
          parent = row.uuid;
        }
        // A turn that produced no assistant frame at all still gets the reply, so a silent
        // kernel does not look like a dropped turn.
        if (!mapped.some((entry) => entry.type === 'assistant')) {
          const fallback = {
            parentUuid: parent,
            isSidechain: false,
            promptId: sessionId,
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
            uuid: newRowUuid(),
            timestamp: stamp,
            cwd: session.cwd,
            sessionId,
            version: '2.42304.0',
          };
          rows.push(fallback);
        }
        transcripts.set(sessionId, [...existing, ...rows]);
        for (const row of rows) {
          if (!mapper.isSteer(row.uuid) && (row !== promptEntry || publishCompletedPrompt)) emit({ type: 'message', sessionId, message: row });
        }
        record(sessionId, {
          isRunning: false,
          lastActivityAt: nowMs(),
          title: session.title || message.slice(0, 60),
        });
        flush();
        emitTurnBoundary();
        idleLifecycle.onTurnComplete(sessionId);
        emit({
          type: 'turn_finished',
          sessionId,
          stopReason: result.stopReason || 'end_turn',
          text: reply,
        });
        return {
          ok: true,
          sessionId,
          text: reply,
          stopReason: result.stopReason || 'end_turn',
        };
      }

      // One assistant entry per tool round, then a user entry carrying the results,
      // mirroring how the CLI lays a tool-using turn out on disk.
      const turnEntries = [];
      let cursor = userEntry;
      for (const call of toolCalls) {
        const assistantToolEntry = {
          parentUuid: cursor.uuid,
          isSidechain: false,
          promptId: sessionId,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.input || {},
            }],
          },
          uuid: newRowUuid(),
          timestamp: stamp,
          cwd: session.cwd,
          sessionId,
          version: '2.42304.0',
        };
        turnEntries.push(assistantToolEntry);

        const resultEntry = {
          parentUuid: assistantToolEntry.uuid,
          isSidechain: false,
          promptId: sessionId,
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: call.id,
              content: typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? ''),
              ...(call.isError ? { is_error: true } : {}),
            }],
          },
          uuid: newRowUuid(),
          timestamp: stamp,
          cwd: session.cwd,
          sessionId,
          version: '2.42304.0',
        };
        turnEntries.push(resultEntry);
        cursor = resultEntry;
      }

      const assistantEntry = {
        parentUuid: cursor.uuid,
        isSidechain: false,
        promptId: sessionId,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
        uuid: newRowUuid(),
        timestamp: stamp,
        cwd: session.cwd,
        sessionId,
        version: '2.42304.0',
      };
      transcripts.set(sessionId, [...existing, userEntry, ...turnEntries, assistantEntry]);

      // The renderer's event switch reads `type: "message"` with a stream-json
      // entry in `message`; it ignores bespoke names like turn_finished. Emitting
      // the transcript entries is what actually appends rows to the conversation,
      // so a turn that only wrote the store left the UI blank.
      if (publishCompletedPrompt) emit({ type: 'message', sessionId, message: userEntry });
      for (const entry of turnEntries) emit({ type: 'message', sessionId, message: entry });
      emit({ type: 'message', sessionId, message: assistantEntry });

      record(sessionId, {
        isRunning: false,
        // Epoch milliseconds, matching the original's session record. The
        // transcript entries keep the ISO string the original uses there.
        lastActivityAt: nowMs(),
        title: session.title || message.slice(0, 60),
      });
      // Persist before announcing completion, so a reload right after the turn
      // cannot read a store that is still missing it.
      flush();
      emit({ type: 'initialization_status', sessionId, initializationStatus: { step: 'model_request', isComplete: true } });
      emitTurnBoundary();
      idleLifecycle.onTurnComplete(sessionId);
      emit({
        type: 'turn_finished',
        sessionId,
        stopReason: result.stopReason || 'end_turn',
        text: reply,
      });
      return {
        ok: true,
        sessionId,
        text: reply,
        stopReason: result.stopReason || 'end_turn',
      };
    } catch (error) {
      if (sessionGenerations.get(sessionId) !== sessionGeneration) return { ok: false, sessionId, error: 'session deleted' };
      // R382's normal terminal path holds ordinary queued input after an unhealthy
      // result. A backend can reject without returning a result (for example when
      // its process dies), which skips that path. Leaving the queue here makes
      // sendMessage.finally drain it and silently send another person message.
      const queuedOnReject = deferredStarts.get(sessionId);
      let parkedAfterReject = false;
      if (queuedOnReject?.some(entry => entry.options.queuedAt) &&
          !disposed && !controller.signal.aborted && running.get(sessionId) === controller &&
          !session.remoteTarget && !session.backend?.remoteTarget &&
          (!session.backend?.kind || session.backend.kind === 'local') &&
          // A successful raw result is NOT completed delivery: the CCB process may
          // still exit before the idle/turn lifecycle settles. A rejected backend
          // Promise always holds the next person-authored input unless cancelled.
          !readFeatureOn('4122449738', false)) {
        const held = heldAfterError.get(sessionId) || [];
        heldAfterError.set(sessionId, held.concat(queuedOnReject.filter(entry => entry.options.queuedAt)));
        const remaining = queuedOnReject.filter(entry => !entry.options.queuedAt);
        if (remaining.length) deferredStarts.set(sessionId, remaining);
        else deferredStarts.delete(sessionId);
        parkedAfterReject = true;
      }
      record(sessionId, { isRunning: false });
      if (parkedAfterReject) announceHeld(sessionId);
      // Keep the user's own message. Without this a failed turn left the transcript EMPTY —
      // measured: sendMessage('my important question') against a throwing agent returned
      // {ok:false} and the transcript held 0 rows, so the text the user had just typed was
      // gone. The user's words are theirs regardless of whether the model answered; only the
      // assistant side of the turn is incomplete. `turnEntries` is deliberately NOT written:
      // a half-built tool sequence would render as a broken conversation.
      // userEntry is built AFTER runTurn returns, so on this path it does not exist yet —
      // the row has to be built here. (The first version of this fix referenced userEntry
      // directly and threw a ReferenceError inside the catch, which the outer guard swallowed.)
      try {
        const before = transcripts.get(sessionId) || [];
        const last = before.length ? before[before.length - 1] : null;
        const alreadyRecorded = last && last.type === 'user' && last.uuid === userMessageUuid
          && JSON.stringify(last.message) === JSON.stringify({ role: 'user', content });
        if (!alreadyRecorded) {
          const failedEntry = {
            parentUuid: last && last.uuid ? last.uuid : null,
            isSidechain: false,
            promptId: sessionId,
            type: 'user',
            message: { role: 'user', content },
            uuid: userMessageUuid,
            timestamp: now(),
            cwd: session.cwd,
            sessionId,
            version: '2.42304.0',
          };
          transcripts.set(sessionId, [...before, failedEntry]);
        }
      } catch { /* never mask the original failure with a bookkeeping one */ }
      // A backend may already have emitted this error through its own event channel
      // (ccb-kernel's rejectTurn does), so emitting again here shows the same failure twice.
      // The turn still reports it in its return value -- that is data, not a notification --
      // but the event belongs to whoever detected it first.
      const reported = backend && typeof backend.reportsTurnErrors === 'function'
        ? backend.reportsTurnErrors()
        : false;
      // The failure result carries the classification too, so a caller can tell a bad key
      // (api-error) from an unreachable host (network) without parsing the message.
      const failureCode = typeof error?.code === 'string' ? error.code : null;
      if (!reported) {
        emit({
          type: 'error',
          sessionId,
          message: String(error && error.message),
          ...(failureCode ? { code: failureCode } : {}),
        });
      }
      return {
        ok: false,
        sessionId,
        error: String(error && error.message),
        ...(failureCode ? { code: failureCode } : {}),
      };
    } finally {
      if (running.get(sessionId) === controller) running.delete(sessionId);
    }
  }

  function getSession(sessionId) {
    const s = sessions.get(sessionId);
    return s ? publicSession(s) : null;
  }

  function getCliInputObservation(sessionId) {
    const entry = cliInputObservations.get(sessionId);
    if (!entry || disposed || sessionGenerations.get(sessionId) !== entry.owner ||
        !currentActorMatches(sessionId, entry.actorToken)) return null;
    return {messageUuid:entry.messageUuid, status:'cli_observed'};
  }

  // Instance-local identity and state guard; this is not an ownership or
  // cross-process lock. Consumers must separately establish authorization.
  function getSessionLease(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || disposed) return null;
    const transcript = transcripts.get(sessionId);
    let snapshot, transcriptSnapshot;
    try { snapshot = structuredClone(session); transcriptSnapshot = structuredClone(transcript); } catch { return null; }
    const owner = generation(sessionId);
    return {
      session: structuredClone(snapshot),
      isCurrent: () => !disposed && sessions.get(sessionId) === session &&
        sessionGenerations.get(sessionId) === owner && isDeepStrictEqual(session, snapshot) &&
        transcripts.get(sessionId) === transcript && isDeepStrictEqual(transcript, transcriptSnapshot),
    };
  }

  // Native Code manager confirms only imported, unconfirmed sessions. It first
  // installs a staged CLI transcript when a CLI ID exists. The replica has no
  // equivalent ownership and destination transaction, so that branch stays gated.
  function confirmImportedSessionResume(sessionId) {
    if (typeof sessionId !== 'string') return false;
    const id = sessionId.startsWith('local_') ? sessionId : `local_${sessionId}`;
    const previous = sessions.get(id);
    if (!previous?.importedFrom || previous.resumeConfirmed) return false;
    if (previous.stagedTranscriptPath && previous.cliSessionId) {
      if (!storePath || backendId !== 'ccb' || typeof historyImportResumeHost?.confirm !== 'function' ||
          typeof backend?.getInfo !== 'function' || typeof backend?.getActiveProcesses !== 'function' || importConfirmations.has(id)) return false;
      const currentActorAbsent = () => {
        try {
          const processes = backend.getActiveProcesses();
          return Array.isArray(processes) && !processes.some(item => item.sessionId === id) && !backend.getInfo(id)?.actorToken;
        } catch { return false; }
      };
      if (!currentActorAbsent() || pendingTurns.has(id) || running.has(id) || warming.has(id)) return false;
      const owner = generation(id), confirmation = {invalid:false, replaced:false};
      const transcript = transcripts.get(id);
      let transcriptSnapshot;
      try { transcriptSnapshot = structuredClone(transcript); } catch { return false; }
      const current = () => !disposed && !confirmation.invalid && !confirmation.replaced && sessions.get(id) === previous && sessionGenerations.get(id) === owner &&
        transcripts.get(id) === transcript && isDeepStrictEqual(transcript, transcriptSnapshot) &&
        !pendingTurns.has(id) && !running.has(id) && !warming.has(id) && currentActorAbsent();
      importConfirmations.set(id, confirmation);
      let committed = false, accepting = true;
      const commit = (proof, lease) => {
        if (!accepting || committed || !current() || !proof || proof.cliSessionId !== previous.cliSessionId ||
            proof.cwd !== previous.cwd || proof.stagingPath !== previous.stagedTranscriptPath ||
            ![proof.homeDir, proof.targetPath].every(value => typeof value === 'string' && path.isAbsolute(value))) return false;
        try { if (typeof lease?.isCurrent !== 'function' || lease.isCurrent() !== true || !current()) return false; }
        catch { return false; }
        const next = { ...previous, resumeConfirmed: true, ccbResume: {
          cliSessionId: proof.cliSessionId, cwd: proof.cwd, homeDir: proof.homeDir, transcriptPath: proof.targetPath,
        } };
        delete next.stagedTranscriptPath;
        delete next.error;
        delete next.errorCategory;
        sessions.set(id, next);
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!writeNow()) {
          const live = sessions.get(id);
          if (live && sessionGenerations.get(id) === owner && !confirmation.replaced) {
            const rolledBack = {...live};
            for (const key of ['resumeConfirmed', 'ccbResume', 'stagedTranscriptPath', 'error', 'errorCategory']) {
              if (Object.hasOwn(previous, key)) rolledBack[key] = previous[key];
              else delete rolledBack[key];
            }
            sessions.set(id, rolledBack);
            save();
          }
          return false;
        }
        committed = true;
        emit({ type: 'session_updated', sessionId: id, session: publicSession(next) });
        return true;
      };
      return Promise.resolve().then(() => historyImportResumeHost.confirm({sessionId:id, session:structuredClone(previous), isCurrent:current, commit}))
        .then(() => { accepting = false; return committed; }, error => { accepting = false; log(String(error?.message || error)); return committed; })
        .finally(() => { if (importConfirmations.get(id) === confirmation) importConfirmations.delete(id); });
    }
    const next = { ...previous, resumeConfirmed: true };
    delete next.error;
    delete next.errorCategory;
    sessions.set(id, next);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!writeNow()) {
      sessions.set(id, previous);
      save();
      return false;
    }
    emit({ type: 'session_updated', sessionId: id, session: publicSession(next) });
    return true;
  }

  /**
   * Apply a patch to a session record and return the public shape, or null when
   * the session does not exist.
   *
   * Rename/star/archive all go through here. They previously had no handler at all,
   * so the bridge answered null, nothing changed, and the UI re-rendered the
   * unchanged session without any error.
   */
  /**
   * Replace a session's transcript. Used by fork to seed the copy with the source
   * conversation; `getTranscript` returns a copy, so a caller cannot mutate it.
   */
  function setTranscript(sessionId, entries) {
    if (!sessions.has(sessionId)) return null;
    if (!Array.isArray(entries)) return null;
    transcripts.set(sessionId, entries.map((entry) => ({ ...entry })));
    save();
    return transcripts.get(sessionId);
  }

  // Backup restore is synchronous: validation, sidecar publication and one durable
  // kernel write form one transaction. No agent/backend is started by an import.
  function importBackupSessions(rows, { overwrite = false, commit = () => {}, rollback = () => {} } = {}) {
    if (disposed || !Array.isArray(rows)) throw new Error('INVALID_BACKUP');
    const ids = new Set();
    for (const row of rows) {
      const id = row?.session?.sessionId;
      if (typeof id !== 'string' || !id || ids.has(id) || !Array.isArray(row.transcript)) throw new Error('INVALID_BACKUP');
      ids.add(id);
      if (sessions.has(id) && !overwrite) throw new Error('CONFLICT');
      if (sessions.get(id)?.isRunning || running.has(id) || warming.has(id) || pendingTurns.has(id) || deferredStarts.has(id) || importConfirmations.has(id)) throw new Error('SESSION_RUNNING');
    }
    const previous = rows.map(row => [row.session.sessionId, sessions.get(row.session.sessionId), transcripts.get(row.session.sessionId)]);
    try {
      for (const row of rows) {
        const id = row.session.sessionId;
        sessions.set(id, { ...structuredClone(row.session), isRunning: false, pendingToolPermissions: [],
          importedFrom: 'localBackup', resumeConfirmed: false, needsResumeConfirm: true });
        transcripts.set(id, structuredClone(row.transcript));
      }
      commit();
      if (!writeNow()) throw new Error('RESTORE_WRITE_FAILED');
    } catch (error) {
      for (const [id, session, transcript] of previous) {
        if (session) sessions.set(id, session); else sessions.delete(id);
        if (transcript) transcripts.set(id, transcript); else transcripts.delete(id);
      }
      rollback();
      throw error;
    }
    for (const id of ids) {
      // Invalidate queued idle controls and old backend resume identities only
      // after publication succeeds; restored sessions start fresh on next send.
      sessionGenerations.set(id, {});
      try { backend?.removeSession?.(id); } catch (error) { log('backup backend reset: ' + String(error?.message || error)); }
      idleLifecycle.register(id);
      emit({ type: 'session_updated', sessionId: id, session: publicSession(sessions.get(id)) });
    }
    return { imported: rows.length };
  }

  function selectedEffort(model, effort) {
    const capabilities = require('./model-capabilities.cjs');
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ? capabilities.validateModelEffort(model, effort, capabilities.currentCapabilityProfile()) : undefined;
  }
  function setEffort(sessionId, effort) {
    const session = sessions.get(sessionId);
    if (!session || selectedEffort(session.model, effort) === undefined) return null;
    return update(sessionId, { effortLevel: effort });
  }
  function modelPatch(sessionId, model) {
    return { model, effortLevel: selectedEffort(model, sessions.get(sessionId)?.effortLevel) ?? null };
  }
  function setModel(sessionId, model) {
    if (disposed) return Promise.reject(new Error('session kernel disposed'));
    if (typeof model !== 'string' || !model.trim() || model !== model.trim() || /[\x00-\x1f\x7f]/.test(model)) {
      return Promise.reject(new TypeError('invalid model'));
    }
    if (!sessions.has(sessionId)) return Promise.resolve(null);
    const sessionGeneration = generation(sessionId);
    const selection = {};
    modelSelections.set(sessionId, selection);
    const current = () => sessionGenerations.get(sessionId) === sessionGeneration;
    const info = () => typeof backend?.getInfo === 'function' ? backend.getInfo(sessionId) : null;
    const active = pendingTurns.get(sessionId)?.started || running.has(sessionId);
    if (active) {
      const actor = info()?.actorToken ?? null;
      const updated = update(sessionId, modelPatch(sessionId, model));
      emit({ type: 'session_updated', sessionId, session: updated });
      if (backend && typeof backend.setModel === 'function') {
        (async () => backend.setModel(sessionId, model))().catch(error => {
          if (!current()) return;
          const state = info();
          const confirmedModel = error?.confirmedModel ?? state?.confirmedModel;
          if (error?.code === 'CCB_CONTROL_REJECTED' && modelSelections.get(sessionId) === selection
              && (state?.actorToken ?? null) === (error?.actorToken ?? actor)
              && sessions.get(sessionId)?.model === model && confirmedModel) {
            const reverted = update(sessionId, { model: confirmedModel });
            emit({ type: 'session_updated', sessionId, session: reverted });
          }
          emit({ type: 'error', sessionId, message: String(error?.message || error),
            ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
        });
      }
      return Promise.resolve(updated);
    }
    return enqueueSession(sessionId, async () => {
      if (disposed || sessionGenerations.get(sessionId) !== sessionGeneration) return null;
      if (backend && typeof backend.setModel === 'function') await backend.setModel(sessionId, model);
      else if (backendId === 'ccb') throw new Error('backend does not support model switching');
      if (disposed || sessionGenerations.get(sessionId) !== sessionGeneration) return null;
      const updated = update(sessionId, modelPatch(sessionId, model));
      emit({ type: 'session_updated', sessionId, session: updated });
      return updated;
    });
  }

  function update(sessionId, patch = {}) {
    if (!patch || typeof patch !== 'object') return null;
    const base = sessions.get(sessionId);
    if (!base) return null;
    // Only own, known-value keys are merged; an undefined must not erase a field.
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) clean[key] = value;
    }
    // The fixed desktop accepts only its eight session colors. An invalid
    // supplied value clears the color; an omitted or undefined value leaves it.
    if (patch.color !== undefined) {
      clean.color = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'].includes(patch.color)
        ? patch.color : undefined;
    }
    // A display selection is keyed by presence, so explicit undefined clears it.
    // Changing it also invalidates the model pin and its resolved app list.
    if (Object.hasOwn(patch, 'cuSelectedDisplayId')) {
      const value = patch.cuSelectedDisplayId;
      clean.cuSelectedDisplayId = Number.isInteger(value) && value >= 0 ? value : undefined;
      clean.cuDisplayPinnedByModel = false;
      clean.cuDisplayResolvedForApps = clean.cuSelectedDisplayId === undefined ? undefined
        : (base.cuAllowedApps ?? []).map(app => app.bundleId).sort().join(',');
    }
    // A rename also moves lastActivityAt? No — renaming is not activity. The
    // original keeps lastActivityAt tied to message traffic.
    const next = { ...base, ...clean, updatedAt: nowMs() };
    sessions.set(sessionId, next);
    save();
    return publicSession(next);
  }

  function getAll() {
    return [...sessions.values()].map(publicSession);
  }


  /** The conversation for one session, as stream-json entries. */
  function getTranscript(sessionId) {
    return (transcripts.get(sessionId) || []).map(projectTranscriptEntry);
  }

  function cancel(sessionId, { keepHeldInput = true } = {}) {
    const goal=sessions.get(sessionId)?.desktopGoal;
    if(goal?.status==='active')record(sessionId,{desktopGoal:{...goal,status:'paused'}});
    if(goalTimers.has(sessionId)){clearTimeout(goalTimers.get(sessionId));goalTimers.delete(sessionId);}
    // Release any open prompt FIRST, unconditionally.
    //
    // A pending approval is not tied to a live controller: a tool can ask for
    // permission while the turn is being torn down, or a request can be raised with no
    // running turn at all. Gating this behind `if (!controller) return` left those
    // waiters pending forever — the exact leak that hung a probe for minutes.
    resolveAllApprovals(sessionId, 'cancelled', 'deny');

    const controller = running.get(sessionId);
    const pending = pendingTurns.get(sessionId);
    if (pending && !pending.started) {
      pending.cancelled = true;
      pending.resolveCancelled({ ok: false, sessionId, error: 'cancelled' });
      pendingTurns.delete(sessionId);
      emit({ type: 'close', sessionId });
      if (!controller) return { ok: true };
    }
    if (!controller) return { ok: false, reason: 'no running turn' };
    // Hand back inputs this side still holds while the turn can still speak for
    // them. Before this, a stop dropped every held steer on the floor: it was
    // never written to the CLI, so the CLI could never replay it, and the turn
    // that owned the steer ledger was torn down right after. Measured against the
    // fixed original main bundle, whose interruptSession calls
    // transferHeldSteersToDeferred for exactly this reason before stopping.
    //
    // This runs BEFORE controller.abort(), because the backend's ledger refuses to
    // park anything once the turn is aborted or interrupted (owned() → false), and
    // before backend.cancel(), which is what marks the turn interrupted. Entries
    // already written to the CLI are skipped inside atBoundary(); they belong to
    // the CLI and are never resent here.
    //
    // keepHeldInput is false for callers that are DISCARDING the conversation rather
    // than stopping the turn: a rewind drops every row after its target, so handing a
    // held steer back would re-send text the user just rewound past. Measured: with
    // the hand-back unconditional, a rewind while a steer was held delivered it to the
    // model (fixture saw A then B after the transcript had already been truncated).
    // The original treats a rewind as a cut-and-withdraw; it does not redeliver.
    //
    // Not handing it back is only half of that. A held steer also lives in the backend's
    // ledger, and a steer parked by an EARLIER stop also sits in deferredStarts; left alone
    // either one fires on the next turn, which is the same redelivery one turn later.
    // Measured: with only the hand-back skipped, the rewound steer was still returned by
    // getQueuedMessages after the cancel.
    //
    // Scoped to the ledger's own uuids on purpose. deferredStarts also holds ordinary
    // busy-queue entries, and a rewind has no business discarding those: on the local kernel
    // (no steer ledger at all) this loop is empty and nothing is dropped, which is the
    // pre-existing behaviour.
    if (backend && keepHeldInput) {
      // Hand back what this side still holds, while the turn can still speak for it.
      //
      // THE BODY WAS REMOVED AND LEFT AS AN EMPTY BLOCK
      //   Until R527 this branch read:
      //       /* MUTATED: held inputs are no longer handed back before the turn is torn down */
      //   A comment that describes an omission is not the omission being tracked — nothing failed, because nothing
      //   asserted the call. The test that was supposed to pin it (`cancel-discard-scope-r385`, "a stop still hands
      //   held inputs back") had been failing on every run and was not being read: it waits for the turn to start,
      //   calls cancel, and expects `parkHeldSteers`.
      //
      //   Restoring it is the whole point of `keepHeldInput`, whose default is true. Callers passing false are
      //   discarding the conversation (a rewind), and that path is the `!keepHeldInput` branch below.
      try {
        backend.parkHeldSteers?.(sessionId);
      } catch (error) {
        log(`backend park failed: ${error && error.message}`);
      }
    }
    // Rows this turn is dropping rather than finishing. Reported on `close` below.
    let closeWithdrawnUuids;
    if (backend && !keepHeldInput) {
      const discarded = [...(backend.getSteerUuids?.(sessionId) || [])];
      if (discarded.length) {
        closeWithdrawnUuids = discarded;
        for (const uuid of discarded) {
          try { backend.withdrawSteer?.(sessionId, uuid); } catch (error) { log(`backend withdraw failed: ${error && error.message}`); }
        }
        const queue = deferredStarts.get(sessionId);
        const kept = (queue || []).filter(entry => !discarded.includes(entry.options?.messageUuid));
        if (kept.length) deferredStarts.set(sessionId, kept); else deferredStarts.delete(sessionId);
        for (const entry of queue || []) {
          if (discarded.includes(entry.options?.messageUuid)) entry.reject?.(new Error('message discarded by rewind'));
        }
        emit({ type: 'session_updated', sessionId, session: getSession(sessionId) });
      }
    }
    pendingTurns.delete(sessionId);
    controller.abort();
    // A backend may own the thing that actually has to stop (a child process, an
    // HTTP stream). Aborting our controller only unblocks the await; the backend
    // is told explicitly so it can interrupt its own turn. Its refusal must not
    // stop the local teardown below, hence the guard.
    if (backend) {
      try { backend.cancel(sessionId); } catch (error) { log(`backend cancel failed: ${error && error.message}`); }
    }
    // Clear isRunning HERE, not only on the turn's own return path.
    //
    // The flag is set at the top of sendMessage and cleared either by the success
    // branch or by the catch. If the agent does not settle after abort — a hung HTTP
    // request, a tool waiting on a response that will never come — neither runs, and
    // the session stays isRunning:true forever. Its stop button then reports
    // cancelled:true while the UI still shows a spinner, and every later sendMessage
    // is refused with "a turn is already running for this session".
    //
    // Observed exactly that: a session that hit an unanswered tool approval and could
    // not be recovered.
    record(sessionId, { isRunning: false });
    running.delete(sessionId);
    // Report which rows this turn dropped, not just that it ended.
    //
    // `close` carries `withdrawnUuids` in the pinned original (offset 690405), and the transport
    // picks its branch from it:
    //
    //   case"close": t(r.withdrawnUuids?.length
    //     ? {kind:"done", withdrawn:r.withdrawnUuids, ...r.lostUuids?.length&&{lost:r.lostUuids}}
    //     : r.interruptQueued ? {kind:"done", settleOnly:true}
    //     : {kind:"done", dropUnconfirmedEchoes:true}); break;
    //
    // and the store's withdrawn branch reconciles them:
    //
    //   case"done": if (n.settleOnly || n.withdrawn) return i=!0, U.reset, K.reset, W.clear,
    //     IC(e), KE({...t, ...UE}, e, n.withdrawn ?? Mw);
    //
    // KE is the same reducer that tombstones held rows. Without the uuids the transport takes
    // the plain `done` branch, so a steer this stop actually withdrew stays in the store's
    // `queuedSteered`/`heldInput` even though the backend ledger no longer has it — the row is
    // shown as pending forever.
    const closePayload = { type: 'close', sessionId, session: getSession(sessionId) };
    if (closeWithdrawnUuids?.length) closePayload.withdrawnUuids = closeWithdrawnUuids;
    emit(closePayload);
    return { ok: true };
  }

  /**
   * Ask the renderer whether a gated tool may run.
   *
   * Returns a promise that settles to 'allow' | 'deny' | 'cancelled'. The renderer
   * answers through respondToToolPermission(); the bridge registers that resolver.
   * A turn cancelled while a prompt is open settles every waiter immediately, so the
   * agent cannot be left awaiting a reply that will never arrive.
   */
  function requestApproval(sessionId, request, { timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
    const requestId = `perm_${++approvalSeq}`;
    const entry = { requestId, sessionId: sessionId ?? null, ...request };
    pendingApprovals.set(requestId, entry);

    const session = sessionId ? sessions.get(sessionId) : null;
    if (session) {
      const list = Array.isArray(session.pendingToolPermissions) ? session.pendingToolPermissions : [];
      record(sessionId, { pendingToolPermissions: [...list, entry] });
    }

    emit({ type: 'tool_permission_request', sessionId, request: entry });
    emit({ type: 'tool_approval_needed', sessionId, requestId, ...request });

    return new Promise((resolve) => {
      // A prompt nobody answers must not hold the turn forever. The renderer is not
      // guaranteed to exist — a window can close mid-approval — and without this the
      // agent blocked on exactly that (an approval that never came), which is the hang
      // that locked a session in round 21.
      const timer = setTimeout(() => {
        if (!approvalWaiters.has(requestId)) return;
        settleApproval(requestId, 'timeout');

      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      approvalWaiters.set(requestId, (decision) => {
        clearTimeout(timer);
        // Timeout keeps its own label so the executor can tell the user "you did not
        // respond" rather than "you declined". Both deny the tool.
        resolve(decision === 'allow' ? 'allow'
          : decision === 'cancelled' ? 'cancelled'
            : decision === 'timeout' ? 'timeout'
              : 'deny');
      });
    });
  }

  function settleApproval(requestId, decision) {
    const waiter = approvalWaiters.get(requestId);
    const entry = pendingApprovals.get(requestId);
    approvalWaiters.delete(requestId);
    pendingApprovals.delete(requestId);

    if (entry) {
      const session = entry.sessionId ? sessions.get(entry.sessionId) : null;
      if (session) {
        const list = Array.isArray(session.pendingToolPermissions) ? session.pendingToolPermissions : [];
        record(entry.sessionId, {
          pendingToolPermissions: list.filter((p) => p && p.requestId !== requestId),
        });
      }
      const resolvedDecision = decision === 'timeout' ? 'timeout' : decision;
      emit({
        type: 'tool_permission_resolved',
        sessionId: entry.sessionId,
        request: { ...entry, decision: resolvedDecision },
      });
    }

    if (waiter) waiter(decision === 'timeout' ? 'timeout' : decision);
    return Boolean(entry);
  }

  /**
   * Answer a pending approval. `decision` is the renderer's string; anything other
   * than "allow"/"always"/"once" denies, which is the safe direction.
   */
  function respondToApproval(requestId, decision, input) {
    if (!approvalWaiters.has(requestId)) return { ok: false, reason: 'no such request' };

    const allow = decision === 'allow' || decision === 'always' || decision === 'once';
    const resolved = allow ? 'allow' : 'deny';

    const entry = pendingApprovals.get(requestId);
    // Carry the renderer's `input` (an edited command) onto the resolution event so a
    // UI that shows the final action stays truthful.
    if (entry && input !== undefined) entry.input = input;
    settleApproval(requestId, resolved);
    return { ok: true, decision: resolved };
  }

  /** Settle every open prompt for a session — used when the turn is cancelled. */
  function resolveAllApprovals(sessionId, reason, resolved = 'deny') {
    for (const [requestId, entry] of [...pendingApprovals]) {
      if (!entry) continue;
      // A session-less request is also released, so nothing waits forever.
      if (sessionId !== null && entry.sessionId !== sessionId) continue;
      if (sessionId === null && entry.sessionId !== null) continue;
      const waiter = approvalWaiters.get(requestId);
      approvalWaiters.delete(requestId);
      pendingApprovals.delete(requestId);
      const session = entry.sessionId ? sessions.get(entry.sessionId) : null;
      if (session) {
        const list = Array.isArray(session.pendingToolPermissions) ? session.pendingToolPermissions : [];
        record(entry.sessionId, {
          pendingToolPermissions: list.filter((p) => p && p.requestId !== requestId),
        });
      }
      emit({
        type: 'tool_permission_resolved',
        sessionId: entry.sessionId,
        request: { ...entry, decision: resolved, reason },
      });
      if (typeof waiter === 'function') waiter(resolved);
    }
  }

  /** Delete one session and its transcript. */
  function remove(sessionId) {
    const existed = sessions.has(sessionId);
    if (existed) {
      mcpAuthBindings.retireSession(sessionId);
      mcpSessionAuth.retireSession(sessionId);
      mcpControlGate.retireSession(sessionId);
      // Invalidate callbacks before interrupting: cancellation itself may settle a turn.
      sessionGenerations.delete(sessionId);
      cliInputObservations.delete(sessionId);
      rejectDeferredStarts(sessionId, 'session deleted');
      heldAfterError.delete(sessionId);
      modelTurnQueues.delete(sessionId);
      warming.delete(sessionId);
      heldMcpVerbs.delete(sessionId);
      visibility.delete(sessionId);
      pendingVisibility.delete(sessionId);
      idleLifecycle.unregister(sessionId);
      const scheduled = scheduledWarms.get(sessionId);
      if (scheduled) clearTimeout(scheduled);
      scheduledWarms.delete(sessionId);
      activity.delete(sessionId);
      clearCliMcpRepoll(cliMcpStatuses.get(sessionId));
      revokeCliMcpApps(sessionId, cliMcpStatuses.get(sessionId));
      cliMcpStatuses.delete(sessionId);
      modelSelections.delete(sessionId);
      cancel(sessionId);
      if (typeof backend?.removeSession === 'function') backend.removeSession(sessionId);
      sessions.delete(sessionId);
      contextUsage.delete(sessionId);
      contextDetail.delete(sessionId);
    }
    transcripts.delete(sessionId);
    if (existed) {
      save();
      emit({ type: 'deleted', sessionId });
    }
    return { ok: Boolean(existed) };
  }

  // The inventory is a real process source. Without it we cannot infer that a
  // query is absent, so automatic warm must remain unavailable.
  function hasActiveQuery(sessionId) {
    if (typeof backend?.getActiveProcesses !== 'function') return null;
    try { return backend.getActiveProcesses().some(p => p.sessionId === sessionId); }
    catch { return null; }
  }

  function isVisible(sessionId) {
    const sources = visibility.get(sessionId);
    return !!sources && [...sources.values()].some(Boolean);
  }

  function scheduleVisibleWarm(sessionId) {
    if (disposed || !sessions.has(sessionId) || typeof backend?.warm !== 'function' ||
        hasActiveQuery(sessionId) !== false || warming.has(sessionId) || scheduledWarms.has(sessionId)) return;
    const stamp = performance.now();
    const delay = Math.max(0, nextWarmSlot - stamp);
    nextWarmSlot = Math.max(stamp, nextWarmSlot) + 1000;
    const run = () => {
      scheduledWarms.delete(sessionId);
      if (disposed || !sessions.has(sessionId) || !isVisible(sessionId) ||
          hasActiveQuery(sessionId) !== false || warming.has(sessionId) || pendingTurns.has(sessionId)) return;
      warmSession(sessionId).catch(error => log(`visibility warm failed for ${sessionId}: ${error?.message || error}`));
    };
    if (delay === 0) run();
    else {
      const timer = setTimeout(run, delay);
      timer.unref?.();
      scheduledWarms.set(sessionId, timer);
    }
  }

  function setVisibility(sessionId, isVisible, source = 'default') {
    if (disposed || typeof sessionId !== 'string' || typeof isVisible !== 'boolean') return false;
    if (!sessions.has(sessionId)) {
      const sources = new Map(pendingVisibility.get(sessionId)?.sources || []);
      if (isVisible) sources.set(source, true); else sources.delete(source);
      pendingVisibility.delete(sessionId); pendingVisibility.set(sessionId, {sources, lastSource: source});
      if (pendingVisibility.size > 64) pendingVisibility.delete(pendingVisibility.keys().next().value);
      return true;
    }
    pendingVisibility.delete(sessionId);
    let sources = visibility.get(sessionId);
    const known = !!sources;
    if (!sources) visibility.set(sessionId, sources = new Map());
    // Native registration starts with visible=true, visibilityKnown=false.
    const wasVisible = known ? [...sources.values()].some(Boolean) : true;
    if (isVisible) sources.set(source, true); else sources.delete(source);
    const visible = [...sources.values()].some(Boolean);
    if (wasVisible && !visible) {
      const scheduled = scheduledWarms.get(sessionId);
      if (scheduled) clearTimeout(scheduled);
      scheduledWarms.delete(sessionId);
      // The lifecycle owns transition timestamps and the configured timeout.
    }
    if (!wasVisible && visible) {
      // Idle cancellation occurs in the shared lifecycle below.
      scheduleVisibleWarm(sessionId);
    }
    idleLifecycle.onVisibilityChange(sessionId, visible);
    return true;
  }

  function replayPendingVisibility(sessionId) {
    const pending = pendingVisibility.get(sessionId);
    if (pending === undefined) return;
    pendingVisibility.delete(sessionId);
    if (!pending.sources.size) setVisibility(sessionId, false, pending.lastSource);
    else for (const source of pending.sources.keys()) setVisibility(sessionId, true, source);
  }

  function getWarmLifecycleState(sessionId) {
    const sources = visibility.get(sessionId);
    return { visibilityKnown: !!sources, isVisible: sources ? isVisible(sessionId) : null,
      hasActiveQuery: hasActiveQuery(sessionId), pendingVisibility: pendingVisibility.has(sessionId) ? pendingVisibility.get(sessionId).sources.size > 0 : undefined, warming: warming.has(sessionId),
      warmScheduled: scheduledWarms.has(sessionId), ...(activity.get(sessionId) || {}) };
  }

  async function warmSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    if (session.isArchived || session.stoppedUntilPersonSends || session.importedFrom && !session.resumeConfirmed) return undefined;
    if (typeof backend?.warm !== 'function') throw new Error('backend warm is unavailable');
    const warmGeneration = generation(sessionId), previousActor = backend.getInfo?.(sessionId)?.actorToken ?? null;
    const warmToken = {};
    warming.set(sessionId, warmToken);
    try {
      await backend.warm(sessionId, { sessionId, cwd: session.cwd || session.ccbResume?.cwd || process.env.CLAUDE_WORKSPACE || process.cwd(), model: session.model, permissionMode: session.permissionMode, cliSessionId: session.cliSessionId, ccbResume: session.ccbResume || null, resume: (transcripts.get(sessionId) || []).some(row => row && row.message) });
      const current = sessions.get(sessionId);
      if (disposed || sessionGenerations.get(sessionId) !== warmGeneration || !current) return undefined;
      const blocked = value => value?.isArchived || value?.stoppedUntilPersonSends || value?.importedFrom && !value.resumeConfirmed;
      if (blocked(current)) {
        const child = backend.getActiveProcesses?.().find(item => item.sessionId === sessionId && item.idleEligible);
        if (!previousActor && child && typeof backend.evictSession === 'function') {
          await backend.evictSession(sessionId, {pid: child.pid, actorToken: child.actorToken, protectionVersion: child.protection?.version,
            validate: () => !disposed && sessionGenerations.get(sessionId) === warmGeneration && !!blocked(sessions.get(sessionId)) && !pendingTurns.has(sessionId) && !sessions.get(sessionId)?.isRunning});
        }
        return undefined;
      }
      replayPendingVisibility(sessionId); idleLifecycle.onQueryInstalled(sessionId);
      return { sessionId, model: current.model, warmed: true };
    } finally { if (warming.get(sessionId) === warmToken) warming.delete(sessionId); }
  }

  async function prewarm(info = {}) {
    if (typeof backend?.warm !== 'function') throw new Error('backend prewarm is unavailable');
    const sessionId = `local_${crypto.randomUUID()}`;
    const draft = { sessionId, cliSessionId: crypto.randomUUID(), discarded: false, cwd: info.cwd, model: info.model || defaultSessionModel(), permissionMode: info.permissionMode === 'default' || !info.permissionMode ? 'acceptEdits' : info.permissionMode };
    draftWarms.set(sessionId, draft);
    const warmToken = {};
    warming.set(sessionId, warmToken);
    try {
      await backend.warm(sessionId, { sessionId, reason: 'prewarm', cwd: info.cwd || process.env.CLAUDE_WORKSPACE || process.cwd(), model: info.model || defaultSessionModel(), permissionMode: info.permissionMode === 'default' || !info.permissionMode ? 'acceptEdits' : info.permissionMode, cliSessionId: draft.cliSessionId });
      if (draft.discarded || draftWarms.get(sessionId) !== draft) throw new Error('prewarm discarded');
      return { sessionId, cwd: info.cwd || '', kind: info.kind || 'session', ready: true, createdAt: Date.now() };
    } catch (error) {
      if (draftWarms.get(sessionId) === draft) draftWarms.delete(sessionId);
      if (!sessions.has(sessionId)) backend.removeSession?.(sessionId);
      throw error;
    } finally { if (warming.get(sessionId) === warmToken) warming.delete(sessionId); }
  }

  function discardPrewarm(sessionId) {
    const draft = draftWarms.get(sessionId);
    if (!draft) return false;
    draft.discarded = true;
    draftWarms.delete(sessionId);
    if (!sessions.has(sessionId)) backend?.removeSession?.(sessionId);
    return true;
  }

  // Require an actor ledger. Its default empty values mirror the native consumer;
  // coverage metadata separately describes which event sources were observed.
  function pickLruIdleVictim(processes, { protectionForSession } = {}) {
    const flags = ['agentRun', 'stopping', 'cron', 'backgroundTasks', 'loopWakeup', 'remoteControl', 'lanyard', 'otherProtection', 'otherProtection2'];
    const eligible = [];
    for (const process of processes || []) {
      const id = process.sessionId, session = sessions.get(id), state = activity.get(id), sources = visibility.get(id);
      if (!session || !state || (sources && [...sources.values()].some(Boolean)) || warming.has(id) || session.isRunning || pendingTurns.has(id) || process.idleEligible !== true || process.initialized !== true) continue;
      if (!state.hasPendingResult && !state.idleUnarmedSince) continue;
      const protection = typeof protectionForSession === 'function' ? protectionForSession(id) : process.protection?.flags;
      if (!protection || flags.some(flag => protection[flag] !== false)) continue;
      eligible.push({ sessionId: id, pid: process.pid, actorToken: process.actorToken,
        protectionVersion: process.protection?.version,
        lastUsedAt: Math.max(state.lastHiddenTime || 0, state.lastResultTime || 0, state.idleUnarmedSince || 0) });
    }
    eligible.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return eligible[0] || null;
  }

  /** Stop the coalescing timer so a process can exit cleanly. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for(const timer of goalTimers.values())clearTimeout(timer);
    goalTimers.clear();
    // Seal admission before promise settlement can schedule further queue work.
    // Backend ownership/active-turn shutdown remains with the caller.
    for (const [id,pending] of pendingTurns) {
      if (pending.started || pending.cancelled) continue;
      pending.cancelled = true;
      pending.rejectCancelled(new Error('session kernel disposed'));
      pendingTurns.delete(id);
    }
    cliInputObservations.clear();
    heldAfterError.clear();
    for (const id of deferredStarts.keys()) rejectDeferredStarts(id, 'session kernel disposed');
    detachImportActorEvents?.();
    for (const sessionId of sessions.keys()) mcpAuthBindings.retireSession(sessionId);
    for (const sessionId of sessions.keys()) mcpSessionAuth.retireSession(sessionId);
    for (const sessionId of sessions.keys()) mcpControlGate.retireSession(sessionId);
    heldMcpVerbs.clear();
    for (const [sessionId, state] of cliMcpStatuses) revokeCliMcpApps(sessionId, state);
    detachLoopEvents?.();
    detachIdleEvents?.();
    detachMcpEvents?.();
    detachMcpDiscovery?.();
    for (const state of cliMcpStatuses.values()) clearCliMcpRepoll(state);
    cliMcpStatuses.clear();
    idleLifecycle.destroy();
    pendingVisibility.clear();
    for (const timer of scheduledWarms.values()) clearTimeout(timer);
    scheduledWarms.clear();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }

  return {
    start, sendMessage, getSession, getSessionLease, getCliInputObservation, getAll, getTranscript, getQueuedMessages, cancelQueuedMessage, reorderQueuedMessage, promoteHeldMessage,
    getContextUsage: id => sessions.has(id) ? contextUsage.get(id) || null : null,
    getContextUsageDetail,
    sendSteeredNow:(id,uuid)=>!disposed && running.has(id) ? backend?.sendSteeredNow?.(id,uuid) ?? false : false,
    // The uuid of the turn in flight, if any.
    //
    // Needed by the bridge's discardPendingTurn: taking a turn back has to name the prompt row
    // it removed, and that uuid lives only in the pending-turn token -- it is not on the session
    // record, and by the time the turn runs the prompt row is already in the transcript, so the
    // host-side queue does not have it either. Read-only; it changes nothing.
    getRunningTurnUuid: (id) => {
      const pending = pendingTurns.get(id);
      if (pending && typeof pending.messageUuid === 'string') return pending.messageUuid;
      return running.has(id) ? null : undefined;
    },
    // Whether the turn in flight has already produced output the model can act on.
    //
    // discardPendingTurn refuses to unsend once this is true: the prompt is no longer the only
    // thing that happened, so removing it would leave the transcript showing an answer to a
    // question that is no longer there. Returns false when no turn is running.
    turnProducesOutput: (id) => turnProducedOutput.get(id) === true,
    setTranscript, importBackupSessions, setModel, setEffort, update, remove, cancel, confirmImportedSessionResume,
    warmSession, prewarm, discardPrewarm, setVisibility, getWarmLifecycleState, pickLruIdleVictim,
    refreshCliMcpStatus, getCliMcpStatus, getCliMcpConfigEpoch, refreshCliMcpApps, getCliMcpApps, readCliMcpAppResource,
    mcpReconnect: mcpVerbs.mcpReconnect, mcpRetryConnection: mcpVerbs.mcpRetryConnection, mcpEnableServer: mcpVerbs.mcpEnableServer,
    mcpAuthenticate: mcpSessionAuth.mcpAuthenticate, mcpAuthenticateConfigServer, mcpSubmitOAuthCallbackUrl: mcpSessionAuth.mcpSubmitOAuthCallbackUrl, mcpClearAuth,
    requestApproval, respondToApproval, resolveAllApprovals,
    flush, dispose,
    storePath,
  };
}

module.exports = { createSessionKernel };
