
'use strict';
// 页面渲染：列表页 + 状态页（简洁中文；不暴露私有路径、原始堆栈、registry 绝对路径）

const { normalizeEntryGeometry } = require('./config');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const Q = String.fromCharCode(34);
const NL = String.fromCharCode(10);

const STYLE = [
  'body{font-family:system-ui,sans-serif;background:#15181d;color:#e8eaed;margin:0;padding:28px 20px 60px}',
  'main{max-width:760px;margin:0 auto}',
  'h1{font-size:20px;margin:0 0 6px}',
  'p.hint{color:#9aa0a6;font-size:13px;margin:0 0 22px}',
  'ul{list-style:none;padding:0;margin:0}',
  'li{display:flex;align-items:center;gap:12px;padding:12px 14px;margin:0 0 10px;background:#1f242b;border:1px solid #2f3640;border-radius:6px}',
  '.nm{font-weight:600;flex:1 1 auto}',
  '.st{font-size:12px;padding:2px 8px;border-radius:10px;border:1px solid #444}',
  '.running{color:#8ab4f8;border-color:#3b5b8a}',
  '.stopped{color:#9aa0a6;border-color:#4a4f55}',
  '.starting{color:#fdd663;border-color:#7a6a2a}',
  '.error{color:#f28b82;border-color:#7a3b38}',
  'a.open{color:#8ab4f8;text-decoration:none;font-size:13px}',
  '.disabled{color:#6b7075;font-size:13px}',
  '.card{background:#1f242b;border:1px solid #2f3640;border-radius:6px;padding:18px 20px}',
  'h2{font-size:17px;margin:0 0 10px}',
  '.msg{color:#9aa0a6;font-size:13px;margin:0 0 18px}',
  'a.back{color:#8ab4f8;font-size:13px;text-decoration:none}',
].join(NL);

function page(title, bodyHtml) {
  return '<!DOCTYPE html>'
    + '<html lang=' + Q + 'zh-CN' + Q + '><head><meta charset=' + Q + 'utf-8' + Q + '>'
    + '<meta name=' + Q + 'viewport' + Q + ' content=' + Q + 'width=device-width,initial-scale=1' + Q + '>'
    + '<meta name=' + Q + 'referrer' + Q + ' content=' + Q + 'no-referrer' + Q + '>'
    + '<title>' + esc(title) + '</title><style>' + STYLE + '</style></head><body><main>'
    + '<h1>' + esc(title) + '</h1>'
    + bodyHtml
    + '</main></body></html>' + NL;
}

const STATE_TEXT = { running: '运行中', stopped: '已停止', starting: '启动中', error: '异常' };

// 列表页「打开桌面」入口链接（列表页唯一几何出口，与 manager/actions.py _public_url 同口径）
//   fixed  => 追加 resolution=<W>x<H>：几何门（lib/selector.js decideGeometry）**先于** state 判定，
//              固定几何缺该参数直接 409「必须带 resolution=WxH」⇒ 裸链等于发一个自己打不开的入口
//   auto   => 不带：auto + resolution 判 409 模式冲突
//   legacy（geometry 键缺席）=> 逐字不带：legacy + resolution 判 409 未登记几何
// 几何不信任注入字段：走 lib/config.js normalizeEntryGeometry（与 server.js 三处几何门同一入口），
// present-非法（未知键 / 缺键 / mode 非法 / 数字字符串 / 超界）一律 null；值只取归一后的整数
// canonical（重排，不透传原样字节）。返回 null = 不发链接（该桌入口必 4xx/5xx）。
// href 保持 root-relative（'/?desktop=' 前缀无 origin），id 走 encodeURIComponent。
function entryOpenHref(d) {
  if (!d || d.geometryError === true) return null;
  const g = normalizeEntryGeometry(d);
  if (!g.ok) return null;
  const base = '/?desktop=' + encodeURIComponent(d.id);
  if (!g.geometry || g.geometry.mode !== 'fixed') return base;
  return base + '&amp;resolution=' + g.geometry.canonical;
}

// 列表页：只列已登记桌面 + 状态 + 打开链接（需点击，永不自动连接）
function listPage(reg) {
  const rows = reg.desktops.map((d) => {
    const st = STATE_TEXT[d.state] || d.state;
    const href = entryOpenHref(d);
    const open = (d.state === 'running' && href !== null)
      ? '<a class=' + Q + 'open' + Q + ' href=' + Q + href + Q + '>打开桌面</a>'
      : '<span class=' + Q + 'disabled' + Q + '>' + (d.state === 'running' ? '几何登记不合法' : '未运行') + '</span>';
    return '<li><span class=' + Q + 'nm' + Q + '>' + esc(d.name) + '</span>'
      + '<span class=' + Q + 'st ' + esc(d.state) + Q + '>' + esc(st) + '</span>' + open + '</li>';
  }).join('');
  const note = reg.error
    ? '<p class=' + Q + 'hint' + Q + '>登记表状态：' + esc(reg.error) + '（列表按未登记显示）</p>'
    : '';
  const body = note + (reg.desktops.length
    ? '<ul>' + rows + '</ul>'
    : '<div class=' + Q + 'card' + Q + '><p class=' + Q + 'msg' + Q + '>当前没有已登记的桌面。</p></div>');
  return page('Webtop 桌面入口', '<p class=' + Q + 'hint' + Q + '>单一 loopback 入口 · 点击打开，不会自动连接</p>' + body);
}

function statusPage(code, title, msg, opts) {
  const o = opts || {};
  const C = (cls, inner) => '<p class=' + Q + cls + Q + '>' + inner + '</p>';
  let b = '<div class=' + Q + 'card' + Q + '><h2>' + esc(title) + '</h2>' + C('msg', esc(msg));
  if (o.autostartNotice) b += C('msg', '本入口不会因 GET 请求自动启动桌面。');
  if (o.form) {
    b += '<form method=' + Q + 'get' + Q + ' action=' + Q + '/' + Q + '><button type=' + Q + 'submit' + Q + '>返回桌面列表</button></form>';
  } else {
    b += '<a class=' + Q + 'back' + Q + ' href=' + Q + '/' + Q + '>返回桌面列表</a>';
  }
  b += '</div>';
  return page(code + ' · ' + title, b);
}

module.exports = { esc, page, listPage, statusPage, STATE_TEXT, entryOpenHref };
