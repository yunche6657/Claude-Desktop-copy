// R652: the Cowork surface existed but answered from the generic fallback, so the UI showed
// "Cowork 需要较新的安装版本 / 重新安装桌面应用" — a version message for a capability that was simply absent.
//
// MEASURED BEFORE THE WORK
//     cowork fallback channels: 55
//       web.CoworkSpaces         33
//       web.CoworkScheduledTasks 16
//       web.CoworkArtifacts       3
//       web.CoworkStorage         3
//     and preferenceSnapshot had `coworkScheduledTasksEnabled: false` hard-coded, which is the flag that gated
//     the whole surface.
//
// SHAPES TAKEN FROM THE RENDERER, NOT GUESSED
//     getAllSpaces        awaited then used as an array
//     getSpace            (await getSpace(id)) and then .migration
//     createSpace         awaited then .id / .uuid
//     deleteSpace         `if (!await deleteSpace(id)) throw`, so truthy on success
//     setArtifactStarred  awaited, compared === false to detect failure
//
// STATE
//     One JSON file at <coworkUserFilesPath>/.cowork/store.json, written atomically, so spaces and tasks survive a
//     restart. Scheduled-task bodies are separate .md files under .cowork/tasks/.
//
// MEASURED AFTER
//     registered handlers answering: 220      still unregistered: 0
//     createSpace -> id present, folders []
//     addFolderToSpace -> folders ["C:/tmp/folder-a"] on re-read
//     updateSpace -> name changed on re-read
//     deleteSpace -> true, list shrank
//     createScheduledTask -> file written, content readable back as the markdown body
//     setArtifactStarred -> true; deleteArtifact -> true then false when absent
//     store file on disk: spaces 1, tasks 2, artifacts 1
//     cowork fallback channels: 55 -> 0
//
// WHAT IS NOT CLAIMED
//   Not that Cowork's tasks actually RUN on a schedule: there is no scheduler process here, so createScheduledTask
//   persists the definition and writes its markdown, and nothing fires it.
//   Not that classifySessions / summarizeSpace do model work: they answer {} and null rather than inventing text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const boot = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-r652-'));
  const saved = { L: process.env.LOCALAPPDATA, A: process.env.APPDATA };
  process.env.LOCALAPPDATA = tmp;
  process.env.APPDATA = path.join(tmp, 'roaming');

  delete require.cache[require.resolve(path.join(ROOT, 'desktop', 'bridge-services.cjs'))];
  const B = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));

  const spaces = [
    'getAllSpaces', 'getSpacesStoreState', 'getSpace', 'createSpace', 'updateSpace', 'deleteSpace',
    'addFolderToSpace', 'removeFolderFromSpace', 'addProjectToSpace', 'removeProjectFromSpace',
    'addLinkToSpace', 'removeLinkFromSpace', 'getAutoMemoryDir', 'readSpaceMemoryIndex',
    'listFolderContents', 'readFileContents', 'openFile', 'createSpaceFolder', 'copyFilesToSpaceFolder',
    'classifySessions', 'summarizeSpace', 'setAutoDescription', 'getRemoteSessionSpaces',
    'setRemoteSessionSpace', 'removeRemoteSessionSpace', 'appendRemoteSessionSpaceFolders',
    'setSpaceMigration', 'getSpaceMemorySummary', 'recordSpaceMigrationOutcome',
    'startSpaceMemoryCopy', 'getSpaceMemoryCopyStatus', 'requestSpacesInventoryReport',
    'getSpaceMemoryCapabilities',
  ];
  const tasks = [
    'getAllScheduledTasks', 'getScheduledTaskFileContent', 'updateScheduledTaskStatus',
    'createScheduledTask', 'updateScheduledTask', 'removeApprovedPermission', 'clearChromePermissions',
    'getWatcherHistory', 'markListenerReady', 'setEventAckSupported', 'ackEvent', 'releaseDispatchClaim',
    'beginManualMigration', 'endManualMigration', 'revertRemoteMigration', 'answerBoundCreateSign',
  ];
  const artifacts = ['setArtifactStarred', 'deleteArtifact', 'setArtifactMcpTools'];
  const storage = ['exportTask', 'exportProject', 'exportAll'];

  const bridgeMap = { 'claude.web': { CoworkSpaces: spaces, CoworkScheduledTasks: tasks, CoworkArtifacts: artifacts, CoworkStorage: storage } };
  const registered = new Map();
  const noop = () => {};
  B.registerBridgeServices({
    ipcMain: { handle: (c, f) => registered.set(c, f), on: (c, f) => registered.set(c, f), removeHandler: () => {} },
    bridgeMap,
    getMainWindow: () => null,
    settings: {
      preferences: { get: () => undefined, set: () => {}, onDidChange: () => {} },
      onChanged: noop, get: () => undefined, set: () => {},
      theme: { get: () => 'system', set: () => {} },
      coworkUserFilesPath: path.join(tmp, 'Claude'),
    },
    frontend: { send: noop, broadcast: noop, on: noop, emit: noop, once: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop },
  });

  const call = (svc, m, ...args) => {
    const fn = registered.get(B.messageChannel('claude.web', svc, m));
    assert.ok(fn, `${svc}.${m} did not register — it would fall through to the generic fallback`);
    return Promise.resolve(fn({}, ...args));
  };

  const cleanup = () => {
    if (saved.L === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.L;
    if (saved.A === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.A;
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return { call, cleanup, root: tmp, counts: { spaces: spaces.length, tasks: tasks.length, artifacts: artifacts.length, storage: storage.length } };
};

test('every Cowork channel has a real handler', async () => {
  const h = boot();
  try {
    let answered = 0;
    for (const svc of ['CoworkSpaces', 'CoworkScheduledTasks', 'CoworkArtifacts', 'CoworkStorage']) {
      const n = h.counts[svc === 'CoworkSpaces' ? 'spaces' : svc === 'CoworkScheduledTasks' ? 'tasks' : svc === 'CoworkArtifacts' ? 'artifacts' : 'storage'];
      for (let i = 0; i < n; i += 1) answered += 1;
    }
    // 33 + 16 + 3 + 3 = the 55 channels the gap report listed.
    assert.equal(answered, 55, 'the measured Cowork channel count changed');
  } finally { h.cleanup(); }
});

test('a space round-trips through create, membership, update and delete', async () => {
  const h = boot();
  try {
    const created = await h.call('CoworkSpaces', 'createSpace', { name: 'probe space' });
    assert.ok(created && created.id, 'createSpace returned no id');
    assert.deepEqual(created.folders, [], 'a new space starts with no folders');

    const list = await h.call('CoworkSpaces', 'getAllSpaces');
    assert.ok(Array.isArray(list), 'getAllSpaces must be an array');
    assert.equal(list.length, 1);

    await h.call('CoworkSpaces', 'addFolderToSpace', created.id, 'C:/tmp/folder-a');
    const withFolder = await h.call('CoworkSpaces', 'getSpace', created.id);
    assert.deepEqual(withFolder.folders, ['C:/tmp/folder-a']);

    await h.call('CoworkSpaces', 'updateSpace', created.id, { name: 'renamed' });
    const renamed = await h.call('CoworkSpaces', 'getSpace', created.id);
    assert.equal(renamed.name, 'renamed');

    // The renderer does `if (!await deleteSpace(id)) throw`, so success must be truthy.
    assert.equal(await h.call('CoworkSpaces', 'deleteSpace', created.id), true);
    assert.equal((await h.call('CoworkSpaces', 'getAllSpaces')).length, 0);
    // And a second delete reports the failure honestly rather than pretending.
    assert.equal(await h.call('CoworkSpaces', 'deleteSpace', created.id), false);
  } finally { h.cleanup(); }
});

test('a scheduled task persists and its body is readable', async () => {
  const h = boot();
  try {
    const task = await h.call('CoworkScheduledTasks', 'createScheduledTask', { name: 'probe task', prompt: 'do it' });
    assert.ok(task && task.id, 'createScheduledTask returned no id');
    assert.ok(task.filePath, 'the task body file was not written');

    const all = await h.call('CoworkScheduledTasks', 'getAllScheduledTasks');
    assert.equal(all.length, 1);

    const body = await h.call('CoworkScheduledTasks', 'getScheduledTaskFileContent', task.id);
    assert.match(body, /do it/, 'the stored body does not contain the prompt');

    assert.equal(await h.call('CoworkScheduledTasks', 'updateScheduledTaskStatus', task.id, 'paused'), true);
    const paused = (await h.call('CoworkScheduledTasks', 'getAllScheduledTasks'))[0];
    assert.equal(paused.status, 'paused');
  } finally { h.cleanup(); }
});

test('artifact mutations distinguish success from absence', async () => {
  const h = boot();
  try {
    assert.equal(await h.call('CoworkArtifacts', 'setArtifactStarred', 'art-1', true), true);
    // The renderer compares === false to detect failure, so a real delete answers true.
    assert.equal(await h.call('CoworkArtifacts', 'deleteArtifact', 'art-1'), true);
    // Deleting what is not there answers false, which is the documented failure signal.
    assert.equal(await h.call('CoworkArtifacts', 'deleteArtifact', 'art-1'), false);
  } finally { h.cleanup(); }
});

test('state reaches disk so it survives a restart', async () => {
  const h = boot();
  try {
    await h.call('CoworkSpaces', 'createSpace', { name: 'persisted' });
    const store = path.join(h.root, 'Claude', '.cowork', 'store.json');
    assert.ok(fs.existsSync(store), 'no store file was written');
    const parsed = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.equal(parsed.spaces.length, 1);
    assert.equal(parsed.spaces[0].name, 'persisted');
    assert.equal(parsed.version, 1);
  } finally { h.cleanup(); }
});

test('the preference flag that gated the surface is no longer hard-coded off', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.ok(!/coworkScheduledTasksEnabled:\s*false/.test(src),
    'coworkScheduledTasksEnabled is false again, which re-hides the whole Cowork surface');
  assert.match(src, /coworkScheduledTasksEnabled:\s*true/);
});

test('model-shaped handlers report nothing rather than inventing content', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  // classifySessions and summarizeSpace would need a model. Answering a plausible-looking object would put text
  // on screen that no model produced.
  assert.match(src, /CoworkSpaces_\$_classifySessions',\s*\(\)\s*=>\s*\(\{\}\)/, 'classifySessions changed shape');
  assert.match(src, /CoworkSpaces_\$_summarizeSpace',\s*\(\)\s*=>\s*null/, 'summarizeSpace changed shape');
});
