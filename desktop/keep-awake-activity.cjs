'use strict';

// Fixed 2.42304 sessionLosableWork.sessionActivityKind for the keep-awake
// call with includeSshSurvivors:true. Facts must come from held sessions and
// actor ledgers; missing facts are not equivalent to false.
const REQUIRED = ['remoteClient', 'violinBow', 'hasQuery', 'lanyardConnected',
  'turnRunning', 'unattended', 'waitingOnUser', 'hasHeldInput',
  'heldInputSurvives', 'losableBackground', 'liveCron', 'liveLoop'];

function activityKind(facts) {
  if (!facts || REQUIRED.some(key => typeof facts[key] !== 'boolean')) {
    throw new TypeError('complete boolean keep-awake activity facts required');
  }
  if (facts.remoteClient && facts.hasQuery) return 'remote_client';
  if (facts.violinBow && facts.hasQuery) return 'violin_bow';
  if (facts.lanyardConnected) return 'lanyard';
  if (facts.turnRunning && (facts.unattended || !facts.waitingOnUser)) return 'turn';
  if (facts.hasHeldInput && !facts.heldInputSurvives) return 'held_input';
  if (facts.losableBackground) return 'background_task';
  if (facts.liveCron || facts.liveLoop) return 'loop';
  return undefined;
}

function countKeepAwakeActivity(heldSessionFacts) {
  if (!heldSessionFacts || typeof heldSessionFacts[Symbol.iterator] !== 'function') {
    throw new TypeError('authoritative held session facts required');
  }
  // YCr consumes only these two categories. restartLosesWorkKind has an
  // additional SSH held-input fallback that does not change either count.
  const counts = { background_task: 0, loop: 0 };
  for (const facts of heldSessionFacts) {
    const kind = activityKind(facts);
    if (kind === 'background_task' || kind === 'loop') counts[kind]++;
  }
  return counts;
}

// Manual status is transient and is cleared on archive/account switch.
function manualKeepAwakeValue({ requested, archived, prewarmHidden, violinBow }) {
  if ([requested, archived, prewarmHidden, violinBow].some(value => typeof value !== 'boolean')) {
    throw new TypeError('complete boolean manual keep-awake facts required');
  }
  return requested && !archived && !prewarmHidden && !violinBow ? true : undefined;
}

// Fixed sessionLosableWork checks the permission broker's settled main-turn
// predicate (10 seconds), not merely whether any approval is pending.
function isWaitingOnUser(facts) {
  if (!facts || !Object.hasOwn(facts, 'statusCategory')) throw new TypeError('complete waiting-on-user facts required');
  const { settledMainPermission, deferredSends, pendingInput, losableBackground,
    turnRunning, workflow, statusCategory } = facts;
  if ([settledMainPermission, deferredSends, pendingInput, losableBackground, turnRunning, workflow]
    .some(value => typeof value !== 'boolean') ||
    (statusCategory !== undefined && typeof statusCategory !== 'string')) {
    throw new TypeError('complete waiting-on-user facts required');
  }
  if (settledMainPermission) return !deferredSends && !pendingInput && !losableBackground;
  if (turnRunning || workflow) return false;
  return statusCategory === 'blocked' || statusCategory === 'need_input' || statusCategory === 'failed';
}

function isUnattended({ scheduledTask, dispatchParent, dispatchOrigin, remoteControl, bridgeSession, violinBow }) {
  if ([scheduledTask, dispatchParent, dispatchOrigin, remoteControl, bridgeSession, violinBow]
    .some(value => typeof value !== 'boolean')) throw new TypeError('complete attendance facts required');
  return scheduledTask || dispatchParent || dispatchOrigin || remoteControl || bridgeSession || violinBow;
}

module.exports = { activityKind, countKeepAwakeActivity, manualKeepAwakeValue, isWaitingOnUser, isUnattended };
