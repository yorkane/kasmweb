'use strict';
// 列表页「打开桌面」入口链接的几何参数单测（node:test，纯函数层）
// 契约要点：
//   * fixed 桌的 href 必须带 &amp;resolution=WxH —— 几何门（lib/selector.js decideGeometry）
//     先于 state 判定，固定几何缺该参数直接 409 ⇒ 裸链等于发一个自己打不开的入口
//   * auto / legacy（geometry 键缺席）逐字不带 resolution（auto 带 = 409 模式冲突，
//     legacy 带 = 409 未登记几何）
//   * 几何登记不合法（geometryError 或 present-非法形态）= fail-closed，即便 state=running
//     也不出链接（与 server 三处几何门同一口径：lib/config.js normalizeEntryGeometry）
//   * 不信任注入的未规范化字段：值只取归一后的整数 canonical
//   * href 保持 root-relative，id 走 encodeURIComponent，name 走 esc()（禁 HTML 注入）
// 本套件不写文件、不启 HTTP、不占端口、require 链仅 pages.js(+config.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pages = require(path.join(ROOT, 'lib/pages'));
const entryOpenHref = pages.entryOpenHref;
const listPage = pages.listPage;

const AMP = String.fromCharCode(38) + 'amp;'; // HTML 属性内的 &amp;
const Q = String.fromCharCode(34);

function desk(o) {
  return Object.assign({
    id: 'd-1', name: '桌面一', port: 25321, state: 'running',
    container: 'wt-d-1', containerId: '', generation: 1, appId: '',
  }, o);
}

function reg(desktops, error) {
  return {
    schemaVersion: 1, publicOrigin: null, desktops: desktops,
    error: error === undefined ? null : error, source: 'memory', mtimeMs: 0,
  };
}

// 按序抽出渲染结果里全部桌面入口 href（属性内已 HTML 转义，逐字比对；不用正则，避免转义面）
function hrefsOf(html) {
  const needle = 'href=' + Q;
  const out = [];
  let i = 0;
  for (;;) {
    const p = html.indexOf(needle, i);
    if (p < 0) break;
    const start = p + needle.length;
    const end = html.indexOf(Q, start);
    if (end < 0) break;
    const v = html.slice(start, end);
    if (v.slice(0, 2) === '/?') out.push(v);
    i = end + 1;
  }
  return out;
}

// ------------------------------------------------------------------
// 1) 纯函数：entryOpenHref
// ------------------------------------------------------------------
test('legacy（geometry 键缺席）：href 逐字不变，不带 resolution', () => {
  const d = desk({ id: 'vcmi' });
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'geometry'), false);
  assert.equal(entryOpenHref(d), '/?desktop=vcmi');
  assert.equal(entryOpenHref(d).indexOf('resolution'), -1);
});

test('fixed：追加 resolution（HTML 属性内 &amp;，浏览器解析回 and 号）', () => {
  const d = desk({ id: 'chrome-1', geometry: { mode: 'fixed', width: 1600, height: 900 } });
  assert.equal(entryOpenHref(d), '/?desktop=chrome-1' + AMP + 'resolution=1600x900');
});

test('fixed：边界 320x240 / 4096x4096 / 320x4096 / 4096x240 逐字断言', () => {
  const cases = [[320, 240], [4096, 4096], [320, 4096], [4096, 240], [1920, 1080]];
  for (const c of cases) {
    const w = c[0], h = c[1];
    const d = desk({ id: 'fx', geometry: { mode: 'fixed', width: w, height: h } });
    assert.equal(entryOpenHref(d), '/?desktop=fx' + AMP + 'resolution=' + w + 'x' + h,
      w + 'x' + h + ' 应逐字出现在 href');
  }
});

test('fixed：值只取归一整数 canonical，注入的自造 canonical 键不生效（fail-closed）', () => {
  const d = desk({
    id: 'fx',
    geometry: { mode: 'fixed', width: 1600, height: 900, canonical: '9999x9999' },
  });
  assert.equal(entryOpenHref(d), null, '未知键 ⇒ present-非法 ⇒ 不得发链接');
});

test('auto：不带 resolution（auto + resolution 必 409）', () => {
  const d = desk({ id: 'a-1', geometry: { mode: 'auto', width: 1280, height: 720 } });
  assert.equal(entryOpenHref(d), '/?desktop=a-1');
  assert.equal(entryOpenHref(d).indexOf('resolution'), -1);
  assert.ok(listPage(reg([d])).indexOf('/?desktop=a-1' + Q) > 0);
});

test('geometryError=true（registry fail-closed）：即便 state=running 也 null', () => {
  const d = desk({ id: 'bad', state: 'running', geometryError: true, geometryDetail: 'x' });
  assert.equal(entryOpenHref(d), null);
});

test('present-非法 geometry 全部 null（不信任注入字段，与 server 几何门同口径）', () => {
  const bad = [
    { mode: 'fixed', width: '1600', height: 900 },       // 数字字符串
    { mode: 'fixed', width: 1600.5, height: 900 },       // 非整数
    { mode: 'fixed', width: 319, height: 900 },          // 宽下界外
    { mode: 'fixed', width: 320, height: 239 },          // 高下界外
    { mode: 'fixed', width: 4097, height: 900 },         // 宽上界外
    { mode: 'fixed', width: 1600, height: 4097 },        // 高上界外
    { mode: 'fixed', width: 1600 },                      // 缺 height
    { mode: 'fixed', height: 900 },                      // 缺 width
    { width: 1600, height: 900 },                        // 缺 mode
    { mode: 'scale', width: 1600, height: 900 },         // mode 非法
    { mode: 'FIXED', width: 1600, height: 900 },         // mode 大小写
    { mode: 'fixed', width: 1600, height: 900, backend: 'evil' }, // 多余键
    { mode: 'fixed', width: 1600, height: 900, exec: 'evil' },
    null,                                                // 键存在值为 null
    [],                                                  // 数组
    'fixed',                                             // 标量
  ];
  for (const g of bad) {
    const d = desk({ id: 'inj', state: 'running' });
    d.geometry = g;
    assert.equal(entryOpenHref(d), null, 'geometry=' + JSON.stringify(g) + ' 必须无链接');
  }
});

test('geometry 键存在但值为 undefined：present-非法 ⇒ null（仅键缺席才是 legacy）', () => {
  const d = desk({ id: 'u' });
  d.geometry = undefined;
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'geometry'), true);
  assert.equal(entryOpenHref(d), null);
});

test('id 一律 encodeURIComponent，href 保持 root-relative（无 origin）', () => {
  const d = desk({ id: 'a b/c' + Q + '1?q&x' });
  const href = entryOpenHref(d);
  assert.equal(href, '/?desktop=a%20b%2Fc%221%3Fq%26x');
  assert.equal(href.slice(0, 2), '/?', '不得带 origin: ' + href);
  assert.equal(/^https?:/i.test(href), false);
});

test('恶意 id / name：无 HTML 注入（属性面与文本面）', () => {
  const evil = '</a><scr' + 'ipt>alert(1)</scr' + 'ipt>';
  const d = desk({ id: evil, name: '<img src=x onerror=alert(1)>' });
  const html = listPage(reg([d]));
  assert.equal(html.indexOf('<scr' + 'ipt'), -1, '不得出现裸 script 开标签');
  assert.equal(html.indexOf('<img'), -1, 'name 的尖括号必须转义');
  assert.ok(html.indexOf('&lt;img src=x onerror=alert(1)&gt;') > 0, 'name 以转义文本呈现');
  const href = hrefsOf(html)[0];
  assert.equal(href, '/?desktop=' + encodeURIComponent(evil));
  assert.equal(href.indexOf('<'), -1);
  assert.equal(href.indexOf('>'), -1);
  assert.equal(href.indexOf(Q), -1);
});

test('非 running 不发链接（stopped / starting / error 一律未运行文案）', () => {
  for (const st of ['stopped', 'starting', 'error']) {
    const html = listPage(reg([desk({
      id: 'd-1', state: st, geometry: { mode: 'fixed', width: 1600, height: 900 },
    })]));
    assert.equal(html.indexOf('<a class=' + Q + 'open'), -1, st + ' 不得出现打开链接');
    assert.ok(html.indexOf('未运行') > 0, st + ' 文案应为未运行');
    assert.equal(hrefsOf(html).length, 0);
  }
});

// ------------------------------------------------------------------
// 2) 列表页渲染：fixed / auto / legacy / 异常混合
// ------------------------------------------------------------------
test('listPage：fixed 行 href 逐字含 resolution，auto 与 legacy 逐字不含', () => {
  const html = listPage(reg([
    desk({ id: 'vcmi', name: 'VCMI' }),
    desk({ id: 'chrome-1', name: 'Chrome 1', geometry: { mode: 'fixed', width: 1600, height: 900 } }),
    desk({ id: 'chrome-2', name: 'Chrome 2', geometry: { mode: 'fixed', width: 1280, height: 800 } }),
    desk({ id: 'auto-1', name: 'Auto 1', geometry: { mode: 'auto', width: 1280, height: 720 } }),
  ]));
  assert.deepEqual(hrefsOf(html), [
    '/?desktop=vcmi',
    '/?desktop=chrome-1' + AMP + 'resolution=1600x900',
    '/?desktop=chrome-2' + AMP + 'resolution=1280x800',
    '/?desktop=auto-1',
  ]);
  assert.ok(html.indexOf('打开桌面') > 0);
});

test('listPage：fixed 行是完整可点 anchor（属性序与引号逐字）', () => {
  const html = listPage(reg([desk({ id: 'fx', geometry: { mode: 'fixed', width: 320, height: 240 } })]));
  assert.ok(html.indexOf('<a class=' + Q + 'open' + Q + ' href=' + Q + '/?desktop=fx'
    + AMP + 'resolution=320x240' + Q + '>打开桌面</a>') > 0, 'anchor 逐字未命中');
});

test('listPage：running + 非法几何 ⇒ 禁用文案「几何登记不合法」，不出 anchor', () => {
  const d = desk({ id: 'bad', name: '坏几何', state: 'running',
    geometry: { mode: 'fixed', width: 0, height: 0 } });
  const html = listPage(reg([d]));
  assert.ok(html.indexOf('几何登记不合法') > 0);
  assert.equal(html.indexOf('打开桌面'), -1);
  assert.deepEqual(hrefsOf(html), []);
});

test('listPage：geometryError + state=running（脏数据未归一）同样 fail-closed', () => {
  const html = listPage(reg([desk({ id: 'ge', name: 'GE', state: 'running', geometryError: true })]));
  assert.ok(html.indexOf('几何登记不合法') > 0);
  assert.deepEqual(hrefsOf(html), []);
});

test('listPage：非 running 文案维持未运行（不被几何文案顶替）', () => {
  const html = listPage(reg([desk({ id: 'st', name: 'ST', state: 'stopped' })]));
  assert.ok(html.indexOf('未运行') > 0);
  assert.equal(html.indexOf('几何登记不合法'), -1);
});

test('listPage：空表与 registry error 路径不受本次改动影响', () => {
  const html = listPage(reg([], 'registry 读取失败'));
  assert.ok(html.indexOf('当前没有已登记的桌面') > 0);
  assert.ok(html.indexOf('登记表状态') > 0);
});
