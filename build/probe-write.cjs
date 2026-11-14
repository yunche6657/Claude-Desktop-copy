const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const { runAgent } = require('../desktop/agent.cjs');
const { defineTools, definitionsFor } = require('../desktop/tools.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'agent-w-'));
fs.writeFileSync(path.join(root,'a.js'), 'const x = 1;\n');
const tools = defineTools({ workspaceRoot: root, allowedRoots: [root] });
const ev=[];
(async()=>{
  const r = await runAgent({
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
    model: 'claude-sonnet-5-5',
    system: 'You are a coding agent. Use tools. Be terse.',
    messages:[{role:'user',content:'In a.js change the value 1 to 42 using the Edit tool, then run "node -e console.log(1)" is NOT allowed - instead run "git status --short" in the workspace and report both results briefly.'}],
    tools: definitionsFor(tools),
    execute: async req => {
      const t = tools.find(x=>x.name===req.name);
      return t ? await t.handler(req.input) : { content:'unknown tool', isError:true };
    },
    onEvent: e => { ev.push(e);
      if(e.type==='tool_request') console.log('REQ', e.name, JSON.stringify(e.input).slice(0,100));
      if(e.type==='tool_result') console.log('RES', e.name, e.isError?'ERR':'OK', e.preview.split('\n')[0].slice(0,90));
      if(e.type==='tool_error') console.log('ERR', e.name, e.message);
      if(e.type==='text') console.log('TXT', e.text.trim().slice(0,200));
    },
    maxTurns: 8,
  });
  console.log('\nfile after:', JSON.stringify(fs.readFileSync(path.join(root,'a.js'),'utf8')));
  console.log('tools:', ev.filter(e=>e.type==='tool_request').map(e=>e.name).join(','));
  console.log('stop:', r.stopReason, 'turns:', r.turns);
  fs.rmSync(root,{recursive:true,force:true});
})().catch(e=>{ console.error('FAIL', e.code, e.message); process.exitCode=1; });

