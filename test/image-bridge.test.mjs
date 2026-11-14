import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');

test('both image send entry points preserve attachments and use their own captured UUID positions', async t => {
  const handlers = new Map(), calls = [];
  const bridge = registerBridgeServices({
    ipcMain: {handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow:()=>null,
    settings: {kernelFactory:()=>({sendMessage:(...args)=>{calls.push(args);return {ok:true};}})}, frontend:{root:process.cwd()},
  });
  t.after(()=>bridge.dispose());
  const call = (service,...args)=>handlers.get(messageChannel('claude.web',service,'sendMessage'))({},...args);
  const images=[{base64:'AQID',mimeType:'image/png'}];
  await call('LocalAgentModeSessions','sid','text',images,[],'agent-uuid');
  await call('LocalSessions','sid','text',images,{},'attachment-value',undefined,undefined,'local-uuid');
  assert.deepEqual(calls,[
    ['sid','text',{images,messageUuid:'agent-uuid'}],
    ['sid','text',{images,messageUuid:'local-uuid',deferIfBusy:true,plainInput:false}],
  ]);
});
