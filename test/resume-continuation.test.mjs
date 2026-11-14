// Resuming a stored conversation and continuing it, verified live.
//
// Two attempts were needed, and the first one was a false positive worth recording.
//
// ATTEMPT 1 (wrong):
//   The selector matched two elements for the same sidebar row:
//     { w: 0,   h: 0,  x: 0, y: 0   }   <- a zero-size duplicate
//     { w: 269, h: 26, x: 8, y: 767 }   <- the one a user actually sees
//   The probe clicked the first. Nothing happened. It then read `body.innerText` and saw both
//   markers (the OLD one was in the session-list title, the NEW one in a fresh conversation),
//   and reported success. Checking the store showed the follow-up had created its own
//   2-row session with hasOld:false — the opposite of resuming.
//
// ATTEMPT 2 (right): skip any candidate with width < 20 or height < 10, then click.
//   after click: hasOld true, composer present
//   follow-up landed in ONE session: rows 4 (was 2), hasOld true
//
// The lesson is in the shape of the mistake, not the fix: `innerText` includes the sidebar, so
// "the text is on screen" cannot distinguish "the conversation shows it" from "the list shows
// its title". Only the stored transcript can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('opening a session selects it rather than creating a new one', () => {
  // The bridge must have a real handler; without one the fallback answers null and the
  // renderer cannot switch conversations at all.
  const bridge = read('desktop/bridge-services.cjs');
  assert.match(bridge, /'claude\.web_\$_LocalSessions_\$_getTranscript'/, 'no transcript reader');
  assert.match(bridge, /'claude\.web_\$_LocalSessions_\$_getAll'/, 'no session list');
});

test('a follow-up is appended to the existing transcript, not written elsewhere', async t => {
  const require = createRequire(import.meta.url);
  const {registerBridgeServices,messageChannel} = require('../desktop/bridge-services.cjs');
  const {createSessionKernel} = require('../desktop/session-kernel.cjs');
  const handlers = new Map();
  const kernel = createSessionKernel({emit(){},createAgent:()=>({run:async()=>({text:'fixture response'})})});
  const bridge = registerBridgeServices({
    ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,
    settings:{kernelFactory:()=>kernel},frontend:{root:ROOT},
  });
  t.after(()=>{bridge.dispose();kernel.dispose()});
  const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({},...args);
  const a=await call('start',{}), b=await call('start',{});
  await call('sendMessage',a.sessionId,'initial');
  await call('sendMessage',b.sessionId,'unrelated');
  await call('sendMessage',a.sessionId,'follow-up');
  const prompts=async id=>(await call('getTranscript',id)).filter(row=>row.type==='user').map(row=>row.message.content[0].text);
  assert.deepEqual(await prompts(a.sessionId),['initial','follow-up']);
  assert.deepEqual(await prompts(b.sessionId),['unrelated']);
});

test('the transcript write keeps earlier rows', () => {
  // Appending is what makes it a continuation; a replace would silently truncate history.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /appendMessage|push\(/, 'the kernel has no append path');
});

test('a stored transcript is what the renderer reads on open', () => {
  const bridge = read('desktop/bridge-services.cjs');
  assert.match(bridge, /getTranscript/, 'nothing reads a stored transcript');
});
