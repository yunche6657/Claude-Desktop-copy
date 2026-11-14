// Session archive and resume through the real desktop shell.
//
// Covers the two things that can silently corrupt a user's history: archiving
// must keep the transcript, and a resume decision must not append to a finished
// conversation. Both are driven through the EIPC bridge against a real session
// store, then checked on disk.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let detach;
let mainWindow;
let dir;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  // The archive lives under userData, so it must be redirected into this run's
  // temp directory. Otherwise a previous run's archived-sessions.idx would be
  // read back and the counts would drift between runs.
  app.setPath('userData', path.join(dir, 'userData'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const dataDir = path.join(dir, 'data');
  server = createApp({ dataDir, mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload-main-view.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bus = new EipcBus();
  detach = registerDesktopServices({ bus, mainWindow, sessions: server.sessions, mode: 'demo', consent: null });
  await mainWindow.loadURL(origin);

  const js = code => mainWindow.webContents.executeJavaScript(code);

  // A session with one completed turn, produced by the real engine.
  const session = await js(`window.claudeAppBindings.createSession({ title: '归档测试', projectPath: '' })`);
  assert.equal(typeof session.id, 'string');

  await js(`window.claudeAppBindings.sendPrompt(${JSON.stringify(session.id)}, '第一轮')`);
  // Wait for the demo run to finish before archiving.
  for (let i = 0; i < 100; i++) {
    const stored = await js(`window.claudeAppBindings.getSession(${JSON.stringify(session.id)})`);
    const last = stored.messages[stored.messages.length - 1];
    if (last && last.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // A completed session that does not resume its transcript must start fresh.
  const finishedPolicy = await js(
    `window.claudeAppBindings.getResumePolicy(${JSON.stringify(session.id)}, { remoteControlSpawn: true })`,
  );
  assert.equal(finishedPolicy.resume, false, 'a completed session must not resume by default');
  assert.match(finishedPolicy.reason, /does not resume its transcript/);

  // Without a remote-control spawn it never resumes, regardless of state.
  const plainPolicy = await js(
    `window.claudeAppBindings.getResumePolicy(${JSON.stringify(session.id)}, {})`,
  );
  assert.equal(plainPolicy.resume, false);
  assert.match(plainPolicy.reason, /starts fresh/);

  // prepareResume persists a transcript and reports the resume decision.
  const prepared = await js(
    `window.claudeAppBindings.prepareResume(${JSON.stringify(session.id)}, { remoteControlSpawn: false })`,
  );
  assert.equal(prepared.resume, false);
  assert.deepEqual(prepared.messages, [], 'a fresh start gets no history');
  assert.ok(!('CLAUDE_BRIDGE_REATTACH_SESSION' in prepared.env), 'a fresh start must not set the reattach env');

  // The transcript must now exist on disk under the observed layout.
  const sessionsDir = path.join(app.getPath('userData'), 'claude-code-sessions');
  const transcript = path.join(sessionsDir, `local_${session.id.replace(/^(?:cse|session)_/, '')}.json`);
  assert.ok(fs.existsSync(transcript), `transcript not written at ${transcript}`);

  // Archiving removes it from the live list but keeps the transcript.
  const archived = await js(`window.claudeAppBindings.archiveSession(${JSON.stringify(session.id)})`);
  assert.equal(archived.id, session.id.replace(/^(?:cse|session)_/, ''));

  const liveAfter = await js(`window.claudeAppBindings.listSessions()`);
  assert.ok(!liveAfter.some(s => s.id === session.id), 'archived session must leave the live list');

  const archivedList = await js(`window.claudeAppBindings.listArchivedSessions()`);
  assert.equal(archivedList.length, 1, `unexpected archive index: ${JSON.stringify(archivedList)}`);
  assert.equal(archivedList[0].id, archived.id);
  assert.equal(archivedList[0].hasTranscript, true);
  assert.ok(fs.existsSync(transcript), 'archiving must not delete the transcript');

  // Restoring puts it back in the index without needing the live store.
  const restored = await js(`window.claudeAppBindings.unarchiveSession(${JSON.stringify(session.id)})`);
  assert.equal(restored.ok, true);
  const afterRestore = await js(`window.claudeAppBindings.listArchivedSessions()`);
  assert.equal(afterRestore.length, 0);
  assert.ok(fs.existsSync(transcript), 'the transcript survives a round trip');

  // The index file lives where the bundle puts it.
  const indexPath = path.join(sessionsDir, 'archived-sessions.idx');
  assert.ok(fs.existsSync(indexPath), 'archive index must be created');

  // An unknown session is refused rather than silently accepted.
  const missing = await js(`window.claudeAppBindings.getResumePolicy('nope', {})`)
    .then(value => ({ value }), error => ({ thrown: String(error && error.message) }));
  assert.match(missing.thrown || '', /no session nope/);

  // The UI offers archiving and the row disappears after clicking it.
  const ui = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const second = await window.claudeAppBindings.createSession({ title: 'UI 归档', projectPath: '' });
    location.reload();
    return second.id;
  })()`);
  await mainWindow.webContents.executeJavaScript('new Promise(r => setTimeout(r, 1200))');

  const uiResult = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100 && !document.querySelector('.task-archive'); i++) await wait(50);
    const rows = [...document.querySelectorAll('#sessions .task-row')];
    const target = rows.find(r => r.querySelector('button').textContent === 'UI 归档');
    if (!target) return { found: false, titles: rows.map(r => r.querySelector('button').textContent) };
    target.querySelector('.task-archive').click();
    for (let i = 0; i < 100; i++) {
      await wait(50);
      if (![...document.querySelectorAll('#sessions .task-row button:first-child')].some(b => b.textContent === 'UI 归档')) break;
    }
    const after = [...document.querySelectorAll('#sessions .task-row button:first-child')].map(b => b.textContent);
    return { found: true, after };
  })()`);
  assert.equal(uiResult.found, true, `archive button missing: ${JSON.stringify(uiResult.titles)}`);
  assert.ok(!uiResult.after.includes('UI 归档'), 'the archived row must disappear from the list');

  const archivedAfterUi = await js(`window.claudeAppBindings.listArchivedSessions()`);
  assert.ok(archivedAfterUi.some(entry => entry.title === 'UI 归档'), 'the UI archive must reach the index');

  console.log(JSON.stringify({
    ok: true,
    finishedPolicy: finishedPolicy.resume,
    plainPolicy: plainPolicy.resume,
    transcriptWritten: true,
    archivedKeepsTranscript: true,
    restored: restored.ok,
    indexCreated: true,
    uiArchived: true,
    archivedCount: archivedAfterUi.length,
  }));

  detach?.();
  bus.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  server.closeAllConnections();
  server.close(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(0);
  });
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
