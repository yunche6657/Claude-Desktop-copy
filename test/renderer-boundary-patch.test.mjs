import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {patchRendererBoundary,parseRendererBoundaryConsole,LABEL}=require('../desktop/renderer-boundary-patch.cjs');
const source="class Boundary{componentDidCatch(e){this.props.onError?.(e),!this.hasCaptured&&(this.hasCaptured=true,this.report(e))}};globalThis.Boundary=Boundary";
test('precise boundary injection retains original catch and emits no message or foreign URL',()=>{
 const patched=patchRendererBoundary(source);assert.equal(patched.changed,true);
 const calls=[],original=[];const context={console:{error:(...v)=>calls.push(v)},location:{pathname:'/epitaxy/local_591fcec4-2bd7-4db8-954b-136105280c04'}};
 vm.runInNewContext(patched.text,context);
 const boundary=new context.Boundary();boundary.props={componentName:'EpitaxyChatPanel',metadata:{sessionId:'local_591fcec4-2bd7-4db8-954b-136105280c04'},onError:e=>original.push(e)};boundary.report=e=>original.push(e);
 const error={name:'TypeError',message:'PRIVATE_SECRET',stack:'TypeError: PRIVATE_SECRET\n at privateName (app://localhost/assets/v1/test-abc.js:1:22)\n at https://x.test?token=SECRET:1:2'};
 boundary.componentDidCatch(error);
 assert.equal(original.length,2);assert.equal(calls.length,1);assert.equal(calls[0][0],LABEL);
 assert.doesNotMatch(calls[0][1],/PRIVATE|SECRET|privateName|https/);
 const parsed=parseRendererBoundaryConsole(calls[0].join(' '));assert.deepEqual(parsed.frames,['assets/v1/test-abc.js:1:22']);
 assert.equal(patchRendererBoundary(patched.text).alreadyApplied,true);
 assert.equal(patchRendererBoundary('unrelated').changed,false);
});
test('other components and invalid console events do not record',()=>{
 const calls=[];const context={console:{error:(...v)=>calls.push(v)},location:{pathname:'/epitaxy'}};
 vm.runInNewContext(patchRendererBoundary(source).text,context);
 const boundary=new context.Boundary();boundary.props={componentName:'Other'};boundary.report=()=>{};boundary.componentDidCatch(new Error('secret'));
 assert.equal(calls.length,0);assert.equal(parseRendererBoundaryConsole('unrelated'),null);assert.equal(parseRendererBoundaryConsole(LABEL+'bad-json'),null);
});
