'use strict';
function themePrompt(controller) {
  const file = controller.getThemeFile();
  const scenes = controller.listScenes().map(({id,title,mode})=>({id,title,mode}));
  return `<xiaoke-desktop-themes>\nThe desktop supports editable Code-tab themes. Only when the user asks to change the desktop appearance, palette, background, or create a theme: read and edit this JSON file with your file tools: ${JSON.stringify(file)}. The desktop validates and hot-reloads it. Never edit application bundles or install a mod to change a theme. Preserve fields not requested by the user. Do not modify the theme for unrelated coding requests.\nSchema: {version:1,name:string,mode:"system"|"light"|"dark",scene:null|sceneId,motion:boolean,glass:{blur:number(0..64),opacity:number(0..1),tint:"#rrggbb"},colors:{light:{background:"#rrggbb",text:"#rrggbb",muted:"#rrggbb",accent:"#rrggbb"},dark:{background:"#rrggbb",text:"#rrggbb",muted:"#rrggbb",accent:"#rrggbb"}}}. Set scene:null for a plain background. Use the available scenes below for animation; choose matching light/dark mode. Custom colors can be freely generated. Only these fields are supported; no JavaScript, remote URLs or HTML.\nScenes: ${JSON.stringify(scenes)}\nAfter writing, read the JSON back and report the chosen colors and scene. This file affects the desktop Code view globally, not website files.\n</xiaoke-desktop-themes>`;
}
// Some compatible gateways discard appended system prompts. Carry the narrow
// appearance request context in the user frame too; ordinary prompts stay intact.
function themeRequestContext(message, controller) {
  if (typeof message !== 'string' || /^\s*[/!]/u.test(message)) return '';
  if (!/(主题|配色|背景|桌面.*(?:颜色|外观)|theme|palette|desktop\s+(?:appearance|colou?r)|background)/i.test(message)) return '';
  return typeof controller === 'string' ? controller : themePrompt(controller);
}
module.exports={themePrompt,themeRequestContext};
