import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { convertAnthropicRequest } = createRequire(import.meta.url)('../desktop/openai-gateway.cjs');
test('Chat preserves tool image results as user images after tool acknowledgements', () => {
 const result=convertAnthropicRequest({model:'fixture',messages:[
 {role:'assistant',content:[{type:'tool_use',id:'read1',name:'Read',input:{}}]},
 {role:'user',content:[{type:'tool_result',tool_use_id:'read1',content:[{type:'text',text:'file image'},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'abcd'}}]}]}
 ]},'openai-chat');
 assert.equal(result.messages[1].role,'tool');
 assert.equal(result.messages[1].tool_call_id,'read1');
 assert.equal(result.messages[1].content,'file image');
 assert.equal(result.messages[2].role,'user');
 assert.equal(result.messages[2].content[0].image_url.url,'data:image/jpeg;base64,abcd');
});
