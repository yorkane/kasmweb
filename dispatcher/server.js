
'use strict';
// K 线单入口 dispatcher：127.0.0.1:25320
// - 根只认 ?desktop=<registered slug>，其它参数 400；无参数 = 列表页（不自动连接）
// - /desktop/<id>/ 前缀 = 该桌面的完整 HTTP/WS 反代（strip 一次到登记后端 root）
// - 状态裁决：running 反代；stopped/starting/error 规范路径统一 503（GET 不自动启动）
// - 无 last-desktop 全局；root 下 /websockify /audio 不 fallback
// - 本服务是 loopback 免密功能层；认证授权全交 authz；不 exec 任何命令

const http = require('http');
const { URL } = require('url');

const { resolveConfig, canonicalParams, normalizeEntryGeometry } = require('./lib/config');
const { Registry } = require('./lib/registry');
const selector = require('./lib/selector');
const proxy = require('./lib/proxy');
const pages = require('./lib/pages');
const { parseResolution } = require('./lib/config');

const WS_ALLOWED_SUFFIX = ['/websockify', '/audio'];

// ============================ 逐桌 auto 屏幕 WS 准入（进程内） ============================
// 作用范围（**不得放大解读**）：cfg.adaptivePreview === true 时，对 registry 登记
//   geometry.mode === 'auto' 的桌面，**画面**通道（tail === '/websockify'）给每桌 1 个
//   「预留 + 已连接」合并名额；名额已被占用 ⇒ 第 2 个 upgrade 在进 proxy 之前直接 HTTP 409。
//   同目录的 /audio 通道是独立通道，**不占画面配额**，行为逐字旧版；
//   legacy（geometry 键缺席）与 fixed 桌的 WS 完全不受本门影响（仍只受全局 maxWs 约束）。
// 语义边界（诚实声明，测试与部署都按此口径）：
//   * 名额是本 createDispatcher 实例内的一张 Map ⇒ **per-process**，不是跨 dispatcher 的唯一权威；
//     两个 dispatcher 进程共读同一 registry 时各自计数，互不可见。
//   * 客户端直接连后端 loopback 端口（不经本入口）⇒ 完全绕过本门，本门只能约束「经本入口的流量」。
//   * 因此 `WTK_ENABLE_ADAPTIVE_PREVIEW=1` **只限隔离的单 dispatcher 测试环境**使用：
//     它是「给多桌面隔离分辨率做测试预览」的安全底座，**不是生产安全门**，
//     不宣称跨进程互斥，也不宣称任何尺寸/分辨率层面的安全性。默认 flag 保持 false，不改。
//   * server.close 只做优雅关闭：不主动杀任何已建立的用户外部连接（无 closeAllConnections）。
// =================================================================================================

const ADAPTIVE_VIDEO_TAIL = '/websockify';

// 几何裁决的 409/503 文案标题（状态页标题；msg 由 selector 给出，不含路径/堆栈）
const GEOM_TITLE = { 409: '几何参数与登记冲突', 503: '几何登记不合法或未开放', 400: '请求参数不合法' };

function parseRes(raw) {
  return parseResolution(raw);
}

// query 键值收集（不做任何校验，只取首值 + 记录 resolution 是否出现）
function parseQueryPairs(search) {
  const out = { resolution: '', resolutionSeen: false, resize: '' };
  for (const [rk, rv] of selector.splitQuery(search)) {
    let key;
    try { key = decodeURIComponent(rk); } catch (e) { continue; }
    if (key === 'resolution') {
      if (out.resolutionSeen) { out.resolutionBad = true; continue; }
      out.resolutionSeen = true;
      try { out.resolution = decodeURIComponent(rv); } catch (e) { out.resolution = ''; out.resolutionBad = true; }
      continue;
    }
    if (key === 'resize' && out.resize === '') {
      try { out.resize = decodeURIComponent(rv); } catch (e) { /* ignore */ }
    }
  }
  return out;
}

function collectExtras(search) {
  const extras = [];
  for (const [rk, rv] of selector.splitQuery(search)) {
    try {
      const key = decodeURIComponent(rk);
      const re = require('./lib/config').CLIENT_PARAM_WHITELIST[key];
      if (re) {
        const val = decodeURIComponent(rv);
        if (re.test(val)) extras.push([key, val]);
      }
    } catch (e) { /* ignore */ }
  }
  return extras;
}

// 路由一律按**原始 request-target**裁决，不用 new URL() 的 pathname：
// WHATWG URL 会把 %2e%2e / %2e 当点段折叠，令 /desktop/%2e%2e/ 静默变成 /，
// 绕过 slug 校验；同时 URL 会重新序列化 query，破坏「strip 一次 + query 原样透传」。
function splitRawUrl(url) {
  const i = url.indexOf('?');
  const h = url.indexOf('#');
  const noFrag = h < 0 ? url : url.slice(0, h);
  const q = noFrag.indexOf('?');
  return {
    rawPath: q < 0 ? noFrag : noFrag.slice(0, q),
    search: q < 0 ? '' : noFrag.slice(q + 1),
  };
}

function makeStats(logger) {
  const counters = new Map();
  const lat = { ws: [] };
  return {
    count(name) { counters.set(name, (counters.get(name) || 0) + 1); },
    get(name) { return counters.get(name) || 0; },
    timing(ms) { lat.ws.push(ms); if (lat.ws.length > 200) lat.ws.shift(); },
    log(level, msg) { logger(level, msg); },
    snapshot() {
      const o = {};
      for (const [k, v] of counters) o[k] = v;
      return o;
    },
  };
}

// 逐桌名额表（**进程内**）：一桌一个「预留 + 已连接」合并名额。
// reserve(key) 成功返回该名额的释放函数，名额已在占用中返回 null；
// 释放函数幂等（重复调用返回 false 且不再动表）⇒ 计数不可能为负、不会误删他人占位。
// 只服务本 createDispatcher 实例：不入 registry、不落盘、不跨进程（见上方范围声明）。
function createDesktopWsAdmission() {
  const held = new Map();
  return {
    reserve(key) {
      if (held.get(key) === true) return null;
      held.set(key, true);
      let released = false;
      return function release() {
        if (released) return false;
        released = true;
        if (held.get(key) === true) held.delete(key);
        return true;
      };
    },
    held(key) { return held.get(key) === true; },
    size() { return held.size; },
  };
}

// registry 条目的几何模式：'auto' / 'fixed' / null（null = legacy 键缺席）/ 'invalid'（present 坏值）
// 与三处几何门同一入口 normalizeEntryGeometry，不另开读法（不据 geometry 改后端地址）。
function geometryModeOf(entry) {
  const g = normalizeEntryGeometry(entry);
  if (!g.ok) return 'invalid';
  return g.geometry ? g.geometry.mode : null;
}

function rawReject(socket, code, text) {
  // 只 end() 不立即 destroy()：write 后立刻 destroy 会把刚排的响应冲掉，
  // 客户端看到 0 字节（root 实测：WS 拒绝路径返回空 ⇒ 拿不到 502/503 状态行）
  if (!socket || socket.destroyed) return;
  const body = String(text);
  const msg = 'HTTP/1.1 ' + code + ' ' + text + String.fromCharCode(13, 10)
    + 'content-type: text/plain; charset=utf-8' + String.fromCharCode(13, 10)
    + 'content-length: ' + Buffer.byteLength(body) + String.fromCharCode(13, 10)
    + 'connection: close' + String.fromCharCode(13, 10)
    + String.fromCharCode(13, 10) + body;
  socket.once('error', () => {});
  try { socket.write(msg); } catch (e) { /* ignore */ }
  socket.end();
  socket.once('close', () => { if (!socket.destroyed) socket.destroy(); });
}

function createDispatcher(opts) {
  const o = opts || {};
  const cfg = o.cfg || resolveConfig();
  // 新鲜度阈值随 cfg 下发（WTK_GEOMETRY_STALE_MS / WTK_GEOMETRY_SKEW_MS；缺省 90s / 60s，
  // 且**只可收紧不可放宽**：env 超过常量上限 ⇒ resolveConfig 启动即抛错，注入超上限 ⇒
  // Registry 构造器夹到常量 ⇒ 阈值不可能被配置放大，见 lib/config.js envIntNoRelax）。
  // 语义见 lib/registry.js 文件头「registry 新鲜度门」：**只约束新准入**
  // （本文件的四处门：根选择器 / 桌面根文档 / 子资源 / WS upgrade），
  // 已建立的 WS 连接不会被切断；legacy（geometry 键缺席）桌面完全不受影响。
  const registry = o.registry || new Registry(cfg.registry, {
    missingCacheMs: cfg.missingCacheMs,
    staleMs: cfg.geometryStaleMs,
    skewMs: cfg.geometrySkewMs,
  });
  const logger = o.logger || ((level, msg) => {
    const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg + String.fromCharCode(10);
    process.stderr.write(line);
  });
  const stats = makeStats(logger);
  let wsActive = 0;
  // 逐桌 auto 画面 WS 名额（见文件头范围声明：进程内、单 dispatcher、非生产安全门）
  const desktopWs = createDesktopWsAdmission();

  const sendHtml = (res, code, html) => {
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  };
  const sendError = (res, code, title, msg, extra) => {
    sendHtml(res, code, pages.statusPage(code, title, msg, extra));
  };

  const server = http.createServer((req, res) => {
    const parsed = splitRawUrl(String(req.url || ''));
    const pathname = parsed.rawPath;
    const search = parsed.search;
    if (pathname.charCodeAt(0) !== 47) {
      sendError(res, 400, '请求不合法', '请求目标必须是绝对路径');
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      const reg = registry.read();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok desktops=' + reg.desktops.length + '\n');
      return;
    }

    if (pathname.indexOf(cfg.prefix) === 0) {
      handleDesktop(req, res, pathname, search);
      return;
    }
    // 原生默认入口（WTK_NATIVE_DEFAULT_MODE=1，默认关闭）：根路径对 resize 的
    // 放宽只发生在**未登记几何的 legacy 桌**（见下方几何门）；关闭时逐字旧行为
    // —— ?resize=... 判「不支持的参数: resize」400。
    const d = selector.decideRoot(pathname, search, { nativeMode: cfg.nativeDefault === true });
    if (d.kind === 'list') {
      const reg = registry.read();
      sendHtml(res, 200, pages.listPage(reg));
      return;
    }
    if (d.kind === 'select') {
      const entry = registry.byId(d.id);
      if (!entry) {
        sendError(res, 404, '桌面未登记', '该桌面不在登记表中');
        return;
      }
      // 几何门：**先于** state 判定（registry 标记 geometryError 的条目不得因 state=running 放行）
      const g = normalizeEntryGeometry(entry);
      const dec = selector.decideGeometry(entry, g.ok ? g.geometry : 'invalid', d.resolution,
        cfg.adaptivePreview === true, cfg.nativeDefault === true);
      if (dec.action === 'error') {
        stats.count('geom_reject_' + dec.code);
        sendError(res, dec.code, GEOM_TITLE[dec.code] || '请求不合法', dec.msg);
        return;
      }
      // 原生默认只放宽**未登记几何**（legacy）桌的 resize；登记了 geometry 的桌
      //（auto / fixed）resize 由入口规范决定 ⇒ 客户端自带 resize 一律 400，
      // 不得把这类桌面隐式降级成 legacy 通道。
      if (d.resize !== null && d.resize !== undefined && dec.resizeMode) {
        stats.count('geom_reject_400');
        sendError(res, 400, GEOM_TITLE[400],
          '该桌面已登记几何，resize 由入口规范决定（' + dec.resizeMode + '），不接受客户端 resize');
        return;
      }
      if (entry.state !== 'running') {
        sendError(res, 503, '桌面未运行', '桌面 ' + entry.name + ' 当前状态：' + entry.state, { autostartNotice: true });
        return;
      }
      const loc = selector.canonicalLocation(cfg.publicOrigin, d.id, d.extras, {
        resizeMode: dec.resizeMode,
        resolution: dec.resolution,
        nativeMode: cfg.nativeDefault === true,
        resize: d.resize,
      });
      if (dec.native === true) stats.count('native_select_pass');
      res.writeHead(302, { location: loc, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (d.kind === 'error') {
      sendError(res, d.code, '请求参数不合法', d.msg, { form: true });
      return;
    }
    sendError(res, 404, '未找到', 'root 路径无桌面 id：不提供 fallback');
  });

  function handleDesktop(req, res, pathname, search) {
    const d = selector.decideDesktop(pathname, search, cfg.prefix);
    if (d.kind === 'error') {
      sendError(res, d.code, '请求参数不合法', d.msg);
      return;
    }
    if (d.kind !== 'desktop') {
      sendError(res, 404, '未找到', '桌面路由不合法');
      return;
    }
    const entry = registry.byId(d.id);
    if (!entry) {
      sendError(res, 404, '桌面未登记', '该桌面不在登记表中');
      return;
    }
    // 几何门：**先于** state 判定。桌面根文档与子资源都过同一道门；
    // 规范参数（resize / resolution）形态由下式统一解析，其它路径只做存在性校验。
    const g = normalizeEntryGeometry(entry);
    const geomMode = g.ok ? g.geometry : 'invalid';
    const rootDoc = (d.tail === '/' || d.tail === '/index.html') && (req.method === 'GET' || req.method === 'HEAD');
    if (rootDoc) {
      const qp = parseQueryPairs(d.search);
      if (qp.resolutionBad) {
        stats.count('geom_reject_400');
        sendError(res, 400, GEOM_TITLE[400], 'resolution 参数重复');
        return;
      }
      let resolution = null;
      let resolutionError = null;
      if (qp.resolutionSeen) {
        const parsed = parseRes(qp.resolution);
        if (parsed.ok) resolution = parsed;
        else resolutionError = 'resolution 不合法：' + parsed.msg;
      }
      const nativeOn = cfg.nativeDefault === true;
      const dec = selector.decideGeometry(entry, geomMode, resolution, cfg.adaptivePreview === true, nativeOn);
      if (dec.action === 'error') {
        if (resolutionError && dec.code === 409) {
          stats.count('geom_reject_400');
          sendError(res, 400, GEOM_TITLE[400], resolutionError);
          return;
        }
        stats.count('geom_reject_' + dec.code);
        sendError(res, dec.code, GEOM_TITLE[dec.code] || '请求不合法', dec.msg);
        return;
      }
      if (resolutionError) {
        stats.count('geom_reject_400');
        sendError(res, 400, GEOM_TITLE[400], resolutionError);
        return;
      }
      if (entry.state !== 'running') {
        sendError(res, 503, '桌面未运行', '桌面 ' + entry.name + ' 当前状态：' + entry.state, { autostartNotice: true });
        return;
      }
      const target = proxy.backendTarget(entry, cfg);
      if (!target) {
        sendError(res, 503, '后端登记不合法', '该桌面登记的端口不在授权范围');
        return;
      }
      // 几何要求引导（legacy 无参 / auto / fixed 齐参）=> 302 到该模式的规范参数
      const b = selector.bootstrapDecision(d.id, d.search, {
        resizeMode: dec.resizeMode, resolution: dec.resolution, nativeMode: nativeOn,
      });
      if (b.action === 'redirect') {
        res.writeHead(302, {
          location: selector.canonicalLocation(cfg.publicOrigin, d.id, collectExtras(d.search), {
            resizeMode: dec.resizeMode,
            resolution: dec.resolution,
            nativeMode: nativeOn,
            // 引导跳转必须保住已校验的单个 resize（off/scale/remote）。
            // 不传 ⇒ /desktop/<id>/?resize=remote 缺规范项时被静默抹掉（2026-11-16 缺陷）。
            // b.resize 只可能是 bootstrapDecision 校验通过的单值；重复/非法时恒为 null
            // ⇒ 回落「无 resize」规范态，绝不自动取其中一个、不伪造。
            resize: b.resize === undefined ? null : b.resize,
          }),
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      if (b.action === 'error') {
        sendError(res, b.code, '请求参数不合法', b.msg);
        return;
      }
      proxy.proxyHttpRequest(req, res, entry, cfg, target, stats, d.tail + (d.search ? '?' + d.search : ''));
      return;
    }
    // 非入口文档（静态 asset / js / css / audiojs / api / 子路径）：子资源请求**不要求** resolution
    // —— 真实浏览器（含 Kasm 自带 audio.js）在子资源上不带该查询；只在显式带上且冲突时拒绝。
    const qp2 = parseQueryPairs(d.search);
    if (qp2.resolutionBad) {
      stats.count('geom_reject_400');
      sendError(res, 400, GEOM_TITLE[400], 'resolution 参数重复');
      return;
    }
    let res2 = null;
    if (qp2.resolutionSeen) {
      const parsed = parseRes(qp2.resolution);
      if (!parsed.ok) {
        stats.count('geom_reject_400');
        sendError(res, 400, GEOM_TITLE[400], 'resolution 不合法：' + parsed.msg);
        return;
      }
      res2 = parsed;
    }
    const dec2 = selector.decideAsset(entry, geomMode, res2, cfg.adaptivePreview === true,
      cfg.nativeDefault === true);
    if (dec2.action === 'error') {
      stats.count('geom_reject_' + dec2.code);
      sendError(res, dec2.code, GEOM_TITLE[dec2.code] || '请求不合法', dec2.msg);
      return;
    }
    if (entry.state !== 'running') {
      sendError(res, 503, '桌面未运行', '桌面 ' + entry.name + ' 当前状态：' + entry.state, { autostartNotice: true });
      return;
    }
    const target = proxy.backendTarget(entry, cfg);
    if (!target) {
      sendError(res, 503, '后端登记不合法', '该桌面登记的端口不在授权范围');
      return;
    }
    // strip 一次：tail 为原始（percent 编码保留）路径，query 原样拼接，不重新编码
    proxy.proxyHttpRequest(req, res, entry, cfg, target, stats, d.tail + (d.search ? '?' + d.search : ''));
  }

  server.on('upgrade', (req, socket, head) => {
    const parsed = splitRawUrl(String(req.url || ''));
    if (parsed.rawPath.charCodeAt(0) !== 47) { rawReject(socket, 400, 'bad request'); return; }
    const d = selector.decideDesktop(parsed.rawPath, parsed.search, cfg.prefix);
    if (d.kind === 'error') { rawReject(socket, 400, 'bad request'); return; }
    if (d.kind !== 'desktop') { rawReject(socket, 404, 'not found'); return; }
    // 尾部逐字比对原始（percent 编码未解码）路径 ⇒ 不接受 /websockify%2Fx 之类的二次路径
    const suffixOk = WS_ALLOWED_SUFFIX.some((s) => d.tail === s);
    if (!suffixOk) { rawReject(socket, 400, 'upgrade path not allowed'); return; }
    const entry = registry.byId(d.id);
    if (!entry) { rawReject(socket, 404, 'not found'); return; }
    // 几何预检：**先于** state 判定（geometryError / 形态坏的条目不得因 state=running 进入）
    // 逐字原始 query 的键值形态判定；浏览器手写 URL 直打 WS 也走同一道门。
    const g = normalizeEntryGeometry(entry);
    const qp = parseQueryPairs(parsed.search);
    const gw = selector.decideGeometryWs(entry, g.ok ? g.geometry : 'invalid', {
      kind: d.tail === '/audio' ? 'audio' : 'video',
      resize: qp.resize,
      resolution: qp.resolution,
      resolutionPresent: qp.resolutionSeen,
      previewEnabled: cfg.adaptivePreview === true,
      nativeMode: cfg.nativeDefault === true,
    });
    if (gw.action === 'reject') {
      stats.count('geom_ws_reject_' + gw.code);
      stats.log('warn', 'geometry ws reject desktop=' + d.id + ' code=' + gw.code + ' reason=' + gw.reason);
      rawReject(socket, gw.code, gw.reason);
      return;
    }
    if (gw.native === true) stats.count('native_ws_pass');
    if (entry.state !== 'running') { rawReject(socket, 503, 'desktop not running'); return; }
    const target = proxy.backendTarget(entry, cfg);
    if (!target) { rawReject(socket, 503, 'backend registration invalid'); return; }
    if (wsActive >= cfg.maxWs) {
      stats.count('ws_over_limit');
      rawReject(socket, 503, 'too many connections');
      return;
    }
    // 逐桌 auto 画面 WS 名额：只在「preview 开 + 本桌登记 geometry.mode==='auto'
    // + tail 逐字 === '/websockify'」时生效，且**在进入 proxy 之前**预留，避免并发双进。
    //   * 名额 = 该桌 1 个「预留 + 已连接」合并名额；已被占 ⇒ 第 2 个连接直接 409（不进 proxy）。
    //   * 同目录 /audio 不占名额、行为逐字旧版；legacy / fixed / geometry 坏值桌不进本门。
    //   * 全局 maxWs 门在它之前，语义不变（legacy/fixed 仅受全局约束）。
    // 释放挂在 proxy 的 release 回调上（见下）：握手成功、握手失败、对端 close、
    // socket 提前 error/close、同步抛错五条路径各自恰好一次，且释放函数幂等 ⇒ 计数不为负。
    let releaseDesktop = null;
    if (cfg.adaptivePreview === true && d.tail === ADAPTIVE_VIDEO_TAIL && geometryModeOf(entry) === 'auto') {
      const r = desktopWs.reserve(entry.id);
      if (!r) {
        stats.count('ws_desktop_busy');
        stats.log('warn', 'ws desktop screen busy desktop=' + entry.id + ' tail=' + d.tail);
        rawReject(socket, 409, 'desktop screen busy');
        return;
      }
      releaseDesktop = r;
    }
    wsActive += 1;
    // 双计数器（全局 wsActive + 逐桌名额）的合并释放闸门：幂等，保证两条路径各释放恰好一次。
    let slotsFreed = false;
    const freeSlots = () => {
      if (slotsFreed) return false;
      slotsFreed = true;
      wsActive -= 1;
      if (releaseDesktop) releaseDesktop();
      return true;
    };
    const wsPathStr = (d.tail || '/') + (parsed.search ? '?' + parsed.search : '');
    // proxyWebSocket 内部的 finish 已由 done 标志保证 release 至多一次；这里补两条 proxy 兜不住的路径：
    //   * 同步抛错（net.connect 收到越界端口等）：proxy 的清理钩子尚未注册就抛出 ⇒ 当场释放，
    //     且异常不得抛穿 upgrade 监听器（抛穿 = 整个 dispatcher 进程未捕获异常退出）。
    //   * proxy 同步返回前连接已被拆（客户端瞬时断开）：proxy 的 finish 可能已在同步阶段跑完，
    //     由 socket.destroyed 兜底确认槽位已落地。
    // 两条路径与 proxy 的 release 共用同一个幂等闸门 ⇒ 每个连接恰好释放一次，计数不会为负。
    let proxyReturned = false;
    try {
      proxy.proxyWebSocket(req, socket, head, entry, cfg, target, stats, freeSlots, wsPathStr);
      // 同步返回 = proxy 的清理钩子（upstream error/close、socket error/close/end）已全部注册，
      // 后续释放责任移交 proxy 的 release 回调。
      proxyReturned = true;
    } catch (e) {
      stats.count('ws_proxy_sync_error');
      stats.log('warn', 'ws proxy sync failure desktop=' + entry.id + ' note=' + String((e && (e.code || e.message)) || 'error').slice(0, 120));
    } finally {
      if (!proxyReturned || socket.destroyed) {
        try { freeSlots(); } catch (e2) { /* 释放闸门自身不得抛穿 upgrade 监听器 */ }
      }
      if (!proxyReturned && !socket.destroyed) {
        try { socket.destroy(); } catch (e3) { /* ignore */ }
      }
    }
  });

  server.on('clientError', (err, socket) => {
    stats.count('client_error');
    if (socket && !socket.destroyed) socket.destroy();
  });

  // desktopWs 只读探针（size/held）仅供测试与观测：不暴露 reserve/delete，避免外部放宽门禁。
  // server 走优雅关闭：不在 close 时主动杀任何已建立的用户外部连接。
  return {
    server, cfg, registry, stats,
    get wsActive() { return wsActive; },
    get desktopWsSlots() { return { size: desktopWs.size(), held: (id) => desktopWs.held(id) }; },
  };
}

function main() {
  const cfg = resolveConfig();
  const app = createDispatcher({ cfg });
  app.registry.startWatch(1000);
  app.server.listen(cfg.port, cfg.host, () => {
    logger('info', 'dispatcher listening on http://' + cfg.host + ':' + cfg.port + ' registry=' + cfg.registry);
    // 开关状态逐条如实播报（措辞门禁：native-default ≠ remote，不宣称「自动跟随」）。
    // L1 服务端许可（KasmVNC -AcceptSetDesktopSize）由镜像/容器参数决定，本行不代表其取值。
    logger('info', 'gate adaptive-preview=' + (cfg.adaptivePreview === true ? 'on' : 'off')
      + ' native-default=' + (cfg.nativeDefault === true ? 'on' : 'off')
      + (cfg.nativeDefault === true
        ? '（legacy 桌入口不注入 resize；Kasm iframe 客户端内置默认 off=不主动缩放也不请求远端改尺寸，'
          + 'URL 可自选 off/scale/remote；原生默认 ≠ remote，不宣称桌面尺寸自动跟随；'
          + 'resolution 固定分辨率不接受；已登记几何的 auto/fixed 桌维持各自 fail-closed 旧行为；'
          + '免责声明：Kasm 客户端 webutil.js getConfigVar 的 # fragment 优先于 query，'
          + '本入口只规范 query，不宣称能约束客户端 hash；'
          + 'fixed 几何的真实性依赖后端 -AcceptSetDesktopSize=0）'
        : '（默认关闭：行为逐字旧版，resize 由入口注入 scale/remote）'));
  });
  app.server.on('error', (e) => {
    logger('error', 'listen failed: ' + (e && e.code ? e.code : 'error'));
    process.exit(1);
  });
  function logger(level, msg) {
    process.stderr.write('[' + new Date().toISOString() + '] ' + level + ' ' + msg + String.fromCharCode(10));
  }
  process.on('SIGTERM', () => { app.registry.stopWatch(); app.server.close(() => process.exit(0)); });
}

if (require.main === module) main();

module.exports = { createDispatcher, makeStats };
