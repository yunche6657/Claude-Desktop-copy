'use strict';
const { randomUUID } = require('node:crypto');

// One ledger per host send on one actor. Only written entries need CLI
// cancellation. An echo can retire an entry while a control reply is in flight.
function createSteerQueue({ owned, canWrite, write, cancel, announce, changed, delayMs = 30000 }) {
  const entries = new Map();
  let timer, escalation, cancelling;
  function clearTimer() {
    if (timer && ![...entries.values()].some(entry => !entry.written)) {
      clearTimeout(timer);
      timer = undefined;
    }
  }
  function dispatch(entry, priority) {
    if (!owned() || !canWrite()) return false;
    entry.frame = {...entry.frame, priority};
    entry.written = true;
    if (!write(entry.frame)) {
      entry.written = false;
      return false;
    }
    clearTimer();
    return true;
  }
  function flush() {
    if (!owned() || !canWrite()) return;
    for (const entry of entries.values()) {
      if (!entry.written && !dispatch(entry,'next')) break;
    }
  }
  function accept(frame, hold) {
    if (!owned() || !canWrite() || entries.has(frame.uuid) || entries.size>=32) return false;
    const entry = {frame, written:false};
    entries.set(frame.uuid,entry);
    if (hold) {
      if (!timer) {
        timer = setTimeout(() => { timer=undefined; flush(); },delayMs);
        timer.unref?.();
      }
    } else if (!dispatch(entry,frame.priority)) {
      entries.delete(frame.uuid);
      return false;
    }
    announce({type:'steer_accepted',frame});
    if (frame.priority==='now' && !hold && owned() && entries.has(frame.uuid)) {
      escalation=frame.uuid;
      announce({type:'steer_escalating',userMessageUuid:frame.uuid});
    }
    return true;
  }
  function forget(uuid) {
    entries.delete(uuid);
    if (escalation===uuid) escalation=undefined;
    clearTimer();
  }
  function observe(uuid) {
    const entry=entries.get(uuid);
    if (!entry?.written || !owned()) return;
    forget(uuid);
    announce({type:'steer_observed',frame:entry.frame});
  }
  function park(entry) {
    const {priority,...frame}=entry.frame;
    forget(frame.uuid);
    announce({type:'steer_parked',frame});
  }
  function atBoundary() {
    if (!owned()) { dispose(); return; }
    // The receiver puts parked inputs at the front of the deferred queue.
    for (const entry of [...entries.values()].reverse()) if (!entry.written) park(entry);
  }
  function withdraw(uuid) {
    const entry=entries.get(uuid);
    if (!entry || !owned()) return false;
    if (!entry.written) { forget(uuid); return true; }
    entry.withdraw=true;
    if (entry.pending) return entry.pending.then(()=>entry.withdrawn===true);
    return requestRemoval(entry,false);
  }
  function escalate(uuid) {
    const entry=entries.get(uuid);
    if (!entry || !owned() || !canWrite() || escalation || cancelling || entry.withdraw) return false;
    if (entry.written) return requestRemoval(entry,true);
    if (!dispatch(entry,'now')) return false;
    escalation=uuid;
    announce({type:'steer_escalating',userMessageUuid:uuid});
    return true;
  }
  function requestRemoval(entry, promote) {
    const uuid=entry.frame.uuid;
    if (promote) cancelling=uuid;
    entry.pending=(async()=>{
      try {
        const answer=await cancel(uuid);
        if (!owned() || entries.get(uuid)!==entry || answer?.cancelled!==true) return false;
        forget(uuid);
        if (entry.withdraw) { entry.withdrawn=true; return !promote; }
        const next=randomUUID();
        entry.frame={...entry.frame,uuid:next};
        entry.written=false;
        entries.set(next,entry);
        announce({type:'steers_rekeyed',rekeyedSteers:[{from:uuid,to:next}]});
        if (!owned() || entries.get(next)!==entry) return false;
        if (!dispatch(entry,'now')) { park(entry); return true; }
        escalation=next;
        announce({type:'steer_escalating',userMessageUuid:next});
        return true;
      } catch { return false; }
      finally {
        entry.pending=undefined;
        entry.withdraw=false;
        if (cancelling===uuid) cancelling=undefined;
        if (owned()) changed();
      }
    })();
    return entry.pending;
  }
  function dispose() {
    clearTimeout(timer);
    entries.clear();
    cancelling=undefined;
    escalation=undefined;
  }
  return {accept,flush,observe,atBoundary,withdraw,escalate,dispose,
    get uuids(){return [...entries.keys()]},
    get busy(){return entries.size>0 || !!cancelling},
    get escalating(){return !!escalation || !!cancelling}};
}
module.exports={createSteerQueue};
