'use strict';
// 小克 Code 主题渲染器 — 注入到页面里的原生 DOM 面板 + 渲染器。
//
// 为什么是 executeJavaScript 而不是打包前端
//   前端 ion-dist 是 MSIX 安装包的 JUNCTION，打包产物不可写；主题必须在运行时注入。
//   注入体是一个自包含函数（toString 后拼进脚本文本），不依赖模块作用域，也不 eval
//   （app:// 的 CSP 未必允许 eval；函数字面量作为实参传入不触发 eval）。
//
// 作用域：只认 Code 视图
//   静态证据（resources/ion-dist，只读 grep，未查编译工件）：
//     shared-6-sd9jbJqs.js  document.querySelector('.dframe-root')?.setAttribute('data-frame-mode', F)
//                           F 来自路由解析的 resolvedMode => 值域只有 'code' 一种出现在 CSS 里
//     shared-1-BJhqMmkf.js  D_="code-prompt-input"; A_=`[data-testid="${D_}"]`
//                           => Code 视图独有的 composer testid
//   shared-styles-D_GJawPO.css  .dframe-content{position:absolute;inset:0;isolation:isolate;...}
//   所以取根的顺序是：code-prompt-input → closest('.dframe-content' | '.epitaxy-root' | 'main')，
//   退化到 '.dframe-root[data-frame-mode=code] .dframe-content' → '.dframe-root[data-frame-mode=code]'。
//   找不到就是“不是 Code 视图”，直接不挂载 —— 绝不在 body 上挂，Chat/Cowork 一像素都不改。
//
// 安全约束（逐条对应实现）
//   * 背景层 pointer-events:none，且只画在 z-index:-1（负层在根元素背景之上、在流内容之下），
//     绝不拦截输入；UI 包装层同样 pointer-events:none，只有按钮/面板自身 auto。
//   * SVG 只以 data:image/svg+xml 的 <img src> 进入页面，任何情况下都不 innerHTML 进主文档；
//     SVG 先过白名单校验（禁 script/foreignObject/on* /href/外部 url()/javascript:）。
//   * 静态 UI 全部走 textContent；主题色只接受 #rrggbb，其余一律回落到默认值。
//   * 切走 Code 视图时清掉作用域属性、全部内联变量、恢复被改过的 position/isolation，并卸载 UI。
//   * install 幂等：重复调用只更新 css/scenes/state 并重新 sync，不新增 style/observer/listener。
//
// 桥接：window['claude.web'].CustomThemes { getState, listScenes, setTheme, reset, getThemeFile }
//   本模块只调用其中 4 个读写方法；getThemeFile 只给提示词用，渲染器不需要。
//   桥接不存在时面板照常工作，保存只在内存生效，并在状态行如实写「仅本地生效」。

const SCOPE_ATTRIBUTE = 'data-xiaoke-theme-active';
const MODE_ATTRIBUTE = 'data-xiaoke-theme-mode';
const MOTION_ATTRIBUTE = 'data-xiaoke-theme-motion';
const BG_ATTRIBUTE = 'data-xiaoke-theme-bg';
const UI_ATTRIBUTE = 'data-xiaoke-theme-ui';
const STYLE_ELEMENT_ID = 'xiaoke-theme-style';
const STATE_VERSION = 1;
const CODE_PROMPT_SELECTOR = '[data-testid="code-prompt-input"]';
const CODE_FRAME_SELECTOR = '.dframe-root[data-frame-mode=code]';

// ---------------------------------------------------------------------------------------------
// 状态校验：主进程与页面共用同一份实现（页面通过函数字面量拿到它，不复制逻辑）
// ---------------------------------------------------------------------------------------------
function sanitizeThemeState(raw) {
  var HEX = /^#[0-9a-fA-F]{6}$/;
  function hex(value, fallback) {
    return typeof value === 'string' && HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback;
  }
  function colorsOf(input, fallback) {
    var src = input && typeof input === 'object' ? input : {};
    return {
      background: hex(src.background, fallback.background),
      text: hex(src.text, fallback.text),
      muted: hex(src.muted, fallback.muted),
      accent: hex(src.accent, fallback.accent),
    };
  }
  function clamp(value, min, max, fallback) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
  function text(value, fallback) {
    if (typeof value !== 'string') return fallback;
    var cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, 60) : fallback;
  }
  var LIGHT = { background: '#f7f7f5', text: '#1b1b19', muted: '#6b6b64', accent: '#c96442' };
  var DARK = { background: '#141417', text: '#f2f0eb', muted: '#9a9a93', accent: '#d97757' };
  var src = raw && typeof raw === 'object' ? raw : {};
  var glass = src.glass && typeof src.glass === 'object' ? src.glass : {};
  var colors = src.colors && typeof src.colors === 'object' ? src.colors : {};
  var scene = typeof src.scene === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(src.scene) ? src.scene : null;
  var mode = src.mode === 'light' || src.mode === 'dark' ? src.mode : 'system';
  var motion = !(src.motion === false || src.motion === 'false' || src.motion === 0 || src.motion === '0');
  return {
    version: 1,
    name: text(src.name, '小克 Code'),
    mode: mode,
    scene: scene,
    motion: motion,
    glass: {
      blur: Math.round(clamp(glass.blur, 0, 64, 18) * 10) / 10,
      opacity: Math.round(clamp(glass.opacity, 0, 1, 0.55) * 100) / 100,
      tint: hex(glass.tint, '#101014'),
    },
    colors: { light: colorsOf(colors.light, LIGHT), dark: colorsOf(colors.dark, DARK) },
  };
}

// ---------------------------------------------------------------------------------------------
// SVG 白名单校验 —— 返回可用的 svg 文本或 null
//
// 白名单按 desktop/themes/ 里实际交付的 20 个场景校准（实测标签集合：
// circle clipPath defs ellipse g linearGradient mask path pattern radialGradient rect stop
// style svg text use —— 最大单文件 88 KB）。若按"只许几何图形"这条更窄的线来收，
// 交付的场景会一个都过不了，所以 style 与 use 必须放行，代价是把它们的内容也一起管住：
//   style  只许声明，不许 @import / 外部 url() / expression() / javascript:
//   use    只许 href="#fragment"（文档内引用），外部 URL 一律拒绝
// 场景只经 <img src="data:image/svg+xml,..."> 进入页面，img 里的 SVG 是静态安全模式：
// 脚本不执行、外部资源不加载。这一层白名单是纵深防御，不是唯一防线。
//
// 注意：本函数会被 toString() 注入页面，所以它用到的常量必须定义在函数体内，
// 不能引用模块级变量 —— 否则页面侧拿到的是 ReferenceError（实测踩过）。
function sanitizeSceneSvg(raw) {
  var SVG_MAX_BYTES = 262144;
  var ALLOWED = {
    svg: 1, g: 1, defs: 1, desc: 1, title: 1, symbol: 1, use: 1, style: 1,
    path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1,
    text: 1, tspan: 1, textpath: 1,
    lineargradient: 1, radialgradient: 1, stop: 1, pattern: 1, clippath: 1,
    mask: 1, filter: 1, feblend: 1, fecolormatrix: 1, fegaussianblur: 1, feoffset: 1,
    femerge: 1, femergenode: 1, fecomposite: 1, feturbulence: 1, fedisplacementmap: 1,
    fedropshadow: 1,
    animate: 1, animatetransform: 1, animatemotion: 1, animatecolor: 1, mpath: 1, set: 1,
  };
  if (typeof raw !== 'string') return null;
  var svg = raw.trim();
  if (!svg || svg.length > SVG_MAX_BYTES) return null;
  if (!/^<svg[\s>]/i.test(svg)) return null;
  // 注释：放行（上游素材可以带版权注释），但校验只看摘掉注释后的 scan 副本 ——
  // 注释里夹带 <script> 之类的标记因此既不会被白名单误杀成"未知标签"，也不可能被当成标签执行。
  // 未闭合的 <!--、孤立的 -->、以及 --!> 一律拒绝：这三种在解析器之间行为不一致。
  // 注释体内不许出现 < > 或 javascript:：惰性内容里夹标记没有正当用途，直接拒掉更省事。
  if (/--!>/.test(svg)) return null;
  var commentBodies = svg.match(/<!--[\s\S]*?-->/g) || [];
  for (var c = 0; c < commentBodies.length; c++) {
    var body = commentBodies[c].slice(4, -3);
    if (body.indexOf('<') >= 0 || body.indexOf('>') >= 0) return null;
    if (/javascript\s*:|vbscript\s*:/i.test(body)) return null;
  }
  var scan = svg.replace(/<!--[\s\S]*?-->/g, ' ');
  if (/<!--/.test(scan) || /-->/.test(scan)) return null;
  // 元素白名单：未知标签一律拒绝，而不是"忽略掉继续用"
  var tagPattern = /<\s*\/?\s*([a-zA-Z][\w:-]*)/g;
  var tagMatch = tagPattern.exec(scan);
  while (tagMatch) {
    if (!ALLOWED[tagMatch[1].toLowerCase()]) return null;
    tagMatch = tagPattern.exec(scan);
  }
  // 事件属性
  if (/\son[a-z]+\s*=/i.test(scan)) return null;
  // 声明：CDATA / DOCTYPE / 实体一律不收
  if (/<!\[cdata\[/i.test(scan)) return null;
  if (/<!doctype/i.test(scan) || /<!entity/i.test(scan)) return null;
  if (/<!/i.test(scan)) return null;
  // 脚本协议与 CSS 表达式
  if (/javascript\s*:|vbscript\s*:|expression\s*\(/i.test(scan)) return null;
  if (/@import/i.test(scan)) return null;
  // 所有 URL 承载属性：只有 href / xlink:href 允许，且必须是文档内 #fragment
  var attrPattern = /\s(href|xlink:href|src|srcset|action|formaction|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  var attrMatch = attrPattern.exec(scan);
  while (attrMatch) {
    var name = attrMatch[1].toLowerCase();
    var value = attrMatch[3] !== undefined ? attrMatch[3]
      : attrMatch[4] !== undefined ? attrMatch[4] : attrMatch[5];
    if (name !== 'href' && name !== 'xlink:href') return null;
    if (!/^#[A-Za-z_][\w.:-]*$/.test(String(value).trim())) return null;
    attrMatch = attrPattern.exec(scan);
  }
  // 每个 url() 只能指向文档内的 #id
  var refs = scan.match(/url\s*\([^)]*\)/gi) || [];
  for (var i = 0; i < refs.length; i++) {
    if (!/^url\s*\(\s*['"]?#[A-Za-z_][\w.:-]*['"]?\s*\)$/i.test(refs[i])) return null;
  }
  // style 块本身也要看内容：去掉注释后不许出现可疑构造
  var styleBlocks = scan.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (var s = 0; s < styleBlocks.length; s++) {
    var body = styleBlocks[s].replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, '');
    if (/@import|javascript\s*:|expression\s*\(|behavior\s*:|-moz-binding/i.test(body)) return null;
    var styleRefs = body.match(/url\s*\([^)]*\)/gi) || [];
    for (var r = 0; r < styleRefs.length; r++) {
      if (!/^url\s*\(\s*['"]?#[A-Za-z_][\w.:-]*['"]?\s*\)$/i.test(styleRefs[r])) return null;
    }
    // 不许出现能提前闭合样式块的序列
    if (body.indexOf('<') >= 0) return null;
  }
  // img 里的 svg 必须有命名空间才能独立渲染
  if (!/xmlns\s*=/.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

// 关掉动效：交付场景的动画在 <style> 里（CSS animation），SMIL 是少数，两条都要压住。
// 加的是作用域内的 override，不改原作者的任何一条规则 —— 所以卡片缩略图仍然是原样。
//
// 会被 toString() 注入页面，因此不引用任何模块级常量（见 sanitizeSceneSvg 上的同类说明）。
function stripSceneAnimation(svg) {
  var KILL = '<style>*,*::before,*::after{animation:none!important;'
    + 'transition:none!important;animation-play-state:paused!important}</style>';
  var stripped = String(svg)
    .replace(/<animate[A-Za-z]*[^>]*\/>/gi, '')
    .replace(/<animate[A-Za-z]*[^>]*>[\s\S]*?<\/animate[A-Za-z]*>/gi, '');
  if (/<\/svg>\s*$/i.test(stripped)) return stripped.replace(/<\/svg>\s*$/i, KILL + '</svg>');
  return stripped + KILL;
}

function sceneDataUri(svg) {
  if (typeof svg !== 'string' || !svg) return '';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// ---------------------------------------------------------------------------------------------
// 场景列表校验
// ---------------------------------------------------------------------------------------------
function sanitizeThemeScenes(list, sanitizeSvg) {
  var out = [];
  var seen = {};
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < 60; i++) {
    var item = list[i];
    if (!item || typeof item !== 'object') continue;
    var id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id) || seen[id]) continue;
    var svg = sanitizeSvg(item.svg);
    if (!svg) continue;
    var title = typeof item.title === 'string'
      ? item.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
      : '';
    seen[id] = true;
    out.push({ id: id, title: title || id, mode: item.mode === 'light' ? 'light' : 'dark', svg: svg });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 内置 20 个场景：桥接给不出场景时面板也必须有 20 张卡片
// ---------------------------------------------------------------------------------------------
function buildBuiltinScenes(sanitizeSvg) {
  function linear(id, stops, x1, y1, x2, y2) {
    var body = '';
    for (var i = 0; i < stops.length; i++) {
      var stop = stops[i];
      body += '<stop offset="' + stop[0] + '" stop-color="' + stop[1] + '"'
        + (stop.length > 2 ? ' stop-opacity="' + stop[2] + '"' : '') + '/>';
    }
    return '<linearGradient id="' + id + '" x1="' + (x1 === undefined ? 0 : x1) + '" y1="' + (y1 === undefined ? 0 : y1)
      + '" x2="' + (x2 === undefined ? 1 : x2) + '" y2="' + (y2 === undefined ? 1 : y2)
      + '" gradientUnits="objectBoundingBox">' + body + '</linearGradient>';
  }
  function radial(id, stops, cx, cy, r) {
    var body = '';
    for (var i = 0; i < stops.length; i++) {
      var stop = stops[i];
      body += '<stop offset="' + stop[0] + '" stop-color="' + stop[1] + '"'
        + (stop.length > 2 ? ' stop-opacity="' + stop[2] + '"' : '') + '/>';
    }
    return '<radialGradient id="' + id + '" cx="' + cx + '" cy="' + cy + '" r="' + r
      + '" gradientUnits="objectBoundingBox">' + body + '</radialGradient>';
  }
  function wrap(defs, body) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">'
      + '<defs>' + defs + '</defs>' + body + '</svg>';
  }
  var spec = [
    {
      id: 'aurora', title: '极光', mode: 'dark',
      defs: linear('a1', [['0', '#050f18'], ['1', '#0b2731']]) + linear('a2', [['0', '#49e0c6', '0.85'], ['1', '#1b6f8c', '0']], 0, 0, 0, 1),
      body: '<rect width="800" height="500" fill="url(#a1)"/>'
        + '<ellipse cx="300" cy="180" rx="360" ry="120" fill="url(#a2)">'
        + '<animateTransform attributeName="transform" type="translate" values="0 0; 60 22; 0 0" dur="18s" repeatCount="indefinite"/></ellipse>'
        + '<ellipse cx="560" cy="330" rx="300" ry="90" fill="url(#a2)" opacity="0.6">'
        + '<animateTransform attributeName="transform" type="translate" values="0 0; -50 -18; 0 0" dur="24s" repeatCount="indefinite"/></ellipse>',
    },
    {
      id: 'nebula', title: '星云', mode: 'dark',
      defs: radial('n1', [['0', '#3b1f6e', '0.9'], ['1', '#0a0713', '0']], 0.42, 0.45, 0.65)
        + radial('n2', [['0', '#8b2f6b', '0.7'], ['1', '#0a0713', '0']], 0.72, 0.62, 0.5),
      body: '<rect width="800" height="500" fill="#0a0713"/><rect width="800" height="500" fill="url(#n1)"/>'
        + '<rect width="800" height="500" fill="url(#n2)"/>'
        + '<circle cx="140" cy="110" r="2" fill="#f6f2ff"/><circle cx="620" cy="90" r="1.6" fill="#f6f2ff"/>'
        + '<circle cx="700" cy="300" r="2.2" fill="#f6f2ff"/><circle cx="380" cy="430" r="1.4" fill="#f6f2ff"/>',
    },
    {
      id: 'grid', title: '网格', mode: 'dark',
      defs: '<pattern id="g1" width="48" height="48" patternUnits="userSpaceOnUse">'
        + '<path d="M48 0H0V48" fill="none" stroke="#2f3b46" stroke-width="1"/></pattern>',
      body: '<rect width="800" height="500" fill="#0d1218"/><rect width="800" height="500" fill="url(#g1)"/>'
        + '<rect x="0" y="240" width="800" height="2" fill="#3d6b7a" opacity="0.7"/>',
    },
    {
      id: 'waves', title: '曲线', mode: 'light',
      defs: linear('w1', [['0', '#f7f7f5'], ['1', '#e6ecf2']]),
      body: '<rect width="800" height="500" fill="url(#w1)"/>'
        + '<path d="M0 300C140 220 260 380 400 300S660 220 800 300" fill="none" stroke="#9db4c6" stroke-width="2"/>'
        + '<path d="M0 350C140 270 260 430 400 350S660 270 800 350" fill="none" stroke="#b9cad6" stroke-width="2"/>'
        + '<path d="M0 400C140 320 260 480 400 400S660 320 800 400" fill="none" stroke="#d3dee6" stroke-width="2"/>',
    },
    {
      id: 'dots', title: '点阵', mode: 'light',
      defs: '<pattern id="d1" width="34" height="34" patternUnits="userSpaceOnUse">'
        + '<circle cx="4" cy="4" r="2" fill="#c2c8cc"/></pattern>',
      body: '<rect width="800" height="500" fill="#fbfbf9"/><rect width="800" height="500" fill="url(#d1)"/>',
    },
    {
      id: 'mesh', title: '斜网', mode: 'dark',
      defs: '<pattern id="m1" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">'
        + '<path d="M0 40V0H40" fill="none" stroke="#26313c" stroke-width="1"/></pattern>',
      body: '<rect width="800" height="500" fill="#0b0e12"/><rect width="800" height="500" fill="url(#m1)"/>',
    },
    {
      id: 'stripes', title: '条纹', mode: 'light',
      defs: '<pattern id="s1" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        + '<rect width="13" height="26" fill="#eef1f4"/></pattern>',
      body: '<rect width="800" height="500" fill="#f9fafb"/><rect width="800" height="500" fill="url(#s1)"/>',
    },
    {
      id: 'rings', title: '同心', mode: 'dark',
      defs: radial('r1', [['0', '#182634', '0.9'], ['1', '#0a0d10', '0']], 0.5, 0.5, 0.75),
      body: '<rect width="800" height="500" fill="#0a0d10"/><rect width="800" height="500" fill="url(#r1)"/>'
        + '<g fill="none" stroke="#2f4a5e" stroke-width="1.5">'
        + '<circle cx="400" cy="250" r="70"/><circle cx="400" cy="250" r="120"/>'
        + '<circle cx="400" cy="250" r="170"/><circle cx="400" cy="250" r="220"/></g>',
    },
    {
      id: 'circuit', title: '电路', mode: 'dark',
      defs: linear('c1', [['0', '#0b1014'], ['1', '#101a20']]),
      body: '<rect width="800" height="500" fill="url(#c1)"/>'
        + '<g fill="none" stroke="#2c5a52" stroke-width="2">'
        + '<path d="M0 120H180V60H340"/><path d="M0 240H120V320H260V400H520"/>'
        + '<path d="M800 160H620V100H520"/><path d="M800 380H660V300H560"/></g>'
        + '<g fill="#49e0c6"><circle cx="340" cy="60" r="4"/><circle cx="520" cy="400" r="4"/>'
        + '<circle cx="520" cy="100" r="4"/><circle cx="560" cy="300" r="4"/></g>',
    },
    {
      id: 'ridge', title: '山脊', mode: 'light',
      defs: linear('rd1', [['0', '#f2f4f6'], ['1', '#dde5ec']]),
      body: '<rect width="800" height="500" fill="url(#rd1)"/>'
        + '<path d="M0 500V330L150 210L300 350L430 240L560 380L700 260L800 340V500Z" fill="#c6d3dd"/>'
        + '<path d="M0 500V400L140 320L280 420L420 330L560 440L700 350L800 420V500Z" fill="#aebfcc"/>',
    },
    {
      id: 'ocean', title: '深海', mode: 'dark',
      defs: linear('o1', [['0', '#061722'], ['1', '#0a2b3a']]),
      body: '<rect width="800" height="500" fill="url(#o1)"/>'
        + '<path d="M0 330C120 300 200 360 320 330S520 300 640 330S760 360 800 330V500H0Z" fill="#0d3b4d" opacity="0.9"/>'
        + '<path d="M0 390C120 360 200 420 320 390S520 360 640 390S760 420 800 390V500H0Z" fill="#134b5f" opacity="0.8">'
        + '<animateTransform attributeName="transform" type="translate" values="0 0; 24 -10; 0 0" dur="12s" repeatCount="indefinite"/></path>',
    },
    {
      id: 'sunset', title: '日落', mode: 'light',
      defs: linear('su1', [['0', '#ffe9d0'], ['0.6', '#ffc9a0'], ['1', '#f6a97e']]),
      body: '<rect width="800" height="500" fill="url(#su1)"/>'
        + '<circle cx="560" cy="330" r="86" fill="#ff8f5e" opacity="0.85"/>'
        + '<path d="M0 400H800V500H0Z" fill="#e8b795" opacity="0.6"/>',
    },
    {
      id: 'forest', title: '林线', mode: 'dark',
      defs: linear('f1', [['0', '#08110d'], ['1', '#0f2119']]),
      body: '<rect width="800" height="500" fill="url(#f1)"/>'
        + '<g fill="#123026">'
        + '<rect x="60" y="180" width="16" height="320"/><rect x="170" y="120" width="20" height="380"/>'
        + '<rect x="290" y="200" width="14" height="300"/><rect x="410" y="140" width="22" height="360"/>'
        + '<rect x="540" y="170" width="18" height="330"/><rect x="660" y="110" width="20" height="390"/></g>'
        + '<rect y="470" width="800" height="30" fill="#0a1813"/>',
    },
    {
      id: 'snow', title: '落雪', mode: 'light',
      defs: linear('sn1', [['0', '#f6f8fa'], ['1', '#e3eaef']]),
      body: '<rect width="800" height="500" fill="url(#sn1)"/>'
        + '<g fill="#ffffff">'
        + '<circle cx="90" cy="80" r="3"/><circle cx="240" cy="150" r="2.4"/><circle cx="380" cy="70" r="3.2"/>'
        + '<circle cx="520" cy="190" r="2.6"/><circle cx="660" cy="110" r="3"/><circle cx="740" cy="260" r="2.2"/>'
        + '<circle cx="160" cy="300" r="2.8"/><circle cx="300" cy="380" r="2.4"/><circle cx="470" cy="330" r="3"/>'
        + '<circle cx="610" cy="420" r="2.6"/></g>',
    },
    {
      id: 'ember', title: '余烬', mode: 'dark',
      defs: radial('e1', [['0', '#ff8a3d', '0.85'], ['1', '#120a06', '0']], 0.5, 0.62, 0.6),
      body: '<rect width="800" height="500" fill="#0d0806"/><rect width="800" height="500" fill="url(#e1)"/>'
        + '<g fill="#ffb872"><circle cx="360" cy="300" r="3"><animate attributeName="opacity" values="1;0.2;1" dur="4s" repeatCount="indefinite"/></circle>'
        + '<circle cx="450" cy="250" r="2.2"><animate attributeName="opacity" values="0.3;1;0.3" dur="6s" repeatCount="indefinite"/></circle>'
        + '<circle cx="520" cy="330" r="2.6"><animate attributeName="opacity" values="1;0.4;1" dur="5s" repeatCount="indefinite"/></circle></g>',
    },
    {
      id: 'orbit', title: '轨道', mode: 'dark',
      defs: radial('or1', [['0', '#1b2440', '0.9'], ['1', '#070a12', '0']], 0.5, 0.5, 0.7),
      body: '<rect width="800" height="500" fill="#070a12"/><rect width="800" height="500" fill="url(#or1)"/>'
        + '<g fill="none" stroke="#3f4f7a" stroke-width="1.4">'
        + '<ellipse cx="400" cy="250" rx="240" ry="90"><animateTransform attributeName="transform" type="rotate" from="0 400 250" to="360 400 250" dur="40s" repeatCount="indefinite"/></ellipse>'
        + '<ellipse cx="400" cy="250" rx="160" ry="200" transform="rotate(30 400 250)"/></g>'
        + '<circle cx="400" cy="250" r="6" fill="#8fa6e8"/>',
    },
    {
      id: 'prism', title: '棱镜', mode: 'light',
      defs: linear('p1', [['0', '#f7f7f5'], ['1', '#eef0f7']]),
      body: '<rect width="800" height="500" fill="url(#p1)"/>'
        + '<path d="M400 90L620 410H180Z" fill="#dbe3f2" opacity="0.85"/>'
        + '<path d="M400 90L180 410L400 410Z" fill="#c9d6ee" opacity="0.7"/>'
        + '<path d="M400 210L520 410H280Z" fill="#e8d9c6" opacity="0.6"/>',
    },
    {
      id: 'hex', title: '蜂巢', mode: 'dark',
      defs: '<pattern id="h1" width="56" height="48" patternUnits="userSpaceOnUse">'
        + '<path d="M28 0L56 16V40L28 48L0 40V16Z" fill="none" stroke="#243040" stroke-width="1.2"/></pattern>',
      body: '<rect width="800" height="500" fill="#0a0d12"/><rect width="800" height="500" fill="url(#h1)"/>',
    },
    {
      id: 'ripple', title: '涟漪', mode: 'light',
      defs: linear('rp1', [['0', '#f4f7f9'], ['1', '#e2ecf1']]),
      body: '<rect width="800" height="500" fill="url(#rp1)"/>'
        + '<g fill="none" stroke="#a9c3d1" stroke-width="1.6">'
        + '<circle cx="400" cy="250" r="40"><animate attributeName="r" values="40;220" dur="7s" repeatCount="indefinite"/>'
        + '<animate attributeName="opacity" values="0.9;0" dur="7s" repeatCount="indefinite"/></circle>'
        + '<circle cx="400" cy="250" r="90" opacity="0.6"/>'
        + '<circle cx="400" cy="250" r="140" opacity="0.4"/></g>',
    },
    {
      id: 'dusk', title: '暮色', mode: 'dark',
      defs: linear('dk1', [['0', '#1a1430'], ['0.55', '#3b2350'], ['1', '#120e1c']]),
      body: '<rect width="800" height="500" fill="url(#dk1)"/>'
        + '<g fill="#f0e6ff"><circle cx="120" cy="90" r="1.8"/><circle cx="260" cy="150" r="1.4"/>'
        + '<circle cx="430" cy="70" r="2"/><circle cx="600" cy="130" r="1.5"/><circle cx="720" cy="210" r="1.8"/>'
        + '<circle cx="330" cy="250" r="1.3"/></g>'
        + '<circle cx="640" cy="360" r="54" fill="#f6c7a0" opacity="0.35"/>',
    },
  ];
  var out = [];
  for (var i = 0; i < spec.length; i++) {
    var svg = sanitizeSvg(wrap(spec[i].defs, spec[i].body));
    if (svg) out.push({ id: spec[i].id, title: spec[i].title, mode: spec[i].mode, svg: svg });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 样式表：每一条规则的每一个选择器都必须以作用域属性开头（测试会逐条核对）
// ---------------------------------------------------------------------------------------------
function scopedStylesheet() {
  const S = '[' + SCOPE_ATTRIBUTE + ']';
  const U = '[data-xiaoke-theme-ui]';
  const parts = [
    '/* 小克 Code 主题 — desktop/theme-renderer.cjs 注入。所有选择器都限定在 Code 视图根节点内。 */',
    // 变量映射：只覆盖 Code 子树，不动 :root，因此 Chat / Cowork 完全不受影响
    S + '{'
      + '--xk-bg:#f7f7f5;--xk-text:#1b1b19;--xk-muted:#6b6b64;--xk-accent:#c96442;--xk-tint:#101014;'
      + '--xk-glass-blur:18px;--xk-glass-opacity:.55;'
      + '--cds-text-primary:var(--xk-text);--cds-text-secondary:var(--xk-muted);--cds-text-muted:var(--xk-muted);'
      + '--cds-text-accent:var(--xk-accent);--cds-fill-accent:var(--xk-accent);'
      + '--df-bg-page:var(--xk-bg);--df-bg-page-hsl:from var(--xk-bg) h s l;--cds-page-bg:var(--xk-bg);'
      + '--cds-surface-0:var(--xk-bg);--cds-surface-1:var(--xk-bg);'
      + '--cds-surface-2:color-mix(in srgb,var(--xk-bg) 94%,var(--xk-text));'
      + '--cds-surface-3:color-mix(in srgb,var(--xk-bg) 90%,var(--xk-text));'
      + 'color:var(--xk-text);caret-color:currentColor;background-color:var(--xk-bg);'
      + '}',
    // Nested cds-root elements redeclare palette variables for the global app mode.
    // Override their declarations too, while retaining Code-only scope.
    S + ' .cds-root{--cds-text-primary:var(--xk-text)!important;--cds-text-secondary:var(--xk-muted)!important;'
      + '--cds-text-muted:var(--xk-muted)!important;--cds-text-accent:var(--xk-accent)!important;'
      + '--cds-fill-accent:var(--xk-accent)!important;--cds-surface-0:var(--xk-bg)!important;'
      + '--cds-surface-1:var(--xk-bg)!important;--cds-surface-2:color-mix(in srgb,var(--xk-bg) 94%,var(--xk-text))!important;'
      + '--cds-surface-3:color-mix(in srgb,var(--xk-bg) 90%,var(--xk-text))!important;'
      + 'color:var(--xk-text);color-scheme:inherit;}',
    S + '[' + MODE_ATTRIBUTE + '="dark"]{color-scheme:dark}',
    S + '[' + MODE_ATTRIBUTE + '="light"]{color-scheme:light}',
    // 让场景真的可见：内容容器原本各自铺不透明底色，在 Code 子树里改成透明，
    // 由根节点的 --xk-bg 承担底色，负层背景才有机会露出来。
    S + ' :where(.dframe-content-inner,.epitaxy-root,main){background-color:transparent;}',
    // 背景层：负层 —— 在根元素背景之上、在流式内容之下；指针事件彻底关闭
    S + ' > [' + BG_ATTRIBUTE + ']{position:absolute;inset:0;z-index:-1;overflow:hidden;contain:strict;'
      + 'pointer-events:none;background-color:var(--xk-bg);border:0;}',
    S + ' [' + BG_ATTRIBUTE + '] > img{position:absolute;inset:0;width:100%;height:100%;display:block;'
      + 'object-fit:cover;object-position:center;border:0;pointer-events:none;user-select:none;-webkit-user-drag:none;}',
    // 场景之上的染色层：glass.opacity 就是"玻璃有多浑"。0 = 清晰场景，1 = 完全被底色盖住。
    // 交付的默认值就是 0，所以默认看到的是干净的场景图。
    S + ' [' + BG_ATTRIBUTE + '] > [data-xiaoke-theme-tint]{position:absolute;inset:0;'
      + 'pointer-events:none;background-color:var(--xk-tint);opacity:var(--xk-glass-opacity);}',
    // UI 包装层：本身不吃事件，只有按钮和面板自己 auto
    S + ' > ' + U + '{position:absolute;inset:0;z-index:2147483000;pointer-events:none;}',
    S + ' ' + U + ' [data-xk-part="launch"]{position:absolute;'
      + 'top:calc(var(--df-chrome-bar-height,44px) + 10px);right:14px;pointer-events:auto;'
      + 'display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;'
      + 'border:1px solid color-mix(in srgb,var(--xk-text) 18%,transparent);border-radius:999px;'
      + 'background:color-mix(in srgb,var(--xk-bg) 88%,transparent);color:var(--xk-text);'
      + 'font:inherit;font-size:12px;line-height:1;cursor:pointer;'
      + 'backdrop-filter:blur(calc(var(--xk-glass-blur) * .4));}',
    S + ' ' + U + ' [data-xk-part="launch"]:hover{background:color-mix(in srgb,var(--xk-bg) 97%,transparent);}',
    S + ' ' + U + ' [data-xk-part="launch"]:focus-visible{outline:2px solid var(--xk-accent);outline-offset:2px;}',
    // 面板
    //
    // 面板底色用「调色板背景」而不是 tint，并且有一个 0.72 的可读下限：
    //   * 交付的玻璃默认值是 blur:0 / opacity:0 / tint:#000000；直接拿 tint 当底色，
    //     opacity:0 会让面板全透明（面板消失），而 tint 的黑色配上浅色模式的近黑文字
    //     会变成黑底黑字（读不出来）。两个都是实测会出现的退化，所以在样式里就锁住下限。
    //   * glass 仍然生效：blur 直接进 backdrop-filter，tint 用在场景染色层与按钮上。
    S + ' ' + U + ' [data-xk-part="panel"]{position:absolute;'
      + 'top:calc(var(--df-chrome-bar-height,44px) + 44px);right:14px;pointer-events:auto;'
      + 'display:flex;flex-direction:column;gap:10px;box-sizing:border-box;'
      + 'width:min(384px,calc(100vw - 28px));max-height:calc(100% - 120px);overflow:auto;padding:14px;'
      + 'border:1px solid color-mix(in srgb,var(--xk-text) 16%,transparent);border-radius:14px;'
      + 'background:color-mix(in srgb,var(--xk-bg) calc(max(0.72,var(--xk-glass-opacity)) * 100%),transparent);'
      + 'color:var(--xk-text);font:inherit;font-size:12px;line-height:1.5;'
      + 'backdrop-filter:blur(var(--xk-glass-blur));box-shadow:0 18px 48px rgba(0,0,0,.28);}',
    S + ' ' + U + ' [data-xk-part="panel"][hidden]{display:none}',
    S + ' ' + U + ' [data-xk-part="title"]{font-size:13px;font-weight:600;letter-spacing:.02em;}',
    S + ' ' + U + ' [data-xk-part="head"]{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
    S + ' ' + U + ' [data-xk-part="row"]{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    S + ' ' + U + ' [data-xk-part="label"]{color:var(--xk-muted);font-size:11px;}',
    S + ' ' + U + ' [data-xk-part="group"]{display:flex;flex-direction:column;gap:6px;}',
    S + ' ' + U + ' [data-xk-part="name"]{box-sizing:border-box;width:100%;height:26px;padding:0 8px;'
      + 'border:1px solid color-mix(in srgb,var(--xk-text) 20%,transparent);border-radius:8px;'
      + 'background:transparent;color:inherit;font:inherit;}',
    S + ' ' + U + ' [data-xk-part="seg"]{display:inline-flex;border:1px solid color-mix(in srgb,var(--xk-text) 20%,transparent);'
      + 'border-radius:8px;overflow:hidden;}',
    S + ' ' + U + ' [data-xk-part="seg"] button{appearance:none;border:0;background:transparent;color:inherit;'
      + 'font:inherit;padding:4px 10px;cursor:pointer;}',
    S + ' ' + U + ' [data-xk-part="seg"] button[aria-checked="true"]{background:var(--xk-accent);color:#fff;}',
    S + ' ' + U + ' [data-xk-part="scenes"]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}',
    S + ' ' + U + ' [data-xk-part="scene"]{display:flex;flex-direction:column;gap:4px;padding:4px;'
      + 'border:1px solid color-mix(in srgb,var(--xk-text) 14%,transparent);border-radius:9px;'
      + 'background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:center;}',
    S + ' ' + U + ' [data-xk-part="scene"] img{width:100%;height:34px;border-radius:6px;object-fit:cover;display:block;}',
    S + ' ' + U + ' [data-xk-part="scene"] span{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    S + ' ' + U + ' [data-xk-part="scene"][aria-pressed="true"]{border-color:var(--xk-accent);'
      + 'box-shadow:0 0 0 1px var(--xk-accent) inset;}',
    S + ' ' + U + ' [data-xk-part="colors"]{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
    S + ' ' + U + ' [data-xk-part="swatch"]{display:flex;align-items:center;gap:6px;}',
    S + ' ' + U + ' [data-xk-part="swatch"] input{width:26px;height:22px;padding:0;border:0;background:transparent;cursor:pointer;}',
    S + ' ' + U + ' [data-xk-part="footer"]{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;}',
    S + ' ' + U + ' [data-xk-part="action"]{appearance:none;border:1px solid color-mix(in srgb,var(--xk-text) 20%,transparent);'
      + 'border-radius:8px;background:transparent;color:inherit;font:inherit;padding:4px 10px;cursor:pointer;}',
    S + ' ' + U + ' [data-xk-part="action"][data-xk-role="primary"]{background:var(--xk-accent);border-color:var(--xk-accent);color:#fff;}',
    S + ' ' + U + ' [data-xk-part="action"]:focus-visible{outline:2px solid var(--xk-accent);outline-offset:2px;}',
    S + ' ' + U + ' [data-xk-part="status"]{color:var(--xk-muted);font-size:11px;min-height:14px;}',
    S + ' ' + U + ' [data-xk-part="range"]{width:150px;accent-color:var(--xk-accent);}',
    S + ' ' + U + ' [data-xk-part="check"]{display:flex;align-items:center;gap:6px;color:var(--xk-muted);}',
    // 关动效：只作用于本面板，SVG 动效在 data URI 生成阶段就被剥掉
    S + '[' + MOTION_ATTRIBUTE + '="off"] ' + U + ' *{transition:none;animation:none;}',
  ];
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 页面内主函数（自包含；toString 注入）
// ---------------------------------------------------------------------------------------------
function xiaokeThemePageMain(cfg, sanitizeThemeState, sanitizeThemeScenes, sanitizeSceneSvg, buildBuiltinScenes, stripSceneAnimation) {
  var W = (cfg && cfg.window) || (typeof window !== 'undefined' ? window : null);
  if (!W) return { ok: false, reason: 'no-window' };
  var D = W.document;
  if (!D) return { ok: false, reason: 'no-document' };

  var SCOPE = 'data-xiaoke-theme-active';
  var MODEATTR = 'data-xiaoke-theme-mode';
  var MOTIONATTR = 'data-xiaoke-theme-motion';
  var BG = 'data-xiaoke-theme-bg';
  var UIA = 'data-xiaoke-theme-ui';
  var STYLEID = 'xiaoke-theme-style';
  var VARS = ['--xk-bg', '--xk-text', '--xk-muted', '--xk-accent', '--xk-tint', '--xk-glass-blur', '--xk-glass-opacity'];

  var api = {
    __v: 1,
    installed: true,
    scenes: [],
    saved: null,
    draft: null,
    dirty: false,
    previewing: false,
    status: { text: '', persisted: null },
  };
  var BOX = {
    root: null, bg: null, img: null, ui: null, panel: null, launch: null, style: null,
    observer: null, quiet: false, quietTimer: 0, tickTimer: 0, keyListener: null,
    mql: [], touched: null, refs: {}, cardNodes: [], modeNodes: [], windowMode: null,
  };

  // ---------- DOM 小工具 ----------
  function el(tag, attrs, styleMap) {
    var node = D.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        if (key === 'text') node.textContent = String(attrs[key]);
        else node.setAttribute(key, String(attrs[key]));
      }
    }
    if (styleMap) {
      for (var prop in styleMap) {
        if (Object.prototype.hasOwnProperty.call(styleMap, prop)) node.style.setProperty(prop, styleMap[prop]);
      }
    }
    return node;
  }
  function setText(node, value) {
    if (node) node.textContent = value === null || value === undefined ? '' : String(value);
    return node;
  }
  function clearChildren(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function mutate(fn) {
    BOX.quiet = true;
    try { fn(); } finally {
      if (BOX.quietTimer) W.clearTimeout(BOX.quietTimer);
      BOX.quietTimer = W.setTimeout(function () { BOX.quiet = false; }, 0);
    }
  }

  // ---------- 状态 ----------
  function clone(state) {
    return {
      version: 1,
      name: state.name,
      mode: state.mode,
      scene: state.scene,
      motion: !!state.motion,
      glass: { blur: state.glass.blur, opacity: state.glass.opacity, tint: state.glass.tint },
      colors: {
        light: { background: state.colors.light.background, text: state.colors.light.text, muted: state.colors.light.muted, accent: state.colors.light.accent },
        dark: { background: state.colors.dark.background, text: state.colors.dark.text, muted: state.colors.dark.muted, accent: state.colors.dark.accent },
      },
    };
  }
  function mediaQuery(query) {
    try { return W.matchMedia ? W.matchMedia(query) : null; } catch (error) { return null; }
  }
  function prefersDark() {
    var mql = mediaQuery('(prefers-color-scheme: dark)');
    return !!(mql && mql.matches);
  }
  function prefersReducedMotion() {
    var mql = mediaQuery('(prefers-reduced-motion: reduce)');
    return !!(mql && mql.matches);
  }
  function resolvedMode(state) {
    if (state.mode === 'light' || state.mode === 'dark') return state.mode;
    return prefersDark() ? 'dark' : 'light';
  }
  function motionOn(state) {
    return state.motion !== false && !prefersReducedMotion();
  }
  function sceneById(id) {
    for (var i = 0; i < api.scenes.length; i++) if (api.scenes[i].id === id) return api.scenes[i];
    return null;
  }
  api.sanitize = function (raw) { return sanitizeThemeState(raw); };

  function mergeScenes(list) {
    var incoming = sanitizeThemeScenes(list, sanitizeSceneSvg);
    if (incoming.length === 0) incoming = sanitizeThemeScenes(buildBuiltinScenes(sanitizeSceneSvg), sanitizeSceneSvg);
    if (incoming.length < 20) {
      var builtins = sanitizeThemeScenes(buildBuiltinScenes(sanitizeSceneSvg), sanitizeSceneSvg);
      var have = {};
      for (var i = 0; i < incoming.length; i++) have[incoming[i].id] = true;
      for (var j = 0; j < builtins.length && incoming.length < 20; j++) {
        if (have[builtins[j].id]) continue;
        have[builtins[j].id] = true;
        incoming.push(builtins[j]);
      }
    }
    return incoming;
  }

  // ---------- 代码视图作用域 ----------
  function closestIn(node, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var hit = node && node.closest ? node.closest(selectors[i]) : null;
      if (hit) return hit;
    }
    return null;
  }
  function findCodeRoot() {
    var input = D.querySelector('[data-testid="code-prompt-input"]');
    if (input) {
      var scoped = closestIn(input, ['.dframe-content', '.epitaxy-root', 'main']);
      if (scoped) return scoped;
    }
    var framed = D.querySelector('.dframe-root[data-frame-mode=code] .dframe-content');
    if (framed) return framed;
    var frame = D.querySelector('.dframe-root[data-frame-mode=code]');
    return frame || null;
  }
  function restoreModes() {
    for (var m = 0; m < BOX.modeNodes.length; m++) {
      var entry = BOX.modeNodes[m];
      if (entry.original === null) entry.node.removeAttribute('data-mode');
      else entry.node.setAttribute('data-mode', entry.original);
    }
    BOX.modeNodes = [];
    BOX.windowMode = null;
    var restoredMode = callBridge('setWindowMode', D.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');
    if (restoredMode && restoredMode.catch) restoredMode.catch(function () {});
  }
  function applyModes(root, mode) {
    var frame = root.closest ? root.closest('.dframe-root') : null;
    var host = frame || root;
    if (BOX.windowMode !== mode) {
      BOX.windowMode = mode;
      var pendingMode = callBridge('setWindowMode', mode);
      if (pendingMode && pendingMode.catch) pendingMode.catch(function () {});
    }
    var nodes = [host];
    if (host.querySelectorAll) {
      var nested = host.querySelectorAll('.cds-root[data-mode]');
      for (var n = 0; n < nested.length; n++) nodes.push(nested[n]);
    }
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      var known = false;
      for (var m = 0; m < BOX.modeNodes.length; m++) if (BOX.modeNodes[m].node === node) known = true;
      if (!known) BOX.modeNodes.push({ node: node, original: node.getAttribute('data-mode') });
      if (node.getAttribute('data-mode') !== mode) node.setAttribute('data-mode', mode);
    }
  }
  function releaseScope() {
    var root = BOX.root;
    if (!root) return;
    mutate(function () {
      try {
        restoreModes();
        root.removeAttribute(SCOPE);
        root.removeAttribute(MODEATTR);
        root.removeAttribute(MOTIONATTR);
        for (var i = 0; i < VARS.length; i++) root.style.removeProperty(VARS[i]);
        if (BOX.touched) {
          if (BOX.touched.position !== null) root.style.setProperty('position', BOX.touched.position);
          if (BOX.touched.isolation !== null) root.style.setProperty('isolation', BOX.touched.isolation);
          BOX.touched = null;
        }
        if (BOX.bg && BOX.bg.parentNode) BOX.bg.parentNode.removeChild(BOX.bg);
        if (BOX.ui && BOX.ui.parentNode) BOX.ui.parentNode.removeChild(BOX.ui);
      } catch (error) { /* 节点被 React 拆掉时忽略 */ }
    });
    BOX.bg = null;
    BOX.img = null;
    BOX.ui = null;
    BOX.panel = null;
    BOX.launch = null;
    BOX.refs = {};
    BOX.cardNodes = [];
    BOX.root = null;
    // 面板随作用域一起被摘掉了，预览也就没有承载它的地方了：标记必须一起收，
    // 否则切回 Code 视图时会拿一份过期的草稿当渲染源。
    api.previewing = false;
    api.draft = api.saved ? clone(api.saved) : null;
    api.dirty = false;
  }

  // ---------- 背景层 ----------
  // 关动效用模块级 stripSceneAnimation（以实参注入），页面内不另写一份实现
  function ensureBackground(root, state) {
    var bg = BOX.bg;
    if (!bg || bg.parentNode !== root) {
      mutate(function () {
        bg = el('div', { 'data-xiaoke-theme-bg': '' }, { 'pointer-events': 'none' });
        bg.setAttribute('aria-hidden', 'true');
        var img = el('img', { alt: '', draggable: 'false' }, { 'pointer-events': 'none' });
        var tint = el('div', { 'data-xiaoke-theme-tint': '' }, { 'pointer-events': 'none' });
        bg.appendChild(img);
        bg.appendChild(tint);
        root.insertBefore(bg, root.firstChild);
        BOX.bg = bg;
        BOX.img = img;
      });
    }
    var scene = sceneById(state.scene);
    var svg = scene ? (motionOn(state) ? scene.svg : stripSceneAnimation(scene.svg)) : '';
    var uri = svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : '';
    if (!BOX.img) return;
    if (uri) BOX.img.setAttribute('src', uri);
    else BOX.img.removeAttribute('src');
    BOX.img.setAttribute('alt', scene ? scene.title : '');
  }

  // ---------- 绘制 ----------
  //
  // 渲染源只有一个函数决定：
  //   previewing ? draft : saved
  // api.saved 是持久态（桥接 setTheme / 磁盘 theme.json 的那一份），api.draft 是面板里的草稿。
  // 预览过去直接写 api.saved，于是"预览"把持久态覆盖掉了：关掉面板画面不回去，再打开时
  // openPanel 又拿这份被覆盖的 saved 克隆 draft —— 未保存的东西就此变成"已保存"。
  // 现在预览只置 previewing，saved 一个字都不动；关闭/保存/恢复默认各自清掉标记再重画。
  function renderState() {
    return api.previewing && api.draft ? api.draft : api.saved;
  }

  function paint() {
    var root = BOX.root;
    if (!root) return false;
    var state = renderState();
    if (!state) return false;
    var mode = resolvedMode(state);
    var palette = state.colors[mode];
    mutate(function () {
      applyModes(root, mode);
      root.setAttribute(SCOPE, '');
      root.setAttribute(MODEATTR, mode);
      root.setAttribute(MOTIONATTR, motionOn(state) ? 'on' : 'off');
      root.style.setProperty('--xk-bg', palette.background);
      root.style.setProperty('--xk-text', palette.text);
      root.style.setProperty('--xk-muted', palette.muted);
      root.style.setProperty('--xk-accent', palette.accent);
      root.style.setProperty('--xk-tint', state.glass.tint);
      root.style.setProperty('--xk-glass-blur', state.glass.blur + 'px');
      root.style.setProperty('--xk-glass-opacity', String(state.glass.opacity));
    });
    ensureBackground(root, state);
    return true;
  }

  // ---------- 面板 ----------
  function buildPanel() {
    var panel = el('div', {
      'data-xk-part': 'panel', 'data-xiaoke-theme-ui': 'panel', role: 'dialog',
      'aria-label': '主题设置', hidden: '',
    });

    var head = el('div', { 'data-xk-part': 'head' });
    head.appendChild(setText(el('div', { 'data-xk-part': 'title' }), '主题'));
    var closeBtn = setText(el('button', { 'data-xk-part': 'action', 'data-xk-action': 'close', type: 'button' }), '关闭');
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var nameRow = el('div', { 'data-xk-part': 'group' });
    nameRow.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '主题名称'));
    var nameInput = el('input', { 'data-xk-part': 'name', type: 'text', maxlength: '60' });
    nameRow.appendChild(nameInput);
    panel.appendChild(nameRow);

    var modeRow = el('div', { 'data-xk-part': 'row' });
    modeRow.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '明暗模式'));
    var seg = el('div', { 'data-xk-part': 'seg', role: 'radiogroup', 'aria-label': '明暗模式' });
    var modeButtons = [];
    var modes = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
    for (var m = 0; m < modes.length; m++) {
      var modeBtn = setText(el('button', { type: 'button', role: 'radio', 'data-xk-mode': modes[m][0] }), modes[m][1]);
      modeBtn.setAttribute('aria-checked', 'false');
      seg.appendChild(modeBtn);
      modeButtons.push(modeBtn);
    }
    modeRow.appendChild(seg);
    panel.appendChild(modeRow);

    var sceneGroup = el('div', { 'data-xk-part': 'group' });
    var sceneHead = el('div', { 'data-xk-part': 'row' });
    sceneHead.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '背景场景'));
    var noneBtn = setText(el('button', { 'data-xk-part': 'action', 'data-xk-action': 'no-scene', type: 'button' }), '无背景');
    noneBtn.setAttribute('aria-pressed', 'false');
    sceneHead.appendChild(noneBtn);
    sceneGroup.appendChild(sceneHead);
    var grid = el('div', { 'data-xk-part': 'scenes' });
    sceneGroup.appendChild(grid);
    panel.appendChild(sceneGroup);

    var colorsWrap = el('div', { 'data-xk-part': 'colors' });
    function colorGroup(label, key) {
      var box = el('div', { 'data-xk-part': 'group', 'data-xk-group': key });
      box.appendChild(setText(el('span', { 'data-xk-part': 'label' }), label));
      var fields = {};
      var names = [['background', '背景'], ['text', '文本'], ['muted', '次要'], ['accent', '强调']];
      for (var i = 0; i < names.length; i++) {
        var row = el('div', { 'data-xk-part': 'swatch' });
        var input = el('input', { type: 'color', 'data-xk-color': names[i][0], 'aria-label': label + names[i][1] });
        row.appendChild(setText(el('span', { 'data-xk-part': 'label' }), names[i][1]));
        row.appendChild(input);
        box.appendChild(row);
        fields[names[i][0]] = input;
      }
      colorsWrap.appendChild(box);
      return fields;
    }
    var lightFields = colorGroup('浅色', 'light');
    var darkFields = colorGroup('深色', 'dark');
    panel.appendChild(colorsWrap);

    var motionRow = el('label', { 'data-xk-part': 'check' });
    var motionInput = el('input', { type: 'checkbox', 'data-xk-part': 'motion' });
    motionRow.appendChild(motionInput);
    motionRow.appendChild(setText(el('span', {}), '动画（减少动效时自动关闭）'));
    panel.appendChild(motionRow);

    var glassRow = el('div', { 'data-xk-part': 'row' });
    glassRow.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '玻璃模糊'));
    var blurInput = el('input', { type: 'range', min: '0', max: '64', step: '1', 'data-xk-part': 'range', 'aria-label': '玻璃模糊' });
    glassRow.appendChild(blurInput);
    panel.appendChild(glassRow);

    var opacityRow = el('div', { 'data-xk-part': 'row' });
    opacityRow.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '不透明度'));
    var opacityInput = el('input', { type: 'range', min: '0', max: '1', step: '0.05', 'data-xk-part': 'range', 'aria-label': '不透明度' });
    opacityRow.appendChild(opacityInput);
    panel.appendChild(opacityRow);

    var tintRow = el('div', { 'data-xk-part': 'row' });
    tintRow.appendChild(setText(el('span', { 'data-xk-part': 'label' }), '底色'));
    var tintInput = el('input', { type: 'color', 'data-xk-color': 'tint', 'aria-label': '面板底色' });
    tintRow.appendChild(tintInput);
    panel.appendChild(tintRow);

    var status = el('div', { 'data-xk-part': 'status', role: 'status' });
    panel.appendChild(status);

    var footer = el('div', { 'data-xk-part': 'footer' });
    var previewBtn = setText(el('button', { 'data-xk-part': 'action', 'data-xk-action': 'preview', type: 'button' }), '预览');
    var saveBtn = setText(el('button', { 'data-xk-part': 'action', 'data-xk-action': 'save', type: 'button' }), '保存');
    saveBtn.setAttribute('data-xk-role', 'primary');
    var resetBtn = setText(el('button', { 'data-xk-part': 'action', 'data-xk-action': 'reset', type: 'button' }), '恢复默认');
    footer.appendChild(previewBtn);
    footer.appendChild(saveBtn);
    footer.appendChild(resetBtn);
    panel.appendChild(footer);

    BOX.refs = {
      panel: panel, grid: grid, status: status, nameInput: nameInput,
      modeButtons: modeButtons, noneBtn: noneBtn,
      light: lightFields, dark: darkFields, tint: tintInput,
      motion: motionInput, blur: blurInput, opacity: opacityInput,
      preview: previewBtn, save: saveBtn, reset: resetBtn, close: closeBtn,
    };
    return panel;
  }

  function rebuildSceneGrid() {
    var grid = BOX.refs.grid;
    if (!grid) return;
    setText(grid, '');
    BOX.cardNodes = [];
    for (var i = 0; i < api.scenes.length; i++) {
      var scene = api.scenes[i];
      var card = el('button', { type: 'button', 'data-xk-part': 'scene', 'data-xk-scene': scene.id, title: scene.title });
      card.setAttribute('aria-pressed', 'false');
      var img = el('img', { alt: '', draggable: 'false' });
      img.setAttribute('src', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(scene.svg));
      card.appendChild(img);
      card.appendChild(setText(el('span', {}), scene.title));
      grid.appendChild(card);
      BOX.cardNodes.push(card);
    }
  }

  function syncPanel() {
    var refs = BOX.refs;
    if (!refs.panel || !api.draft) return;
    var draft = api.draft;
    refs.nameInput.value = draft.name;
    for (var i = 0; i < refs.modeButtons.length; i++) {
      var mode = refs.modeButtons[i].getAttribute('data-xk-mode');
      refs.modeButtons[i].setAttribute('aria-checked', mode === draft.mode ? 'true' : 'false');
    }
    refs.noneBtn.setAttribute('aria-pressed', draft.scene === null ? 'true' : 'false');
    for (var c = 0; c < BOX.cardNodes.length; c++) {
      var id = BOX.cardNodes[c].getAttribute('data-xk-scene');
      BOX.cardNodes[c].setAttribute('aria-pressed', id === draft.scene ? 'true' : 'false');
    }
    refs.light.background.value = draft.colors.light.background;
    refs.light.text.value = draft.colors.light.text;
    refs.light.muted.value = draft.colors.light.muted;
    refs.light.accent.value = draft.colors.light.accent;
    refs.dark.background.value = draft.colors.dark.background;
    refs.dark.text.value = draft.colors.dark.text;
    refs.dark.muted.value = draft.colors.dark.muted;
    refs.dark.accent.value = draft.colors.dark.accent;
    refs.tint.value = draft.glass.tint;
    refs.motion.checked = draft.motion === true;
    refs.blur.value = String(draft.glass.blur);
    refs.opacity.value = String(draft.glass.opacity);
    setText(refs.status, api.status.text || '');
  }

  function setStatus(text, persisted) {
    api.status = { text: text || '', persisted: persisted === undefined ? api.status.persisted : persisted };
    if (BOX.refs.status) setText(BOX.refs.status, api.status.text);
  }

  // ---------- 草稿编辑 ----------
  function editDraft(mutator) {
    var next = clone(api.draft || api.saved);
    mutator(next);
    api.draft = sanitizeThemeState(next);
    api.dirty = true;
    syncPanel();
    // 正在预览时草稿就是渲染源（见 renderState），所以每一次编辑都要重画，
    // 否则预览会停在第一次点“预览”那一刻，和面板里显示的值不一致。
    // 没在预览时一个字都不动：未点预览/保存之前页面不跟着草稿变。
    if (api.previewing) paint();
  }

  // ---------- 挂载 / 卸载 UI ----------
  function ensureUi(root) {
    var ui = BOX.ui;
    if (!ui) {
      ui = el('div', { 'data-xiaoke-theme-ui': 'wrapper' }, { 'pointer-events': 'none' });
      var launch = setText(el('button', { 'data-xk-part': 'launch', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }), '主题');
      ui.appendChild(launch);
      var panel = buildPanel();
      ui.appendChild(panel);
      BOX.ui = ui;
      BOX.launch = launch;
      BOX.panel = panel;
      launch.addEventListener('click', function () {
        if (!BOX.panel) return;
        if (BOX.panel.hasAttribute('hidden')) openPanel();
        else closePanel();
      });
      wirePanel();
      // 面板建好就把卡片填满：路由切换后重新挂载时卡片不会空着
      rebuildSceneGrid();
    }
    if (ui.parentNode !== root) root.appendChild(ui);
    return ui;
  }

  function wirePanel() {
    var refs = BOX.refs;
    refs.close.addEventListener('click', function () { closePanel(); });
    // 预览：只置 previewing，让 paint 走 draft 分支；api.saved（持久态）一个字都不动。
    // 关闭面板时 previewing 被清掉，画面自动回到持久态。
    refs.preview.addEventListener('click', function () {
      api.draft = sanitizeThemeState(api.draft || api.saved);
      api.previewing = true;
      paint();
      syncPanel();
      setStatus('已预览（未保存）');
    });
    // save / reset 把桥接返回的 Promise 原样交出去，调用方可以等它落地
    refs.save.addEventListener('click', function () { return save(); });
    refs.reset.addEventListener('click', function () { return reset(); });
    refs.noneBtn.addEventListener('click', function () {
      editDraft(function (next) { next.scene = null; });
    });
    refs.nameInput.addEventListener('input', function () {
      var value = refs.nameInput.value;
      editDraft(function (next) { next.name = value; });
    });
    for (var i = 0; i < refs.modeButtons.length; i++) {
      (function (button) {
        button.addEventListener('click', function () {
          var mode = button.getAttribute('data-xk-mode');
          editDraft(function (next) { next.mode = mode; });
        });
      })(refs.modeButtons[i]);
    }
    // 卡片用事件委托：重建网格（热刷新 / 场景变更）不新增任何 listener
    refs.grid.addEventListener('click', function (event) {
      var node = event && event.target;
      while (node && node !== refs.grid && !(node.getAttribute && node.getAttribute('data-xk-scene'))) {
        node = node.parentNode;
      }
      if (!node || node === refs.grid || !node.getAttribute) return;
      var id = node.getAttribute('data-xk-scene');
      if (!id) return;
      editDraft(function (next) { next.scene = id; });
    });
    ['light', 'dark'].forEach(function (group) {
      ['background', 'text', 'muted', 'accent'].forEach(function (key) {
        var input = refs[group][key];
        input.addEventListener('input', function () {
          var value = input.value;
          editDraft(function (next) { next.colors[group][key] = value; });
        });
      });
    });
    refs.tint.addEventListener('input', function () {
      var value = refs.tint.value;
      editDraft(function (next) { next.glass.tint = value; });
    });
    refs.motion.addEventListener('change', function () {
      var checked = refs.motion.checked === true;
      editDraft(function (next) { next.motion = checked; });
      paint();
    });
    refs.blur.addEventListener('input', function () {
      var value = Number(refs.blur.value);
      editDraft(function (next) { next.glass.blur = value; });
    });
    refs.opacity.addEventListener('input', function () {
      var value = Number(refs.opacity.value);
      editDraft(function (next) { next.glass.opacity = value; });
    });
  }

  function openPanel() {
    if (!BOX.panel) return;
    BOX.panel.removeAttribute('hidden');
    if (BOX.launch) BOX.launch.setAttribute('aria-expanded', 'true');
    // 打开面板一律从持久态重新起一份草稿；上次预览的标记在这里收掉，
    // 否则 renderState 会继续把遗留的 draft 当渲染源。
    var wasPreviewing = api.previewing;
    api.previewing = false;
    api.draft = clone(api.saved);
    api.dirty = false;
    syncPanel();
    if (wasPreviewing) paint();
    if (!BOX.keyListener) {
      BOX.keyListener = function (event) {
        if (event && event.key === 'Escape') closePanel();
      };
      D.addEventListener('keydown', BOX.keyListener);
    }
  }
  function closePanel(opts) {
    if (!BOX.panel) return;
    var keep = opts && opts.keep === true;
    BOX.panel.setAttribute('hidden', '');
    if (BOX.launch) BOX.launch.setAttribute('aria-expanded', 'false');
    // 预览标记与"面板是否可见"同生共死：面板一关，画面就必须回到持久态，
    // 否则用户看到的是一份既没保存、也不再能编辑的临时值。keep 只决定草稿留不留。
    var wasPreviewing = api.previewing;
    api.previewing = false;
    if (!keep) {
      // 未保存的编辑一并丢弃：saved 是唯一权威的一份
      api.draft = clone(api.saved);
      api.dirty = false;
      setStatus('');
    }
    if (wasPreviewing || !keep) paint();
    if (BOX.keyListener) {
      D.removeEventListener('keydown', BOX.keyListener);
      BOX.keyListener = null;
    }
  }

  // ---------- 桥接 ----------
  function themesApi() {
    var holder = null;
    try { holder = W['claude.web'] || null; } catch (error) { holder = null; }
    var themes = holder && holder.CustomThemes ? holder.CustomThemes : null;
    return themes && typeof themes === 'object' ? themes : null;
  }
  function callBridge(method, arg) {
    var themes = themesApi();
    if (!themes || typeof themes[method] !== 'function') return null;
    try {
      var out = arg === undefined ? themes[method]() : themes[method](arg);
      return out && typeof out.then === 'function' ? out : null;
    } catch (error) { return null; }
  }

  function save() {
    var candidate = sanitizeThemeState(api.draft || api.saved);
    var pending = callBridge('setTheme', candidate);
    function done(returned) {
      var next = returned && typeof returned === 'object' ? sanitizeThemeState(returned) : candidate;
      api.saved = next;
      api.draft = clone(next);
      api.dirty = false;
      // 保存（含桥接失败退回的“仅本地生效”）之后，持久态就是渲染源，预览标记必须收掉，
      // 否则 renderState 仍然优先 draft，画面会和刚落地的那份状态分叉。
      api.previewing = false;
      paint();
      syncPanel();
      setStatus(returned ? '已保存' : '已应用到当前窗口（桥接不可用，仅本地生效）', !!returned);
      return { ok: true, persisted: !!returned, state: next };
    }
    if (pending && typeof pending.then === 'function') {
      return pending.then(function (returned) { return done(returned); }, function () { return done(null); });
    }
    return done(null);
  }
  function reset() {
    var pending = callBridge('reset');
    function done(returned) {
      var next = returned && typeof returned === 'object' ? sanitizeThemeState(returned) : sanitizeThemeState({});
      api.saved = next;
      api.draft = clone(next);
      api.dirty = false;
      api.previewing = false;
      paint();
      syncPanel();
      setStatus(returned ? '已恢复默认' : '已恢复默认（仅本地生效）', !!returned);
      return { ok: true, persisted: !!returned, state: next };
    }
    if (pending && typeof pending.then === 'function') {
      return pending.then(function (returned) { return done(returned); }, function () { return done(null); });
    }
    return done(null);
  }

  // ---------- 同步循环 ----------
  function sync() {
    var root = findCodeRoot();
    if (!root) {
      releaseScope();
      return { ok: true, active: false };
    }
    if (BOX.root !== root) {
      releaseScope();
      BOX.root = root;
      BOX.touched = { position: null, isolation: null };
      var computed = null;
      try { computed = W.getComputedStyle ? W.getComputedStyle(root) : null; } catch (error) { computed = null; }
      var position = computed && computed.position ? computed.position : 'relative';
      mutate(function () {
        if (position === 'static') {
          BOX.touched.position = root.style.getPropertyValue('position') || '';
          root.style.setProperty('position', 'relative');
        }
        var isolation = computed && computed.isolation ? computed.isolation : 'isolate';
        if (isolation === 'auto' || !isolation) {
          BOX.touched.isolation = root.style.getPropertyValue('isolation') || '';
          root.style.setProperty('isolation', 'isolate');
        }
      });
    }
    ensureUi(root);
    if (BOX.launch && BOX.launch.parentNode !== BOX.ui) BOX.ui.appendChild(BOX.launch);
    if (BOX.panel && BOX.panel.parentNode !== BOX.ui) BOX.ui.appendChild(BOX.panel);
    if (BOX.ui && BOX.ui.parentNode !== root) root.appendChild(BOX.ui);
    paint();
    return { ok: true, active: true };
  }
  function schedule() {
    if (BOX.tickTimer) return;
    BOX.tickTimer = W.setTimeout(function () {
      BOX.tickTimer = 0;
      try { sync(); } catch (error) { /* 渲染期异常不能拖垮页面 */ }
    }, 80);
  }

  // ---------- 安装 ----------
  api.apply = function (next) {
    var state = sanitizeThemeState(next);
    api.saved = state;
    api.draft = clone(state);
    api.dirty = false;
    api.previewing = false;
    var result = sync();
    syncPanel();
    return { ok: true, active: result.active === true, state: state };
  };
  api.sync = sync;
  api.open = openPanel;
  api.close = function () { closePanel(); };
  // 程序化预览同样只置标记：返回的是"当前画在页面上的那份"，而不是被覆盖掉的持久态。
  api.preview = function () {
    api.draft = sanitizeThemeState(api.draft || api.saved);
    api.previewing = true;
    paint();
    syncPanel();
    return renderState();
  };
  api.save = save;
  api.reset = reset;
  api.setDraft = function (mutator) { editDraft(mutator); return api.draft; };
  api.teardown = function () {
    releaseScope();
    mutate(function () {
      if (BOX.style && BOX.style.parentNode) BOX.style.parentNode.removeChild(BOX.style);
    });
    BOX.style = null;
    if (BOX.observer) { try { BOX.observer.disconnect(); } catch (error) { /* ignore */ } BOX.observer = null; }
    for (var i = 0; i < BOX.mql.length; i++) {
      var entry = BOX.mql[i];
      if (entry.mql && entry.mql.removeEventListener && entry.handler) entry.mql.removeEventListener('change', entry.handler);
    }
    BOX.mql = [];
    if (BOX.keyListener) { D.removeEventListener('keydown', BOX.keyListener); BOX.keyListener = null; }
    if (BOX.tickTimer) { W.clearTimeout(BOX.tickTimer); BOX.tickTimer = 0; }
    if (BOX.quietTimer) { W.clearTimeout(BOX.quietTimer); BOX.quietTimer = 0; }
    BOX.quiet = false;
    api.installed = false;
    return { ok: true };
  };
  api.__dom = BOX;
  api.__refresh = function (nextState, nextScenes, nextCss) {
    if (typeof nextCss === 'string' && nextCss) {
      if (!BOX.style) {
        BOX.style = D.getElementById(STYLEID) || el('style', { id: STYLEID });
        if (!BOX.style.parentNode && D.head) D.head.appendChild(BOX.style);
      }
      setText(BOX.style, nextCss);
    }
    // State-only installs carry []: do not replace an already loaded catalog with fallbacks.
    if (Array.isArray(nextScenes) && nextScenes.length) api.scenes = mergeScenes(nextScenes);
    if (nextState) {
      api.saved = sanitizeThemeState(nextState);
      // 预览中 draft 就是渲染源，不能被外部推来的持久态顶掉
      if (!api.dirty && !api.previewing) api.draft = clone(api.saved);
    }
    rebuildSceneGrid();
    sync();
    syncPanel();
    return { ok: true, reused: true, scenes: api.scenes.length };
  };

  // 全局单例检查：已装过就走 __refresh，不重建任何 DOM / observer / listener
  var existing = W.__xiaokeTheme;
  if (existing && existing.__v === 1 && typeof existing.__refresh === 'function') {
    var refreshed = existing.__refresh(cfg && cfg.state, cfg && cfg.scenes, cfg && cfg.css);
    return { ok: true, reused: true, scenes: refreshed.scenes, active: !!(existing.__dom && existing.__dom.root) };
  }

  // 首装
  api.saved = sanitizeThemeState(cfg && cfg.state);
  api.draft = clone(api.saved);
  api.scenes = mergeScenes(cfg && cfg.scenes);

  BOX.style = D.getElementById(STYLEID);
  if (!BOX.style) {
    BOX.style = el('style', { id: STYLEID });
    if (D.head) D.head.appendChild(BOX.style);
  }
  setText(BOX.style, (cfg && cfg.css) || '');

  // 场景网格在 sync() 建好面板之后立即填充
  var first = sync();
  rebuildSceneGrid();
  syncPanel();

  // 主进程只会在 did-finish-load 时给一次 scenes；applyThemeState 触发的自动安装、
  // 以及任何一次热刷新都可能没带场景。桥接就在页面里，所以面板自己补齐：
  // 拿不到就沿用内置 20 个，绝不会出现空网格。
  var pendingScenes = callBridge('listScenes');
  if (pendingScenes && typeof pendingScenes.then === 'function') {
    pendingScenes.then(function (list) {
      if (!Array.isArray(list) || !list.length) return;
      var merged = mergeScenes(list);
      if (!merged.length) return;
      api.scenes = merged;
      rebuildSceneGrid();
      syncPanel();
    }, function () { /* 桥接拒绝时保留内置场景 */ });
  }
  // 同理：状态没传或者传是默认值时，问一次桥接要权威状态
  if (!cfg || !cfg.state) {
    var pendingState = callBridge('getState');
    if (pendingState && typeof pendingState.then === 'function') {
      pendingState.then(function (value) {
        if (!value || typeof value !== 'object') return;
        if (api.dirty || api.previewing) return;
        api.saved = sanitizeThemeState(value);
        api.draft = clone(api.saved);
        sync();
        syncPanel();
      }, function () { /* 保留当前状态 */ });
    }
  }

  // 一个 observer，两个媒体查询监听器，都是单份
  if (typeof W.MutationObserver === 'function') {
    BOX.observer = new W.MutationObserver(function () {
      if (BOX.quiet) return;
      schedule();
    });
    try {
      BOX.observer.observe(D.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-frame-mode', 'class', 'data-mode'],
      });
    } catch (error) { /* 观察失败不影响首次渲染 */ }
  }
  function watchMedia(query) {
    var mql = mediaQuery(query);
    if (!mql || typeof mql.addEventListener !== 'function') return;
    var handler = function () { schedule(); };
    mql.addEventListener('change', handler);
    BOX.mql.push({ mql: mql, handler: handler });
  }
  watchMedia('(prefers-color-scheme: dark)');
  watchMedia('(prefers-reduced-motion: reduce)');

  W.__xiaokeTheme = api;
  return {
    ok: true, reused: false, scenes: api.scenes.length,
    active: !!(BOX.root), scope: SCOPE,
  };
}

// ---------------------------------------------------------------------------------------------
// 脚本拼装与对外接口
// ---------------------------------------------------------------------------------------------
function jsonLiteral(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildInstallScript({ state, scenes, css }) {
  const payload = jsonLiteral({ state: sanitizeThemeState(state), scenes: Array.isArray(scenes) ? scenes : [], css: css || scopedStylesheet() });
  return '(function(){try{'
    + 'var run=(function(){return ' + xiaokeThemePageMain.toString() + ';})();'
    + 'return run(' + payload + ',(' + sanitizeThemeState.toString() + '),('
    + sanitizeThemeScenes.toString() + '),(' + sanitizeSceneSvg.toString() + '),('
    + buildBuiltinScenes.toString() + '),(' + stripSceneAnimation.toString() + '));'
    + '}catch(error){return {ok:false,reason:String((error&&error.message)||error)};}})()';
}

function buildApplyScript(state) {
  return '(function(){try{'
    + 'var api=globalThis.__xiaokeTheme;'
    + 'if(!api||typeof api.apply!=="function")return {ok:false,reason:"not-installed"};'
    + 'return api.apply(' + jsonLiteral(sanitizeThemeState(state)) + ');'
    + '}catch(error){return {ok:false,reason:String((error&&error.message)||error)};}})()';
}

function resolveWebContents(win) {
  if (!win) return null;
  if (typeof win.executeJavaScript === 'function') return win;
  if (win.webContents && typeof win.webContents.executeJavaScript === 'function') return win.webContents;
  return null;
}

/**
 * 注入渲染器。幂等：重复调用只刷新 css / scenes / state。
 *
 * @param {object} win BrowserWindow（或任何带 webContents.executeJavaScript 的对象）
 * @param {{state?: object, scenes?: Array}} [options]
 * @returns {Promise<{ok: boolean, reused?: boolean, scenes?: number, active?: boolean, reason?: string}>}
 */
async function installThemeRenderer(win, options) {
  const target = resolveWebContents(win);
  if (!target) return { ok: false, reason: 'no-web-contents' };
  const opts = options && typeof options === 'object' ? options : {};
  try {
    const result = await target.executeJavaScript(buildInstallScript({
      state: opts.state,
      scenes: opts.scenes,
      css: opts.css || scopedStylesheet(),
    }), true);
    return result && typeof result === 'object' ? result : { ok: false, reason: 'unexpected-result' };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

/**
 * 把一份状态推到页面：执行 globalThis.__xiaokeTheme.apply(state)。
 * 渲染器还没装（例如 on('change') 早于 did-finish-load）时先装一次再应用。
 *
 * @param {object} win
 * @param {object} state
 */
async function applyThemeState(win, state) {
  const target = resolveWebContents(win);
  if (!target) return { ok: false, reason: 'no-web-contents' };
  try {
    const result = await target.executeJavaScript(buildApplyScript(state), true);
    if (result && result.ok) return result;
    if (result && result.reason === 'not-installed') return await installThemeRenderer(win, { state });
    return result && typeof result === 'object' ? result : { ok: false, reason: 'unexpected-result' };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

const DEFAULT_THEME_STATE = sanitizeThemeState({});
const BUILTIN_SCENES = buildBuiltinScenes(sanitizeSceneSvg);

module.exports = {
  installThemeRenderer,
  applyThemeState,
  scopedStylesheet,
  sanitizeThemeState,
  sanitizeThemeScenes,
  sanitizeSceneSvg,
  buildBuiltinScenes,
  stripSceneAnimation,
  sceneDataUri,
  buildInstallScript,
  buildApplyScript,
  xiaokeThemePageMain,
  STATE_VERSION,
  SCOPE_ATTRIBUTE,
  MODE_ATTRIBUTE,
  MOTION_ATTRIBUTE,
  BG_ATTRIBUTE,
  UI_ATTRIBUTE,
  STYLE_ELEMENT_ID,
  CODE_PROMPT_SELECTOR,
  CODE_FRAME_SELECTOR,
  DEFAULT_THEME_STATE,
  BUILTIN_SCENES,
};
