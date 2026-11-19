
'use strict';
// 选择器解析：URL -> 「根选择器」/「桌面前缀路由」两类决策 + 参数白名单裁决
// server.js 只按 kind 执行，不含 URL 逻辑
// 契约：根路径只认 desktop 与少量显示参数白名单，其它参数（含 image/exec/env/port/path/url）
//       一律 400；desktop 值必须是已校验 slug，不接受 URL / 路径

const {
  CLIENT_PARAM_WHITELIST, FORCED_PARAM_KEYS,
  canonicalParams, canonicalParamsFor, canonicalParamsNative,
  RESIZE_CLIENT_VALUES, parseResolution,
} = require('./config');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const BS = String.fromCharCode(92);

// 明确禁止的选择类参数（试图指定后端 / 镜像 / 执行 / 端口 / 凭据）
const FORBIDDEN_KEYS = new Set([
  'image', 'url', 'uri', 'exec', 'env', 'port', 'host', 'hostname',
  'backend', 'target', 'addr', 'address', 'registry', 'token', 'password',
  'passwd', 'container', 'proxy', 'upstream', 'forward', 'dest', 'destination',
  'path', 'argv', 'cmd', 'command',
]);

function bad(code, msg) {
  return { kind: 'error', code: code, msg: msg };
}

function splitQuery(qs) {
  const out = [];
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out.push([part, '']);
    else out.push([part.slice(0, i), part.slice(i + 1)]);
  }
  return out;
}

function decodeStrict(v) {
  try { return decodeURIComponent(v); } catch (e) { return null; }
}

// 裁决根路径（/ 与 /websockify、/audio 等 root 无桌面 id 资源）
// opts（可选，缺省 = 逐字旧行为）：{ nativeMode: true } = 原生默认入口已启用
// （WTK_NATIVE_DEFAULT_MODE=1，且本桌 geometry 键缺席 = legacy）。仅此模式下、
// 仅对 legacy 桌放宽 resize：接受 Kasm 客户端合法枚举 off/scale/remote（重复即 400）。
// 非 native 模式 resize 仍旧 400「不支持的参数: resize」⇒ 旧行为字节不变。
function decideRoot(pathname, search, opts) {
  const c = opts || {};
  if (pathname === '/' || pathname === '/index.html') {
    const pairs = splitQuery(search);
    let desktopSeen = null;
    let resolutionSeen = null;
    let resizeSeen = null;
    const extras = [];
    for (const [rawKey, rawVal] of pairs) {
      const key = decodeStrict(rawKey);
      if (key === null) return bad(400, '查询参数编码不合法');
      if (key === 'desktop') {
        if (desktopSeen !== null) return bad(400, 'desktop 参数重复');
        desktopSeen = rawVal;
        continue;
      }
      // resolution 是 dispatcher 侧的**选择参数**（不是 Kasm 显示参数）：
      // 只在此处做形态校验（400 类），模式裁决（409 / 302）需要 registry 几何 ⇒ 交给 server。
      // 非法形态与无 desktop 时一样先报错，且绝不让它进 extras 透传给后端。
      if (key === 'resolution') {
        if (resolutionSeen !== null) return bad(400, 'resolution 参数重复');
        const parsed = parseResolution(decodeStrict(rawVal));
        if (!parsed.ok) return bad(400, 'resolution 不合法：' + parsed.msg);
        resolutionSeen = parsed;
        continue;
      }
      if (key === 'resize') {
        if (c.nativeMode !== true) return bad(400, '不支持的参数: ' + key);
        if (resizeSeen !== null) return bad(400, 'resize 参数重复');
        const rval = decodeStrict(rawVal);
        if (rval === null || !RESIZE_CLIENT_VALUES.has(rval)) return bad(400, '参数取值不合法: resize');
        resizeSeen = rval;
        continue;
      }
      if (FORBIDDEN_KEYS.has(key)) return bad(400, '不支持的参数: ' + key);
      const re = CLIENT_PARAM_WHITELIST[key];
      if (!re) return bad(400, '不支持的参数: ' + key);
      const val = decodeStrict(rawVal);
      if (val === null || !re.test(val)) return bad(400, '参数取值不合法: ' + key);
      extras.push([key, val]);
    }
    if (desktopSeen === null) {
      if (resolutionSeen !== null) return bad(400, 'resolution 需要与 desktop 参数同用');
      return { kind: 'list' };
    }
    const id = decodeStrict(desktopSeen);
    if (id === null) return bad(400, 'desktop 值编码不合法');
    if (id === '') return bad(400, 'desktop 参数为空');
    if (id.indexOf('/') >= 0 || id.indexOf(BS) >= 0 || id.indexOf('..') >= 0) {
      return bad(400, 'desktop 值含路径分隔，拒绝');
    }
    if (!SLUG_RE.test(id)) return bad(400, 'desktop 值不是合法标识');
    return { kind: 'select', id: id, extras: extras, resolution: resolutionSeen, resize: resizeSeen };
  }
  // root 下无桌面 id 的 Kasm 资源：不 fallback
  return { kind: 'root404' };
}

// 裁决 /desktop/<id>/... 前缀路由
function decideDesktop(pathname, search, cfgPrefix) {
  const prefix = cfgPrefix || '/desktop/';
  if (pathname.indexOf(prefix) !== 0) return { kind: 'root404' };
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const seg = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? '' : rest.slice(slash);
  const id = decodeStrict(seg);
  if (id === null) return bad(400, '桌面标识编码不合法');
  if (id === '') return bad(400, '桌面标识为空');
  if (id.indexOf('/') >= 0 || id.indexOf(BS) >= 0 || id.indexOf('..') >= 0) {
    return bad(400, '桌面标识含路径分隔，拒绝');
  }
  if (!SLUG_RE.test(id)) return bad(400, '桌面标识不是合法 slug');
  return { kind: 'desktop', id: id, tail: tail === '' ? '/' : tail, search: search || '' };
}

// 桌面根文档（/desktop/<id>/）的规范参数裁决（ctx 可选，缺省 = legacy 语义，逐字旧行为）：
//   ctx = { resizeMode: 'scale'|'remote', resolution: {canonical} | null }
//   - resizeMode='remote'（auto 桌）⇒ 规范集里的 resize 期望值变成 remote
//   - resolution 是 dispatcher 选择参数：白名单外的它**不判 400**，由调用方（server）
//     按几何裁决 302/409；形态非法（ctx.resolutionError）判 400
//   - ctx.nativeMode=true 且 resizeMode 为 null（原生默认入口 + legacy 桌）⇒
//     规范集 = canonicalParamsNative（**无 resize 键**），客户端自带的 resize
//     只校验形态（∈ off/scale/remote，且最多一次）：**不比对期望值、不注入、不改写**；
//     校验通过的单个值随结果回传（result.resize），调用方在需要 302 引导时**必须原样带上**，
//     否则用户显式选择的 resize 会在跳转中被静默抹掉（2026-11-16 实测缺陷）；
//     重复 / 非法的 resize ⇒ result.resize = null 且必判 redirect（**不取其中一个、不伪造**，
//     回落到「无 resize」规范态）。
//     **判定与 query 顺序无关**（2026-11-16 顺序依赖修复）：resize 的全部 occurrences
//     在循环**之前**整体预扫定案 ⇒ ?path=evil&resize=remote 与 ?resize=remote&path=evil
//     同判（旧实现扫到 resize 前遇坏 forced 键就提前引导，会丢已校验的 resize）。
//     这样 Kasm 客户端带 ?resize=off|scale|remote 的 URL 直接 200，不再被 302 抹平。
//     native 分支为**完整遍历**（不短路）：坏 forced 键只记「需引导」，危险键
//     （FORBIDDEN / 白名单外 / 白名单内值非法 / resolution 形态坏）一旦发现立刻 400，
//     因此 ?path=evil&image=evil&resize=remote 与 ?image=evil&path=evil&resize=remote
//     同判 400（旧实现遇坏 path 即引导 ⇒ image 被静默跳过 = 危险键被 forced 顺序屏蔽）。
//     non-native 分支保留**逐字旧短路顺序**（先遇到者定局），形状仍 {action, resize:null}。
// 返回：{action:'pass'|'redirect', resize: 'off'|'scale'|'remote'|null} | {action:'error', code, msg}
//   resize 仅在 nativeMode 下可能非 null；非 native 模式恒为 null（旧调用方忽略该字段即可）。
//   终局优先级（native：与键序无关）：resolutionError / 白名单外 / 白名单内值非法
//   ⇒ error 400（危险键直接拒，不做引导，且**不受 forced 键位置屏蔽**）
//   ＞ forced 键缺改/重复 / resize 作废 / resolution 不符 ⇒ redirect ＞ 全齐 ⇒ pass。
//   non-native 不承诺该优先级：短路顺序逐字保留（先遇到者定局）。
// 缺规范参数或被客户端改写 => 需要 302 引导；规范值完全一致 => 放行
// 判定顺序：**先 FORCED_PARAM_KEYS，再 FORBIDDEN_KEYS**。
//   FORBIDDEN_KEYS 含 'path'（禁止客户端指定后端路径），而规范参数里正好有
//   path=desktop/<id>/websockify ⇒ 若先查 FORBIDDEN，dispatcher 自己生成的规范 URL
//   会被自己判 400（root 实测 test17/18 = 400 的根因）。
// 客户端自由参数不在这组键上的：白名单内保留、白名单外 400
function bootstrapDecision(id, search, ctx) {
  const c = ctx || {};
  const nativeMode = c.nativeMode === true && !c.resizeMode;
  const want = nativeMode ? canonicalParamsNative(id) : canonicalParamsFor(id, c.resizeMode);
  const pairs = splitQuery(search);
  if (c.resolutionError) return { action: 'error', code: 400, msg: c.resolutionError };
  // native 模式：resize 的裁决**先于**其余强制参数判定、且与键序无关。
  // 预扫全部 occurrences ⇒ 「有且仅有一个且值合法」才保留；重复 / 任一非法 ⇒ 连先前
  // 有效值一起作废（null），否则等于替用户静默选了先出现的那个。
  // nativeResizeSeen 只表示「query 里出现过 resize」：出现但未定案 ⇒ 必判 redirect。
  let nativeResize = null;
  let nativeResizeSeen = false;
  if (nativeMode) {
    let count = 0;
    let legal = null;
    let allLegal = true;
    for (const [rawKey, rawVal] of pairs) {
      if (decodeStrict(rawKey) !== 'resize') continue;
      count += 1;
      const rval = decodeStrict(rawVal);
      if (rval === null || !RESIZE_CLIENT_VALUES.has(rval)) allLegal = false;
      else legal = rval;
    }
    if (count > 0) nativeResizeSeen = true;
    if (count === 1 && allLegal) nativeResize = legal;
  }
  const redir = () => ({ action: 'redirect', resize: nativeMode ? nativeResize : null });
  if (nativeMode) {
    // native：完整遍历，引导类判据先收集，危险键 400 立即返回 ⇒ 优先级与键序无关
    let needRedirect = false;
    for (const [rawKey, rawVal] of pairs) {
      const key = decodeStrict(rawKey);
      if (key === null) { needRedirect = true; continue; }
      // resize 已由预扫定案（合法单值 ⇒ 原样保留；重复/非法 ⇒ 作废并记引导）
      if (key === 'resize') continue;
      if (FORCED_PARAM_KEYS.has(key)) {
        const expect = want.find((p) => p[0] === key);
        const val = decodeStrict(rawVal);
        if (!expect || val !== expect[1]) needRedirect = true;
        continue;
      }
      if (key === 'resolution') {
        // native 规范集（legacy 未登记几何）永不含 resolution ⇒ 出现即需引导；
        // 形态坏仍按 400 拒（与旧分支同文案）。resizeMode 在 native 恒为假，旧
        // 的 remote 短路分支在此不可达，不复制。
        const parsed = parseResolution(decodeStrict(rawVal));
        if (!parsed.ok) return { action: 'error', code: 400, msg: 'resolution 不合法：' + parsed.msg };
        if (!c.resolution || c.resolution.canonical !== parsed.canonical) needRedirect = true;
        continue;
      }
      if (FORBIDDEN_KEYS.has(key)) return { action: 'error', code: 400, msg: '不支持的参数: ' + key };
      const re = CLIENT_PARAM_WHITELIST[key];
      if (!re) return { action: 'error', code: 400, msg: '不支持的参数: ' + key };
      const val = decodeStrict(rawVal);
      if (val === null || !re.test(val)) return { action: 'error', code: 400, msg: '参数取值不合法: ' + key };
    }
    if (nativeResizeSeen && nativeResize === null) needRedirect = true;
    const nfound = new Set(pairs.map((p) => decodeStrict(p[0])));
    for (const kv of want) if (!nfound.has(kv[0])) needRedirect = true;
    if (needRedirect) return { action: 'redirect', resize: nativeResize };
    return { action: 'pass', resize: nativeResize };
  }
  for (const [rawKey, rawVal] of pairs) {
    const key = decodeStrict(rawKey);
    if (key === null) return redir();
    if (FORCED_PARAM_KEYS.has(key)) {
      const expect = want.find((p) => p[0] === key);
      const val = decodeStrict(rawVal);
      if (!expect || val !== expect[1]) return redir();
      continue;
    }
    if (key === 'resolution') {
      // 带 resolution 的引导 URL 永远不是规范态（规范态由几何裁决决定）⇒ 交给 server 重新裁决
      if (c.resizeMode === 'remote') return redir();
      const parsed = parseResolution(decodeStrict(rawVal));
      if (!parsed.ok) return { action: 'error', code: 400, msg: 'resolution 不合法：' + parsed.msg };
      if (!c.resolution || c.resolution.canonical !== parsed.canonical) return redir();
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) return { action: 'error', code: 400, msg: '不支持的参数: ' + key };
    const re = CLIENT_PARAM_WHITELIST[key];
    if (!re) return { action: 'error', code: 400, msg: '不支持的参数: ' + key };
    const val = decodeStrict(rawVal);
    if (val === null || !re.test(val)) return { action: 'error', code: 400, msg: '参数取值不合法: ' + key };
  }
  const found = new Set(pairs.map((p) => decodeStrict(p[0])));
  if (c.resizeMode === 'remote' && found.has('resolution')) return redir();
  for (const kv of want) if (!found.has(kv[0])) return redir();
  return { action: 'pass', resize: nativeMode ? nativeResize : null };
}

// 规范 302 目标 = **root-relative**：'/desktop/<encoded id>/?<规范参数 + extras>'
// 裁决（2026-11-13）：Location 一律**不拼 origin**，浏览器始终留在用户原入口
//   （https://25320-235.ws.gatepro.cn:99/… 这类边缘域名），dispatcher 不再将
//   会话固定到 cfg.publicOrigin 的 http://127.0.0.1:25320。
// 不从 Host / X-Forwarded-Host / X-Forwarded-Proto 推断 origin ⇒ 入口域名与协议
//   完全由边缘层（authz / APISIX）决定，dispatcher 只保证 path + query 正确。
// cfg.publicOrigin 仍在 proxy.js 用于后端 Host 透传与上游 Location 改写，用途不变。
// 形参表保留旧签名 (publicOrigin, id, extras) ⇒ 两处调用点 API 不动；首参值被忽略。
function canonicalLocation(publicOrigin, id, extras, opts) {
  const o = opts || {};
  // nativeMode（且调用方未给出强制 resizeMode）⇒ 规范集去掉 resize；
  // 客户端在根选择里自带的合法 resize 作为**显式选择**原样保留在规范集之后。
  // 仍是 root-relative（首参 origin 依旧被忽略），不拼协议、不拼 //。
  const nativeMode = o.nativeMode === true && !o.resizeMode;
  const params = (nativeMode
    ? canonicalParamsNative(id).concat(o.resize ? [['resize', o.resize]] : [])
    : canonicalParamsFor(id, o.resizeMode)).concat(extras || []);
  if (o.resolution && o.resolution.canonical) {
    params.push(['resolution', o.resolution.canonical]);
  }
  const qs = params.map((p) => encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1])).join('&');
  return '/desktop/' + encodeURIComponent(id) + '/?' + qs;
}

// ---------------- 几何裁决（需要 registry 条目；纯函数，server 与单测共用） ----------------
// 入参：
//   geometry = normalizeGeometry 产物 {mode,width,height,canonical} | null（null = legacy）
//   geometryError = registry 标记该桌面几何登记不合法（registry.js 侧写入）
//   resolution = decideRoot/解析产物 {width,height,canonical} | null（URL 未给 = null）
//   previewEnabled = cfg.adaptivePreview
// 返回 {action:'redirect', resizeMode, resolution} | {action:'pass', resizeMode, resolution}
//   | {action:'error', code, msg}
// 状态语义（不得混淆）：
//   legacy + 无 resolution ⇒ 现状逐字不变（resize=scale）
//   legacy + 有 resolution ⇒ 409 not supported（不静默打开远端尺寸、不假成功）
//   auto   + 无 resolution ⇒ resize=remote（须 previewEnabled，否则 503 failclosed）
//   auto   + 有 resolution ⇒ 409 模式冲突
//   fixed  + resolution 精确等于登记 WxH ⇒ 强制 resize=scale + 固定尺寸
//   fixed  + 缺参 / 不等   ⇒ 409 模式冲突
//   geometryError / mode 非法 / geometry 形态坏 ⇒ 503 failclosed
// nativeMode=true（WTK_NATIVE_DEFAULT_MODE=1）只改**一条**规则：
//   legacy（未登记几何）+ 无 resolution ⇒ redirect 且 resizeMode=null（**不注入 resize**）
// 其余逐字不变：legacy + resolution 仍 409；auto / fixed 桌**不因本模式降级**，
// 各自的 503 failclosed / 409 冲突口径原样保留（登记几何的桌面不会被隐式当 legacy）。
function decideGeometry(entry, geometry, resolution, previewEnabled, nativeMode) {
  if (entry && entry.geometryError === true) {
    return { action: 'error', code: 503, msg: '该桌面的几何登记不合法，已按 failclosed 拒绝' };
  }
  if (geometry === 'invalid') {
    return { action: 'error', code: 503, msg: '该桌面的几何登记不合法，已按 failclosed 拒绝' };
  }
  if (!geometry) {
    if (resolution) {
      return { action: 'error', code: 409, msg: '该桌面未登记几何（legacy），暂不支持 resolution 参数；待迁移后可用' };
    }
    if (nativeMode === true) {
      // 原生默认入口：规范集不含 resize（客户端自选），其余规范参数照旧引导
      return { action: 'redirect', resizeMode: null, resolution: null, legacy: true, native: true };
    }
    return { action: 'redirect', resizeMode: 'scale', resolution: null, legacy: true };
  }
  if (geometry.mode === 'auto') {
    if (resolution) return { action: 'error', code: 409, msg: '该桌面为自适应（auto）几何，不接受 resolution 参数' };
    if (!previewEnabled) {
      return { action: 'error', code: 503, msg: '自适应几何预览未启用（WTK_ENABLE_ADAPTIVE_PREVIEW=1 才开放）' };
    }
    return { action: 'redirect', resizeMode: 'remote', resolution: null };
  }
  // fixed
  if (!resolution) {
    return { action: 'error', code: 409, msg: '该桌面为固定几何 ' + geometry.canonical + '，必须带 resolution=' + geometry.canonical };
  }
  if (resolution.canonical !== geometry.canonical) {
    return { action: 'error', code: 409, msg: 'resolution 与登记几何不符（要求 ' + geometry.canonical + '）' };
  }
  return { action: 'redirect', resizeMode: 'scale', resolution: resolution };
}

// 非入口文档（静态 asset、/api、audiojs 等子资源）的几何门。
// 真实浏览器在子资源请求上**不会**携带 resolution（Kasm 自带的 audio.js / jsmpeg / css 都只按
// 相对路径取），因此这里**不要求** resolution；只在「显式带上且与登记冲突」时拒绝，避免
// 把 resolution 变成每个 asset 的准入门槛。
//   geometryError / 形态坏 => 503；legacy 带 resolution => 409
//   auto：带 resolution => 409；preview 关闭 => 503（所有路径都拒绝，不留子资源口子）
//   fixed：带 resolution => 形态 400 / 与登记不等 409；不带 => 放行（后端 AcceptSetDesktopSize=0）
// nativeMode=true 只改 legacy 无 resolution 一条：allow 且 resizeMode=null
// （子资源本就无参数注入语义，这里只是把「无模式」如实标出）；auto/fixed 规则逐字不变。
function decideAsset(entry, geometry, resolution, previewEnabled, nativeMode) {
  if (entry && entry.geometryError === true) {
    return { action: 'error', code: 503, msg: '该桌面的几何登记不合法，已按 failclosed 拒绝' };
  }
  if (geometry === 'invalid') {
    return { action: 'error', code: 503, msg: '该桌面的几何登记不合法，已按 failclosed 拒绝' };
  }
  if (!geometry) {
    if (resolution) return { action: 'error', code: 409, msg: '该桌面未登记几何（legacy），暂不支持 resolution 参数' };
    if (nativeMode === true) return { action: 'allow', resizeMode: null, legacy: true, native: true };
    return { action: 'allow', resizeMode: 'scale', legacy: true };
  }
  if (geometry.mode === 'auto') {
    if (resolution) return { action: 'error', code: 409, msg: '该桌面为自适应（auto）几何，不接受 resolution 参数' };
    if (!previewEnabled) {
      return { action: 'error', code: 503, msg: '自适应几何预览未启用（WTK_ENABLE_ADAPTIVE_PREVIEW=1 才开放）' };
    }
    return { action: 'allow', resizeMode: 'remote' };
  }
  if (resolution) {
    if (resolution.canonical !== geometry.canonical) {
      return { action: 'error', code: 409, msg: 'resolution 与登记几何不符（要求 ' + geometry.canonical + '）' };
    }
  }
  return { action: 'allow', resizeMode: 'scale' };
}

// WS 升级的几何预检（与 decideGeometry 同一套规则，不含引导语义）
// params = { kind: 'video'|'audio', resize, resolution, resolutionPresent }
//   resize/resolution = query 里的原始值（缺省 undefined）；resolutionPresent = query 是否出现该键
// 逐模式规则：
//   geometryError / geometry 形态坏 => 503（**先于 state 判定**，不得靠 state=running 绕过）
//   legacy  => 逐字旧行为放行（不新增 resize / resolution 形态约束）；仅带 resolution => 409
//   auto    => 带 resolution 409；preview 关闭 503（画面与音频通道同门）；
//              video 通道**显式**给 resize 且非 remote => 400（缺省不约束：真实 Kasm 客户端
//              的 WS URL 由 ui.js 按 path 拼接，不保证带 resize）
//   fixed   => 不要求 resolution（Kasm 客户端 WS URL 无该查询，后端 AcceptSetDesktopSize=0）；
//              显式带 resolution => 形态 400 / 与登记不等 409；
//              video 通道**显式**给 resize 且非 scale => 400
// audio 通道无 resize 语义：只做 resolution 存在性/一致性校验 + preview / failclosed 门。
// nativeMode=true 只改 legacy 一条：legacy 放行时 resizeMode=null（不注入），
// 且**不新增** resize 形态约束（与旧行为一致，Kasm 客户端 WS URL 不保证带 resize）；
// auto（preview 关闭 ⇒ 503 failclosed）与 fixed 规则逐字不变。
function decideGeometryWs(entry, geometry, params) {
  const p = params || {};
  const previewEnabled = p.previewEnabled === true;
  const nativeMode = p.nativeMode === true;
  const kind = p.kind === 'audio' ? 'audio' : 'video';
  if (entry && entry.geometryError === true) return { action: 'reject', code: 503, reason: 'geometryError' };
  const mode = geometry === 'invalid' ? 'invalid' : (geometry ? geometry.mode : 'legacy');
  if (mode === 'invalid') return { action: 'reject', code: 503, reason: 'geometryInvalid' };
  if (mode === 'legacy') {
    if (p.resolutionPresent) return { action: 'reject', code: 409, reason: 'legacyNotSupported' };
    if (nativeMode) return { action: 'allow', resizeMode: null, native: true };
    return { action: 'allow', resizeMode: 'scale' };
  }
  if (p.resolutionPresent) {
    const parsed = parseResolution(p.resolution);
    if (!parsed.ok) return { action: 'reject', code: 400, reason: 'resolutionMalformed' };
    if (mode === 'auto') return { action: 'reject', code: 409, reason: 'autoConflict' };
    if (parsed.canonical !== geometry.canonical) return { action: 'reject', code: 409, reason: 'fixedMismatch' };
  }
  if (mode === 'auto') {
    if (!previewEnabled) return { action: 'reject', code: 503, reason: 'previewDisabled' };
    if (kind === 'video' && p.resize !== undefined && p.resize !== '' && p.resize !== 'remote') {
      return { action: 'reject', code: 400, reason: 'resizeMismatch' };
    }
    return { action: 'allow', resizeMode: 'remote' };
  }
  // fixed
  if (kind === 'video' && p.resize !== undefined && p.resize !== '' && p.resize !== 'scale') {
    return { action: 'reject', code: 400, reason: 'resizeMismatch' };
  }
  return { action: 'allow', resizeMode: 'scale' };
}

module.exports = {
  decideRoot,
  decideDesktop,
  bootstrapDecision,
  canonicalLocation,
  decideGeometry,
  decideAsset,
  decideGeometryWs,
  splitQuery,
  SLUG_RE,
  FORBIDDEN_KEYS,
};
