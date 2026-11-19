'use strict';
// K 线 dispatcher 运行期配置（只读入口，不做容器管理）

const path = require('path');
const { URL } = require('url');

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.floor(n);
}

// 新鲜度门阈值 env 解析（2026-11-14 root 契约补口）：**只可收紧，不可放宽**。
// envInt 接受任意正数 ⇒ 运维写 WTK_GEOMETRY_STALE_MS=31536000000（一年）会把门关掉，
// 直接打破「state=running 快照最长约 180s 可观察有效期」这条边界（90s 陈旧 + 90s 健康证据），
// 也与我方叙述的「env 可收紧」口径不一致。因此上限 = **单点常量本身**（DEFAULTS 的两个值，
// 不引入第二处字面量）：
//   * 未设置 / 空 / 非数字 / 非有限 / 非正（含 floor 后为 0 的小数）⇒ 回落默认（= 不放宽）；
//   * 正数且 floor 后 > 上限 ⇒ **启动期抛错**（fail closed，与本文件 WTK_LISTEN_HOST /
//     WTK_REGISTRY / 端口区间 / WTK_PUBLIC_ORIGIN 的校验同口径）⇒ 不静默 clamp，
//     避免运维写了放宽值却以为生效；
//   * 正数且 <= 上限 ⇒ 采纳（收紧）。小数走 Math.floor ⇒ 只会更小，不可能因小数放宽。
function envIntNoRelax(name, cap) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return cap;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return cap;
  const v = Math.floor(n);
  if (v <= 0) return cap; // 例 0.4 ⇒ floor 0；零阈值 = 恒陈旧，按非法回落默认
  if (v > cap) {
    throw new Error(name + ' 只允许收紧（必须 <= ' + cap + ' ms），收到: ' + raw
      + '；上限 = 单点常量默认值，放宽会打破 registry 新鲜度门的最长约 180s 边界');
  }
  return v;
}

const DEFAULTS = {
  host: '127.0.0.1',            // 主监听仅 loopback，禁 IPv6 / 通配
  port: 25320,
  registry: '/data/app/webtop-kasmvnc/registry.json',
  publicOrigin: 'http://127.0.0.1:25320',
  backendPortMin: 25321,
  backendPortMax: 25329,
  backendHost: '127.0.0.1',
  browserOrigin: '',            // 显式外域浏览器 origin（WTK_BROWSER_ORIGIN）；空 = 关闭
  adaptivePreview: false,       // auto 几何预览总开关；只认 WTK_ENABLE_ADAPTIVE_PREVIEW=1
  // 原生默认（native-default）入口总开关：**默认 false = 旧行为逐字不变**。
  // 只认 WTK_NATIVE_DEFAULT_MODE=1（逐字 '1'；0 / 空 / true / 其它一律视为关闭）。
  // 开启后语义（L3 入口层，逐条限定，不得放大解读）：
  //   * legacy 桌（registry geometry 键缺席）：根选择 302 与桌面根文档规范参数
  //     **不注入 resize 键**（其余 5 件规范参数逐字不变）；客户端可在 URL 上
  //     自带 resize ∈ {off,scale,remote}（Kasm noVNC 客户端合法枚举）， dispatcher 不强行改写；
  //   * **原生默认 ≠ remote**：Kasm 1.1 客户端在 iframe 内的内置默认是 resize=off
  //     （本地缩放，见 ui.js 的 isInsideKasmVDI 分支），且 URL query 优先于 localStorage；
  //     因此本入口**不宣称**「桌面自动跟随窗口尺寸」，也不把 resize 强制成 remote；
  //   * 不接受 resolution 固定分辨率参数（legacy 桌维持 409 口径）；
  //   * 登记了 geometry 的桌（auto / fixed）**不降级**：各自旧行为逐字保留
  //     （auto 未开 preview = 503 fail-closed；fixed 缺参/不等 = 409）。
  nativeDefault: false,
  // registry 新鲜度门（fail-closed，2026-11-14 root 契约）：只作用于**登记了 geometry 的桌面**。
  // 阈值口径 = manager 刷新周期（WT_KASM_REFRESH_INTERVAL 默认 30s）x3 = 90s，
  // 与 manager/attest.py HEALTH_MAX_AGE_S=90 同口径 ⇒ daemon 崩溃 / 刷新抛错 / 写盘失败时
  // 陈旧的 state=running 不得被入口无限放行。
  geometryStaleMs: 90000,
  // mtime 超前容忍（时钟回拨 / 跨机时钟偏差）：与 manager/attest.py CLOCK_SKEW_S=60 同口径。
  // 超过该容忍的「未来 mtime」同样判陈旧 = fail-closed。
  geometrySkewMs: 60000,
};

const LISTEN_HOSTS = new Set(['127.0.0.1', 'localhost']);

// 自适应预览（auto 几何）总开关：默认 false。
// 关闭时 auto 桌的 HTTP 与 WS（websockify / audio）一律 503 failclosed ——
// per-desktop 连接准入与防恶意 SetDesktopSize 由后续 worker 在 server WS admission 实现，
// 未实现前本入口不得把 auto 视为可上线。测试通过 cfg 显式 opt-in，不改全局 env。
function envAdaptivePreview() {
  return String(process.env.WTK_ENABLE_ADAPTIVE_PREVIEW === undefined ? '' : process.env.WTK_ENABLE_ADAPTIVE_PREVIEW).trim() === '1';
}

// 原生默认入口开关（WTK_NATIVE_DEFAULT_MODE）：与 envAdaptivePreview 同口径 ——
// **只认逐字 '1'**（trim 后）；未设置 / 空 / '0' / 'true' / 乱码 ⇒ false（默认关闭）。
// 生产开启是运维决策：本开关只改「入口是否注入 resize」，不改任何后端容器参数，
// 也不构成 KasmVNC 侧 -AcceptSetDesktopSize（L1）的授权声明。
function envNativeDefault() {
  return String(process.env.WTK_NATIVE_DEFAULT_MODE === undefined ? '' : process.env.WTK_NATIVE_DEFAULT_MODE).trim() === '1';
}

// 显式外域浏览器 origin（WTK_BROWSER_ORIGIN，默认空 = 关闭）。
// 只接受**纯 origin**：scheme ∈ {http,https} + host[:port]，禁止凭据 / path / query / hash，
// host 不得含 '*'（明确拒绝，不做来源校验矩阵）。非法值在启动期直接抛清楚错误。
function normalizeBrowserOrigin(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (s === '') return null;
  let u = null;
  try { u = new URL(s); } catch (e) {
    throw new Error('WTK_BROWSER_ORIGIN 不是合法 URL（必须是完整 origin，如 https://example:99），收到: ' + s);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('WTK_BROWSER_ORIGIN 只接受 http/https origin，收到: ' + s);
  }
  if (u.username || u.password) {
    throw new Error('WTK_BROWSER_ORIGIN 不得带凭据，收到: ' + s);
  }
  if (u.pathname !== '' && u.pathname !== '/') {
    throw new Error('WTK_BROWSER_ORIGIN 只接受 origin（不得带 path），收到: ' + s);
  }
  if (u.search) throw new Error('WTK_BROWSER_ORIGIN 不得带 query，收到: ' + s);
  if (u.hash) throw new Error('WTK_BROWSER_ORIGIN 不得带 fragment，收到: ' + s);
  if (!u.hostname) throw new Error('WTK_BROWSER_ORIGIN 缺 host，收到: ' + s);
  if (u.hostname.indexOf('*') >= 0) throw new Error('WTK_BROWSER_ORIGIN 不接受 wildcard，收到: ' + s);
  return { origin: u.protocol + '//' + u.host, host: u.host };
}

function resolveConfig(overrides) {
  const o = overrides || {};
  const cfg = {
    host: String(process.env.WTK_LISTEN_HOST || DEFAULTS.host).trim(),
    port: envInt('WTK_PORT', DEFAULTS.port),
    registry: String(process.env.WTK_REGISTRY || DEFAULTS.registry),
    publicOrigin: String(process.env.WTK_PUBLIC_ORIGIN || DEFAULTS.publicOrigin).trim(),
    browserOrigin: String(process.env.WTK_BROWSER_ORIGIN || DEFAULTS.browserOrigin).trim(),
    backendHost: DEFAULTS.backendHost,
    backendPortMin: envInt('WTK_BACKEND_PORT_MIN', DEFAULTS.backendPortMin),
    backendPortMax: envInt('WTK_BACKEND_PORT_MAX', DEFAULTS.backendPortMax),
    maxWs: envInt('WTK_MAX_WS', 64),
    httpTimeoutMs: envInt('WTK_HTTP_TIMEOUT_MS', 60000),
    missingCacheMs: envInt('WTK_MISSING_CACHE_MS', 2000),
    prefix: '/desktop/',
    adaptivePreview: envAdaptivePreview(),
    nativeDefault: envNativeDefault(),
    // 上限 = DEFAULTS 自身（单点常量）；超上限启动即拒 ⇒ 门不可被 env 关掉
    geometryStaleMs: envIntNoRelax('WTK_GEOMETRY_STALE_MS', DEFAULTS.geometryStaleMs),
    geometrySkewMs: envIntNoRelax('WTK_GEOMETRY_SKEW_MS', DEFAULTS.geometrySkewMs),
  };
  Object.assign(cfg, o);
  const bo = normalizeBrowserOrigin(cfg.browserOrigin);
  cfg.browserOrigin = bo ? bo.origin : '';
  cfg.browserOriginHost = bo ? bo.host : '';

  if (!LISTEN_HOSTS.has(cfg.host)) {
    throw new Error('WTK_LISTEN_HOST 只允许 127.0.0.1 / localhost，收到: ' + cfg.host);
  }
  if (!path.isAbsolute(cfg.registry)) {
    throw new Error('WTK_REGISTRY 必须是绝对路径，收到: ' + cfg.registry);
  }
  if (cfg.backendPortMin > cfg.backendPortMax) {
    throw new Error('WTK_BACKEND_PORT_MIN 不得大于 WTK_BACKEND_PORT_MAX');
  }
  // 内部规范 origin 必须是纯 URL origin（音频映射改写用它，直接消费会带尾 '/' 等偏差 ⇒ 启动即拒）
  if (cfg.publicOrigin) {
    let pu = null;
    try { pu = new URL(String(cfg.publicOrigin).trim()); } catch (e) { pu = null; }
    if (!pu || (pu.protocol !== 'http:' && pu.protocol !== 'https:') || !pu.hostname) {
      throw new Error('WTK_PUBLIC_ORIGIN 必须是合法 http/https origin，收到: ' + cfg.publicOrigin);
    }
    cfg.publicOrigin = pu.protocol + '//' + pu.host;
  }
  return cfg;
}

// 规范选择参数：由 dispatcher 生成，Kasm 客户端 ui.js 消费。
// path 值不带前导斜杠 —— ui.js:1379 是 url += '/' + path 的拼接语义（取证 docker/nginx/wtk.conf.template 注释块）。
function canonicalParams(id) {
  const wsPath = 'desktop/' + id + '/websockify';
  return [
    ['autoconnect', '1'],
    ['resize', 'scale'],
    ['path', wsPath],
    ['idle_disconnect', '0'],
    ['clipboard_seamless', 'false'],
    ['shared', 'true'],
  ];
}

// 规范参数的 resize 变体：'remote' = auto 几何桌面（Kasm 客户端 resizeSession，远端尺寸随视口）。
// 'scale' / 缺省 = 与 canonicalParams 逐字一致（legacy 与 fixed 共用）。
// shared=true 在这两种模式下都只是 iframe 地址参数，**不**代表后端互斥/单用户限制。
function canonicalParamsFor(id, resizeMode) {
  const params = canonicalParams(id);
  if (resizeMode === 'remote') {
    return params.map((p) => (p[0] === 'resize' ? ['resize', 'remote'] : p));
  }
  return params;
}

// Kasm / noVNC 客户端 resize 下拉框的合法枚举（取证：vnc.html
// <select id="noVNC_setting_resize" name="vncResize"> 的 option value = off / scale / remote）。
// 只用于**客户端自带值**的形态校验；native-default 模式下 dispatcher 自己**不注入**该键。
const RESIZE_CLIENT_VALUES = new Set(['off', 'scale', 'remote']);

// native-default（opt-in）模式的规范参数集 = canonicalParams **去掉 resize 一件**，
// 其余 5 件逐字逐序不变（autoconnect / path / idle_disconnect / clipboard_seamless / shared）。
// 单独成函数而不是给 canonicalParamsFor 加第三态，是为了让「不注入」这件事在调用点显式可读，
// 并且旧函数（canonicalParams / canonicalParamsFor）的产物字节序完全不动。
function canonicalParamsNative(id) {
  return canonicalParams(id).filter((p) => p[0] !== 'resize');
}

// ---------------- 几何与 resolution 值契约（registry 侧新增，只读） ----------------
const GEOMETRY_MODES = new Set(['auto', 'fixed']);
const RESOLUTION_RE = /^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/;
const RES_WIDTH = { min: 320, max: 4096 };
const RES_HEIGHT = { min: 240, max: 4096 };

function inRange(v, r) {
  return Number.isInteger(v) && v >= r.min && v <= r.max;
}

// 解析 URL 里的 resolution=WxH。只接受规范形态：小写 x、3..4 位、无前导 0，
// 宽 320..4096 / 高 240..4096；大写 X、前导 0、只给宽/只给高、空值、重复值一律判不合法。
// 返回 {ok:true,width,height,canonical} 或 {ok:false,msg}；调用方据此回 400，
// 后续 Location 只使用返回的整数字符串，**不透传**用户原样字节。
function parseResolution(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw);
  if (s === '') return { ok: false, msg: 'resolution 为空' };
  if (!RESOLUTION_RE.test(s)) return { ok: false, msg: 'resolution 格式不合法（需 宽x高，如 1600x900）' };
  const i = s.indexOf('x');
  const w = Number(s.slice(0, i));
  const h = Number(s.slice(i + 1));
  if (!inRange(w, RES_WIDTH)) return { ok: false, msg: 'resolution 宽度超出 320..4096' };
  if (!inRange(h, RES_HEIGHT)) return { ok: false, msg: 'resolution 高度超出 240..4096' };
  return { ok: true, width: w, height: h, canonical: w + 'x' + h };
}

// registry 条目的 geometry 归一 —— 与 registry.js 侧 validateGeometry **同口径**（双侧独立校验，
// 2026-11-14 root 裁决收紧）：
//   仅「**键缺席**」= legacy ⇒ 由调用方用 hasOwnProperty 判定后传 undefined，此处 undefined => null
//   null / 非对象 / 数组 / 非纯对象（含 present-undefined 值） => ok:false（503 failclosed）
//   键集合必须**恰好** ⊆ {mode,width,height} 且三键 hasOwnProperty 齐备 => 缺任一键 ok:false
//   mode 必须是字符串且 ∈ {auto,fixed}
//   width/height 必须 **typeof === 'number'** 且 Number.isInteger 且在范围内
//     ⇒ 数字字符串（'1600'）与 null / undefined 值一律拒绝（不再 Number() 宽化）
//   多余字段（backend / exec / canonical …）一律 ok:false，不接受注入面
// auto 的 width/height = 登记初始尺寸（不参与连接判定，canonical 恒 null）。
const GEOMETRY_KEYS = ['mode', 'width', 'height'];
const GEOMETRY_KEYSET = new Set(GEOMETRY_KEYS);
function normalizeGeometry(raw) {
  if (raw === undefined) return { ok: true, geometry: null };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, msg: 'geometry 必须是对象，实为 ' + (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw) };
  }
  for (const k of Object.keys(raw)) {
    if (!GEOMETRY_KEYSET.has(k)) return { ok: false, msg: 'geometry 含未知键: ' + k };
  }
  for (const k of GEOMETRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) return { ok: false, msg: 'geometry 缺键: ' + k };
  }
  const mode = raw.mode;
  if (typeof mode !== 'string' || !GEOMETRY_MODES.has(mode)) {
    return { ok: false, msg: 'geometry.mode 必须是 auto/fixed' };
  }
  const width = raw.width;
  const height = raw.height;
  if (typeof width !== 'number' || !Number.isInteger(width) || !inRange(width, RES_WIDTH)) {
    return { ok: false, msg: 'geometry.width 必须是 320..4096 的整数' };
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || !inRange(height, RES_HEIGHT)) {
    return { ok: false, msg: 'geometry.height 必须是 240..4096 的整数' };
  }
  if (mode === 'fixed') {
    return { ok: true, geometry: { mode: 'fixed', width: width, height: height, canonical: width + 'x' + height } };
  }
  return { ok: true, geometry: { mode: 'auto', width: width, height: height, canonical: null } };
}

// 从 registry 条目读取几何（**server 三处入口必须用这个，不要直接 normalizeGeometry(entry.geometry)**）：
// 只有「geometry 键缺席」才是 legacy；键存在但值是 undefined / null / 数字 / 字符串 / 数组 /
// 三键不齐 / 多余字段 ⇒ ok:false ⇒ 调用方 503 failclosed。
// 直接写 entry.geometry 无法区分 present-undefined 与键缺席，因此必须走 hasOwnProperty。
function normalizeEntryGeometry(entry) {
  if (!entry || typeof entry !== 'object' ||
      !Object.prototype.hasOwnProperty.call(entry, 'geometry')) {
    return { ok: true, geometry: null };
  }
  const raw = entry.geometry;
  if (raw === undefined) return { ok: false, msg: 'geometry 键存在但值为 undefined（仅键缺席才是 legacy）' };
  if (raw === null) return { ok: false, msg: 'geometry 键存在但值为 null（仅键缺席才是 legacy）' };
  return normalizeGeometry(raw);
}

// 允许透传的少量 Kasm 显示参数：键白名单 + 取值枚举，不扩大攻击面
const CLIENT_PARAM_WHITELIST = {
  show_control_bar: /^(0|1|true|false)$/,
  bell: /^(on|off)$/,
  reconnect: /^(true|false)$/,
  reconnect_delay: /^[0-9]{1,6}$/,
};

const FORCED_PARAM_KEYS = new Set(['autoconnect', 'resize', 'path', 'idle_disconnect', 'clipboard_seamless', 'shared']);

const STATES = new Set(['running', 'stopped', 'starting', 'error']);

module.exports = {
  resolveConfig,
  normalizeBrowserOrigin,
  canonicalParams,
  canonicalParamsFor,
  canonicalParamsNative,
  RESIZE_CLIENT_VALUES,
  normalizeGeometry,
  normalizeEntryGeometry,
  parseResolution,
  GEOMETRY_MODES,
  RESOLUTION_RE,
  RES_WIDTH,
  RES_HEIGHT,
  envAdaptivePreview,
  envNativeDefault,
  envIntNoRelax,
  CLIENT_PARAM_WHITELIST,
  FORCED_PARAM_KEYS,
  DEFAULTS,
  STATES,
  GEOMETRY_STALE_MS: DEFAULTS.geometryStaleMs,
  GEOMETRY_SKEW_MS: DEFAULTS.geometrySkewMs,
};

