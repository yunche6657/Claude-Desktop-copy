import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file = new URL('../resources/ion-dist/assets/v1/c71860c77-BwbfSKgy.js', import.meta.url);
const bundle = fs.readFileSync(file, 'utf8');
const start = bundle.indexOf('function SubscriptionImport({lib})');
const end = bundle.indexOf('var Wt=', start);
assert.ok(start >= 0 && end > start, 'actual bundled subscription component exists');
const source = bundle.slice(start, end);

function mount(importSubscription, options = {}) {
  const states = [], refs = [];
  let cursor = 0, refCursor = 0;
  const calls = [];
  const node = (type, props) => ({ type, props });
  const context = vm.createContext({
    u(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    n(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    r: node, i: node, a: 'Fragment', f: 'Button', b: 'Input',
    g: { Root: 'Dialog', Popup: 'Popup', Header: 'Header', Footer: 'Footer' },
    'claude.settings': { Custom3pSetup: { importSubscription } },
  });
  const component = vm.runInContext(`(${source})`, context);
  const lib = {
    async reload() { calls.push('reload'); if (options.reloadError) throw Error('refresh failed'); },
    async switchTo(id) { calls.push(['switchTo', id]); },
    ...options.lib,
  };
  const render = () => { cursor = 0; refCursor = 0; return component({ lib }); };
  function nodes(root) {
    if (!root || typeof root !== 'object') return [];
    return [root, ...[root.props?.children].flat(Infinity).flatMap(child => nodes(child))];
  }
  const find = predicate => nodes(render()).find(predicate);
  const field = label => find(node => node.props?.['aria-label'] === label);
  const change = (label, value) => field(label).props.onChange({ target: { value } });
  const submit = () => find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const open = () => find(node => node.type === 'Button' && node.props.children === '导入订阅').props.onClick();
  return { render, find, field, change, submit, open, calls };
}

test('header retains configuration menu and adds subscription import using shared UI primitives', () => {
  assert.match(bundle, /r\(Kt,\{lib:Jt,platform:xe,onPrompt:an,onImport:on\}\),r\(SubscriptionImport,\{lib:Jt\}\)/);
  assert.match(bundle, /Test model discovery/);
  assert.doesNotMatch(source, /\b(?:prompt|alert)\s*\(/);
  const ui = mount(async () => ({ ok: true, id: 'new' }));
  ui.open();
  assert.equal(ui.find(n => n.type === 'Dialog').props.open, true);
  assert.equal(ui.field('配置名称').type, 'Input');
  assert.equal(ui.field('默认模型').type, 'Input');
  assert.equal(ui.field('订阅凭据').props.autoComplete, 'off');
});

test('token and JSON import refresh library then select returned ID, show success and clear credential', async () => {
  for (const input of ['sk-ant-oat01-fixture', '{"accessToken":"fixture"}']) {
    let received;
    const ui = mount(async payload => { received = payload; return { ok: true, id: 'subscription-1' }; });
    ui.open(); ui.change('订阅凭据', ` ${input} `); ui.change('配置名称', '  我的订阅 '); ui.change('默认模型', ' claude-sonnet-4-6 ');
    await ui.submit();
    assert.deepEqual(JSON.parse(JSON.stringify(received)), { input, name: '我的订阅', model: 'claude-sonnet-4-6' });
    assert.deepEqual(ui.calls, ['reload', ['switchTo', 'subscription-1']]);
    assert.equal(ui.field('订阅凭据').props.value, '');
    assert.equal(ui.find(n => n.type === 'Dialog').props.open, false);
    assert.match(ui.find(n => n.props?.role === 'status').props.children, /导入成功/);
  }
});

test('optional fields default empty; backend failure stays in dialog and clears/redacts credentials', async () => {
  let received;
  const token = 'sk-ant-oat01-fixture';
  const ui = mount(async payload => { received = payload; return { ok: false, error: `invalid ${token}` }; });
  ui.open(); ui.change('订阅凭据', token); await ui.submit();
  assert.equal(received.name, ''); assert.equal(received.model, '');
  assert.equal(ui.find(n => n.type === 'Dialog').props.open, true);
  assert.equal(ui.field('订阅凭据').props.value, '');
  assert.doesNotMatch(ui.find(n => n.props?.role === 'alert').props.children, /sk-ant-/);
  assert.deepEqual(ui.calls, []);
});

test('submit blocks empty input and duplicate in-flight submissions; busy dialog cannot close', async () => {
  let resolve, count = 0;
  const ui = mount(() => { count++; return new Promise(done => { resolve = done; }); });
  ui.open(); await ui.submit(); assert.equal(count, 0);
  ui.change('订阅凭据', 'token');
  const first = ui.submit(); await ui.submit(); assert.equal(count, 1);
  assert.equal(ui.field('订阅凭据').props.disabled, true);
  ui.find(n => n.type === 'Dialog').props.onOpenChange(false);
  assert.equal(ui.find(n => n.type === 'Dialog').props.open, true);
  resolve({ ok: true, id: 'new' }); await first;
});

test('cancel and dismiss clear credentials and stale errors', async () => {
  const ui = mount(async () => { throw Error('request failed'); });
  ui.open(); ui.change('订阅凭据', 'token'); await ui.submit();
  assert.equal(ui.find(n => n.props?.role === 'alert').props.children, 'request failed');
  ui.change('订阅凭据', 'another-token');
  ui.find(n => n.type === 'Button' && n.props.children === '取消').props.onClick();
  ui.open(); assert.equal(ui.field('订阅凭据').props.value, '');
  assert.equal(ui.find(n => n.props?.role === 'alert'), undefined);
  ui.change('订阅凭据', 'third-token'); ui.find(n => n.type === 'Dialog').props.onOpenChange(false);
  assert.equal(ui.field('订阅凭据').props.value, '');
});

test('refresh failure reports imported state and invalid result does not navigate', async () => {
  const ui = mount(async () => ({ ok: true, id: 'new' }), { reloadError: true });
  ui.open(); ui.change('订阅凭据', 'token'); await ui.submit();
  assert.match(ui.find(n => n.props?.role === 'alert').props.children, /已导入，刷新配置失败/);
  assert.equal(ui.field('订阅凭据').props.value, ''); assert.deepEqual(ui.calls, ['reload']);
  const invalid = mount(async () => ({ ok: true }));
  invalid.open(); invalid.change('订阅凭据', 'token'); await invalid.submit();
  assert.match(invalid.find(n => n.props?.role === 'alert').props.children, /缺少配置 ID/);
  assert.deepEqual(invalid.calls, []);
});
