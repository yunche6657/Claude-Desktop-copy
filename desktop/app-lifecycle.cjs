'use strict';

const { buildRelaunchArgs } = require('./relaunch-args.cjs');

// Hold both ordinary quits and relaunches while the main process drains its
// resources and then waits for outstanding store writes to land.
function createAppLifecycle({ app, prepareForQuit, prepareForRelaunch, quiesce = async () => {}, onError = error => console.error('[quit]', error), timers = { setTimeout, clearTimeout }, cleanupTimeoutMs = 75000, quiesceTimeoutMs = 5000, exitTimeoutMs = app?.isPackaged ? 15000 : 5000 }) {
  if (!app || typeof app.on !== 'function' || typeof app.quit !== 'function' || typeof app.relaunch !== 'function' || typeof app.exit !== 'function') {
    throw new TypeError('Electron app lifecycle methods are required');
  }
  const prepare = prepareForQuit ?? prepareForRelaunch;
  if (typeof prepare !== 'function') throw new TypeError('prepareForQuit is required');
  if (typeof quiesce !== 'function') throw new TypeError('quiesce must be a function');
  let state = 'idle';
  let restart = false;
  let additionalArgs = [];
  let phaseTimer;
  let exitTimer;

  function report(error) {
    try { onError(error); } catch { /* diagnostics must not block shutdown */ }
  }

  function runPhase(fn, timeoutMs, label) {
    return new Promise(resolve => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(phaseTimer);
        phaseTimer = undefined;
        if (error) report(error);
        resolve();
      };
      phaseTimer = timers.setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
      Promise.resolve().then(fn).then(() => finish(), finish);
    });
  }

  async function prepareAndQuit() {
    await runPhase(prepare, cleanupTimeoutMs, 'Quit cleanup');
    if (state !== 'preparing') return;
    await runPhase(quiesce, quiesceTimeoutMs, 'Quit quiesce');
    if (state !== 'preparing') return;
    state = 'committed';
    if (restart) {
      try {
        const args = buildRelaunchArgs(process.argv, process.defaultApp, additionalArgs);
        if (!(globalThis.isDeveloperApprovedE2eTestHooksEnabled === true && process.env.CLAUDE_E2E_RELAUNCH_EXIT_ONLY === '1')) app.relaunch({ args });
      } catch (error) { report(error); }
    }
    exitTimer = timers.setTimeout(() => {
      if (state !== 'committed') return;
      report(new Error('Quit timed out; forcing process exit'));
      app.exit(0);
    }, exitTimeoutMs);
    exitTimer?.unref?.();
    app.quit();
  }

  function onQuit(event) {
    if (state === 'committed' || state === 'disposed') return;
    event.preventDefault();
    if (state === 'preparing') return;
    state = 'preparing';
    void prepareAndQuit();
  }
  app.on('before-quit', onQuit);
  app.on('will-quit', onQuit);

  return {
    relaunchApp(args = []) {
      if (state !== 'idle') return;
      restart = true;
      additionalArgs = [...args];
      try { app.quit(); } catch (error) { restart = false; throw error; }
    },
    dispose() {
      app.removeListener('before-quit', onQuit);
      app.removeListener('will-quit', onQuit);
      if (phaseTimer !== undefined) timers.clearTimeout(phaseTimer);
      if (exitTimer !== undefined) timers.clearTimeout(exitTimer);
      state = 'disposed';
    },
  };
}

module.exports = { createAppLifecycle };
