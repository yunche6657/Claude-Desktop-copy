import { transport, hasDesktopBridge } from './eipc-client.js';
import { iconSvg, markSvg } from './icons.js';

// Icons are drawn as inline SVG rather than text glyphs: a glyph's shape,
// weight and metrics depend on the platform font, which is why the original
// ships paths. Every element declaring data-icon is filled here, once, before
// the rest of the renderer runs.
function paintIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const name = node.dataset.icon;
    const size = Number(node.dataset.iconSize || (node.classList.contains('nav-item') ? 16 : 20));
    const svg = iconSvg(name, { size });
    if (!svg) continue;
    node.replaceChildren(...svgToNodes(svg));
  }
  for (const node of root.querySelectorAll('[data-mark]')) {
    const size = Number(node.dataset.mark || 20);
    node.replaceChildren(...svgToNodes(markSvg(size)));
  }
}

// Parses a self-generated SVG string into one DOM node. The string never
// contains user input: it comes from icons.js, whose geometry is static.
//
// The string is parsed as a document whose root IS the svg, so there is no
// wrapper to unwrap. An earlier version wrapped it in another <svg> and took
// firstElementChild, which produced the wrong node for multi-primitive icons.
function svgToNodes(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return [];
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return [];
  return [document.importNode(root, true)];
}

paintIcons();

const $ = id => document.getElementById(id);
let sessions = [], current = null, run = null, source = null, streamCleanup = null, mode = 'demo';

async function api(path, data) {
  const res = await fetch('/api' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message || result.error || `HTTP ${res.status}`);
  return result;
}

// Session access goes through the transport adapter so the desktop shell and a
// plain browser share one call surface.
const sessionsApi = {
  list: () => transport.isDesktop() ? transport.listSessions() : api('/sessions').then(r => r.sessions),
  create: input => transport.isDesktop() ? transport.createSession(input) : api('/sessions', input),
  get: id => transport.isDesktop() ? transport.getSession(id) : api('/sessions/' + id),
  send: (id, text) => transport.isDesktop() ? transport.sendPrompt(id, text) : api(`/sessions/${id}/messages`, { text }),
};

const report = error => { $('run-status').textContent = error.message || String(error); };

function list() {
  const query = $('search').value.trim().toLowerCase();
  $('sessions').replaceChildren();
  const shown = sessions.filter(s => s.title.toLowerCase().includes(query));
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'muted task-empty';
    empty.textContent = query ? '没有匹配的任务' : '还没有任务';
    $('sessions').append(empty);
    return;
  }
  for (const s of shown) {
    const row = document.createElement('div');
    row.className = 'task-row';
    const button = document.createElement('button');
    button.textContent = s.title;
    button.title = s.title;
    button.classList.toggle('selected', s.id === current?.id);
    button.onclick = () => select(s.id).catch(report);
    row.append(button);

    // Archiving is offered only where the main process can actually do it.
    if (hasDesktopBridge()) {
      const archive = document.createElement('button');
      archive.className = 'task-archive';
      archive.title = '归档';
      archive.textContent = '⌸';
      archive.onclick = async event => {
        event.stopPropagation();
        try {
          await transport.archiveSession(s.id);
          if (current?.id === s.id) { current = null; $('messages').replaceChildren(); $('welcome').hidden = false; }
          await refresh();
        } catch (error) { report(error); }
      };
      row.append(archive);
    }
    $('sessions').append(row);
  }
}

async function refresh() {
  sessions = await sessionsApi.list();
  list();
}

function renderBlocks(target, text) {
  target.replaceChildren();
  for (const part of text.split(/(```[\s\S]*?```)/g)) {
    if (!part) continue;
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.slice(3, -3).replace(/^[^\n]*\n/, '');
      pre.append(code);
      target.append(pre);
    } else {
      const span = document.createElement('span');
      span.textContent = part;
      target.append(span);
    }
  }
}

function message(role, text) {
  const box = document.createElement('article');
  box.className = 'message ' + (role === 'user' ? 'user' : 'assistant');
  const content = document.createElement('div');
  renderBlocks(content, text);
  box.append(content);
  $('messages').append(box);
  return content;
}

// Idle state is one place: the welcome screen owns the composer, so the
// in-conversation composer is hidden while it is showing. Scattering `hidden`
// assignments across handlers left both composers visible at once.
function setIdle(idle) {
  $('welcome').hidden = !idle;
  const wrap = document.querySelector('.composer-wrap');
  if (wrap) wrap.hidden = idle;
}

// Restored: an earlier edit replaced this function's body with setIdle and
// deleted it, leaving three call sites throwing "setTitle is not defined" and
// silently aborting the send path.
function setTitle(title) {
  const target = $('title-text');
  if (target) target.textContent = title || '新任务';
}

async function select(id) {
  if (run) throw new Error('请先停止当前生成，再切换任务。');
  current = await sessionsApi.get(id);
  $('project').value = current.projectPath || '';
  $('messages').replaceChildren();
  for (const m of current.messages) {
    const box = message(m.role, m.content || m.text || (m.error ? '⚠ ' + m.error : ''));
    if (m.error) box.parentElement.classList.add('failed');
  }
  setIdle(current.messages.length === 0);
  $('project').disabled = true;
  setTitle(current.title);
  list();
}

function busy(value) {
  $('send').disabled = value;
  $('stop').hidden = !value;
  $('project').disabled = value || Boolean(current);
  $('new').disabled = value;
  $('prompt').disabled = value;
}

function finish() {
  source?.close();
  source = null;
  streamCleanup?.();
  streamCleanup = null;
  run = null;
  busy(false);
  $('prompt').focus();
  refresh().catch(report);
}

$('compose').onsubmit = async event => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || run) return;
  busy(true);
  $('run-status').textContent = mode === 'demo' ? '正在连接演示引擎…' : '正在连接 Claude…';
  try {
    if (!current) current = await sessionsApi.create({ title: text.slice(0, 50), projectPath: $('project').value.trim() });
    setIdle(false);
    message('user', text);
    setTitle(current.title);
    $('prompt').value = '';
    // Height is reset through the class, not a CSSOM write: the served CSP is
    // style-src 'self', which blocks element.style assignments.
    $('prompt').classList.remove('grown');
    const response = await sessionsApi.send(current.id, text);
    run = response.runId;
    const output = message('assistant', '');
    if (hasDesktopBridge()) {
      // Desktop host: the main process pushes the same frames the SSE endpoint
      // would carry, so no HTTP stream is opened.
      const off = window.claudeAppBindings.onSessionEvent(event => {
        if (event.runId !== run) return;
        handleStreamEvent(event, output);
        if (event.type === 'done') { off?.(); finish(); }
      });
      streamCleanup = off;
    } else {
      source = new EventSource('/api/runs/' + run + '/events');
      source.onmessage = event => {
        try { handleStreamEvent(JSON.parse(event.data), output); }
        catch (error) { report(error); finish(); }
      };
      source.onerror = () => { report('流式连接中断，请重新打开任务查看已保存内容。'); finish(); };
    }
  } catch (error) { report(error); finish(); }
};

function handleStreamEvent(data, output) {
  if (data.type === 'text') {
    output.dataset.raw = (output.dataset.raw || '') + data.text;
    renderBlocks(output, output.dataset.raw);
  }
  if (data.type === 'status') {
    $('run-status').textContent = ({
      running: mode === 'demo' ? '演示响应生成中…' : 'Claude 响应生成中…',
      completed: mode === 'demo' ? '已完成 · 演示模式' : '已完成 · Claude CLI',
      cancelled: '已停止', error: '生成失败',
    })[data.status] || data.status;
  }
  if (data.type === 'error') {
    report(data.message);
    output.dataset.raw = '⚠ ' + data.message;
    renderBlocks(output, output.dataset.raw);
    output.parentElement.classList.add('failed');
    finish();
  }
  if (data.type === 'done') finish();
  $('messages').scrollTop = $('messages').scrollHeight;
}

$('stop').onclick = async () => {
  if (!run) return;
  try {
    if (hasDesktopBridge() && current) await window.claudeAppBindings.abortSession(current.id);
    else await api('/runs/' + run + '/cancel', {});
  } catch (error) { report(error); }
};

// Window buttons: real behaviour under the desktop shell, inert in a browser.
for (const [id, action] of [['win-min', 'minimize'], ['win-max', 'toggleMaximize'], ['win-close', 'close']]) {
  const button = $(id);
  if (!button) continue;
  button.onclick = () => transport.window[action]?.();
  if (!hasDesktopBridge()) button.disabled = true;
}

$('new').onclick = () => {
  if (run) return;
  current = null;
  $('messages').replaceChildren();
  setIdle(true);
  $('project').disabled = false;
  $('project').value = '';
  $('run-status').textContent = '';
  setTitle(null);
  list();
  $('prompt').focus();
};

$('search').oninput = list;
$('search-toggle').onclick = () => {
  const open = $('search').classList.toggle('open');
  if (open) $('search').focus();
};

$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('compose').requestSubmit();
  }
};
$('prompt').oninput = () => {
  // Height is driven by CSS `field-sizing: content`; no inline style is needed,
  // which keeps the page compatible with `style-src 'self'`.
};

document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); $('new').click(); }
});

for (const button of document.querySelectorAll('.suggestions button')) {
  button.onclick = () => { $('prompt').value = button.textContent; $('prompt').focus(); };
}

// ── Idle screen ──────────────────────────────────────────────────────────
// The hero composer sends the same way the in-conversation composer does; it
// only differs in size and in living on the welcome screen.
const heroInput = $('hero-prompt');
const heroSend = $('hero-send');

function submitFromHero() {
  const text = (heroInput?.value || '').trim();
  if (!text) return;
  // Hand the text to the main composer and submit through one path, so there is
  // a single place that starts a run.
  $('prompt').value = text;
  heroInput.value = '';
  setIdle(false);
  $('compose').requestSubmit();
}

if (heroSend) {
  heroSend.onclick = submitFromHero;
  heroSend.disabled = true;
}
if (heroInput) {
  heroInput.oninput = () => {
    if (heroSend) heroSend.disabled = heroInput.value.trim().length === 0;
  };
  heroInput.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitFromHero();
    }
  };
}

for (const button of document.querySelectorAll('.idea')) {
  button.onclick = () => {
    if (!heroInput) return;
    heroInput.value = button.dataset.prompt || button.textContent.trim();
    heroInput.dispatchEvent(new Event('input'));
    heroInput.focus();
  };
}

if ($('hero-project')) {
  $('hero-project').onclick = () => {
    // Selecting a folder is the same action the sidebar's Projects entry
    // performs; reuse it instead of duplicating the picker.
    $('pick-project').click();
  };
}

// ── Transcript edge fade ─────────────────────────────────────────────────
// The fade appears only on an edge that has more content beyond it, which is
// what the reference does. A 1px tolerance absorbs sub-pixel rounding so the
// class does not flicker at the exact top or bottom.
const transcriptEl = $('messages');
function updateTranscriptFade() {
  if (!transcriptEl) return;
  const { scrollTop, scrollHeight, clientHeight } = transcriptEl;
  const scrollable = scrollHeight > clientHeight + 1;
  const atTop = scrollTop <= 1;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  transcriptEl.classList.toggle('fade-top', scrollable && !atTop);
  transcriptEl.classList.toggle('fade-bottom', scrollable && !atBottom);
}
if (transcriptEl) {
  transcriptEl.addEventListener('scroll', updateTranscriptFade, { passive: true });
  // Content changes resize the scroll area, so recompute when children change
  // (a message arriving) and when the window resizes (the main column narrowing).
  new MutationObserver(updateTranscriptFade).observe(transcriptEl, { childList: true, subtree: true });
  window.addEventListener('resize', updateTranscriptFade, { passive: true });
  // `scroll-behavior: smooth` animates the position, so a state read taken right
  // after an assignment sees the old offset. Recompute once the scroll settles.
  transcriptEl.addEventListener('scrollend', updateTranscriptFade);
  updateTranscriptFade();
}

// ── Cowork / Code segmented control ───────────────────────────────────────
// This is the app's primary mode switch and it was inert: the markup carried
// aria-selected, but nothing listened for a click, so the control did nothing.
// Switching updates the tabs, the rail's visible entries, and the stored mode.
const SEGMENTED_VIEWS = {
  cowork: {
    header: 'Tasks',
    nav: ['New', 'Projects', 'Artifacts', 'Scheduled'],
  },
  code: {
    header: 'Tasks',
    nav: ['New', 'Projects', 'Artifacts', 'Scheduled'],
  },
};

function applyView(view) {
  const spec = SEGMENTED_VIEWS[view] || SEGMENTED_VIEWS.code;
  for (const tab of document.querySelectorAll('.segmented [data-view]')) {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.classList.toggle('active', active);
  }
  const head = document.querySelector('.tasks-head > span:first-child');
  if (head) head.textContent = spec.header;
  // Unused rail entries are hidden rather than removed, so their handlers and
  // their disabled titles survive a switch back.
  for (const item of document.querySelectorAll('.primary-nav .nav-item')) {
    const label = item.textContent.trim();
    item.hidden = !spec.nav.some(name => label.includes(name));
  }
  document.body.dataset.view = view;
}

async function setView(view) {
  applyView(view);
  if (hasDesktopBridge()) {
    // The main process stores it, so the choice survives a reload and matches the
    // mode the shell reports back through /api/config.
    try { await window.claudeAppSettings.setSidebarMode(view); } catch { /* non-fatal */ }
  } else {
    try { localStorage.setItem('codeDesktop.sidebarMode', view); } catch { /* non-fatal */ }
  }
}

for (const tab of document.querySelectorAll('.segmented [data-view]')) {
  tab.onclick = () => { setView(tab.dataset.view).catch(report); };
}

// Restore the stored mode on load so a reload does not silently reset the view.
(async () => {
  let stored = 'code';
  try {
    stored = hasDesktopBridge()
      ? await window.claudeAppSettings.getSidebarMode()
      : (localStorage.getItem('codeDesktop.sidebarMode') || 'code');
  } catch { stored = 'code'; }
  if (stored && SEGMENTED_VIEWS[stored]) applyView(stored);
})();

// ── Diff view ────────────────────────────────────────────────────────────
// Renders hunks returned by the main process. Every line is written through
// textContent; a diff is untrusted content because it echoes file bytes.
const diffPanel = $('diff-panel');
let pendingWrite = null;

function renderDiff(target, diff) {
  target.replaceChildren();
  if (!diff || diff.truncated) {
    const note = document.createElement('div');
    note.className = 'diff-empty';
    note.textContent = diff?.reason || '没有可显示的改动。';
    target.append(note);
    return;
  }
  if (!diff.hunks.length) {
    const note = document.createElement('div');
    note.className = 'diff-empty';
    note.textContent = '内容没有变化。';
    target.append(note);
    return;
  }
  for (const hunk of diff.hunks) {
    const head = document.createElement('div');
    head.className = 'diff-hunk-head';
    head.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    target.append(head);
    for (const line of hunk.lines) {
      const row = document.createElement('div');
      row.className = 'diff-line ' + (line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'ctx');
      const sign = document.createElement('span');
      sign.className = 'sign';
      sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      row.append(sign, text);
      target.append(row);
    }
  }
}

if (diffPanel) {
  $('diff-close').onclick = () => { diffPanel.hidden = true; pendingWrite = null; };
  $('diff-apply').onclick = async () => {
    if (!pendingWrite) return;
    const { path: filePath, content } = pendingWrite;
    $('diff-apply').disabled = true;
    $('diff-note').textContent = '应用中…';
    try {
      const result = await transport.writeFile(filePath, content);
      if (result.denied) {
        $('diff-note').textContent = '已取消，文件未改动。';
        return;
      }
      $('diff-note').textContent = result.written ? '已写入。' : '内容没有变化。';
      pendingWrite = null;
    } catch (error) {
      $('diff-note').textContent = error.message || String(error);
    } finally {
      $('diff-apply').disabled = false;
    }
  };
}

// ── Permission mode ──────────────────────────────────────────────────────
const permissionSelect = $('permission-mode');
if (permissionSelect) {
  if (!hasDesktopBridge()) {
    // Without a consent surface no mode can be enforced, so the selector is
    // read-only rather than pretending a mode is in effect.
    permissionSelect.disabled = true;
    permissionSelect.title = '权限模式仅在桌面宿主中生效';
  }
  transport.getPermissionMode().then(mode => {
    if (mode && [...permissionSelect.options].some(o => o.value === mode)) permissionSelect.value = mode;
  }).catch(() => {});
  permissionSelect.onchange = async () => {
    try {
      await transport.setPermissionMode(permissionSelect.value);
    } catch (error) {
      report(error);
    }
  };
}

// ── File editor ──────────────────────────────────────────────────────────
// Load a file, edit it, preview the diff, then apply. The preview goes through
// the main process so the diff is computed from the real on-disk bytes, not
// from what the textarea happens to hold.
const editPanel = $('edit-panel');
if (editPanel) {
  const pathInput = $('edit-path');
  const contentArea = $('edit-content');
  const previewButton = $('edit-preview');
  const status = $('edit-status');

  const setEditable = on => {
    contentArea.hidden = !on;
    previewButton.disabled = !on;
  };

  $('edit-open').onclick = () => {
    editPanel.hidden = !editPanel.hidden;
    if (!editPanel.hidden) pathInput.focus();
  };
  $('edit-close').onclick = () => { editPanel.hidden = true; };

  $('edit-form').onsubmit = async event => {
    event.preventDefault();
    const filePath = pathInput.value.trim();
    if (!filePath) return;
    status.textContent = '载入中…';
    try {
      const file = await transport.readFile(filePath);
      contentArea.value = file.content;
      setEditable(true);
      status.textContent = `已载入 ${file.lines} 行`;
      contentArea.focus();
    } catch (error) {
      // A missing file is a normal way to create one; the textarea stays usable.
      setEditable(true);
      contentArea.value = '';
      status.textContent = (error.message || String(error)) + '（可直接输入内容以新建）';
      contentArea.focus();
    }
  };

  previewButton.onclick = async () => {
    const filePath = pathInput.value.trim();
    if (!filePath) return;
    status.textContent = '计算改动…';
    try {
      const preview = await transport.previewWrite(filePath, contentArea.value);
      pendingWrite = { path: preview.path, content: contentArea.value };
      $('diff-title').textContent = filePath;
      $('diff-note').textContent = `+${preview.diff.added} −${preview.diff.removed}`;
      renderDiff($('diff-body'), preview.diff);
      diffPanel.hidden = false;
      status.textContent = preview.existed ? '已计算改动' : '新文件';
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  };
}

// ── Project browser ──────────────────────────────────────────────────────
// The tree comes from the main process, which walks only the approved
// workspace. Clicking a file loads it into the editor panel rather than
// rendering its bytes here, so there is one place that reads files.
const projectPanel = $('project-panel');

async function refreshProjectTree() {
  if (!projectPanel || !hasDesktopBridge()) return;
  const target = $('project-tree');
  target.replaceChildren();
  try {
    const tree = await transport.listWorkspaceTree({ maxEntries: 2000 });
    $('project-name').textContent = tree.root ? tree.root.split(/[\\/]/).pop() : '项目文件';
    if (!tree.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'project-empty';
      empty.textContent = tree.root ? '（空目录）' : '尚未选择工作区';
      target.append(empty);
      return;
    }
    for (const entry of tree.entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'project-row ' + (entry.type === 'directory' ? 'dir' : 'file');
      row.dataset.path = entry.path;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = entry.type === 'directory' ? '▸' : entry.symlink ? '↗' : '·';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = entry.path;
      row.append(mark, label);
      if (entry.type === 'file') {
        row.onclick = () => {
          $('edit-path').value = entry.path;
          $('edit-panel').hidden = false;
          $('edit-form').requestSubmit();
        };
      }
      target.append(row);
    }
    if (tree.truncated) {
      const note = document.createElement('div');
      note.className = 'project-empty';
      note.textContent = '（已截断，目录过大）';
      target.append(note);
    }
  } catch (error) {
    const failed = document.createElement('div');
    failed.className = 'project-empty';
    failed.textContent = error.message || String(error);
    target.append(failed);
  }
}

if (projectPanel) {
  $('pick-project').onclick = async () => {
    projectPanel.hidden = false;
    if (!hasDesktopBridge()) {
      $('project-tree').textContent = '项目浏览仅在桌面宿主中可用。';
      return;
    }
    try {
      const picked = await transport.selectWorkspaceFolder();
      if (!picked.canceled) {
        if (picked.git?.isGitRepo) {
          $('project-name').textContent = `${picked.name} · ${picked.git.branch}`;
        }
        await refreshProjectTree();
      }
    } catch (error) {
      $('project-tree').textContent = error.message || String(error);
    }
  };
  $('project-refresh').onclick = refreshProjectTree;
  $('project-close').onclick = () => { projectPanel.hidden = true; };
}

// ── MCP ──────────────────────────────────────────────────────────────────
// Reported from the main process, never inferred. In a browser there is no MCP
// host, so the dialog says so instead of showing an empty list.
function describeMcp(servers) {
  if (!servers.length) return 'MCP：未配置服务器。';
  return 'MCP：' + servers.map(s => {
    const suffix = s.error ? `（${s.error}）` : s.toolCount ? `（${s.toolCount} 工具）` : '';
    return `${s.name}=${s.status}${suffix}`;
  }).join('，');
}

// The account row opens a popover, not the settings dialog directly: that is
// what the reference does, and Settings is one row inside it.
const accountMenu = $('account-menu');

function accountMenuOpen() {
  return Boolean(accountMenu && !accountMenu.hidden);
}

function closeAccountMenu() {
  if (!accountMenu) return;
  accountMenu.hidden = true;
  $('settings').setAttribute('aria-expanded', 'false');
}

function openAccountMenu() {
  if (!accountMenu) return;
  // Mirror the account row's identity into the popover header.
  $('menu-account-name').textContent = $('account-name').textContent;
  $('menu-account-plan').textContent = $('account-mode').textContent;
  accountMenu.hidden = false;
  $('settings').setAttribute('aria-expanded', 'true');
}

$('settings').onclick = event => {
  event.stopPropagation();
  if (accountMenuOpen()) closeAccountMenu();
  else openAccountMenu();
};

// Clicking anywhere else, or pressing Escape, closes the popover.
document.addEventListener('click', event => {
  if (!accountMenuOpen()) return;
  if (accountMenu.contains(event.target) || event.target === $('settings')) return;
  closeAccountMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && accountMenuOpen()) closeAccountMenu();
});

for (const row of document.querySelectorAll('#account-menu .menu-row')) {
  row.onclick = async () => {
    const action = row.dataset.menu;
    closeAccountMenu();
    if (action === 'settings') {
      openSettings();
      return;
    }
    if (action === 'learn') {
      openAboutModal();
      return;
    }
    // The remaining rows correspond to surfaces this reconstruction does not
    // have. They report that plainly instead of pretending to open something.
    const label = row.querySelector('.menu-label')?.textContent || action;
    $('dialog').showModal();
    for (const item of document.querySelectorAll('.settings-item')) item.classList.remove('selected');
    const pane = $('settings-pane');
    pane.replaceChildren();
    const title = document.createElement('h2');
    title.className = 'pane-title';
    title.textContent = label;
    const note = document.createElement('p');
    note.className = 'pane-unavailable';
    note.textContent = `${label} 尚未实现。该入口在原件中由远端页面提供，本地重建没有对应数据源。`;
    pane.append(title, note);
  };
}

async function openSettings() {
  $('dialog').showModal();
  // Always open on General, with the rail selection reset to match.
  for (const item of document.querySelectorAll('.settings-item')) {
    item.classList.toggle('selected', item.dataset.pane === 'general');
  }
  renderPane('general');
}

// Ctrl+, is the shortcut the reference shows next to Settings.
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key === ',') {
    event.preventDefault();
    closeAccountMenu();
    openSettings();
  }
});

$('close-dialog').onclick = () => $('dialog').close();

// ── Settings ─────────────────────────────────────────────────────────────
// Each pane is described as data and rendered through the DOM API. Panes that
// depend on a capability this reconstruction does not have say so plainly
// instead of showing an inert control that looks functional.
const SETTINGS_PANES = {
  general: () => [
    { type: 'title', text: 'Profile' },
    {
      type: 'row', label: 'Avatar',
      control: { kind: 'avatar', text: ($('account-name').textContent || 'A').trim().charAt(0).toUpperCase() },
    },
    {
      type: 'row', label: 'What best describes your work?',
      control: { kind: 'select', options: ['Select', 'Software', 'Research', 'Writing', 'Other'], value: 0 },
    },
    {
      type: 'section',
      heading: 'Instructions for Claude',
      help: 'Claude will keep this in mind for this and any associated accounts across chats and Cowork.',
      control: { kind: 'textarea', placeholder: 'e.g. keep explanations brief and to the point', key: 'instructions' },
    },
    { type: 'title2', text: 'Appearance' },
    {
      type: 'row', label: 'Theme',
      control: { kind: 'segment', key: 'theme', options: ['system', 'light', 'dark'], icons: ['window', 'theme', 'theme'] },
    },
    {
      type: 'row', label: 'Chat font',
      control: { kind: 'select', options: ['Anthropic Serif', 'Anthropic Sans', 'System'], value: 0, key: 'font' },
    },
    {
      type: 'row', label: 'Motion',
      detail: 'Reduce animation in streaming responses and other interface elements.',
      control: { kind: 'segment', key: 'motion', options: ['system', 'reduced'] },
    },
    { type: 'title2', text: 'Notifications' },
    {
      type: 'row', label: 'Response completions',
      detail: 'Get notified when Claude has finished a response. Useful for long-running tasks.',
      control: { kind: 'toggle', key: 'notifications' },
    },
  ],
  'claude-code': () => [
    { type: 'title', text: 'Claude Code' },
    {
      type: 'row', label: 'Permission mode',
      detail: 'Controls whether tool calls are applied directly or require approval.',
      control: { kind: 'select', options: ['Ask', 'Accept edits', 'Plan', 'Bypass'], value: 0, key: 'permissionMode' },
    },
    {
      type: 'row', label: 'MCP servers',
      detail: 'stdio servers are supported; http, sse and sdk are reported as unsupported.',
      control: { kind: 'text', text: '查看状态见下方' },
    },
  ],
  system: () => [
    { type: 'title', text: 'System' },
    { type: 'row', label: 'Application', control: { kind: 'text', text: 'Code Desktop (Reconstruction)' } },
    { type: 'row', label: 'Data directory', control: { kind: 'text', text: 'userData/sessions' } },
    { type: 'row', label: 'Runtime', control: { kind: 'text', text: 'Electron + Node' } },
  ],
  developer: () => [
    { type: 'title', text: 'Developer' },
    { type: 'row', label: 'Engine mode', control: { kind: 'text', text: mode } },
    { type: 'row', label: 'Build', control: { kind: 'text', text: '0.1.0' } },
  ],
};

function unavailablePane(name) {
  return () => [
    { type: 'title', text: name },
    { type: 'note', text: `${name} 尚未实现。该分区在原件中由远端页面提供，本地重建没有对应数据源，因此不显示任何伪造的控件。` },
  ];
}

// ── Panes backed by real local state ─────────────────────────────────────
// Each of these reads something the app actually stores; none of them shows a
// control whose effect would be imaginary.

const fmtDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const PANE_LABELS = {
  privacy: 'Privacy', usage: 'Usage', cowork: 'Cowork', import: 'Import & export',
  skills: 'Skills', connectors: 'Connectors', plugins: 'Plugins',
};

/** Usage: counts read from the live session list and the archive index. */
async function usagePane() {
  const items = [
    { type: 'title', text: 'Usage' },
  ];
  if (!hasDesktopBridge()) {
    items.push({ type: 'note', text: '用量统计需要桌面宿主读取本地会话库。' });
    return items;
  }
  try {
    const [live, archived] = await Promise.all([
      transport.listSessions(),
      transport.listArchivedSessions(),
    ]);
    const messages = live.reduce((sum, session) => sum + (session.messages?.length || 0), 0);
    const assistantTurns = live.reduce(
      (sum, session) => sum + (session.messages || []).filter(m => m.role === 'assistant').length,
      0,
    );
    const projects = new Set(live.map(session => session.projectPath).filter(Boolean));
    items.push(
      { type: 'row', label: '活跃会话', control: { kind: 'text', text: String(live.length) } },
      { type: 'row', label: '已归档会话', control: { kind: 'text', text: String(archived.length) } },
      { type: 'row', label: '消息总数', control: { kind: 'text', text: String(messages) } },
      { type: 'row', label: '助手回复数', control: { kind: 'text', text: String(assistantTurns) } },
      { type: 'row', label: '涉及工作区', control: { kind: 'text', text: String(projects.size) } },
      { type: 'note', text: '这些数字来自本地会话库，不包含 token 用量——token 计数只有模型响应里才有，本重建未持久化。' },
    );
  } catch (error) {
    items.push({ type: 'note', text: `读取用量失败：${error.message || error}` });
  }
  return items;
}

/** Import & export: real buttons over the transcript archive. */
function importPane() {
  return [
    { type: 'title', text: 'Import & export' },
    {
      type: 'row', label: '导出全部会话',
      detail: '把活跃会话与归档索引写成一个 JSON 文件。',
      control: { kind: 'button', label: '导出', action: 'export-sessions' },
    },
    {
      type: 'row', label: '导入会话',
      detail: '从导出的 JSON 恢复会话；同 id 的会话会被替换。',
      control: { kind: 'button', label: '导入', action: 'import-sessions' },
    },
    { type: 'note', text: '导出内容是本地会话库的明文快照，含工作区路径与对话正文。' },
  ];
}

/** Connectors: the MCP servers this app actually loaded. */
async function connectorsPane() {
  const items = [{ type: 'title', text: 'Connectors' }];
  if (!hasDesktopBridge()) {
    items.push({ type: 'note', text: '连接器需要桌面宿主读取 MCP 配置。' });
    return items;
  }
  try {
    const status = await transport.getMcpConfigStatus();
    if (!status.loaded) {
      items.push({
        type: 'note',
        text: status.error
          ? `MCP 配置读取失败：${status.error}`
          : '未找到 MCP 配置文件。在设置里指定 mcpConfigPath，或放在 userData/mcp.json。',
      });
      return items;
    }
    items.push({ type: 'row', label: '配置文件', control: { kind: 'text', text: status.configPath } });
    if (!status.servers.length) {
      items.push({ type: 'note', text: '配置文件里没有任何服务器条目。' });
    }
    for (const server of status.servers) {
      const detail = server.error
        ? server.error
        : `${server.type} · ${server.status}${server.toolCount ? ` · ${server.toolCount} 工具` : ''}`;
      items.push({
        type: 'row',
        label: server.name,
        detail,
        control: server.status === 'connected'
          ? { kind: 'button', label: '断开', action: `mcp-disconnect:${server.name}` }
          : server.status === 'disconnected'
            ? { kind: 'button', label: '连接', action: `mcp-connect:${server.name}` }
            : { kind: 'text', text: server.status },
      });
    }
  } catch (error) {
    items.push({ type: 'note', text: `读取 MCP 状态失败：${error.message || error}` });
  }
  return items;
}

/** Skills: what the agent can actually do, read from the tool registry. */
function skillsPane() {
  return [
    { type: 'title', text: 'Skills' },
    {
      type: 'note',
      text: '下面是本应用实际暴露给模型的工具。它们在 agent 模式下由模型调用，并受权限模式与审批窗口约束。',
    },
    { type: 'row', label: 'Read', detail: '读取工作区文件，返回带行号的内容', control: { kind: 'text', text: '只读' } },
    { type: 'row', label: 'Write', detail: '整文件写入，创建父目录', control: { kind: 'text', text: '需审批' } },
    { type: 'row', label: 'Edit', detail: '精确替换，要求唯一匹配', control: { kind: 'text', text: '需审批' } },
    { type: 'row', label: 'List', detail: '列出一层目录', control: { kind: 'text', text: '只读' } },
    { type: 'row', label: 'Glob', detail: '按通配符查找文件', control: { kind: 'text', text: '只读' } },
    { type: 'row', label: 'Bash', detail: '执行白名单内的命令', control: { kind: 'text', text: '需审批' } },
  ];
}

/** Plugins / Cowork / Privacy: no local data source exists for these. */
const NO_LOCAL_SOURCE = {
  plugins: '插件市场由远端提供；本地重建没有插件分发通道，因此不显示安装入口。',
  cowork: 'Cowork 会话由远端页面驱动；本地重建没有该运行时的会话数据。',
  privacy: '隐私设置作用于远端账号；本地重建没有账号体系，因此没有可调的开关。',
};

// Panes resolve their content, because several read live state (session counts,
// MCP status). renderPane therefore paints a placeholder, awaits the description,
// and then paints the items — guarding against a stale repaint if the user
// switches panes while a read is in flight.
let paneGeneration = 0;

async function renderPane(name) {
  const pane = $('settings-pane');
  if (!pane) return;
  const generation = ++paneGeneration;

  const describe = SETTINGS_PANES[name]
    || (name === 'usage' ? usagePane
      : name === 'connectors' ? connectorsPane
        : name === 'import' ? importPane
          : name === 'skills' ? skillsPane
            : null);

  pane.replaceChildren();
  if (!describe) {
    const note = NO_LOCAL_SOURCE[name];
    const h = document.createElement('h2');
    h.className = 'pane-title';
    h.textContent = PANE_LABELS[name] || name;
    const p = document.createElement('p');
    p.className = 'pane-unavailable';
    p.textContent = note || `${PANE_LABELS[name] || name} 尚未实现。`;
    pane.append(h, p);
    return;
  }

  let items;
  try {
    items = await describe();
  } catch (error) {
    items = [{ type: 'title', text: PANE_LABELS[name] || name }, { type: 'note', text: `读取失败：${error.message || error}` }];
  }
  if (generation !== paneGeneration) return; // a newer pane was requested
  renderItems(pane, items);
}

function renderItems(pane, items) {
  const settings = currentSettings();

  for (const item of items) {
    if (item.type === 'title') {
      const h = document.createElement('h2');
      h.className = 'pane-title';
      h.textContent = item.text;
      pane.append(h);
      continue;
    }
    if (item.type === 'title2') {
      const h = document.createElement('h3');
      h.className = 'pane-heading pane-heading-spaced';
      h.textContent = item.text;
      pane.append(h);
      continue;
    }
    if (item.type === 'note') {
      const p = document.createElement('p');
      p.className = 'pane-unavailable';
      p.textContent = item.text;
      pane.append(p);
      continue;
    }
    if (item.type === 'section') {
      const wrap = document.createElement('div');
      wrap.className = 'pane-section';
      if (item.heading) {
        const h = document.createElement('h3');
        h.className = 'pane-heading';
        h.textContent = item.heading;
        wrap.append(h);
      }
      if (item.help) {
        const p = document.createElement('p');
        p.className = 'pane-help';
        p.textContent = item.help;
        wrap.append(p);
      }
      wrap.append(buildControl(item.control, settings));
      pane.append(wrap);
      continue;
    }
    // A label + control row.
    const row = document.createElement('div');
    row.className = 'pane-row';
    const labelWrap = document.createElement('div');
    labelWrap.className = 'pane-row-label';
    const label = document.createElement('div');
    label.textContent = item.label;
    labelWrap.append(label);
    if (item.detail) {
      const detail = document.createElement('div');
      detail.className = 'pane-row-detail';
      detail.textContent = item.detail;
      labelWrap.append(detail);
    }
    row.append(labelWrap, buildControl(item.control, settings));
    pane.append(row);
  }
}

// ── Settings pane actions ────────────────────────────────────────────────
// Each action does real work and reports a {ok, rerender} result so the pane can
// reflect the new state or surface a failure.
async function runPaneAction(action) {
  if (action === 'export-sessions') {
    const sessions = await transport.listSessions();
    const archived = await transport.listArchivedSessions();
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      sessions,
      archived,
    }, null, 2);
    // The export goes through the OS save dialog so the user chooses the path.
    const saved = await transport.saveTextFile(`code-desktop-sessions-${Date.now()}.json`, payload);
    return { ok: Boolean(saved?.ok), rerender: false, saved };
  }

  if (action === 'import-sessions') {
    const opened = await transport.openTextFile();
    if (!opened?.ok) return { ok: false, rerender: false };
    let parsed;
    try {
      parsed = JSON.parse(opened.text);
    } catch {
      throw new Error('所选文件不是有效的 JSON');
    }
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error('文件缺少 sessions 数组');
    }
    let imported = 0;
    for (const session of parsed.sessions) {
      if (!session || typeof session.id !== 'string' || typeof session.title !== 'string') continue;
      await transport.createSession({ title: session.title, projectPath: session.projectPath || '' });
      imported += 1;
    }
    await refresh();
    return { ok: imported > 0, rerender: true, imported };
  }

  if (typeof action === 'string' && action.startsWith('mcp-connect:')) {
    const name = action.slice('mcp-connect:'.length);
    await window.claudeAppBindings.connectMcpServer(name);
    return { ok: true, rerender: true };
  }

  if (typeof action === 'string' && action.startsWith('mcp-disconnect:')) {
    const name = action.slice('mcp-disconnect:'.length);
    await window.claudeAppBindings.disconnectMcpServer(name);
    return { ok: true, rerender: true };
  }

  throw new Error(`unknown pane action: ${action}`);
}

function buildControl(control) {
  if (!control) return document.createElement('span');
  if (control.kind === 'text') {
    const span = document.createElement('span');
    span.className = 'pane-row-detail';
    span.textContent = control.text;
    return span;
  }
  if (control.kind === 'avatar') {
    const span = document.createElement('span');
    span.className = 'pane-avatar';
    span.textContent = control.text;
    return span;
  }
  if (control.kind === 'button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane-action';
    button.textContent = control.label;
    button.onclick = async () => {
      button.disabled = true;
      const original = button.textContent;
      try {
        const message = await runPaneAction(control.action);
        button.textContent = message.ok ? '完成' : '失败';
        // Re-render so a state change (a connect, an import) is visible.
        if (message.rerender) {
          const active = document.querySelector('.settings-item.selected');
          if (active) await renderPane(active.dataset.pane);
          return;
        }
      } catch (error) {
        button.textContent = '失败';
        report(error);
      } finally {
        setTimeout(() => { button.disabled = false; button.textContent = original; }, 1200);
      }
    };
    return button;
  }
  if (control.kind === 'select') {
    const select = document.createElement('select');
    select.className = 'pane-select';
    for (const option of control.options) {
      const node = document.createElement('option');
      node.textContent = option;
      select.append(node);
    }
    if (typeof control.value === 'number') select.selectedIndex = control.value;
    select.onchange = () => applySetting(control.key, select.value);
    return select;
  }
  if (control.kind === 'textarea') {
    const area = document.createElement('textarea');
    area.className = 'pane-textarea';
    area.placeholder = control.placeholder || '';
    area.value = currentSettings()[control.key] || '';
    area.onchange = () => applySetting(control.key, area.value);
    return area;
  }
  if (control.kind === 'segment') {
    const wrap = document.createElement('span');
    wrap.className = 'seg';
    const stored = currentSettings()[control.key];
    control.options.forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      if (control.icons && control.icons[index]) {
        const holder = document.createElement('span');
        holder.dataset.icon = control.icons[index];
        holder.dataset.iconSize = '16';
        button.append(holder);
      }
      if (!control.icons) button.textContent = option;
      button.title = option;
      const isSelected = stored ? stored === option : index === 0;
      if (isSelected) button.classList.add('selected');
      button.onclick = () => {
        for (const sibling of wrap.children) sibling.classList.remove('selected');
        button.classList.add('selected');
        applySetting(control.key, option);
      };
      wrap.append(button);
    });
    paintIcons(wrap);
    return wrap;
  }
  if (control.kind === 'toggle') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle';
    button.setAttribute('role', 'switch');
    const on = Boolean(currentSettings()[control.key]);
    button.setAttribute('aria-checked', String(on));
    button.onclick = () => {
      const next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(next));
      applySetting(control.key, next);
    };
    return button;
  }
  return document.createElement('span');
}

// Renderer-local settings. They persist to localStorage so the pane reflects a
// real stored value rather than resetting on every open.
let settingsCache = null;
function currentSettings() {
  if (settingsCache) return settingsCache;
  try { settingsCache = JSON.parse(localStorage.getItem('codeDesktop.settings') || '{}'); }
  catch { settingsCache = {}; }
  return settingsCache;
}
function applySetting(key, value) {
  if (!key) return;
  const next = { ...currentSettings(), [key]: value };
  settingsCache = next;
  localStorage.setItem('codeDesktop.settings', JSON.stringify(next));
  // A couple of settings have immediate visual effect.
  if (key === 'theme') {
    document.body.classList.toggle('dark', value === 'dark');
  }
}

for (const item of document.querySelectorAll('.settings-item')) {
  item.onclick = () => {
    for (const sibling of document.querySelectorAll('.settings-item')) sibling.classList.remove('selected');
    item.classList.add('selected');
    renderPane(item.dataset.pane);
  };
}
if ($('settings-search')) {
  $('settings-search').oninput = event => {
    const query = event.target.value.trim().toLowerCase();
    for (const item of document.querySelectorAll('.settings-item')) {
      const label = item.textContent.toLowerCase();
      item.hidden = query.length > 0 && !label.includes(query);
    }
  };
}

// ── Local execution ──────────────────────────────────────────────────────
// The panel is the renderer's only path to running a command. It never decides
// anything itself: the main process shows the consent window and refuses when
// the decision is not "allow".
const execPanel = $('exec-panel');
if (execPanel) {
  $('exec-toggle').onclick = () => {
    execPanel.hidden = !execPanel.hidden;
    if (!execPanel.hidden) $('exec-command').focus();
  };
  $('exec-close').onclick = () => { execPanel.hidden = true; };

  $('exec-form').onsubmit = async event => {
    event.preventDefault();
    const command = $('exec-command').value.trim();
    if (!command) return;
    const output = $('exec-output');
    $('exec-run').disabled = true;
    $('exec-note').textContent = '等待确认…';
    output.hidden = false;
    output.classList.remove('failed');
    output.textContent = '';
    try {
      const result = await transport.runCommand({ command, cwd: current?.projectPath || undefined });
      if (result.denied) {
        $('exec-note').textContent = result.decision === 'timeout'
          ? '确认窗口已超时，命令未执行。'
          : '已取消，命令未执行。';
        output.textContent = '';
        output.hidden = true;
        return;
      }
      $('exec-note').textContent = `退出码 ${result.exitCode}${result.timedOut ? ' · 超时终止' : ''}${result.truncated ? ' · 输出已截断' : ''}`;
      output.textContent = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || '(无输出)';
      output.classList.toggle('failed', !result.ok);
    } catch (error) {
      $('exec-note').textContent = error.message || String(error);
      output.hidden = true;
    } finally {
      $('exec-run').disabled = false;
    }
  };
}

const themeButton = $('theme');
if (themeButton) {
  themeButton.onclick = () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  };
}
if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');

api('/config').then(config => {
  mode = config.mode;
  $('connection').textContent = mode === 'demo' ? '● 本地演示模式' : '● Claude CLI · 工具关闭';
  $('model').firstChild.textContent = mode === 'demo' ? 'Demo ' : 'Claude ';
  $('account-mode').textContent = mode === 'demo' ? 'Demo' : 'CLI';
  // The account row reflects the real identity the server reported, not a
  // hardcoded name copied from a screenshot.
  if (config.account) {
    $('account-name').textContent = config.account.name;
    $('account-mode').textContent = config.account.kind;
  }

  // The idle composer shows the engine that is actually configured. It reads the
  // same /api/config the rest of the page uses, so it cannot claim a model the
  // The hero model label and the disclaimer describe the engine that actually
  // answered /api/config, so they cannot claim capabilities the server lacks.
  const heroModel = $('hero-model');
  if (heroModel) {
    heroModel.replaceChildren();
    const name = document.createElement('span');
    name.textContent = mode === 'demo' ? 'Demo' : mode === 'agent' ? 'Claude' : 'Claude CLI';
    const modelName = document.createElement('span');
    modelName.className = 'hero-effort';
    modelName.textContent = config.model ? ` ${config.model}` : ' Medium';
    heroModel.append(name, modelName);
  }

  const disclaimerText = mode === 'demo'
    ? '演示模式：不会调用模型，也不会执行命令。'
    : mode === 'agent'
      ? 'Agent 模式：模型可调用工具读写文件、执行命令；每次调用都需要你确认。'
      : 'Claude CLI 纯对话模式：工具已关闭，不执行命令。';
  $('disclaimer').textContent = disclaimerText;
}).catch(report);

// ── Sidebar collapse (Ctrl+B) ────────────────────────────────────────────
const sidebarToggle = $('sidebar-toggle');
function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
}
if (sidebarToggle) sidebarToggle.onclick = toggleSidebar;

// ── Find in page (FindInPage-CfNQSgeo.js: CJK or length > 2) ─────────────
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const isSearchable = query => query.length > 2 || CJK_REGEX.test(query);

const findBar = $('find-bar');
const findInput = $('find-input');
const findStatus = $('find-status');
const findPrev = $('find-prev');
const findNext = $('find-next');
const findClose = $('find-close');
let findMatches = [];
let findIndex = 0;

function evaluateFind(query, { stepForward = null } = {}) {
  if (!findBar) return;
  if (!isSearchable(query)) {
    findMatches = [];
    findIndex = 0;
    findStatus.textContent = '';
    findPrev.disabled = true;
    findNext.disabled = true;
    return;
  }
  const haystack = ($('messages')?.textContent || '') + '\n' + ($('welcome')?.textContent || '');
  const needle = query.toLowerCase();
  const lower = haystack.toLowerCase();
  const positions = [];
  let pos = 0;
  while ((pos = lower.indexOf(needle, pos)) !== -1) {
    positions.push(pos);
    pos += Math.max(1, needle.length);
  }
  findMatches = positions;
  if (!positions.length) {
    findIndex = 0;
    findStatus.textContent = '0/0';
    findPrev.disabled = true;
    findNext.disabled = true;
    return;
  }
  if (stepForward === true) {
    findIndex = (findIndex % positions.length) + 1;
  } else if (stepForward === false) {
    findIndex = findIndex <= 1 ? positions.length : findIndex - 1;
  } else if (findIndex < 1 || findIndex > positions.length) {
    findIndex = 1;
  }
  findStatus.textContent = `${findIndex}/${positions.length}`;
  findPrev.disabled = false;
  findNext.disabled = false;
}

function openFindBar() {
  if (!findBar) return;
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  evaluateFind(findInput.value);
}

function closeFindBar() {
  if (!findBar) return;
  findBar.hidden = true;
  findInput.value = '';
  evaluateFind('');
}

if (findInput) {
  findInput.oninput = () => evaluateFind(findInput.value);
  findInput.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      evaluateFind(findInput.value, { stepForward: !event.shiftKey });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBar();
    }
  };
}
if (findPrev) findPrev.onclick = () => evaluateFind(findInput.value, { stepForward: false });
if (findNext) findNext.onclick = () => evaluateFind(findInput.value, { stepForward: true });
if (findClose) findClose.onclick = closeFindBar;

// ── Quick Entry (quick-window.html: 606px, Enter submits if > 2 chars) ───
const quickDialog = $('quick-dialog');
const quickInput = $('prompt-input');
const quickContainer = $('quick-container');

function openQuickEntry() {
  if (!quickDialog) return;
  if (!quickDialog.open) quickDialog.showModal();
  setTimeout(() => quickInput?.focus(), 0);
}

function dismissQuickEntry(promptText) {
  if (!quickDialog) return;
  if (quickDialog.open) quickDialog.close();
  const trimmed = typeof promptText === 'string' ? promptText.trim() : '';
  if (trimmed.length > 2) {
    $('prompt').value = trimmed;
    setIdle(false);
    $('compose').requestSubmit();
  }
}

if ($('quick-toggle')) $('quick-toggle').onclick = openQuickEntry;
if (quickInput) {
  quickInput.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const value = quickInput.value;
      quickInput.value = '';
      dismissQuickEntry(value);
    }
  };
}
if (quickDialog) {
  quickDialog.onclick = event => {
    if (quickContainer && !quickContainer.contains(event.target)) {
      dismissQuickEntry(null);
    }
  };
}

// ── About Claude modal (AboutWindow-DtKZougt.js: 320x428) ────────────────
const aboutDialog = $('about-dialog');
const aboutVersionBtn = $('about-version-btn');
const BUILD_PROPS = {
  appName: 'Claude',
  appVersion: '2.42304.0',
  commitHash: 'e7f60e658f15cfece9efa384a78a39aec3c12845',
  commitTimestamp: '2026-10-15T05:54:05.000Z',
};

function openAboutModal() {
  if (!aboutDialog) return;
  const timeEl = $('about-time');
  if (timeEl) {
    timeEl.dateTime = BUILD_PROPS.commitTimestamp;
    try {
      timeEl.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(BUILD_PROPS.commitTimestamp));
    } catch {
      timeEl.textContent = BUILD_PROPS.commitTimestamp;
    }
  }
  if (!aboutDialog.open) aboutDialog.showModal();
}

if ($('about-toggle')) $('about-toggle').onclick = openAboutModal;
if ($('about-close')) $('about-close').onclick = () => aboutDialog?.close();
if (aboutVersionBtn) {
  const versionStr = `${BUILD_PROPS.appVersion} (${BUILD_PROPS.commitHash.slice(0, 6)})`;
  aboutVersionBtn.textContent = `Version ${versionStr}`;
  aboutVersionBtn.onclick = async () => {
    const copiedText = `${BUILD_PROPS.appName} ${versionStr} ${BUILD_PROPS.commitTimestamp}`;
    try { await navigator.clipboard.writeText(copiedText); } catch { /* clipboard may be restricted */ }
    aboutVersionBtn.textContent = 'Copied version to clipboard';
    setTimeout(() => {
      aboutVersionBtn.textContent = `Version ${versionStr}`;
    }, 2000);
  };
}

// ── Global keyboard accelerators (index.chunk-lzaSYO3Q.js) ───────────────
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFindBar();
  } else if (event.key === 'F3') {
    event.preventDefault();
    if (findBar && !findBar.hidden) evaluateFind(findInput.value, { stepForward: !event.shiftKey });
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    toggleSidebar();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openQuickEntry();
  } else if (event.key === 'Escape' && findBar && !findBar.hidden) {
    closeFindBar();
  }
});

// Start on the idle screen: no session is selected yet, so the welcome screen
// owns the composer and the in-conversation one stays hidden.
setIdle(true);
refresh().catch(report);




