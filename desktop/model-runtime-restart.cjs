'use strict';

// Provider clients, child environments and gateway adapters are process-lifetime
// resources. Restart at an idle boundary instead of partially updating them.
function createModelRuntimeRestart({ relaunch, isBusy = () => false,
  timers = { setTimeout, clearTimeout }, debounceMs = 800, pollMs = 250,
  onError = () => {} } = {}) {
  if (typeof relaunch !== 'function') throw new TypeError('relaunch is required');
  let pending = false, committed = false, disposed = false, timer, active = 0;
  function schedule(delay) {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(check, delay);
    timer?.unref?.();
  }
  function check() {
    timer = undefined;
    if (disposed || !pending || committed) return;
    try {
      if (active || isBusy()) return schedule(pollMs);
      committed = true;
      relaunch();
    } catch {
      // Errors may contain provider credentials; report only a fixed message.
      committed = false;
      try { onError('Model configuration restart deferred'); } catch { /* diagnostic only */ }
      schedule(pollMs);
    }
  }
  function assertReady() {
    if (pending || disposed) {
      const error = new Error('模型配置已保存，正在等待当前任务结束并重启。重启后请重试。');
      error.code = 'MODEL_RUNTIME_RESTART_PENDING';
      throw error;
    }
  }
  return {
    request() {
      if (disposed || committed) return;
      pending = true; // Close admission immediately, before the debounce timer.
      schedule(debounceMs);
    },
    assertReady,
    async run(fn) {
      assertReady();
      active++;
      try { return await fn(); } finally { active--; }
    },
    guardRunner(runner) {
      for (const name of ['run', 'runStream']) {
        if (typeof runner[name] !== 'function') continue;
        const original = runner[name].bind(runner);
        runner[name] = (...args) => this.run(() => original(...args));
      }
      return runner;
    },
    // Preserve optional native methods and events while gating operations which
    // create a new actor or turn. Steers/approvals/cancel for a live turn remain usable.
    guardBackend(backend) {
      for (const name of ['start', 'sendMessage', 'warm']) {
        if (typeof backend[name] !== 'function') continue;
        const original = backend[name].bind(backend);
        backend[name] = (...args) => { assertReady(); return original(...args); };
      }
      return backend;
    },
    dispose() { disposed = true; timers.clearTimeout(timer); timer = undefined; },
  };
}

function modelRuntimeBusy({ bridge, backends = [] } = {}) {
  for (const session of bridge?.diagnose?.().sessions || []) {
    if (session.isRunning || bridge.getWarmLifecycleState?.(session.sessionId)?.hasActiveQuery) return true;
  }
  for (const backend of backends) {
    for (const child of backend.getActiveProcesses()) {
      if (child.hasPendingTurn || child.pendingApprovals || child.pendingControls ||
          ['agentRun', 'stopping', 'backgroundTasks', 'loopWakeup', 'cron', 'remoteControl', 'lanyard']
            .some(flag => child.protection?.flags?.[flag])) return true;
    }
  }
  return false;
}

module.exports = { createModelRuntimeRestart, modelRuntimeBusy };
