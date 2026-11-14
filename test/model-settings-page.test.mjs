import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../tools/model-settings-page.js',import.meta.url),'utf8');
const bundle=fs.readFileSync(new URL('../resources/ion-dist/assets/v1/c71860c77-BwbfSKgy.js',import.meta.url),'utf8');
function mount(overrides={}){
 const states=[],refs=[],effects=[],calls=[];let cursor=0,refCursor=0;
 const node=(type,props)=>({type,props});
 const bridge={listConfigs:async()=>({entries:[],appliedId:null}),createConfig:async opts=>{calls.push(['create',opts]);return{ok:true,id:'new-id'}},setAppliedConfig:async id=>calls.push(['apply',id]),relaunchApp:async()=>calls.push(['restart']),...overrides};
 const context=vm.createContext({URL,u(value){const index=cursor++;if(!(index in states))states[index]=value;return[states[index],value=>states[index]=typeof value==='function'?value(states[index]):value]},n(value){return refs[refCursor++]??={current:value}},c(fn){effects.push(fn)},r:node,i:node,a:'Fragment',b:'Input',f:'Button',g:{Root:'DialogRoot',Popup:'DialogPopup',Header:'DialogHeader',Footer:'DialogFooter'},'claude.settings':{Custom3pSetup:bridge}});
 const component=vm.runInContext(`(${source})`,context);
 const render=()=>{cursor=0;refCursor=0;return component()};
 const nodes=root=>root&&typeof root==='object'?[root,...[root.props?.children].flat(Infinity).flatMap(nodes)]:[];
 const find=fn=>nodes(render()).find(fn);
 const field=label=>find(node=>node.props?.['aria-label']===label);
 const change=(label,value)=>field(label).props.onChange({target:{value}});
 const click=text=>find(node=>node.type==='Button'&&node.props.children===text).props.onClick();
 return{render,find,field,change,click,calls};
}
test('model route renders compact one-page configuration with existing settings controls',()=>{
 assert.ok(bundle.includes(source));assert.match(bundle,/t\?r\(ModelSettingsPage,\{\}\)/);
 const ui=mount();for(const label of ['服务 URL','API 密钥','模型列表','订阅 URL'])assert.ok(ui.field(label));
 assert.equal(ui.find(node=>node.type==='nav'),undefined);
 assert.equal(ui.field('API 密钥').props.type,'password');
});
test('save persists edited fields and applies profile before optional restart',async()=>{
 const ui=mount();ui.change('服务 URL','https://fixture.test');ui.change('API 密钥','fixture-key');ui.change('模型列表','first\nsecond\nfirst');ui.change('接口类型','openai-chat');
 await ui.click('保存并重启');
 assert.equal(ui.calls[0][1].config.inferenceApiType,'openai-chat');
  assert.equal(ui.calls[0][0],'create');assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0][1].config.inferenceModels)),['first','second']);
 assert.deepEqual(ui.calls.slice(1),[['apply','new-id'],['restart']]);
});
test('an explicit apply failure stays visible and prevents restart or success notice',async()=>{
 const ui=mount({setAppliedConfig:async()=>({ok:false,error:'应用配置失败：fixture'})});
 ui.change('服务 URL','https://fixture.test');ui.change('模型列表','fixture');
 await ui.click('保存并重启');
 assert.equal(ui.find(node=>node.props?.role==='alert').props.children,'应用配置失败：fixture');
 assert.equal(ui.calls.some(call=>call[0]==='restart'),false);
 assert.equal(ui.find(node=>node.props?.children==='已保存并设为当前配置'),undefined);
});
test('URL import previews config without persisting until save',async()=>{
 const ui=mount({importModelSubscription:async options=>{assert.equal(options.url,'https://fixture.test/sub');return{ok:true,configs:[{name:'From URL',config:{inferenceGatewayBaseUrl:'https://api.fixture.test',inferenceGatewayApiKey:'import-key',inferenceModels:['model-a']}}]}}});
 ui.change('订阅 URL','https://fixture.test/sub');await ui.click('导入');
 assert.equal(ui.field('服务 URL').props.value,'https://api.fixture.test');assert.equal(ui.field('模型列表').props.value,'model-a');assert.equal(ui.calls.length,0);
 await ui.click('保存');assert.equal(ui.calls[0][1].name,'From URL');
});
test('fetch models previews selection, preserves current default and supports changing default',async()=>{
 const ui=mount({discoverModels:async options=>{assert.equal(options.apiType,'openai-chat');return{ok:true,models:[{id:'new-model',name:'New model'},{id:'existing',name:'Existing'}]}}});
 ui.change('服务 URL','http://127.0.0.1:3000/v1');ui.change('API 密钥','fixture-key');ui.change('接口类型','openai-chat');ui.change('模型列表','existing');
 await ui.click('获取可用模型');assert.equal(ui.field('模型列表').props.value,'existing');
  assert.equal(ui.field('选择可用模型').type,'DialogPopup');ui.change('搜索可用模型','new');
  assert.ok(ui.field('选择模型 new-model'));assert.equal(ui.field('选择模型 existing'),undefined);
  await ui.click('全选搜索结果');await ui.click('添加所选模型');assert.equal(ui.field('模型列表').props.value,'existing\nnew-model');
 ui.change('默认模型','new-model');assert.equal(ui.field('模型列表').props.value,'new-model\nexisting');assert.equal(ui.calls.length,0);
});

test('default selector exists for saved models before discovery and cancellation leaves catalogue untouched',async()=>{
 const ui=mount({discoverModels:async()=>({ok:true,models:[{id:'remote-a'},{id:'remote-b'}]})});
 ui.change('模型列表','saved-a\nsaved-b');assert.equal(ui.field('默认模型').props.value,'saved-a');
 ui.change('默认模型','saved-b');assert.equal(ui.field('模型列表').props.value,'saved-b\nsaved-a');
 ui.change('服务 URL','https://fixture.test');ui.change('API 密钥','fixture-key');await ui.click('获取可用模型');
 ui.field('选择模型 remote-b').props.onChange({target:{checked:true}});await ui.click('取消');
 assert.equal(ui.field('选择可用模型'),undefined);assert.equal(ui.field('模型列表').props.value,'saved-b\nsaved-a');
});

test('explicit per-model capabilities persist arbitrary efforts, optional default, none and auto',async()=>{
 const ui=mount({writeConfig:async(id,config)=>{ui.calls.push(['write',config]);return{ok:true}},renameConfig:async()=>({ok:true})});ui.change('服务 URL','https://fixture.test');ui.change('模型列表','opaque-a\nopaque-b');
 ui.change('能力模式 opaque-a','custom');ui.change('支持的 effort opaque-a','minimal, xhigh, high');
 assert.equal(ui.field('支持的 effort opaque-a').props.value,'minimal, xhigh, high');
 ui.change('默认 effort opaque-a','xhigh');ui.change('能力模式 opaque-b','none');
 await ui.click('保存');let config=ui.calls[0][1].config;
 assert.deepEqual(JSON.parse(JSON.stringify(config.inferenceModelCapabilities)),{'opaque-a':{supportedEfforts:['minimal','xhigh','high'],defaultEffort:'xhigh'},'opaque-b':{supportedEfforts:[]}});
 ui.change('能力模式 opaque-a','auto');ui.change('能力模式 opaque-b','custom');ui.change('支持的 effort opaque-b','');
 assert.ok(ui.field('支持的 effort opaque-b'));await ui.click('保存');
 assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call=>call[0]==='write')[1].inferenceModelCapabilities)),{'opaque-b':{supportedEfforts:[]}});
 assert.equal(ui.field('能力模式 opaque-a').props.value,'auto');
});
test('imported metadata survives load/save and auto removes only the chosen override',async()=>{
 const rows=[{id:'opaque',name:'Display',supportedEfforts:['low','ultra'],defaultEffort:'ultra',vendor:{context:123}},'plain'];
 const ui=mount({importModelSubscription:async()=>({ok:true,configs:[{config:{inferenceGatewayBaseUrl:'https://fixture.test',inferenceModels:rows,inferenceModelCapabilities:{opaque:{supportedEfforts:['high'],defaultEffort:'high'},plain:{supportedEfforts:[]}}}}]})});
 ui.change('订阅 URL','https://fixture.test/sub');await ui.click('导入');
 ui.change('能力模式 opaque','auto');await ui.click('保存');
 const config=JSON.parse(JSON.stringify(ui.calls[0][1].config));assert.deepEqual(config.inferenceModels,rows);assert.deepEqual(config.inferenceModelCapabilities,{plain:{supportedEfforts:[]}});
 assert.ok(ui.find(node=>typeof node.props?.children==='string'&&node.props.children.includes('output_config.effort')&&node.props.children.includes('reasoning_effort')&&node.props.children.includes('reasoning.effort')));
});
test('saved nested gateway fields load and drive discovery with runtime precedence',async()=>{
 const config={inferenceGatewayBaseUrl:' ',inferenceGatewayApiKey:' ',inferenceApiType:' ',credentials:{baseUrl:' https://nested.fixture.test/v1 ',apiKey:' nested-key ',apiType:'openai-chat'},inferenceModels:['nested-model']};
 const ui=mount({readConfig:async()=>({ok:true,config}),discoverModels:async options=>{assert.equal(options.baseUrl,'https://nested.fixture.test/v1');assert.equal(options.apiKey,'nested-key');assert.equal(options.apiType,'openai-chat');return{ok:true,models:[{id:'nested-model'}]}}});
 ui.field('选择配置').props.onChange({target:{value:'profile'}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.field('API 密钥').props.value,'nested-key');
 assert.equal(ui.field('服务 URL').props.value,'https://nested.fixture.test/v1');
 assert.equal(ui.field('接口类型').props.value,'openai-chat');
 await ui.click('获取可用模型');assert.equal(ui.find(node=>node.props?.role==='alert'),undefined);
});
test('discovery retains selected metadata',async()=>{
 const remote={id:'remote',name:'Remote',capabilities:{supportedEfforts:['none','xhigh'],defaultEffort:'xhigh'},extra:{source:'catalogue'}};
 const ui=mount({discoverModels:async()=>({ok:true,models:[remote]})});
 ui.change('服务 URL','https://fixture.test');ui.change('API 密钥','key');ui.change('模型列表','existing');
 await ui.click('获取可用模型');await ui.click('添加所选模型');await ui.click('保存');
 assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0][1].config.inferenceModels)),['existing',remote]);
 assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0][1].config.inferenceModelCapabilities)),{});
});

test('saved profile load, default reorder and cancelled discovery preserve metadata',async()=>{
 const row={id:'saved',supportedEfforts:['high'],defaultEffort:'high',other:{retained:true}};
 const ui=mount({readConfig:async()=>({ok:true,config:{inferenceGatewayBaseUrl:'https://fixture.test',inferenceModels:[row,'plain'],inferenceModelCapabilities:{saved:{supportedEfforts:['high'],defaultEffort:'high'}}}}),writeConfig:async(id,config)=>{ui.calls.push(['write',config]);return{ok:true}},renameConfig:async()=>({ok:true}),discoverModels:async()=>({ok:true,models:[{id:'saved',supportedEfforts:['different']} ]})});
 ui.field('选择配置').props.onChange({target:{value:'profile'}});await new Promise(resolve=>setImmediate(resolve));
 ui.change('默认模型','plain');ui.change('API 密钥','key');await ui.click('获取可用模型');await ui.click('取消');
 await ui.click('保存');const config=JSON.parse(JSON.stringify(ui.calls.find(call=>call[0]==='write')[1]));
 assert.deepEqual(config.inferenceModels,['plain',row]);assert.deepEqual(config.inferenceModelCapabilities,{saved:{supportedEfforts:['high'],defaultEffort:'high'}});
 assert.equal(ui.find(node=>node.props?.role==='alert'),undefined);
});

test('context windows survive discovery, manual edits, reread and clearing with metadata intact',async()=>{
 const remote={id:'remote',name:'Remote',contextWindow:131072,capabilities:{supportedEfforts:['high']},other:{x:1}};
 let saved;const ui=mount({discoverModels:async()=>({ok:true,models:[remote]}),writeConfig:async(id,config)=>{saved=config;ui.calls.push(['write',config]);return{ok:true}},readConfig:async()=>({ok:true,config:saved}),renameConfig:async()=>({ok:true})});
 ui.change('服务 URL','https://fixture.test');ui.change('API 密钥','key');ui.change('模型列表','plain');await ui.click('获取可用模型');await ui.click('添加所选模型');
 assert.equal(ui.field('上下文窗口 remote').props.value,131072);ui.change('上下文窗口 plain','200000');await ui.click('保存');saved=ui.calls[0][1].config;
 assert.deepEqual(JSON.parse(JSON.stringify(saved.inferenceModels)),[{name:'plain',contextWindow:200000},remote]);
 ui.field('选择配置').props.onChange({target:{value:'profile'}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.field('上下文窗口 plain').props.value,200000);ui.change('上下文窗口 remote','');await ui.click('保存');
 const rows=JSON.parse(JSON.stringify(saved.inferenceModels));assert.deepEqual(rows,[{name:'plain',contextWindow:200000},{id:'remote',name:'Remote',capabilities:{supportedEfforts:['high']},other:{x:1}}]);
});
test('context window strictly validates input and preserves legacy string models',async()=>{
 for(const value of ['0','-1','1.5','1e3',' 123','01','9007199254740992']){const ui=mount();ui.change('服务 URL','https://fixture.test');ui.change('模型列表','legacy');ui.change('上下文窗口 legacy',value);await ui.click('保存');assert.equal(ui.calls.length,0,value);assert.match(ui.find(node=>node.props?.role==='alert').props.children,/正安全整数/)}
 const ui=mount();ui.change('服务 URL','https://fixture.test');ui.change('模型列表','legacy');await ui.click('保存');assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0][1].config.inferenceModels)),['legacy']);
});
test('invalid form and URL import error stay visible without saving',async()=>{
 const ui=mount({importModelSubscription:async()=>({ok:false,error:'订阅格式错误'})});await ui.click('保存');assert.equal(ui.calls.length,0);
 ui.change('订阅 URL','https://fixture.test/sub');await ui.click('导入');assert.equal(ui.find(node=>node.props?.role==='alert').props.children,'订阅格式错误');
});
