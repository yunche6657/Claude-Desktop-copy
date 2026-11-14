'use strict';
// Explicit background acceptance only; calls the actual renderer/preload bridge.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runModelCheck({ phase, out, report, ev, getActiveCcbProcesses, verifyDefaultEntry, win }) {
  const bridge = (method, args = []) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const modelA = process.env.CLAUDE_AGENT_MODEL;
  const modelB = process.env.CLAUDE_PROOF_SWITCH_MODEL;
  assert.ok(modelA && modelB && modelA !== modelB, 'two distinct explicit proof models required');
  const tokenA = 'R362_REPLY_ALPHA';
  const tokenB = 'R362_REPLY_BETA';
  const pidFor = sid => getActiveCcbProcesses().find(child => child.sessionId === sid)?.pid || null;
  const turn = async (sid, token, recall = false) => {
    const prompt = recall ? 'Recall the exact token from your previous reply in this conversation. Reply only with that token; use no tools.'
      : 'Reply with exactly: ' + token + '. Use no tools.';
    const result = await bridge('sendMessage', [sid, prompt]);
    assert.equal(result.ok, true, JSON.stringify({ ok: result.ok, error: result.error }));
    assert.equal(result.text.trim(), token);
    return pidFor(sid);
  };
  let sid;
  if (phase === 'model-switch-active') {
    const control = process.env.CLAUDE_PROOF_CONTROL_URL;
    assert.ok(control && new URL(control).hostname === '127.0.0.1');
    sid = (await bridge('start', [{ cwd: process.env.CLAUDE_WORKSPACE, model: modelA }])).sessionId;
    await verifyDefaultEntry(sid);
    await ev(`window.__activeModelTurn=window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(sid)},'Reply with exactly: R362_REPLY_ALPHA. Use no tools.');true`);
    let held = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      held = (await (await fetch(control + '/proof-status')).json()).held;
      if (held) break;
      await sleep(100);
    }
    assert.ok(held, 'first upstream response must still be held');
    const started = Date.now();
    const switched = await bridge('setModel', [sid, modelB]);
    report.activeSelectionMs = Date.now() - started;
    assert.equal(switched.model, modelB);
    assert.ok((await (await fetch(control + '/proof-status')).json()).held, 'selection must return while the old turn is held');
    await fetch(control + '/proof-release', { method: 'POST' });
    const first = await ev('window.__activeModelTurn');
    assert.equal(first.ok, true); assert.equal(first.text.trim(), tokenA);
    report.firstPid = pidFor(sid);
    report.switchedPid = await turn(sid, tokenB);
    assert.equal(report.switchedPid, report.firstPid);
    report.activeSelectionReturnedBeforeRelease = true;
    report.sameActorHotSwitch = true;
  } else if (phase === 'model-switch') {
    const session = await bridge('start', [{ cwd: process.env.CLAUDE_WORKSPACE, title: 'Model switch background proof', model: modelA }]);
    sid = session.sessionId;
    await verifyDefaultEntry(sid);
    report.firstPid = await turn(sid, tokenA);
    assert.ok(report.firstPid);
    const switched = await bridge('setModel', [sid, modelB]);
    assert.equal(switched.model, modelB);
    assert.equal((await bridge('getSession', [sid])).model, modelB);
    report.switchedPid = await turn(sid, tokenB);
    assert.equal(report.switchedPid, report.firstPid, 'hot switch must keep the native actor');
    const second = await bridge('start', [{ cwd: process.env.CLAUDE_WORKSPACE, title: 'Independent model proof', model: modelA }]);
    report.otherSessionId = second.sessionId;
    report.otherPid = await turn(second.sessionId, tokenA);
    assert.ok(report.otherPid && report.otherPid !== report.firstPid);
    assert.equal((await bridge('getSession', [sid])).model, modelB);
    assert.equal((await bridge('getSession', [second.sessionId])).model, modelA);
    report.sameActorHotSwitch = true;
    report.independentSessionModel = true;
  } else {
    const seed = JSON.parse(fs.readFileSync(path.join(out, 'model-switch.json'), 'utf8'));
    sid = seed.sessionId;
    const session = await bridge('getSession', [sid]);
    assert.equal(session.model, modelB);
    const before = await bridge('getTranscript', [sid]);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex'), seed.transcriptHash);
    report.restoredPid = await turn(sid, tokenB, true);
    assert.ok(report.restoredPid && report.restoredPid !== seed.firstPid);
    report.savedModelRestored = true;
    report.differentActor = true;
  }
  report.sessionId = sid;
  report.models = { initial: modelA, selected: modelB };
  const transcript = await bridge('getTranscript', [sid]);
  report.transcriptHash = crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex');
  report.transcriptRows = transcript.length;
  report.transcriptTypes = transcript.map(row => row.type);
  report.fullTranscriptOmitted = true;
  assert.equal(transcript.length, phase === 'model-switch-restore' ? 6 : 4);
  await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(sid)});dispatchEvent(new PopStateEvent('popstate'));true`);
  await sleep(1000);
  report.renderedReplies = await ev(`([...document.querySelectorAll('main *')].filter(e=>e.textContent.trim()===${JSON.stringify(tokenB)}&&![...e.children].some(c=>c.textContent.trim()===${JSON.stringify(tokenB)}))).length`);
  assert.ok(report.renderedReplies >= 1, 'switched reply must render');
  fs.writeFileSync(path.join(out, phase + '.png'), (await win.webContents.capturePage()).toPNG());
}

module.exports = { runModelCheck };
