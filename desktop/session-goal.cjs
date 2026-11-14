'use strict';
const MAX_TURNS=150;
const HELP='/goal <目标> · status · pause · resume · continue · complete · clear';
function command(current,args){
 const value=args.trim(),verb=value.toLowerCase();let goal=current?{...current}:null;
 if(!value||verb==='status')return {goal,text:goal?`目标：${goal.objective}\n状态：${goal.status}\n执行轮数：${goal.turns}/${MAX_TURNS}`:`尚未设置目标。${HELP}`};
 if(verb==='clear')return {goal:null,text:'目标已清除。'};
 if(['pause','resume','continue','complete'].includes(verb)){
  if(!goal)return {goal,text:`尚未设置目标。${HELP}`};
  if(verb==='pause')goal.status='paused';
  if(verb==='complete')goal.status='complete';
  if(verb==='resume'&&goal.status==='max_turns')return {goal,text:'已到轮数上限，使用 /goal continue 重置计数。'};
  if(verb==='resume'||verb==='continue'){goal.status='active';if(verb==='continue')goal.turns=0;}
  return {goal,text:`目标状态：${goal.status}`,run:goal.status==='active'};
 }
 if(value.length>8000)return {goal,text:'目标长度上限为8000字符。'};
 goal={objective:value,status:'active',turns:0,createdAt:new Date().toISOString(),blockedAttempts:0};
 return {goal,text:`目标已设置：${value}`,run:true};
}
function prompt(goal){return `继续完成用户明确设置的持久目标：\n${goal.objective}\n\n这是目标执行第 ${goal.turns} 轮。实际执行并验证结果。目标真正完成时，在回复末尾单独写 <desktop-goal-complete/>。遇到具体阻塞时写 <desktop-goal-blocked>具体原因</desktop-goal-blocked>。尚有可执行工作时继续推进。不要仅因结束当前回复就宣称目标完成。`;}
function afterTurn(goal,result){
 if(!goal||goal.status!=='active')return goal;
 const next={...goal};
 if(result?.ok===false){next.status='paused';next.lastError=result.error||'执行失败';return next;}
 const text=result?.text||'';
 if(text.includes('<desktop-goal-complete/>'))next.status='complete';
 const block=text.match(/<desktop-goal-blocked>([\s\S]*?)<\/desktop-goal-blocked>/);
 next.blockedAttempts=block?(next.blockedAttempts||0)+1:0;
 if(block)next.lastBlockReason=block[1];
 if(next.blockedAttempts>=3)next.status='blocked';
 if(next.status==='active'&&next.turns>=MAX_TURNS)next.status='max_turns';
 return next;
}
module.exports={command,prompt,afterTurn,MAX_TURNS};
