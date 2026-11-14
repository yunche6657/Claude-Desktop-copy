// A tool call and its output are visible in the conversation, not only in the transcript.
//
// MEASURED (replica :10510) with a prompt that deliberately does NOT contain the answer:
//   'Use the Read tool on the file that holds this project name. Then tell me the name.'
//
//   rows                            6
//   promptMentionsPackageJson       false      (the prompt never names the file)
//   domMentionsPackageJson          true       (so it came from the tool, rendered)
//   domMentionsName                 true       ('code-desktop-reconstruction')
//
// The control matters: an earlier probe asked for 'package.json' by name and then found that
// string in the DOM — but it was the USER'S OWN PROMPT echoed back, not the tool result. That
// measurement proved nothing. Removing the filename from the prompt is what made it evidence.
//
// A second false alarm from the same round: searching resources/ion-dist/assets for 'tool_use'
// returned 0 hits, which looked like 'the frontend cannot render tools'. That directory holds
// only 6 worker bundles (2.4 MB). The real bundles are under assets/v1 (3 797 files) and contain
// 1 656 occurrences of tool_use. Searching the wrong directory produced a confident wrong answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the transcript records a tool_use block with a name', () => {
  // Measured: rows [user, assistant(tool_use Read), user(tool_result), assistant(text)].
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const call = \{ id: event\.id, name: event\.name, input: event\.input, content: '', isError: false \}/,
    'the tool call record lost its id/name/input');
});

test('a tool result is paired with its call by id', () => {
  // Without the pairing the UI cannot tell which output belongs to which card.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /byToolId\.set\(event\.id, call\)/, 'the call is not registered by id');
  assert.match(kernel, /byToolId\.get\(event\.id\)/, 'the result is not matched to its call');
});

test('the shipped frontend does render tool_use blocks', () => {
  // Measured: 1 656 occurrences across assets/v1. Asserted on the directory that actually
  // contains the app bundles, not assets/ (workers only).
  const v1 = path.join(ROOT, 'resources', 'ion-dist', 'assets', 'v1');
  assert.ok(fs.existsSync(v1), 'the v1 asset directory is missing');
  let hits = 0;
  for (const f of fs.readdirSync(v1).filter((x) => x.endsWith('.js'))) {
    hits += read(path.join('resources', 'ion-dist', 'assets', 'v1', f)).split('tool_use').length - 1;
    if (hits > 0) break;
  }
  assert.ok(hits > 0, 'the shipped frontend has no tool_use handling');
});

test('a tool_use row reaches the renderer as a message event', async t => {
  const {createSessionKernel} = createRequire(import.meta.url)('../desktop/session-kernel.cjs');
  const events = [];
  let listener;
  const tool = {type:'tool_use', id:'read-1', name:'Read', input:{file_path:'fixture.txt'}};
  const backend = {id:'fixture', start(){}, cancel(){}, dispose(){},
    onEvent(fn){listener=fn; return ()=>{}},
    async sendMessage(sessionId){
      listener({sessionId,type:'raw',frame:{type:'assistant',message:{role:'assistant',id:'a',content:[tool]}}});
      return {text:'done'};
    }};
  const kernel = createSessionKernel({backend,emit:event=>events.push(event)});
  t.after(()=>kernel.dispose());
  const {sessionId} = kernel.start({});
  assert.equal((await kernel.sendMessage(sessionId,'inspect the fixture')).ok,true);
  const rows=events.filter(e=>e.sessionId===sessionId && e.type==='message').map(e=>e.message);
  assert.deepEqual(rows,kernel.getTranscript(sessionId));
  assert.deepEqual(rows.find(row=>row.type==='assistant').message.content,[tool]);
});
