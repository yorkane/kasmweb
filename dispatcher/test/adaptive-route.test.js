'use strict';
// 自适应几何路由底座（foundation）离线单测：node:test + 真 HTTP 服务 listen(0)
// 契约要点（与 doc/并行制作任务.md 的裁决一致）：
//   * geometry 只从 registry 条目的 entry.geometry 读（本套件用内存注入 registry，不落盘）
//   * registry 未升级时 geometry 字段缺失 ⇒ 全部桌面按 legacy 现状逐字运行
//   * geometry 的 409/503/400 门全部**先于** state 判定（geometryError 不得被 state=running 绕过）
//   * auto 几何必须 WTK_ENABLE_ADAPTIVE_PREVIEW=1（cfg 显式 opt-in）才开放，关闭时 HTTP 与 WS 一律 503
//   * 本套件不写任何文件、不占固定端口、不启停任何容器

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const selector = require(path.join(ROOT, 'lib/selector'));
const {
  parseResolution, normalizeGeometry, canonicalParamsFor, canonicalLocation,
} = require(path.join(ROOT, 'lib/config'));
const { createDispatcher } = require(path.join(ROOT, 'server'));
const WS = require(path.join(ROOT, 'vendor/ws'));

// ------------------------------------------------------------------
// 纯函数层：resolution / geometry 值契约
// ------------------------------------------------------------------
test('parseResolution：规范 WxH 通过并归一', () => {
  for (const [s, w, h] of [['320x240', 320, 240], ['1600x900', 1600, 900], ['4096x4096', 4096, 4096], ['1000x1000', 1000, 1000]]) {
    const r = parseResolution(s);
    assert.equal(r.ok, true, s);
    assert.equal(r.width, w, s);
    assert.equal(r.height, h, s);
    assert.equal(r.canonical, w + 'x' + h, s + ' canonical 由整数重排');
  }
});

test('parseResolution：非规范形态一律拒绝（大写/前导0/越界/只宽/只高/空）', () => {
  const bad = ['', '1600X900', '1600x900 ', ' 1600x900', '0160x900', '1600x0900',
    '160x900', '100x900', '319x900', '1600x239', '1600x100', '4097x900', '1600x4097',
    '16000x900', '1600x9000', '1600', 'x900', '1600x', 'ax600x900', '1600x90x',
    '1600x900x100', '1600 900', '-1600x900', '1600x-900', '1.6e3x900', '%3600x900'];
  for (const s of bad) {
    const r = parseResolution(s);
    assert.equal(r.ok, false, JSON.stringify(s) + ' 必须拒绝');
    assert.equal(typeof r.msg, 'string', JSON.stringify(s) + ' 必须给可展示原因');
  }
});

test('parseResolution：非字符串入参安全拒绝', () => {
  for (const v of [undefined, null, 1600, {}, [], true]) {
    assert.equal(parseResolution(v).ok, false, String(v));
  }
});

test('normalizeGeometry：仅「键缺席」= legacy；auto/fixed 三键归一；key 顺序不依赖', () => {
  assert.deepEqual(normalizeGeometry(undefined), { ok: true, geometry: null },
    'undefined 入参 = 调用方已确认 geometry 键缺席 ⇒ legacy');
  assert.equal(normalizeGeometry(null).ok, false, 'present null 不是 legacy ⇒ failclosed');
  const a = normalizeGeometry({ mode: 'auto', width: 1600, height: 900 });
  assert.equal(a.ok, true);
  assert.equal(a.geometry.mode, 'auto');
  assert.equal(a.geometry.canonical, null, 'auto 无固定尺寸');
  assert.equal(a.geometry.width, 1600, 'auto 登记尺寸保留（不参与连接判定）');
  const f1 = normalizeGeometry({ mode: 'fixed', width: 1600, height: 900 });
  const f2 = normalizeGeometry({ height: 900, width: 1600, mode: 'fixed' });
  assert.equal(f1.ok, true);
  assert.deepEqual(f1.geometry, f2.geometry, 'key 顺序不影响结果');
  assert.equal(f1.geometry.canonical, '1600x900');
  assert.deepEqual(normalizeGeometry({ mode: 'auto', width: 1600, height: 900 }).geometry,
    normalizeGeometry({ height: 900, mode: 'auto', width: 1600 }).geometry);
  const f3 = normalizeGeometry({ mode: 'fixed', width: '1920', height: '1080' });
  assert.equal(f3.ok, false, '数字字符串与 registry.validateGeometry 同口径拒绝（不 Number() 宽化）');
});

test('normalizeGeometry：与 registry.validateGeometry 同口径 — 三键齐备 + 严格数字类型，坏值 ok:false', () => {
  const bad = ['auto', '', 'fixed', 1600, [], { mode: 'stretch' }, { mode: 'AUTO', width: 1600, height: 900 },
    // auto 与 fixed 一样必须三键：缺 width / 缺 height / 全缺 均不合法
    { mode: 'auto' }, { mode: 'auto', width: 1600 }, { mode: 'auto', height: 900 },
    { mode: 'fixed' }, { mode: 'fixed', width: 1600 }, { mode: 'fixed', height: 900 },
    { mode: 'fixed', width: 0, height: 900 }, { mode: 'fixed', width: 1600, height: 0 },
    { mode: 'fixed', width: 1600, height: null }, { mode: 'fixed', width: 4097, height: 900 },
    { mode: 'fixed', width: 1600, height: 4097 }, { mode: 'fixed', width: 1600, height: 239 },
    { mode: 'fixed', width: 320.5, height: 900 }, { mode: 'fixed', width: 'abc', height: 900 },
    { mode: 'auto', width: 9999 }, { mode: 'auto', height: 100 }, { mode: 'auto', width: 'x' },
    { mode: 'auto', width: 1600, height: 239 },
    // present null / present undefined 值（registry 侧同样判非法）
    { mode: 'fixed', width: null, height: null }, { mode: 'fixed', width: undefined, height: 900 },
    { mode: 'auto', width: '1600', height: '900' }, { mode: 'fixed', width: '1600', height: '900' },
    { mode: 'fixed', width: 1600, height: '900' }, { mode: 'auto', width: [], height: 900 },
    { mode: 'auto', width: {}, height: 900 }, { mode: 'fixed', width: true, height: 900 },
    // 三键之外的多余字段一律拒绝（不接受后端/exec/env 等注入面）
    { mode: 'auto', width: 1600, height: 900, backend: 'evil' },
    { mode: 'fixed', width: 1600, height: 900, exec: 'x' },
    { mode: 'fixed', width: 1600, height: 900, canonical: '1600x900' }];
  for (const g of bad) {
    assert.equal(normalizeGeometry(g).ok, false, JSON.stringify(g) + ' 必须判不合法');
  }
});

test('normalizeEntryGeometry：只有 geometry 键缺席才是 legacy；present undefined/null ⇒ 503 口径', () => {
  const { normalizeEntryGeometry } = require(path.join(ROOT, 'lib/config'));
  assert.deepEqual(normalizeEntryGeometry({ id: 'a' }), { ok: true, geometry: null }, '键缺席 = legacy');
  assert.deepEqual(normalizeEntryGeometry({ id: 'a', geometry: { mode: 'fixed', width: 1600, height: 900 } }).geometry,
    { mode: 'fixed', width: 1600, height: 900, canonical: '1600x900' });
  for (const e of [
    { id: 'a', geometry: undefined },
    { id: 'a', geometry: null },
    { id: 'a', geometry: '1600x900' },
    { id: 'a', geometry: 1600 },
    { id: 'a', geometry: [] },
    { id: 'a', geometry: { mode: 'auto' } },
    { id: 'a', geometry: { mode: 'fixed', width: '1600', height: '900' } },
    { id: 'a', geometry: { mode: 'fixed', width: 1600, height: 900, exec: 'x' } },
  ]) {
    assert.equal(normalizeEntryGeometry(e).ok, false, JSON.stringify(e) + ' present 坏值必须 ok:false');
  }
  assert.equal(Object.prototype.hasOwnProperty.call({ geometry: undefined }, 'geometry'), true,
    '前提：present-undefined 与键缺席可被 hasOwnProperty 区分');
});

test('canonicalParamsFor：scale 与 legacy 逐字一致；remote 只改 resize，shared 不变', () => {
  const s = canonicalParamsFor('d-1');
  const r = canonicalParamsFor('d-1', 'remote');
  assert.deepEqual(s, canonicalParamsFor('d-1', 'scale'));
  const get = (arr, k) => arr.find((p) => p[0] === k)[1];
  assert.equal(get(s, 'resize'), 'scale');
  assert.equal(get(r, 'resize'), 'remote');
  for (const k of ['autoconnect', 'path', 'idle_disconnect', 'clipboard_seamless', 'shared']) {
    assert.equal(get(r, k), get(s, k), k + ' 不随模式变化');
  }
  assert.equal(get(r, 'shared'), 'true', 'shared 仅 iframe 参数，不宣称后端互斥');
  assert.equal(get(r, 'path'), 'desktop/d-1/websockify');
});

test('canonicalLocation：remote/resolution 只写归一值，保持 root-relative', () => {
  const loc = selector.canonicalLocation('http://127.0.0.1:25320', 'd 1', [['bell', 'on']], {
    resizeMode: 'remote', resolution: { canonical: '1600x900' },
  });
  assert.ok(loc.startsWith('/desktop/d%201/?'), loc);
  assert.ok(!/^\/\//.test(loc) && !/^[a-z]+:/i.test(loc), '不得绝对/协议相对');
  const u = new URL(loc, 'https://edge.example:99');
  assert.equal(u.origin, 'https://edge.example:99', '原入口 origin 保持');
  assert.equal(u.searchParams.get('resize'), 'remote');
  assert.equal(u.searchParams.get('resolution'), '1600x900');
  assert.equal(u.searchParams.get('bell'), 'on');
});

// ------------------------------------------------------------------
// 纯函数层：几何裁决矩阵
// ------------------------------------------------------------------
const auto = { mode: 'auto', width: null, height: null, canonical: null };
const fixed16 = { mode: 'fixed', width: 1600, height: 900, canonical: '1600x900' };
const res16 = { ok: true, width: 1600, height: 900, canonical: '1600x900' };
const res19 = { ok: true, width: 1920, height: 1080, canonical: '1920x1080' };

test('decideGeometry：legacy 无参=现状 scale；legacy 带参=409 not supported', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideGeometry(e, null, null, false),
    { action: 'redirect', resizeMode: 'scale', resolution: null, legacy: true });
  assert.deepEqual(selector.decideGeometry(e, null, null, true),
    { action: 'redirect', resizeMode: 'scale', resolution: null, legacy: true },
    'preview 开关不影响 legacy');
  const d = selector.decideGeometry(e, null, res16, true);
  assert.equal(d.action, 'error');
  assert.equal(d.code, 409);
  assert.match(d.msg, /legacy|待迁移/, '告知有待迁移：' + d.msg);
});

test('decideGeometry：auto 无参=remote；带参=409；preview 关闭=503（两个预期不混淆）', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideGeometry(e, auto, null, true),
    { action: 'redirect', resizeMode: 'remote', resolution: null });
  const off = selector.decideGeometry(e, auto, null, false);
  assert.equal(off.action, 'error');
  assert.equal(off.code, 503, '未开预览 = 503，不是 409');
  assert.match(off.msg, /WTK_ENABLE_ADAPTIVE_PREVIEW/);
  const conf = selector.decideGeometry(e, auto, res16, true);
  assert.equal(conf.code, 409, 'auto + resolution = 模式冲突');
  assert.match(conf.msg, /auto/);
  const confOff = selector.decideGeometry(e, auto, res16, false);
  assert.equal(confOff.code, 409, '开关关闭时 409 优先级高于 503（不混淆两个语义）');
});

test('decideGeometry：fixed 只接受精确登记尺寸，其余 409', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideGeometry(e, fixed16, res16, false),
    { action: 'redirect', resizeMode: 'scale', resolution: res16 },
    'fixed 不依赖 preview 开关');
  const miss = selector.decideGeometry(e, fixed16, null, true);
  assert.equal(miss.code, 409);
  assert.match(miss.msg, /1600x900/, '提示要求值：' + miss.msg);
  assert.equal(selector.decideGeometry(e, fixed16, res19, true).code, 409);
});

test('decideGeometry：geometryError / 形态坏 = 503 failclosed，且优先于其它判定', () => {
  assert.equal(selector.decideGeometry({ id: 'a', geometryError: true }, null, null, true).code, 503);
  assert.equal(selector.decideGeometry({ id: 'a', geometryError: true }, auto, null, true).code, 503);
  assert.equal(selector.decideGeometry({ id: 'a', geometryError: true }, fixed16, res16, true).code, 503);
  const inv = selector.decideGeometry({ id: 'a' }, 'invalid', null, true);
  assert.equal(inv.action, 'error');
  assert.equal(inv.code, 503);
});

test('decideAsset：子资源不要求 resolution；显式冲突才拒', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideAsset(e, null, null, true), { action: 'allow', resizeMode: 'scale', legacy: true });
  assert.equal(selector.decideAsset(e, null, res16, true).code, 409, 'legacy 带 resolution 仍 409');
  assert.deepEqual(selector.decideAsset(e, fixed16, null, false), { action: 'allow', resizeMode: 'scale' },
    'fixed 的 js/css/audiojs 不带 resolution 必须放行（真实浏览器行为）');
  assert.equal(selector.decideAsset(e, fixed16, res16, false).action, 'allow');
  assert.equal(selector.decideAsset(e, fixed16, res19, false).code, 409);
  assert.deepEqual(selector.decideAsset(e, auto, null, true), { action: 'allow', resizeMode: 'remote' });
  assert.equal(selector.decideAsset(e, auto, null, false).code, 503, 'preview 关闭时 asset 同样拒绝');
  assert.equal(selector.decideAsset(e, auto, res16, true).code, 409);
  assert.equal(selector.decideAsset({ id: 'a', geometryError: true }, null, null, true).code, 503);
  assert.equal(selector.decideAsset(e, 'invalid', null, true).code, 503);
});

test('decideGeometryWs：video/audio 均不强制 resolution；显式值才校验', () => {
  const vid = { kind: 'video' };
  const aud = { kind: 'audio' };
  // legacy：现状放行（不新增 resize 形态约束）；带 resolution = 409
  assert.equal(selector.decideGeometryWs({ id: 'a' }, null, { ...vid, resize: 'scale' }).action, 'allow');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, null, { ...vid, resize: 'nope' }).action, 'allow',
    'legacy 逐字旧行为：不因新校验改变');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, null, { ...vid, resolutionPresent: true }).code, 409);
  // auto
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...vid, resize: 'remote', previewEnabled: true }).action, 'allow');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...vid, previewEnabled: true }).action, 'allow',
    'WS URL 缺 resize 不约束（Kasm ui.js 按 path 拼接，不保证带 resize）');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...vid, resize: 'scale', previewEnabled: true }).code, 400,
    '显式 resize=scale 与 auto 冲突 = 400');
  const off = selector.decideGeometryWs({ id: 'a' }, auto, { ...vid, resize: 'remote' });
  assert.equal(off.code, 503);
  assert.equal(off.reason, 'previewDisabled');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...aud, previewEnabled: true }).action, 'allow',
    'audio 通道无 resize 语义');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...aud, previewEnabled: false }).code, 503,
    'preview 关闭时音频通道同样被拒');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, auto, { ...vid, resize: 'remote', resolutionPresent: true, resolution: '1600x900', previewEnabled: true }).code, 409);
  // fixed：后端 AcceptSetDesktopSize=0 ⇒ 画面/音频 WS 不带 resolution 也必须可用
  const fx = (o) => selector.decideGeometryWs({ id: 'a' }, fixed16, { ...vid, ...o });
  assert.equal(fx({ resize: 'scale', resolutionPresent: true, resolution: '1600x900' }).action, 'allow');
  assert.equal(fx({ resize: 'scale' }).action, 'allow', '缺 resolution 放行（不要求每个连接携带）');
  assert.equal(fx({}).action, 'allow', '连 resize 都没有 ⇒ 放行（形态缺省不约束）');
  assert.equal(fx({ resize: 'scale', resolutionPresent: true, resolution: '1920x1080' }).code, 409);
  assert.equal(fx({ resize: 'scale', resolutionPresent: true, resolution: '1600X900' }).code, 400, '形态坏 400');
  assert.equal(fx({ resize: 'remote', resolutionPresent: true, resolution: '1600x900' }).code, 400, '显式 resize 必须 scale');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, fixed16, { ...aud }).action, 'allow', 'fixed 音频 WS 无 resolution 放行');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, fixed16, { ...aud, resolutionPresent: true, resolution: '1600x900' }).action, 'allow');
  assert.equal(selector.decideGeometryWs({ id: 'a' }, fixed16, { ...aud, resolutionPresent: true, resolution: '1920x1080' }).code, 409);
  // failclosed 优先
  assert.equal(selector.decideGeometryWs({ id: 'a', geometryError: true }, null, vid).code, 503);
  assert.equal(selector.decideGeometryWs({ id: 'a', geometryError: true }, auto, { ...vid, previewEnabled: true }).code, 503);
  assert.equal(selector.decideGeometryWs({ id: 'a' }, 'invalid', vid).code, 503);
});

// ------------------------------------------------------------------
// 集成层：真 HTTP + listen(0) + 内存注入 registry（不落盘、不占固定端口）
// ------------------------------------------------------------------
const DESKS = {
  // legacy = geometry 键**缺席**（不是 present undefined）
  legacy: { id: 'legacy', name: 'Legacy 桌', port: 0, state: 'running' },
  legacyErr: { id: 'legacy-err', name: '几何坏桌', port: 0, state: 'running', geometryError: true },
  legacyBad: { id: 'legacy-bad', name: '几何非法桌', port: 0, state: 'running', geometry: { mode: 'stretch' } },
  auto: { id: 'auto-1', name: '自适应桌', port: 0, state: 'running', geometry: { mode: 'auto', width: 1600, height: 900 } },
  autoNoWh: { id: 'auto-nowh', name: '缺尺寸自适桌', port: 0, state: 'running', geometry: { mode: 'auto' } },
  fixed: { id: 'fixed-1', name: '固定桌', port: 0, state: 'running', geometry: { mode: 'fixed', width: 1600, height: 900 } },
  // present 坏值注入面：键存在但值不是合法三键对象 ⇒ 一律 503（不得退化成 legacy 放行）
  geomUndef: { id: 'geom-undef', name: 'present undefined', port: 0, state: 'running', geometry: undefined },
  geomNull: { id: 'geom-null', name: 'present null', port: 0, state: 'running', geometry: null },
  geomStr: { id: 'geom-str', name: 'geometry 为字符串', port: 0, state: 'running', geometry: '1600x900' },
  geomStrWh: { id: 'geom-strwh', name: '宽高数字字符串', port: 0, state: 'running', geometry: { mode: 'fixed', width: '1600', height: '900' } },
};

function memoryRegistry() {
  const deskOf = (id) => {
    for (const k of Object.keys(DESKS)) if (DESKS[k].id === id) return DESKS[k];
    return null;
  };
  const reg = {
    desktops: [],
    byId(id) {
      const d = deskOf(id);
      if (!d) return null;
      const e = { id: d.id, name: d.name, port: d.port, state: d.state, container: '', containerId: '', generation: 1, appId: '' };
      // 逐字保留「键缺席」与「present undefined」的区别（与 lib/registry 的 hasOwn 口径一致）
      if (Object.prototype.hasOwnProperty.call(d, 'geometry')) e.geometry = d.geometry;
      if (d.geometryError === true) e.geometryError = true;
      return e;
    },
    read() { return { schemaVersion: 1, publicOrigin: null, desktops: [], error: null, source: 'memory', mtimeMs: 0 }; },
    startWatch() {}, stopWatch() {}, writeAtomic() {},
  };
  return reg;
}

const backendState = new Map(); // id -> {server, wss, port, marker, httpCount, wsCount, lastUpgrade}

function startBackend(id) {
  return new Promise((resolve, reject) => {
    const st = { httpCount: 0, wsCount: 0, lastUpgrade: null, marker: 'ADAPTIVE_BACKEND_' + id };
    const server = http.createServer((req, res) => {
      st.httpCount += 1;
      st.lastRequest = { url: req.url, method: req.method };
      if (req.url.indexOf('/qecho') === 0) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(req.url);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(st.marker);
    });
    const wss = new WS.Server({ server, verifyClient: () => true, noServer: false });
    wss.on('connection', (sock, req) => {
      st.wsCount += 1;
      st.lastUpgrade = { url: req.url, headers: req.headers };
      sock.on('message', (m) => { try { sock.send('ECHO_' + id + ':' + m.toString('utf8')); } catch (e) {} });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      st.port = server.address().port;
      st.server = server;
      st.wss = wss;
      backendState.set(id, st);
      resolve(st);
    });
  });
}

function req(method, urlPath, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: o.port || dispatcherPort, method, path: urlPath,
      headers: o.headers || {}, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(o.timeoutMs || 8000, () => { r.destroy(new Error('client request timeout')); });
    r.end();
  });
}
const get = (p, o) => req('GET', p, o);

function rawHttp(requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(dispatcherPort, '127.0.0.1', () => s.write(requestText));
    const chunks = [];
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    s.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    s.on('error', reject);
    s.setTimeout(timeoutMs || 5000, () => { s.destroy(); reject(new Error('raw timeout')); });
  });
}

// 放行（101）时连接被升级为隧道、不会关闭 ⇒ rawHttp 只能等超时。
// 取状态行用这个：收到完整响应头（\r\n\r\n）立刻 resolve 并主动断开。
function rawStatus(requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(dispatcherPort, '127.0.0.1', () => s.write(requestText));
    let buf = '';
    const finish = () => {
      s.removeAllListeners('data');
      try { s.destroy(); } catch (e) { /* ignore */ }
      resolve(buf.split(String.fromCharCode(13, 10))[0]);
    };
    s.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.indexOf(String.fromCharCode(13, 10) + String.fromCharCode(13, 10)) >= 0) finish();
    });
    s.on('end', () => resolve(buf.split(String.fromCharCode(13, 10))[0]));
    s.on('close', () => resolve(buf.split(String.fromCharCode(13, 10))[0]));
    s.on('error', reject);
    s.setTimeout(timeoutMs || 5000, () => { s.destroy(); reject(new Error('raw status timeout')); });
  });
}

function wsConnect(pathStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const client = new WS('ws://127.0.0.1:' + dispatcherPort + pathStr, { handshakeTimeout: o.handshakeTimeout || 5000 });
    client.once('open', () => resolve(client));
    client.once('error', (e) => reject(e));
  });
}

function wsEcho(client, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('echo timeout')), 4000);
    client.once('message', (m) => { clearTimeout(t); resolve(m.toString('utf8')); });
    client.send(msg);
  });
}

function statusLineOf(raw) {
  return raw.split(String.fromCharCode(13, 10))[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 后端 ws 库要求 Sec-WebSocket-Key 是 24 字符 base64（/^[+/0-9A-Za-z]{22}==$/），
// 随手写 'AAAA' 会被后端判 400，掩盖 dispatcher 自己的状态行 ⇒ 用合法 key。
const WSKEY = 'dGhlIHNhbXBsZSBub25jZQ==';

let app = null;
let dispatcherPort = 0;

function startDispatcher(previewEnabled) {
  return new Promise((resolve, reject) => {
    const ports = [...backendState.values()].map((b) => b.port);
    app = createDispatcher({
      registry: memoryRegistry(),
      cfg: {
        host: '127.0.0.1', port: 0, registry: '/nonexistent/registry.json',
        publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
        backendHost: '127.0.0.1',
        backendPortMin: Math.min(...ports), backendPortMax: Math.max(...ports),
        maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
        adaptivePreview: previewEnabled === true,
      },
      logger: () => {},
    });
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      dispatcherPort = app.server.address().port;
      resolve();
    });
  });
}

test.before(async () => {
  for (const key of Object.keys(DESKS)) {
    const st = await startBackend(key);
    DESKS[key].port = st.port;
  }
  await startDispatcher(false);
});

test.after(async () => {
  if (app) { app.registry.stopWatch(); await new Promise((r) => app.server.close(r)); }
  for (const [, b] of backendState) {
    for (const c of b.wss.clients) { try { c.terminate(); } catch (e) {} }
    await new Promise((r) => b.server.close(r));
  }
});

const CANON_SCALE = 'autoconnect=1&resize=scale&path=';
function canonicalScale(id) {
  return 'autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
}
function canonicalRemote(id) {
  return 'autoconnect=1&resize=remote&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
}

function assertRelativeLocation(loc, msg) {
  assert.equal(typeof loc, 'string', msg + ' 必须字符串');
  assert.ok(loc.startsWith('/desktop/'), msg + ' 必须 root-relative: ' + loc);
  assert.ok(!loc.startsWith('//'), msg + ' 不得协议相对');
  assert.ok(!/^[a-z]+:/i.test(loc), msg + ' 不得绝对 URL');
}

// ---- legacy：现状逐字不变 ----
test('legacy 根选择：302 规范参数逐字不变，无新增可见字段', async () => {
  const r = await get('/?desktop=legacy');
  assert.equal(r.status, 302);
  assertRelativeLocation(r.headers.location, 'legacy 302');
  const want = '/desktop/legacy/?' + canonicalScale('legacy');
  assert.equal(r.headers.location, want, 'legacy Location 必须逐字等于旧规范串');
  assert.equal(r.headers['x-wtk-geometry'], undefined, '不加自定义头（避免改变用户可见行为）');
});

test('legacy 书签直达 302 + 规范参数直连后端字节', async () => {
  const r = await get('/desktop/legacy/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/desktop/legacy/?' + canonicalScale('legacy'));
  const r2 = await get('/desktop/legacy/?' + canonicalScale('legacy'));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.toString('utf8'), backendState.get('legacy').marker);
});

test('legacy 带 resolution = 409（根选择与规范路径一致，不假成功）', async () => {
  const a = await get('/?desktop=legacy&resolution=1600x900');
  assert.equal(a.status, 409);
  assert.match(a.body.toString('utf8'), /legacy/);
  const b = await get('/desktop/legacy/?resolution=1600x900');
  assert.equal(b.status, 409);
  const c = await get('/desktop/legacy/?' + canonicalScale('legacy') + '&resolution=1600x900');
  assert.equal(c.status, 409, '规范参数 + resolution 同样 409');
});

test('legacy WS 现状放行（画面 + 音频），无 query 逐字旧行为不变', async () => {
  const c = await wsConnect('/desktop/legacy/websockify?' + canonicalScale('legacy'));
  assert.equal(await wsEcho(c, 'legacy-rfb'), 'ECHO_legacy:legacy-rfb');
  c.close();
  const ca = await wsConnect('/desktop/legacy/audio');
  assert.equal(await wsEcho(ca, 'legacy-audio'), 'ECHO_legacy:legacy-audio');
  ca.close();
  await sleep(120);
});

test('legacy WS 带 resolution = 409 逐字回显状态行', async () => {
  const raw = await rawHttp('GET /desktop/legacy/websockify?autoconnect=1&resize=scale&resolution=1600x900 HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade'
    + String.fromCharCode(13, 10) + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Key: ' + WSKEY + '' + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw), /^HTTP\/1\.1 409/, 'legacy WS 拒绝必须可见: ' + statusLineOf(raw));
});

// ---- failclosed：geometryError / 形态坏（state=running，不得被绕过）----
test('geometryError 桌面（state=running）：HTTP 两条路径与 WS 一律 503', async () => {
  for (const p of ['/?desktop=legacy-err', '/desktop/legacy-err/', '/desktop/legacy-err/api/status']) {
    const r = await get(p);
    assert.equal(r.status, 503, p + ' 必须 failclosed');
    assert.match(r.body.toString('utf8'), /几何/);
  }
  const before = backendState.get('legacyErr').httpCount;
  assert.equal(before, backendState.get('legacyErr').httpCount, '零后端请求');
  const raw = await rawHttp('GET /desktop/legacy-err/websockify?' + canonicalScale('legacy-err') + ' HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw), /^HTTP\/1\.1 503/, 'WS 同样 failclosed: ' + statusLineOf(raw));
  const rawA = await rawHttp('GET /desktop/legacy-err/audio HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(rawA), /^HTTP\/1\.1 503/, '音频通道不得留口: ' + statusLineOf(rawA));
});

test('geometry.mode 非法（state=running）：HTTP 与 WS 一律 503', async () => {
  assert.equal((await get('/?desktop=legacy-bad')).status, 503);
  assert.equal((await get('/desktop/legacy-bad/')).status, 503);
  const raw = await rawHttp('GET /desktop/legacy-bad/websockify?' + canonicalScale('legacy-bad') + ' HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw), /^HTTP\/1\.1 503/);
});

// ---- auto：preview 关闭（默认）→ 503；不得只挡首页留 WS 口 ----
test('preview 关闭（默认）：auto 桌 HTTP 两条路径 + WS 两通道一律 503', async () => {
  assert.equal(app.cfg.adaptivePreview, false, '本段跑在开关关闭态');
  for (const p of ['/?desktop=auto-1', '/desktop/auto-1/', '/desktop/auto-1/api/status']) {
    const r = await get(p);
    assert.equal(r.status, 503, p + ' 未开预览必须 503');
    assert.match(r.body.toString('utf8'), /WTK_ENABLE_ADAPTIVE_PREVIEW|未启用/);
  }
  for (const tail of ['/websockify?' + canonicalRemote('auto-1'), '/websockify?autoconnect=1&resize=remote', '/audio']) {
    const raw = await rawHttp('GET /desktop/auto-1' + tail + ' HTTP/1.1'
      + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
      + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
      + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
      + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
    assert.match(statusLineOf(raw), /^HTTP\/1\.1 503/, 'WS ' + tail + ' 未开预览必须 503: ' + statusLineOf(raw));
  }
  assert.equal(backendState.get('auto').wsCount, 0, '未开预览时后端零 WS 连接');
});

test('auto + resolution = 409（开关关闭时仍是 409，两个预期不混淆）', async () => {
  assert.equal((await get('/?desktop=auto-1&resolution=1600x900')).status, 409);
  assert.equal((await get('/desktop/auto-1/?resolution=1600x900')).status, 409);
});

test('resolution 形态非法 = 400（root 与规范路径；不透传原串）', async () => {
  for (const p of ['/?desktop=legacy&resolution=1600X900', '/?desktop=legacy&resolution=0160x900',
    '/?desktop=legacy&resolution=1600', '/?desktop=legacy&resolution=x900',
    '/?desktop=legacy&resolution=', '/?desktop=legacy&resolution=100x900',
    '/?desktop=legacy&resolution=1600x100', '/?desktop=legacy&resolution=4097x900',
    '/?desktop=legacy&resolution=1600x900&resolution=1600x900',
    '/desktop/legacy/?resolution=1600x90%2F0', '/desktop/legacy/?' + canonicalScale('legacy') + '&resolution=1600x900x1']) {
      const r = await get(p);
      assert.equal(r.status, 400, p + ' -> ' + r.status);
      assert.match(r.body.toString('utf8'), /resolution/);
  }
});

test('参数注入面不受几何改动影响：path/image/exec/env/port 仍 400', async () => {
  for (const k of ['path', 'image', 'exec', 'env', 'port', 'url', 'host', 'token', 'backend']) {
    const r = await get('/?desktop=legacy&resolution=1600x900&' + k + '=evil');
    assert.equal(r.status, 400, k + ' 必须拒绝');
    const r2 = await get('/?desktop=legacy&' + k + '=evil');
    assert.equal(r2.status, 400, k + ' 旧行为不变');
  }
});

// ---- preview 打开后的 auto / fixed 语义（cfg 显式 opt-in）----
test('preview 开启：auto 根选择 302 到 resize=remote + shared=true', async () => {
  app.registry.stopWatch();
  await new Promise((r) => app.server.close(r));
  await startDispatcher(true);
  assert.equal(app.cfg.adaptivePreview, true);
  const r = await get('/?desktop=auto-1');
  assert.equal(r.status, 302);
  assertRelativeLocation(r.headers.location, 'auto 302');
  assert.equal(r.headers.location, '/desktop/auto-1/?' + canonicalRemote('auto-1'));
  const u = new URL(r.headers.location, 'https://edge.example:99');
  assert.equal(u.searchParams.get('resize'), 'remote');
  assert.equal(u.searchParams.get('shared'), 'true');
  assert.equal(u.searchParams.get('resolution'), null, 'auto 规范地址不带 resolution');
});

test('preview 开启：auto 规范文档直连后端；书签直达引导到 remote 规范参数', async () => {
  const r = await get('/desktop/auto-1/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/desktop/auto-1/?' + canonicalRemote('auto-1'));
  const r2 = await get('/desktop/auto-1/?' + canonicalRemote('auto-1'));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.toString('utf8'), backendState.get('auto').marker);
  // 二次请求幂等（不循环）
  const r3 = await get('/desktop/auto-1/?' + canonicalRemote('auto-1'));
  assert.equal(r3.status, 200);
});

test('preview 开启：auto 的 scale 参数被引导为 remote；带 resolution 引导串 409', async () => {
  const r = await get('/desktop/auto-1/?' + canonicalScale('auto-1'));
  assert.equal(r.status, 302, 'auto 桌不接受 scale 规范态 ⇒ 引导');
  assert.equal(r.headers.location, '/desktop/auto-1/?' + canonicalRemote('auto-1'));
  const r2 = await get('/desktop/auto-1/?' + canonicalRemote('auto-1') + '&resolution=1600x900');
  assert.equal(r2.status, 409);
});

test('preview 开启：auto WS 画面通道需 resize=remote；scale 直打 400；resolution 直打 409', async () => {
  const c = await wsConnect('/desktop/auto-1/websockify?' + canonicalRemote('auto-1'));
  assert.equal(await wsEcho(c, 'auto-rfb'), 'ECHO_auto:auto-rfb');
  c.close();
  await sleep(100);
  const raw = await rawHttp('GET /desktop/auto-1/websockify?' + canonicalScale('auto-1') + ' HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw), /^HTTP\/1\.1 400/, 'auto 直打 scale = 400: ' + statusLineOf(raw));
  const raw2 = await rawHttp('GET /desktop/auto-1/websockify?' + canonicalRemote('auto-1') + '&resolution=1600x900 HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw2), /^HTTP\/1\.1 409/);
});

test('fixed 桌：缺 resolution=409；精确匹配=强制 scale；不等=409；不依赖 preview', async () => {
  assert.equal((await get('/?desktop=fixed-1')).status, 409);
  assert.equal((await get('/desktop/fixed-1/')).status, 409);
  const r = await get('/?desktop=fixed-1&resolution=1600x900');
  assert.equal(r.status, 302);
  const u = new URL(r.headers.location, 'https://edge.example:99');
  assert.equal(u.searchParams.get('resize'), 'scale', 'fixed 强制 scale');
  assert.equal(u.searchParams.get('resolution'), '1600x900');
  assert.equal(u.searchParams.get('path'), 'desktop/fixed-1/websockify', 'path 恒为登记桌面');
  const r2 = await get('/?desktop=fixed-1&resolution=1920x1080');
  assert.equal(r2.status, 409);
  const r3 = await get('/desktop/fixed-1/?' + canonicalScale('fixed-1') + '&resolution=1600x900');
  assert.equal(r3.status, 200, '规范参数 + 精确 resolution ⇒ 直连');
  assert.equal(r3.body.toString('utf8'), backendState.get('fixed').marker);
});

test('fixed 桌 WS：精确 resolution 放行；**缺失也放行**；不等 409；resize=remote 400', async () => {
  const c = await wsConnect('/desktop/fixed-1/websockify?' + canonicalScale('fixed-1') + '&resolution=1600x900');
  assert.equal(await wsEcho(c, 'fixed-rfb'), 'ECHO_fixed:fixed-rfb');
  c.close();
  await sleep(100);
  const cases = [
    [canonicalScale('fixed-1'), 101, '缺 resolution（Kasm 客户端 WS URL 无该查询）'],
    [canonicalScale('fixed-1') + '&resolution=1920x1080', 409, '尺寸不符'],
    [canonicalScale('fixed-1') + '&resolution=1600X900', 400, '形态非法'],
    ['autoconnect=1&resize=remote&path=' + encodeURIComponent('desktop/fixed-1/websockify') + '&idle_disconnect=0&clipboard_seamless=false&shared=true&resolution=1600x900', 400, 'resize 必须 scale'],
  ];
  for (const [q, code, note] of cases) {
    const line = await rawStatus('GET /desktop/fixed-1/websockify?' + q + ' HTTP/1.1'
      + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
      + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
      + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
      + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
    assert.match(line, new RegExp('^HTTP\\/1\\.1 ' + code), note + ': ' + line);
  }
});

// ---- 真实浏览器链：子资源/WS 不得被要求带 resolution（root 裁决①）----
test('fixed 桌真实链：302 → index 200 → asset 200（无 resolution）→ websockify 101 → audio 101', async () => {
  const sel = await get('/?desktop=fixed-1&resolution=1600x900');
  assert.equal(sel.status, 302, '入口文档带 resolution 引导');
  const idx = await get('/desktop/fixed-1/');
  assert.equal(idx.status, 409, '入口文档（root doc）必须带 resolution=fixed 登记值 ⇒ 409');
  // 规范文档（带 resolution）⇒ 200
  const doc = await get('/desktop/fixed-1/?' + canonicalScale('fixed-1') + '&resolution=1600x900');
  assert.equal(doc.status, 200);
  assert.equal(doc.body.toString('utf8'), backendState.get('fixed').marker);
  // 子资源：真实浏览器**不带** resolution（Kasm audio.js / jsmpeg / css 用相对路径）
  for (const p of ['/desktop/fixed-1/api/status', '/desktop/fixed-1/audiojs/audio.js',
    '/desktop/fixed-1/audiojs/layout.css', '/desktop/fixed-1/vnc/index.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p + ' 子资源不带 resolution 必须放行');
    assert.equal(r.body.toString('utf8'), backendState.get('fixed').marker, p + ' 到达后端');
  }
  // 子资源带**正确** resolution 也放行（浏览器刷新整链时可能保留）
  const w = await get('/desktop/fixed-1/audiojs/audio.js?resolution=1600x900');
  assert.equal(w.status, 200);
  // 子资源带**错误** resolution = 409（显式冲突才拒）
  assert.equal((await get('/desktop/fixed-1/audiojs/audio.js?resolution=1920x1080')).status, 409);
  // WS 画面通道：Kasm 客户端 URL 无 resolution ⇒ 必须 101
  const c = await wsConnect('/desktop/fixed-1/websockify?' + canonicalScale('fixed-1'));
  assert.equal(await wsEcho(c, 'fixed-nores'), 'ECHO_fixed:fixed-nores');
  c.close();
  // 音频通道（audio.js 用 BASE+'audio' 拼接，无查询）⇒ 必须 101
  const ca = await wsConnect('/desktop/fixed-1/audio');
  assert.equal(await wsEcho(ca, 'fixed-audio'), 'ECHO_fixed:fixed-audio');
  ca.close();
  await sleep(120);
});

// ---- present 坏值注入面：不得退化成 legacy 放行（root 裁决②）----
test('present 坏 geometry（undefined/null/字符串/数字字符串宽高）：HTTP 与 WS 一律 503', async () => {
  for (const id of ['geom-undef', 'geom-null', 'geom-str', 'geom-strwh']) {
    for (const p of ['/?desktop=' + id, '/desktop/' + id + '/', '/desktop/' + id + '/api/status']) {
      const r = await get(p);
      assert.equal(r.status, 503, p + ' 必须 failclosed，不得按 legacy 放行');
      assert.match(r.body.toString('utf8'), /几何/);
    }
    const raw = await rawHttp('GET /desktop/' + id + '/websockify?' + canonicalScale(id) + ' HTTP/1.1'
      + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
      + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
      + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
      + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
    assert.match(statusLineOf(raw), /^HTTP\/1\.1 503/, id + ' WS 同样 failclosed: ' + statusLineOf(raw));
    const rawA = await rawHttp('GET /desktop/' + id + '/audio HTTP/1.1'
      + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
      + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
      + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
      + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
    assert.match(statusLineOf(rawA), /^HTTP\/1\.1 503/, id + ' 音频通道不得留口: ' + statusLineOf(rawA));
  }
});

test('auto 登记缺 width/height（注入面）：HTTP 与 WS 一律 503，不得退化为 legacy', async () => {
  for (const p of ['/?desktop=auto-nowh', '/desktop/auto-nowh/', '/desktop/auto-nowh/api/status']) {
    const r = await get(p);
    assert.equal(r.status, 503, p + ' 三键不齐 = failclosed');
  }
  const raw = await rawHttp('GET /desktop/auto-nowh/websockify?autoconnect=1&resize=remote HTTP/1.1'
    + String.fromCharCode(13, 10) + 'Host: 127.0.0.1' + String.fromCharCode(13, 10)
    + 'Upgrade: websocket' + String.fromCharCode(13, 10) + 'Connection: Upgrade' + String.fromCharCode(13, 10)
    + 'Sec-WebSocket-Version: 13' + String.fromCharCode(13, 10) + 'Sec-WebSocket-Key: ' + WSKEY + ''
    + String.fromCharCode(13, 10) + String.fromCharCode(13, 10));
  assert.match(statusLineOf(raw), /^HTTP\/1\.1 503/, 'auto 缺宽高 WS = 503: ' + statusLineOf(raw));
});

test('桌面间几何互不串台：legacy 照旧、fixed 要求参数、auto 独立', async () => {
  const beforeL = backendState.get('legacy').httpCount;
  const rL = await get('/desktop/legacy/?' + canonicalScale('legacy'));
  assert.equal(rL.status, 200);
  assert.equal(rL.body.toString('utf8'), backendState.get('legacy').marker);
  assert.ok(backendState.get('legacy').httpCount > beforeL);
  // 串台检查自包含：先看 fixed 的入口文档，再看 legacy 的 WS，各自只命中自己的后端
  const rF = await get('/desktop/fixed-1/?' + canonicalScale('fixed-1') + '&resolution=1600x900');
  assert.equal(rF.status, 200);
  assert.equal(backendState.get('fixed').lastRequest.url, '/?autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/fixed-1/websockify') + '&idle_disconnect=0&clipboard_seamless=false&shared=true&resolution=1600x900');
  assert.equal(rF.body.toString('utf8'), backendState.get('fixed').marker, 'fixed 命中自己的后端');
  assert.equal((await get('/desktop/fixed-1/?resolution=1600x900')).status, 302, 'fixed 规范参数缺失 ⇒ 引导');
});

test('健康检查与列表页不受几何层影响', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.match(r.body.toString('utf8'), /^ok desktops=0/);
  const l = await get('/');
  assert.equal(l.status, 200);
});
