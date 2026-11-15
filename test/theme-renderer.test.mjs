// 小克 Code 主题渲染器 — 作用域、净化、幂等三件套的实测。
//
// 为什么用 fake DOM 而不是真浏览器
//   被测对象是"注入到页面里的那段函数"，它的全部契约都在 DOM 操作与状态净化上：
//   选择器落在哪个节点、背景层是否吃指针事件、SVG 走的是哪条通道、切路由有没有把
//   变量和属性收干净、第二次 install 有没有多挂一份 observer/listener。
//   这些都能用一个最小 DOM 精确观察，而且能在 CI 里跑。真浏览器的行为由
//   theme-application.test.mjs 那类测量覆盖，这里不重复。
//
// 静态源码事实（resources/ion-dist，只读 grep，未查编译工件）
//   shared-6-sd9jbJqs.js   document.querySelector('.dframe-root')?.setAttribute('data-frame-mode', F)
//   shared-1-BJhqMmkf.js   D_="code-prompt-input"; A_=`[data-testid="${D_}"]`
// 下面 fake 文档里的 Code 标记按这两条构造，不额外发明选择器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = require('../desktop/theme-renderer.cjs');
const {
  scopedStylesheet, sanitizeThemeState, sanitizeThemeScenes, sanitizeSceneSvg,
  buildBuiltinScenes, buildInstallScript, installThemeRenderer, applyThemeState,
  xiaokeThemePageMain, stripSceneAnimation, DEFAULT_THEME_STATE, BUILTIN_SCENES,
  SCOPE_ATTRIBUTE, MODE_ATTRIBUTE, MOTION_ATTRIBUTE, BG_ATTRIBUTE, UI_ATTRIBUTE, STYLE_ELEMENT_ID,
} = renderer;

// ---------------------------------------------------------------------------------------------
// 最小 DOM
// ---------------------------------------------------------------------------------------------
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'selected']);

function makeDocument() {
  const doc = {
    innerHTMLWrites: [],
    listeners: [],
    head: null,
    documentElement: null,
    body: null,
  };

  class FakeStyle {
    constructor() { this.map = new Map(); }
    setProperty(name, value) { this.map.set(name, String(value)); }
    getPropertyValue(name) { return this.map.has(name) ? this.map.get(name) : ''; }
    removeProperty(name) { this.map.delete(name); }
    get cssText() { return [...this.map].map(([k, v]) => `${k}:${v}`).join(';'); }
  }

  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.parentNode = null;
      this.style = new FakeStyle();
      this._text = '';
      this.listeners = [];
      this.id = '';
    }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    get textContent() {
      if (!this.children.length) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(value) {
      this.children = [];
      this._text = value === null || value === undefined ? '' : String(value);
      this.children.forEach((c) => { c.parentNode = null; });
    }
    // 一旦有人写 innerHTML 就记一笔：SVG 绝不能走这条路进主文档。
    set innerHTML(value) { doc.innerHTMLWrites.push(String(value)); }
    setAttribute(name, value) {
      const key = String(name);
      this.attrs.set(key, String(value));
      if (key === 'id') this.id = String(value);
      if (key === 'class') this.className = String(value);
    }
    getAttribute(name) {
      if (String(name) === 'class') return this.className === undefined ? null : this.className;
      return this.attrs.has(String(name)) ? this.attrs.get(String(name)) : null;
    }
    hasAttribute(name) { return this.attrs.has(String(name)); }
    removeAttribute(name) { this.attrs.delete(String(name)); }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const at = before ? this.children.indexOf(before) : -1;
      if (at < 0) this.children.push(child);
      else this.children.splice(at, 0, child);
      return child;
    }
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at >= 0) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    }
    addEventListener(type, handler) { this.listeners.push({ type, handler }); }
    removeEventListener(type, handler) {
      this.listeners = this.listeners.filter((l) => !(l.type === type && l.handler === handler));
    }
    querySelectorAll(selector) {
      const found = [];
      const visit = node => { for (const child of node.children) { if (matchesSelector(child, selector)) found.push(child); visit(child); } };
      visit(this);
      return found;
    }
    closest(selector) {
      let node = this;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    }
    get classNameValue() {
      const raw = this.attrs.get('class');
      return raw ? raw.split(/\s+/).filter(Boolean) : [];
    }
  }

  function parseSimple(sel) {
    const out = { tag: null, classes: [], id: null, attrs: [] };
    let rest = sel.trim();
    const tagMatch = /^([a-zA-Z][\w-]*)/.exec(rest);
    if (tagMatch) { out.tag = tagMatch[1].toUpperCase(); rest = rest.slice(tagMatch[0].length); }
    const token = /^(?:\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\])/;
    let match = token.exec(rest);
    while (match) {
      if (match[1]) out.classes.push(match[1]);
      else if (match[2]) out.id = match[2];
      else if (match[3]) {
        const value = match[4] !== undefined ? match[4]
          : match[5] !== undefined ? match[5]
            : match[6] !== undefined ? match[6] : null;
        out.attrs.push([match[3], value]);
      }
      rest = rest.slice(match[0].length);
      if (!rest) break;
      match = token.exec(rest);
    }
    return out;
  }

  function matchesSimple(node, sel) {
    if (!node || !node.tagName) return false;
    const spec = parseSimple(sel);
    if (spec.tag && spec.tag !== node.tagName) return false;
    if (spec.id && node.getAttribute('id') !== spec.id) return false;
    const classes = node.classNameValue;
    for (const name of spec.classes) if (!classes.includes(name)) return false;
    for (const [name, value] of spec.attrs) {
      if (!node.hasAttribute(name)) return false;
      if (value !== null && node.getAttribute(name) !== value) return false;
      if (value === null && BOOLEAN_ATTRS.has(name) && node.getAttribute(name) === 'false') return false;
    }
    return true;
  }

  function splitTopLevel(selector, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (const ch of selector) {
      if (quote) {
        if (ch === quote) quote = null;
        current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (ch === separator && depth === 0) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function matchesSelector(node, selector) {
    const chain = splitTopLevel(selector, ' ');
    if (!chain.length) return false;
    let index = chain.length - 1;
    if (!matchesSimple(node, chain[index])) return false;
    index--;
    let cursor = node.parentNode;
    while (index >= 0 && cursor) {
      if (matchesSimple(cursor, chain[index])) index--;
      cursor = cursor.parentNode;
    }
    return index < 0;
  }

  function walk(node, visit) {
    for (const child of node.children) {
      visit(child);
      walk(child, visit);
    }
  }

  doc.createElement = (tag) => new FakeNode(tag);
  doc.querySelectorAll = (selector) => {
    const out = [];
    walk(doc.documentElement, (node) => { if (matchesSelector(node, selector)) out.push(node); });
    return out;
  };
  doc.querySelector = (selector) => doc.querySelectorAll(selector)[0] || null;
  doc.getElementById = (id) => doc.querySelectorAll('#' + id)[0] || null;
  doc.addEventListener = (type, handler) => { doc.listeners.push({ type, handler }); };
  doc.removeEventListener = (type, handler) => {
    doc.listeners = doc.listeners.filter((l) => !(l.type === type && l.handler === handler));
  };
  doc.__matches = matchesSelector;
  doc.__walk = walk;

  doc.documentElement = new FakeNode('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  return doc;
}

function makeWindow(doc) {
  const timers = [];
  let timerId = 0;
  const media = new Map();
  const observers = [];
  const win = {
    document: doc,
    getComputedStyle: () => ({ position: 'static', isolation: 'auto' }),
    matchMedia: (query) => {
      if (!media.has(query)) media.set(query, { matches: false, listeners: [], addEventListener(t, h) { this.listeners.push(h); }, removeEventListener(t, h) { this.listeners = this.listeners.filter((x) => x !== h); } });
      return media.get(query);
    },
    setTimeout: (fn, ms) => {
      if (!ms) { fn(); return ++timerId; }
      timers.push(fn);
      return ++timerId;
    },
    clearTimeout: () => {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
    },
    __timers: timers,
    __observers: observers,
    __media: media,
  };
  win.__flush = (limit = 200) => {
    let guard = 0;
    while (timers.length && guard < limit) { timers.shift()(); guard++; }
    return guard;
  };
  return win;
}

/** 按 shared-1/shared-6 的静态事实构造一个 Code 视图文档。 */
function makeCodeDocument() {
  const doc = makeDocument();
  const frameRoot = doc.createElement('div');
  frameRoot.setAttribute('class', 'dframe-root');
  frameRoot.setAttribute('data-frame-mode', 'code');
  const content = doc.createElement('main');
  content.setAttribute('class', 'dframe-content');
  const inner = doc.createElement('div');
  inner.setAttribute('class', 'epitaxy-root');
  const input = doc.createElement('div');
  input.setAttribute('data-testid', 'code-prompt-input');
  inner.appendChild(input);
  content.appendChild(inner);
  frameRoot.appendChild(content);
  doc.body.appendChild(frameRoot);
  return { doc, frameRoot, content, inner, input };
}

function install(win, options) {
  return xiaokeThemePageMain(
    Object.assign({ window: win }, options),
    sanitizeThemeState, sanitizeThemeScenes, sanitizeSceneSvg, buildBuiltinScenes, stripSceneAnimation,
  );
}

function elements(doc, selector) { return doc.querySelectorAll(selector); }

// ---------------------------------------------------------------------------------------------
// CSS 作用域
// ---------------------------------------------------------------------------------------------
test('每一条 CSS 规则的每一个选择器都以作用域属性开头', () => {
  const css = scopedStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 25, `规则数只有 ${rules.length}，样式表看起来被截断了`);
  const offenders = [];
  for (const rule of rules) {
    const selectorText = rule[1].trim();
    // 括号感知的逗号切分：:where(.a,.b) 里的逗号不是选择器分隔符
    const depthReset = [];
    let depth = 0;
    let current = '';
    for (const ch of selectorText) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { depthReset.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    depthReset.push(current.trim());
    for (const part of depthReset) {
      if (!part.startsWith('[' + SCOPE_ATTRIBUTE + ']')) offenders.push(part);
    }
  }
  assert.deepEqual(offenders, [], '有选择器逃出了作用域:\n' + offenders.join('\n'));
});

test('样式表没有任何全局选择器，也不碰 :root / html / body', () => {
  const css = scopedStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
  const selectorText = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).join('\n');
  const globalOnes = selectorText.split('\n').filter((line) => /(^|[\s,:])(:root|html|body|\*)\s*(,|\{|$|\[)/.test(line) && !line.startsWith('[' + SCOPE_ATTRIBUTE + ']'));
  assert.deepEqual(globalOnes, [], '样式表里出现了全局选择器:\n' + globalOnes.join('\n'));
});

test('作用域只落在 Code 子树，覆盖路径与反查路径都与静态标记一致', () => {
  const scopeRule = scopedStylesheet().split('\n').find((line) => line.startsWith('[' + SCOPE_ATTRIBUTE + '][data-xiaoke-theme-custom]{'));
  assert.ok(scopeRule, '缺少作用域根规则');
  // 变量只在这里定义，说明改的是 Code 子树的继承值而不是 :root
  assert.match(scopeRule, /--xk-bg:#/);
  assert.match(scopeRule, /--df-bg-page:var\(--xk-bg\)/);
  assert.equal(/--cds-text-primary/.test(scopeRule), true);
  // 内容容器必须透明，否则负层背景永远看不见
  const css = scopedStylesheet();
  assert.match(css, /\[data-xiaoke-theme-active\]\[data-xiaoke-theme-custom\] :where\(\.dframe-content-inner,\.epitaxy-root,main\)\{background-color:transparent;\}/);
});

test('背景层规则同时锁死指针事件与层级', () => {
  const css = scopedStylesheet();
  const rule = css.split('\n').find((line) => line.includes('[data-xiaoke-theme-bg]{'));
  assert.ok(rule, '缺少背景层规则');
  assert.match(rule, /pointer-events:none/);
  assert.match(rule, /z-index:-1/);
  // 染色层同样不吃事件
  const tint = css.split('\n').find((line) => line.includes('data-xiaoke-theme-tint'));
  assert.match(tint, /pointer-events:none/);
  assert.match(tint, /opacity:var\(--xk-glass-opacity\)/);
  // UI 包装层同样不吃事件，只有交互控件自己 auto
  const wrapper = css.split('\n').find((line) => line.includes('[' + UI_ATTRIBUTE + ']{'));
  assert.match(wrapper, /pointer-events:none/);
  const launch = css.split('\n').find((line) => line.includes('data-xk-part="launch"'));
  assert.match(launch, /pointer-events:auto/);
});

test('交付的玻璃默认值（0/0/#000000）不会把面板变成透明或黑底黑字', () => {
  // desktop/themes 的 DEFAULT_STATE 是 blur:0 opacity:0 tint:#000000。
  // 拿 tint 当面板底色 => opacity 0 时面板整个消失；浅色模式下黑底 + 近黑文字 => 读不出字。
  // 所以面板底色必须取调色板背景，并且带一个可读下限。
  const css = scopedStylesheet();
  const panelRule = css.split('\n').find((line) => line.includes('[data-xk-part="panel"]{'));
  assert.match(panelRule, /background:var\(--cds-surface-0,#fcfcfb\)/,
    '设置内弹层始终使用独立的不透明原生底色');
  assert.match(panelRule, /--xk-text:var\(--cds-text-primary,#151515\)/,
    '移入设置后弹层必须自行定义文本变量');
  assert.equal(/background:color-mix\(in srgb,var\(--xk-tint\)/.test(panelRule), false,
    '面板不能直接用 tint 当底色');
  // glass 仍然要生效：blur 进 backdrop-filter
  assert.match(panelRule, /backdrop-filter:blur\(var\(--xk-glass-blur\)\)/);
});

test('减少动效时面板动画被关掉，靠的是作用域属性而不是全局媒体查询', () => {
  const css = scopedStylesheet();
  const rule = css.split('\n').find((line) => line.includes('[' + MOTION_ATTRIBUTE + '="off"]'));
  assert.ok(rule, '缺少关动效规则');
  assert.match(rule, /animation:none/);
  assert.ok(rule.startsWith('[' + SCOPE_ATTRIBUTE + ']'));
});

// ---------------------------------------------------------------------------------------------
// 净化
// ---------------------------------------------------------------------------------------------
test('颜色只接受 #rrggbb，其余一律回落', () => {
  const state = sanitizeThemeState({
    name: 'x', mode: 'dim', scene: 'nope!', motion: 'yes',
    colors: {
      light: { background: 'red', text: '#ABCDEF', muted: 'rgb(1,2,3)', accent: '#12' },
      dark: { background: '#000000', text: null, muted: '#fffffff', accent: '#C96442' },
    },
    glass: { blur: 999, opacity: -3, tint: 'blue' },
  });
  assert.equal(state.colors.light.background, DEFAULT_THEME_STATE.colors.light.background);
  assert.equal(state.colors.light.text, '#abcdef', '合法 hex 应保留下转小写');
  assert.equal(state.colors.light.muted, DEFAULT_THEME_STATE.colors.light.muted);
  assert.equal(state.colors.light.accent, DEFAULT_THEME_STATE.colors.light.accent);
  assert.equal(state.colors.dark.background, '#000000');
  assert.equal(state.colors.dark.muted, DEFAULT_THEME_STATE.colors.dark.muted, '7 位 hex 必须被拒');
  assert.equal(state.colors.dark.accent, '#c96442');
  assert.equal(state.mode, 'system', '未知 mode 回落 system');
  assert.equal(state.scene, null, '非法 scene id 必须丢掉');
  assert.equal(state.glass.blur, 64, 'blur 上限 64');
  assert.equal(state.glass.opacity, 0, 'opacity 下限 0');
  assert.equal(state.glass.tint, DEFAULT_THEME_STATE.glass.tint);
  assert.equal(state.version, 1);
});

test('name 里的 HTML 只当文本保留，不会被解释', () => {
  const state = sanitizeThemeState({ name: '<img src=x onerror=alert(1)>' });
  assert.equal(typeof state.name, 'string');
  assert.equal(state.name, '<img src=x onerror=alert(1)>');
  // 控制字符与换行被压平，长度被截断
  const long = sanitizeThemeState({ name: 'a\nb\u0000c' + 'x'.repeat(200) });
  assert.equal(long.name.includes('\n'), false);
  assert.equal(long.name.includes('\u0000'), false);
  assert.equal(long.name.length <= 60, true);
});

test('SVG 白名单：脚本、外来文档、事件、外链、实体一律拒绝', () => {
  assert.equal(sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>') !== null, true);
  const rejected = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="javascript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil/x.png"/></svg>',
    // use 本身放行（交付场景在用），但只能文档内引用
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil/x.svg#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="//evil/x#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(x)</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{background:expression(alert(1))}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{}</style></svg>'.replace('</style>', '</sty' + 'le><script>x</script>'),
    '<svg xmlns="http://www.w3.org/2000/svg"><!DOCTYPE x><rect/></svg>',
    // 注释放行，但夹带可执行标记的注释必须被拒（校验看的是摘掉注释后的副本）
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- <script>alert(1)</script> --><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- 未闭合<rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- a --!><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="f"><feImage href="https://evil/x"/></filter></defs></svg>',
    '<div>not svg</div>',
    '',
  ];
  for (const svg of rejected) {
    assert.equal(sanitizeSceneSvg(svg), null, '未被拒绝: ' + svg);
  }
});

test('SVG 白名单按交付场景校准：style 与 use 放行，文档内引用可用', () => {
  // desktop/themes/ 里实际交付的场景带着 <style> 和 <use href="#id">，
  // 白名单若按"只许几何图形"来收，交付的 20 个场景会全部被拒。
  const withStyleAndUse = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>'
    + '<mask id="m"><rect width="10" height="10" fill="#fff"/></mask></defs>'
    + '<style>.a{fill:url(#g);animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>'
    + '<use href="#m"/><rect class="a" width="10" height="10"/></svg>';
  const out = sanitizeSceneSvg(withStyleAndUse);
  assert.ok(out, 'style + 文档内 use 的合法场景被拒了');
  assert.match(out, /<style>/);
  assert.match(out, /<use href="#m"\/>/);
});

test('合法注释原样保留，注释里夹带的可执行标记不会漏过去', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<!-- (c) upstream，Apache-2.0 --><rect width="10" height="10" fill="#123456"/></svg>';
  const out = sanitizeSceneSvg(svg);
  assert.ok(out, '带普通注释的合法场景被拒了');
  assert.match(out, /<!-- \(c\) upstream，Apache-2\.0 -->/);
  // 注释是惰性的，但摘注释之后仍要走完整套校验：不能靠注释把 <script> 藏进来
  assert.equal(sanitizeSceneSvg(svg.replace('<rect', '<script>alert(1)</script><rect')), null);
});

test('SVG 允许文档内 url(#id) 引用，并补上 xmlns', () => {
  const svg = sanitizeSceneSvg('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>');
  assert.ok(svg);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /url\(#g\)/);
});

test('场景列表校验去重、限量、丢坏条', () => {
  const good = sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  const scenes = sanitizeThemeScenes([
    { id: 'ok', title: '好的', mode: 'light', svg: good },
    { id: 'ok', title: '重复', mode: 'dark', svg: good },
    { id: 'bad id!', title: 'x', mode: 'dark', svg: good },
    { id: 'nosvg', title: 'x', mode: 'dark', svg: '<svg><script>x</script></svg>' },
    { id: 'nomode', title: '', mode: 'weird', svg: good },
    null,
  ], sanitizeSceneSvg);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].id, 'ok');
  assert.equal(scenes[0].mode, 'light');
  assert.equal(scenes[1].id, 'nomode');
  assert.equal(scenes[1].mode, 'dark', '未知 mode 回落 dark');
  assert.equal(scenes[1].title, 'nomode', '空标题回落 id');
});

test('内置场景正好 20 个且全部通过白名单', () => {
  assert.equal(BUILTIN_SCENES.length, 20);
  const ids = new Set(BUILTIN_SCENES.map((s) => s.id));
  assert.equal(ids.size, 20, '内置场景 id 必须唯一');
  for (const scene of BUILTIN_SCENES) {
    assert.equal(sanitizeSceneSvg(scene.svg), scene.svg, `场景 ${scene.id} 的 SVG 不能通过自身白名单`);
    assert.equal(scene.mode === 'light' || scene.mode === 'dark', true);
    assert.equal(scene.title.length > 0, true);
  }
});

test('交付到 desktop/themes 的 20 个场景全部通过白名单（白名单是对着真实产物校准的）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = path.join(ROOT, 'desktop', 'themes');
  const { ThemeController } = require('../desktop/theme-controller.cjs');
  assert.equal(fs.existsSync(path.join(dir, 'catalog.json')), true, '交付场景目录缺少 catalog.json: ' + dir);
  const controller = new ThemeController({ directory: path.join(os.tmpdir(), 'xk-scene-' + process.pid), onChange() {} });
  try {
    const scenes = controller.listScenes();
    assert.equal(scenes.length, 20, '交付场景数应为 20');
    const rejected = scenes.filter((s) => !sanitizeSceneSvg(s.svg)).map((s) => `${s.id} (${s.svg.length}B)`);
    assert.deepEqual(rejected, [], '这些交付场景过不了白名单:\n' + rejected.join('\n'));
    // 校准依据写进断言：真实场景确实带着 style/use，窄白名单会把它们全拒掉
    assert.equal(scenes.some((s) => /<style/i.test(s.svg)), true);
    assert.equal(scenes.some((s) => /<use\s/i.test(s.svg)), true);
    const sanitized = sanitizeThemeScenes(scenes, sanitizeSceneSvg);
    assert.equal(sanitized.length, 20, '净化后的场景数量不能变少');
    // 关键回归：真实场景 20/20 到手时，渲染器绝不能拿内置合成图替换/补齐它们。
    // （内置图里有 aurora、ember 两个 id 与官方场景同名，所以这条必须按 id 全等来断言。）
    assert.deepEqual(sanitized.map((s) => s.id), scenes.map((s) => s.id), '场景 id 顺序必须与官方一致');
    assert.deepEqual(sanitized.map((s) => s.title), scenes.map((s) => s.title), '场景标题必须来自官方，不是内置图');
    const builtinSvg = new Set(BUILTIN_SCENES.map((s) => s.svg));
    const replaced = sanitized.filter((s) => builtinSvg.has(s.svg)).map((s) => s.id);
    assert.deepEqual(replaced, [], '这些场景被内置合成图顶替了: ' + replaced.join(','));
  } finally {
    controller.close();
  }
});

test('注入脚本不依赖 eval，且把净化函数一起带进页面', () => {
  const script = buildInstallScript({ state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  assert.equal(/\beval\s*\(/.test(script), false, '注入脚本不能包含 eval');
  assert.match(script, /data-xiaoke-theme-active/);
  // 函数以实参形式传入，页面侧拿到的是同一份实现
  assert.match(script, /return run\(/);
  assert.match(script, /function sanitizeThemeState/);
  assert.equal(script.includes('\u2028'), false, '行分隔符必须转义，否则脚本会被截断');
});

// ---------------------------------------------------------------------------------------------
// 安装 / 作用域 / 背景通道
// ---------------------------------------------------------------------------------------------
test('install 在 Code 视图挂作用域、背景层与悬浮按钮', () => {
  const { doc, content } = makeCodeDocument();
  const win = makeWindow(doc);
  const result = install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.reused, false);
  assert.equal(result.scenes, 20);

  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']');
  assert.equal(root.length, 1, '作用域属性只能落在一个节点上');
  assert.equal(root[0], content, '作用域必须落在 code-prompt-input 最近的 .dframe-content 上');

  // 变量写在作用域节点上，不是 :root
  assert.equal(root[0].style.getPropertyValue('--xk-bg'), DEFAULT_THEME_STATE.colors.light.background);
  assert.equal(root[0].style.getPropertyValue('--xk-text'), DEFAULT_THEME_STATE.colors.light.text);
  assert.equal(root[0].style.getPropertyValue('--xk-accent'), DEFAULT_THEME_STATE.colors.light.accent);
  assert.equal(root[0].getAttribute(MODE_ATTRIBUTE), 'light', 'system 必须解析成具体明暗');
  assert.equal(doc.documentElement.hasAttribute(SCOPE_ATTRIBUTE), false, '根元素不能被挂作用域');

  const bg = elements(doc, '[' + BG_ATTRIBUTE + ']');
  assert.equal(bg.length, 1);
  assert.equal(bg[0].parentNode, content);
  assert.equal(bg[0].style.getPropertyValue('pointer-events'), 'none', '背景层必须显式不吃指针事件');
  const img = elements(doc, '[' + BG_ATTRIBUTE + '] img');
  assert.equal(img.length, 1);
  assert.equal(img[0].style.getPropertyValue('pointer-events'), 'none');
  assert.equal(img[0].hasAttribute('src'), false, '未选场景时不应有 img src');

  const launch = elements(doc, '[data-xk-part="launch"]');
  assert.equal(launch.length, 1);
  assert.equal(launch[0].textContent, '主题');
  assert.equal(launch[0].style.getPropertyValue('pointer-events'), '', '按钮的 pointer-events 由样式表给，不写内联');
  assert.equal(launch[0].getAttribute('aria-expanded'), 'false');
});

test('面板是中文的，20 张卡片全部走 data:image/svg+xml 的 img', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });

  const panel = elements(doc, '[data-xk-part="panel"]');
  assert.equal(panel.length, 1);
  assert.equal(panel[0].hasAttribute('hidden'), true, '面板初始关闭');

  const labels = panel[0].textContent;
  for (const word of ['主题', '明暗模式', '跟随系统', '浅色', '深色', '背景场景', '预览', '保存', '恢复默认', '玻璃模糊', '不透明度']) {
    assert.equal(labels.includes(word), true, `面板缺少中文控件: ${word}`);
  }

  const cards = elements(doc, '[data-xk-scene]');
  assert.equal(cards.length, 20, '必须有 20 张场景卡片');
  const sources = cards.map((card) => card.children.find((child) => child.tagName === 'IMG'));
  assert.equal(sources.every((node) => node && node.getAttribute('src').startsWith('data:image/svg+xml')), true);
  assert.equal(sources.every((node) => node.getAttribute('alt') === ''), true);

  // 4 个颜色字段 × 明暗两套 + 底色
  const swatches = elements(doc, '[data-xk-color]');
  assert.equal(swatches.length, 9);
  const kinds = swatches.map((node) => node.getAttribute('data-xk-color'));
  assert.equal(kinds.filter((k) => k === 'background').length, 2);
  assert.equal(kinds.filter((k) => k === 'accent').length, 2);
  assert.equal(kinds.includes('tint'), true);
});

test('SVG 只以 img src 进入页面，主文档从不收到 innerHTML', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: { scene: 'aurora' }, scenes: BUILTIN_SCENES });
  assert.deepEqual(doc.innerHTMLWrites, [], '有代码把 HTML/SVG 写进了 innerHTML');

  const img = elements(doc, '[' + BG_ATTRIBUTE + '] img')[0];
  const src = img.getAttribute('src');
  assert.match(src, /^data:image\/svg\+xml;charset=utf-8,/);
  const decoded = decodeURIComponent(src.split(',').slice(1).join(','));
  assert.match(decoded, /^<svg/);
  assert.equal(/<script|onload=/.test(decoded), false, 'data URI 里的 SVG 仍然是净化后的');
});

test('name 与场景标题都走 textContent，不产生任何元素或事件属性', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const scenes = [{ id: 'evil', title: '<img src=x onerror=alert(1)>', mode: 'dark', svg: sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>') }];
  install(win, { state: { name: '<b>标题注入</b>', scene: 'evil' }, scenes });
  const ui = elements(doc, '[data-xiaoke-theme-ui="wrapper"]')[0];
  const nodes = [];
  doc.__walk(ui, (node) => nodes.push(node));
  const offenders = [];
  for (const node of nodes) {
    for (const name of [...node.attrs.keys()]) {
      if (/^on/i.test(name)) offenders.push(node.tagName + ' ' + name);
    }
  }
  assert.deepEqual(offenders, [], '出现了内联事件属性');
  // 标题原文作为文本存在，标签没有被解释成元素
  const card = elements(doc, '[data-xk-scene="evil"]')[0];
  assert.equal(card.textContent.includes('<img src=x onerror=alert(1)>'), true);
  assert.equal(card.children.some((child) => child.tagName === 'IMG' && child.getAttribute('src') === 'x'), false);
  const titleNode = elements(doc, '[data-xk-part="title"]')[0];
  assert.equal(titleNode.textContent, '主题');
  assert.equal(titleNode.children.length, 0);
});

test('System 明暗跟随系统，切到 dark 用 dark 调色板', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  win.matchMedia('(prefers-color-scheme: dark)').matches = true;
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.equal(root.getAttribute(MODE_ATTRIBUTE), 'dark');
  assert.equal(root.style.getPropertyValue('--xk-bg'), DEFAULT_THEME_STATE.colors.dark.background);
});

test('applyThemeState 走 __xiaokeTheme.apply，未安装时退回安装', async () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  // executeJavaScript 的语义是"求值并返回表达式结果"，所以这里用 Function 包一层 return，
  // 而不是直接把函数体当语句执行（那样表达式值会被丢掉）。
  const run = (source) => new Function('return (' + source + ');');
  const windowLike = {
    document: doc,
    webContents: {
      executeJavaScript: (source) => {
        const previousWindow = globalThis.window;
        const previousDocument = globalThis.document;
        const previousTheme = globalThis.__xiaokeTheme;
        globalThis.window = win;
        globalThis.document = doc;
        // 真渲染器里 globalThis === window；这里把 win 上的实例镜像到 globalThis，
        // 让 buildApplyScript 的 globalThis.__xiaokeTheme 查找等价于页面内的查找。
        globalThis.__xiaokeTheme = win.__xiaokeTheme;
        try {
          return Promise.resolve(run(source)()).then((value) => {
            if (win.__xiaokeTheme) globalThis.__xiaokeTheme = win.__xiaokeTheme;
            return value;
          });
        } finally {
          globalThis.window = previousWindow;
          globalThis.document = previousDocument;
          globalThis.__xiaokeTheme = previousTheme;
        }
      },
    },
  };
  const first = await applyThemeState(windowLike, { scene: 'ocean' });
  assert.equal(first.ok, true, '未安装时 applyThemeState 应自动安装: ' + JSON.stringify(first));
  assert.equal(first.scenes, 20, '自动安装也要带满 20 个场景');
  assert.equal(win.__xiaokeTheme.saved.scene, 'ocean');

  const second = await applyThemeState(windowLike, { scene: 'forest', mode: 'dark' });
  assert.equal(second.ok, true);
  assert.equal(second.active, true);
  assert.equal(second.state.scene, 'forest');
  assert.equal(second.state.mode, 'dark');
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.equal(root.getAttribute(MODE_ATTRIBUTE), 'dark');
});

test('installThemeRenderer 通过 webContents.executeJavaScript 注入，没有 webContents 时如实报错', async () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const calls = [];
  const windowLike = {
    webContents: {
      executeJavaScript: (source, userGesture) => { calls.push({ source, userGesture }); return Promise.resolve({ ok: true, reused: false, scenes: 20, active: true }); },
    },
  };
  const result = await installThemeRenderer(windowLike, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userGesture, true);
  assert.match(calls[0].source, /data-xiaoke-theme-active/);
  assert.equal(typeof win.installThemeRenderer, 'undefined', '渲染器不应污染 window 上的其它名字');

  const missing = await installThemeRenderer({}, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-web-contents');
});

// ---------------------------------------------------------------------------------------------
// 幂等 / 路由切换 / 清理
// ---------------------------------------------------------------------------------------------
test('重复 install 复用同一份 DOM、同一个 observer、同一批 listener', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const before = install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const styleCount = elements(doc, '#' + STYLE_ELEMENT_ID).length;
  const bgRef = elements(doc, '[' + BG_ATTRIBUTE + ']')[0];
  const uiRef = elements(doc, '[' + UI_ATTRIBUTE + ']')[0];
  const launchRef = elements(doc, '[data-xk-part="launch"]')[0];
  const observerCount = win.__observers.length;

  const after = install(win, { state: { mode: 'dark' }, scenes: BUILTIN_SCENES });
  assert.equal(after.ok, true);
  assert.equal(after.reused, true, '第二次 install 必须走复用分支');
  assert.equal(before.reused, false);

  assert.equal(elements(doc, '#' + STYLE_ELEMENT_ID).length, styleCount, 'style 元素被重复插入');
  assert.equal(styleCount, 1);
  assert.equal(elements(doc, '[' + BG_ATTRIBUTE + ']')[0], bgRef, '背景层被重建');
  assert.equal(elements(doc, '[' + UI_ATTRIBUTE + ']')[0], uiRef, 'UI 被重建');
  assert.equal(elements(doc, '[data-xk-part="launch"]')[0], launchRef, '按钮被重建');
  assert.equal(win.__observers.length, observerCount, 'observer 被重复创建');
  assert.equal(win.__observers.length, 1);
  assert.equal(win.__observers[0].targets.length, 1, 'observer 被重复 observe');
  assert.equal(win.__media.get('(prefers-color-scheme: dark)').listeners.length, 1, '媒体查询监听器被重复注册');
  assert.equal(win.__media.get('(prefers-reduced-motion: reduce)').listeners.length, 1);
  assert.equal(elements(doc, '[data-xk-scene]').length, 20, '复用后卡片不能变多或变少');
  assert.equal(elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0].getAttribute(MODE_ATTRIBUTE), 'dark', '复用分支必须应用新状态');
});

test('点“主题”开面板，关掉时未保存的改动被丢弃', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const launch = elements(doc, '[data-xk-part="launch"]')[0];
  const panel = elements(doc, '[data-xk-part="panel"]')[0];

  launch.listeners.find((l) => l.type === 'click').handler({});
  assert.equal(panel.hasAttribute('hidden'), false, '点按钮应打开面板');
  assert.equal(launch.getAttribute('aria-expanded'), 'true');

  // 未保存就改成 dark 场景
  const darkButton = elements(doc, '[data-xk-mode="dark"]')[0];
  darkButton.listeners.find((l) => l.type === 'click').handler({});
  assert.equal(darkButton.getAttribute('aria-checked'), 'true', '草稿应立刻反映到面板');
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.notEqual(root.getAttribute(MODE_ATTRIBUTE), 'dark', '未点预览/保存，页面不应跟着变');

  // 关闭：恢复已保存状态
  elements(doc, '[data-xk-action="close"]')[0].listeners.find((l) => l.type === 'click').handler({});
  assert.equal(panel.hasAttribute('hidden'), true);
  launch.listeners.find((l) => l.type === 'click').handler({});
  assert.equal(darkButton.getAttribute('aria-checked'), 'false', '重新打开时草稿应回到已保存值');
  assert.ok(win.__xiaokeTheme.draft.mode === DEFAULT_THEME_STATE.mode);
});

test('预览立即生效，保存走桥接并回写返回状态', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const calls = [];
  win['claude.web'] = {
    CustomThemes: {
      getState: () => DEFAULT_THEME_STATE,
      listScenes: () => [],
      setTheme: (value) => { calls.push(value); return Promise.resolve(Object.assign({}, value, { name: '已保存' })); },
      reset: () => { calls.push('reset'); return Promise.resolve(DEFAULT_THEME_STATE); },
      getThemeFile: () => '/fixture/theme.json',
    },
  };
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });

  elements(doc, '[data-xk-part="launch"]')[0].listeners.find((l) => l.type === 'click').handler({});
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  elements(doc, '[data-xk-action="preview"]')[0].listeners.find((l) => l.type === 'click').handler({});
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.equal(root.getAttribute(MODE_ATTRIBUTE), 'dark', '预览必须落到 DOM');
  assert.equal(elements(doc, '[data-xk-part="status"]')[0].textContent, '已预览（未保存）');

  const pending = elements(doc, '[data-xk-action="save"]')[0].listeners.find((l) => l.type === 'click').handler({});
  assert.equal(calls.length, 1, '保存必须调用 CustomThemes.setTheme');
  assert.equal(calls[0].mode, 'dark');
  assert.equal(pending && typeof pending.then, 'function');
  return pending.then(() => {
    assert.equal(elements(doc, '[data-xk-part="status"]')[0].textContent, '已保存');
    assert.equal(win.__xiaokeTheme.saved.name, '已保存', '应回写桥接返回的状态');
  });
});

test('桥接不可用时保存只在本窗口生效，并如实写进状态行', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const result = win.__xiaokeTheme.save();
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.equal(elements(doc, '[data-xk-part="status"]')[0].textContent, '已应用到当前窗口（桥接不可用，仅本地生效）');
});

test('切走 Code 视图时作用域属性、内联变量、背景与 UI 全部收干净', () => {
  const { doc, frameRoot, content } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: { scene: 'aurora' }, scenes: BUILTIN_SCENES });
  assert.equal(content.hasAttribute(SCOPE_ATTRIBUTE), true);
  assert.equal(content.style.getPropertyValue('--xk-bg').length > 0, true);

  // 路由切走：data-frame-mode 变 chat，composer 消失
  frameRoot.setAttribute('data-frame-mode', 'chat');
  content.removeChild(content.children[1]); // 摘掉 epitaxy-root（含 code-prompt-input）
  const result = win.__xiaokeTheme.sync();
  assert.equal(result.active, false);
  assert.equal(content.hasAttribute(SCOPE_ATTRIBUTE), false, '作用域属性没被移除');
  assert.equal(content.hasAttribute(MODE_ATTRIBUTE), false);
  assert.equal(content.style.getPropertyValue('--xk-bg'), '', '内联变量没被移除');
  assert.equal(content.style.getPropertyValue('--xk-accent'), '');
  assert.equal(elements(doc, '[' + BG_ATTRIBUTE + ']').length, 0, '背景层没被摘掉');
  assert.equal(elements(doc, '[' + UI_ATTRIBUTE + ']').length, 0, 'UI 没被摘掉');
  // 唯一保留的是样式表本身（无副作用，留着下次直接用）
  assert.equal(elements(doc, '#' + STYLE_ELEMENT_ID).length, 1);
});

test('切回来时重新挂载，且不重复插 style 元素', () => {
  const { doc, frameRoot, content } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: { scene: 'aurora' }, scenes: BUILTIN_SCENES });
  const inner = content.children[1];
  frameRoot.setAttribute('data-frame-mode', 'chat');
  content.removeChild(inner);
  win.__xiaokeTheme.sync();

  frameRoot.setAttribute('data-frame-mode', 'code');
  content.appendChild(inner);
  const back = win.__xiaokeTheme.sync();
  assert.equal(back.active, true);
  assert.equal(content.hasAttribute(SCOPE_ATTRIBUTE), true);
  assert.equal(elements(doc, '#' + STYLE_ELEMENT_ID).length, 1);
  assert.equal(elements(doc, '[' + BG_ATTRIBUTE + ']').length, 1);
  assert.equal(elements(doc, '[data-xk-scene]').length, 20, '重新挂载后面板必须是满的');
});

test('非 Code 视图（Chat）一个节点都不加，也不挂作用域', () => {
  const doc = makeDocument();
  const frameRoot = doc.createElement('div');
  frameRoot.setAttribute('class', 'dframe-root');
  frameRoot.setAttribute('data-frame-mode', 'chat');
  const main = doc.createElement('main');
  main.setAttribute('class', 'dframe-content');
  frameRoot.appendChild(main);
  doc.body.appendChild(frameRoot);

  const win = makeWindow(doc);
  const result = install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  assert.equal(result.ok, true);
  assert.equal(result.active, false, '没有 Code 标记就不该激活');
  assert.deepEqual(main.children, [], 'Chat 视图的容器被动了');
  assert.equal(elements(doc, '[' + BG_ATTRIBUTE + ']').length, 0);
  assert.equal(elements(doc, '[' + UI_ATTRIBUTE + ']').length, 0);
  assert.equal(elements(doc, '[' + SCOPE_ATTRIBUTE + ']').length, 0);
  assert.equal(doc.body.children.length, 1, 'body 上不允许挂任何东西');
});

test('只有 .dframe-root[data-frame-mode=code] 时退化到它自己，仍然不越界', () => {
  const doc = makeDocument();
  const frameRoot = doc.createElement('div');
  frameRoot.setAttribute('class', 'dframe-root');
  frameRoot.setAttribute('data-frame-mode', 'code');
  doc.body.appendChild(frameRoot);
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  assert.equal(frameRoot.hasAttribute(SCOPE_ATTRIBUTE), true);
  assert.equal(doc.documentElement.hasAttribute(SCOPE_ATTRIBUTE), false);
  assert.equal(doc.body.hasAttribute(SCOPE_ATTRIBUTE), false);
});

test('teardown 断开 observer、摘掉 listener、删掉样式表', () => {
  const { doc, content } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const keydownCount = doc.listeners.filter((l) => l.type === 'keydown').length;
  win.__xiaokeTheme.open();
  assert.equal(doc.listeners.filter((l) => l.type === 'keydown').length, keydownCount + 1, '打开面板要挂 Esc 监听');
  win.__xiaokeTheme.teardown();
  assert.equal(doc.listeners.filter((l) => l.type === 'keydown').length, 0, 'Esc 监听没被摘掉');
  assert.equal(win.__observers[0].disconnected, true, 'observer 没被断开');
  assert.equal(win.__media.get('(prefers-color-scheme: dark)').listeners.length, 0, '媒体查询监听器没被摘掉');
  assert.equal(content.hasAttribute(SCOPE_ATTRIBUTE), false);
  assert.equal(elements(doc, '[' + BG_ATTRIBUTE + ']').length, 0);
  assert.equal(elements(doc, '[' + UI_ATTRIBUTE + ']').length, 0);
  assert.equal(elements(doc, '#' + STYLE_ELEMENT_ID).length, 0);
  assert.equal(win.__xiaokeTheme.installed, false);
});

test('减少动效时背景 SVG 里的 SMIL 被剥掉，卡片预览仍保留完整场景', () => {
  assert.equal(BUILTIN_SCENES.some((s) => s.svg.includes('<animate')), true, '内置场景里应存在 SMIL，否则这条测试没有意义');
  const withAnimation = BUILTIN_SCENES.find((s) => s.svg.includes('<animate'));
  const stripped = renderer.stripSceneAnimation(withAnimation.svg);
  assert.equal(stripped.includes('<animate'), false);
  assert.equal(stripped.includes('<svg'), true);
  assert.equal(sanitizeSceneSvg(stripped) !== null, true, '剥完动效后仍然必须通过白名单');

  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  win.matchMedia('(prefers-reduced-motion: reduce)').matches = true;
  install(win, { state: Object.assign({}, DEFAULT_THEME_STATE, { scene: withAnimation.id }), scenes: BUILTIN_SCENES });
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.equal(root.getAttribute(MOTION_ATTRIBUTE), 'off');
  const src = elements(doc, '[' + BG_ATTRIBUTE + '] img')[0].getAttribute('src');
  const decoded = decodeURIComponent(src.split(',').slice(1).join(','));
  assert.equal(decoded.includes('<animate'), false, '减少动效时背景不能还在动');
  // 卡片不受影响：那是静态缩略图，动效开关不该让预览变成空图
  const cardSrc = elements(doc, '[data-xk-scene="' + withAnimation.id + '"] img')[0].getAttribute('src');
  assert.equal(decodeURIComponent(cardSrc.split(',').slice(1).join(',')).includes('<animate'), true);
});

// 交付场景的动画全在 <style> 的 @keyframes 里（实测 20/20 带 CSS 动画，SMIL 只有内置合成图有）。
// 只剥 SMIL 等于 motion:false 什么都没关，所以关动效必须往 SVG 里注入一条 override 样式。
test('motion:false 真的停住 CSS 动画：注入 override 样式，而不是只剥 SMIL', () => {
  const cssScene = BUILTIN_SCENES.find((s) => s.svg.includes('@keyframes')) || BUILTIN_SCENES[0];
  const cssAnimated = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<style>.a{animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>'
    + '<rect class="a" width="10" height="10"/></svg>';
  const off = renderer.stripSceneAnimation(cssAnimated);
  assert.match(off, /animation:none!important/, 'motion:false 必须真的关掉 CSS 动画');
  assert.match(off, /animation-play-state:paused!important/);
  // override 必须在 </svg> 之内，否则浏览器不会应用
  assert.equal(off.indexOf('animation:none!important') < off.lastIndexOf('</svg>'), true);
  // 原作者那条 @keyframes 保留：不动素材，只叠一条作用域内的 override
  assert.match(off, /@keyframes spin/);
  assert.equal(sanitizeSceneSvg(off) !== null, true, '注入 override 之后仍必须通过白名单');

  // 真实交付场景同样要压住
  assert.ok(cssScene);
  const realOff = renderer.stripSceneAnimation(cssScene.svg);
  assert.match(realOff, /animation:none!important/);

  // 背景层走的是 stripSceneAnimation，卡片缩略图仍是完整动画
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: Object.assign({}, DEFAULT_THEME_STATE, { scene: cssScene.id, motion: false }), scenes: BUILTIN_SCENES });
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  assert.equal(root.getAttribute(MOTION_ATTRIBUTE), 'off');
  const src = elements(doc, '[' + BG_ATTRIBUTE + '] img')[0].getAttribute('src');
  const decoded = decodeURIComponent(src.split(',').slice(1).join(','));
  assert.match(decoded, /animation:none!important/, 'motion:false 的背景里没有关动画的样式');
});

test('观察器只在 layout 变化时重同步，且自身写入不触发回环', () => {
  const { doc, content, frameRoot } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const observer = win.__observers[0];
  const callback = observer.callback;

  // 自身的写入（作用域属性）被 quiet 保护，不会排队
  win.__flush();
  const queuedAfterInstall = win.__timers.length;
  assert.equal(queuedAfterInstall, 0, '安装结束后不应残留待执行的同步任务');

  callback([{ type: 'attributes', attributeName: 'data-frame-mode' }]);
  assert.equal(win.__timers.length, 1, 'layout 变化应触发一次排队的同步');
  win.__flush();
  assert.equal(win.__observers.length, 1, '同步过程不能再造 observer');

  // 切到 chat 后，观察器驱动的那次同步必须把作用域收掉
  frameRoot.setAttribute('data-frame-mode', 'chat');
  content.removeChild(content.children[1]);
  callback([{ type: 'attributes', attributeName: 'data-frame-mode' }]);
  win.__flush();
  assert.equal(content.hasAttribute(SCOPE_ATTRIBUTE), false);
});

test('场景从桥接之外变更时卡片跟着更新，且不超过 20 张', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const custom = { id: 'custom', title: '自定义', mode: 'light', svg: sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>') };
  install(win, { state: DEFAULT_THEME_STATE, scenes: [custom] });
  const cards = elements(doc, '[data-xk-scene]');
  assert.equal(cards.length, 20, '不足 20 时必须用内置场景补齐');
  assert.equal(elements(doc, '[data-xk-scene="custom"]').length, 1, '自定义场景要保留');
  assert.equal(elements(doc, '[data-xk-scene="aurora"]').length, 1, '内置场景要补位且不重复');
});

test('install 没带 scenes 时面板自己向桥接的 listScenes 要，不留在内置合成图上', async () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const delivered = Array.from({ length: 20 }, (_, i) => ({
    id: 'delivered-' + i,
    title: '交付场景 ' + i,
    mode: i % 2 ? 'dark' : 'light',
    svg: sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'),
  }));
  win['claude.web'] = {
    CustomThemes: {
      getState: () => DEFAULT_THEME_STATE,
      listScenes: () => Promise.resolve(delivered),
      setTheme: (v) => Promise.resolve(v),
      reset: () => Promise.resolve(DEFAULT_THEME_STATE),
      getThemeFile: () => '/fixture/theme.json',
    },
  };
  install(win, { state: DEFAULT_THEME_STATE });
  // 首次同步时用内置场景兜底，桥接落地后必须换成交付场景
  assert.equal(elements(doc, '[data-xk-scene]').length, 20);
  await Promise.resolve();
  await Promise.resolve();
  const ids = elements(doc, '[data-xk-scene]').map((n) => n.getAttribute('data-xk-scene'));
  assert.equal(ids.length, 20, '换场景后卡片数仍应是 20');
  assert.equal(ids[0], 'delivered-0', '面板应改用交付场景而不是内置合成图: ' + ids.slice(0, 3).join(','));
  assert.equal(elements(doc, '[data-xk-scene="aurora"]').length, 0, '内置合成场景应被交付场景替换');
});

// ---------------------------------------------------------------------------------------------
// 预览 vs 持久态
//
// 实测过的缺陷：点“预览”写的是 api.saved —— 也就是桥接 setTheme / 磁盘 theme.json 的那一份。
// 于是预览一次就把持久态换成了草稿：关掉面板画面不回去（paint 读 saved），再打开面板时
// openPanel 拿这份被覆盖的 saved 去克隆 draft，未保存的东西就变成了“已保存”。
//
// 修法：paint 的渲染源是 previewing ? draft : saved，preview 只置标记，saved 一个字不动。
// 下面的断言按这个契约钉住，并且都从 API 表面（saved / draft / previewing）与 DOM 两头看。
// ---------------------------------------------------------------------------------------------
function openPanelVia(doc) {
  elements(doc, '[data-xk-part="launch"]')[0].listeners.find((l) => l.type === 'click').handler({});
}
function clickPart(doc, action) {
  return elements(doc, '[data-xk-action="' + action + '"]')[0].listeners.find((l) => l.type === 'click').handler({});
}
function modeOf(doc) {
  const root = elements(doc, '[' + SCOPE_ATTRIBUTE + ']')[0];
  return root ? root.getAttribute(MODE_ATTRIBUTE) : null;
}
function snapshot(state) { return JSON.stringify(state); }

test('预览不碰持久态：saved 原样保留，预览态只在 previewing 标记上', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);

  openPanelVia(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  clickPart(doc, 'preview');

  assert.equal(modeOf(doc), 'dark', '预览必须落到 DOM');
  assert.equal(api.previewing, true, '预览只能是一个标记');
  assert.equal(snapshot(api.saved), savedBefore, '预览覆盖了持久态(saved)');
  assert.equal(api.saved.mode, DEFAULT_THEME_STATE.mode);
  assert.equal(api.draft.mode, 'dark', '草稿才是被预览的那一份');
});

test('关闭面板把预览画面恢复成持久态，previewing 归位，草稿不残留', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);

  openPanelVia(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  clickPart(doc, 'preview');
  assert.equal(modeOf(doc), 'dark');

  clickPart(doc, 'close');
  assert.equal(modeOf(doc), DEFAULT_THEME_STATE.mode === 'system' ? 'light' : DEFAULT_THEME_STATE.mode,
    '关闭后画面必须回到持久态，而不是停在预览值');
  assert.equal(api.previewing, false, '预览标记必须被清掉');
  assert.equal(snapshot(api.saved), savedBefore);
  assert.equal(api.draft.mode, DEFAULT_THEME_STATE.mode, '关闭后草稿应回到持久态');
  assert.equal(api.dirty, false);
  assert.equal(elements(doc, '[data-xk-part="status"]')[0].textContent, '');

  // 重新打开：面板显示的是持久态，不是上一次预览
  openPanelVia(doc);
  assert.equal(elements(doc, '[data-xk-mode="dark"]')[0].getAttribute('aria-checked'), 'false',
    '被预览过的值不能变成重新打开时的已保存值');
  assert.equal(api.saved.mode, DEFAULT_THEME_STATE.mode);
});

test('预览期间改草稿会自动跟随（dirty 自动预览），关闭后一起丢弃', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);

  openPanelVia(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  clickPart(doc, 'preview');
  assert.equal(modeOf(doc), 'dark');

  // 预览中继续编辑：草稿就是渲染源，页面必须跟着走，而不是停在第一次预览那一刻
  elements(doc, '[data-xk-mode="light"]')[0].listeners.find((l) => l.type === 'click').handler({});
  assert.equal(api.dirty, true);
  assert.equal(modeOf(doc), 'light', '预览中编辑草稿必须重画（dirty 自动预览）');
  assert.equal(snapshot(api.saved), savedBefore, '预览中的编辑不能写进持久态');

  // 没在预览时不重画：先关掉，再改
  clickPart(doc, 'close');
  assert.equal(modeOf(doc), 'light');
  openPanelVia(doc);
  const beforeEdit = modeOf(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  assert.equal(modeOf(doc), beforeEdit, '未点预览/保存时页面不该跟着草稿变');
});

test('预览中的路由重同步不会把持久态画回来，也不会覆盖持久态', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: { scene: 'aurora' }, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);

  openPanelVia(doc);
  // 卡片走 grid 上的事件委托，没有自己的 listener；这里直接用同等效果的 setDraft
  api.setDraft((next) => { next.scene = 'ocean'; });
  clickPart(doc, 'preview');
  const previewed = decodeURIComponent(
    elements(doc, '[' + BG_ATTRIBUTE + '] img')[0].getAttribute('src').split(',').slice(1).join(','),
  );
  assert.match(previewed, /#061722/, '预览必须画出草稿场景');

  api.sync();
  assert.equal(api.previewing, true, '重同步不能悄悄结束预览');
  const afterSync = decodeURIComponent(
    elements(doc, '[' + BG_ATTRIBUTE + '] img')[0].getAttribute('src').split(',').slice(1).join(','),
  );
  assert.equal(afterSync, previewed, '重同步把预览画面换回了持久态');
  assert.equal(snapshot(api.saved), savedBefore);
});

test('保存失败时预览标记收掉，画面落在保存后的那份状态上', async () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const calls = [];
  win['claude.web'] = {
    CustomThemes: {
      getState: () => DEFAULT_THEME_STATE,
      listScenes: () => [],
      setTheme: (value) => { calls.push(value); return Promise.reject(new Error('disk full')); },
      reset: () => Promise.resolve(DEFAULT_THEME_STATE),
      getThemeFile: () => '/fixture/theme.json',
    },
  };
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;

  openPanelVia(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  clickPart(doc, 'preview');
  assert.equal(api.previewing, true);

  const pending = clickPart(doc, 'save');
  assert.equal(calls.length, 1, '保存必须走桥接 setTheme');
  const result = await pending;
  assert.equal(result.persisted, false, '桥接拒绝时如实报告没有落地');
  assert.equal(api.previewing, false, '保存失败后预览标记也必须收掉');
  assert.equal(api.saved.mode, 'dark', '保存失败退回本窗口生效，saved 就是这份候选值');
  assert.equal(modeOf(doc), 'dark', '画面必须等于保存后的那份状态');
  assert.equal(elements(doc, '[data-xk-part="status"]')[0].textContent,
    '已应用到当前窗口（桥接不可用，仅本地生效）');
});

test('api.preview() 与按钮同一条契约：不写 saved，关闭即恢复', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);

  openPanelVia(doc);
  api.setDraft((next) => { next.mode = 'dark'; });
  const shown = api.preview();
  assert.equal(shown.mode, 'dark', 'api.preview 返回的应是画在页面上的那份');
  assert.equal(modeOf(doc), 'dark');
  assert.equal(api.previewing, true);
  assert.equal(snapshot(api.saved), savedBefore, 'api.preview 覆盖了持久态');

  api.close();
  assert.equal(modeOf(doc), 'light');
  assert.equal(api.previewing, false);
  assert.equal(snapshot(api.saved), savedBefore);
});

test('切走 Code 视图时预览一起收掉：切回来看到的是持久态', () => {
  const { doc, frameRoot, content } = makeCodeDocument();
  const win = makeWindow(doc);
  install(win, { state: DEFAULT_THEME_STATE, scenes: BUILTIN_SCENES });
  const api = win.__xiaokeTheme;
  const savedBefore = snapshot(api.saved);
  const inner = content.children[1];

  openPanelVia(doc);
  elements(doc, '[data-xk-mode="dark"]')[0].listeners.find((l) => l.type === 'click').handler({});
  clickPart(doc, 'preview');
  assert.equal(api.previewing, true);

  frameRoot.setAttribute('data-frame-mode', 'chat');
  content.removeChild(inner);
  assert.equal(api.sync().active, false);
  assert.equal(api.previewing, false, '作用域被摘掉后预览标记必须一起收');
  assert.equal(snapshot(api.saved), savedBefore, '切走视图不能写持久态');

  frameRoot.setAttribute('data-frame-mode', 'code');
  content.appendChild(inner);
  assert.equal(api.sync().active, true);
  assert.equal(modeOf(doc), 'light', '切回来渲染的是持久态，不是上次那份弃掉的预览');
  assert.equal(api.draft.mode, DEFAULT_THEME_STATE.mode);
  assert.equal(snapshot(api.saved), savedBefore);
});

test('默认状态不启用覆盖，深色场景自动选择深色并可恢复原样', () => {
  const {doc, frameRoot, content} = makeCodeDocument();
  frameRoot.setAttribute('data-mode','light');
  const win=makeWindow(doc);
  install(win,{state:DEFAULT_THEME_STATE,scenes:BUILTIN_SCENES});
  assert.equal(content.hasAttribute('data-xiaoke-theme-custom'),false);
  assert.equal(frameRoot.getAttribute('data-mode'),'light');
  const dark=BUILTIN_SCENES.find(s=>s.mode==='dark');
  win.__xiaokeTheme.apply({...DEFAULT_THEME_STATE,scene:dark.id,mode:'system'});
  assert.equal(content.getAttribute(MODE_ATTRIBUTE),'dark');
  assert.equal(content.hasAttribute('data-xiaoke-theme-custom'),true);
  win.__xiaokeTheme.apply(DEFAULT_THEME_STATE);
  assert.equal(content.hasAttribute('data-xiaoke-theme-custom'),false);
  assert.equal(frameRoot.getAttribute('data-mode'),'light');
});

test('深浅主题同步frame与内部cds容器，卸载后恢复原模式', () => {
  const { doc, frameRoot, content } = makeCodeDocument();
  frameRoot.setAttribute('data-mode', 'light');
  const innerRoot = doc.createElement('div');
  innerRoot.setAttribute('class', 'cds-root');
  innerRoot.setAttribute('data-mode', 'light');
  content.appendChild(innerRoot);
  const win = makeWindow(doc);
  install(win, { state: { ...DEFAULT_THEME_STATE, mode: 'dark' }, scenes: BUILTIN_SCENES });
  assert.equal(frameRoot.getAttribute('data-mode'), 'dark');
  assert.equal(innerRoot.getAttribute('data-mode'), 'dark');
  win.__xiaokeTheme.teardown();
  assert.equal(frameRoot.getAttribute('data-mode'), 'light');
  assert.equal(innerRoot.getAttribute('data-mode'), 'light');
});

test('状态独立重装不覆盖已经注入的官方场景目录', () => {
  const { doc } = makeCodeDocument();
  const win = makeWindow(doc);
  const { ThemeController } = require('../desktop/theme-controller.cjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-catalog-race-'));
  const controller = new ThemeController({ directory });
  try {
    const scenes = controller.listScenes();
    install(win, { state: DEFAULT_THEME_STATE, scenes });
    const expected = scenes.map(s => s.id);
    assert.deepEqual(win.__xiaokeTheme.scenes.map(s => s.id), expected);
    install(win, { state: { mode: 'dark' }, scenes: [] });
    assert.deepEqual(win.__xiaokeTheme.scenes.map(s => s.id), expected);
    assert.equal(win.__xiaokeTheme.saved.mode, 'dark');
  } finally {
    controller.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
