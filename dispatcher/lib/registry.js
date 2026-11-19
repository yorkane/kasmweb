'use strict';
// registry.json 读取层：每请求读 + mtime 缓存 + 原子写（tmp+rename）
// 契约 schemaVersion 1；desktops[] = {id,name,port,state,container,containerId,generation,appId}
// 可选几何（schemaVersion 仍 = 1，root 契约 2026-11-14）：
//   desktops[].geometry = {mode:'auto'|'fixed', width:int 320..4096, height:int 240..4096}
//   仅 3 键，唯一来源 = manager 侧显式几何 DesktopSpec（config.normalize_geometry 同区间）。
//   字段**缺席** = legacy 桌面（不注入任何新键，与旧版输出逐字段一致）；
//   字段**出现且非法**（类型错 / 未知键含 __proto__ / 缺键 / 超界 / 非整数 / 数组 / null /
//   mode 非 auto|fixed）= 该桌 **state 强制 'error'** + geometryError=true + geometryDetail，
//   **不降级 legacy、不采用可疑值、不丢同文件其它桌**。
//   state=error 是 fail-closed 的承重设计（root 契约 2026-11-14，与 dispatcher worker 对齐）：
//   现网 server.js / pages.js 只放行 state==='running'，因此**未升级的 consumer 也会对该桌
//   直接 503 / 显示异常**，不会带着可疑 geometry 继续代理；geometryError 是给已升级消费方的
//   可诊断标识，两者同时给出，缺一不可（只标 geometryError 会被旧 consumer 忽略 = 放行）。
//   geometry 只来自本文件（后端唯一写入者 = manager）：URL query / path 无权注入几何，
//   本模块不读任何请求参数，消费方也不得据 geometry 改 backend 地址。
// 文件缺失 / JSON 坏 / schema 不合法 => 返回带 error 的空表（列表页显示未登记，不崩溃）
//
// ================== registry 新鲜度门（fail-closed，2026-11-14 root 契约） ==================
// 动机：desktops[].state=running 是**快照**，其成立前提是 manager daemon 每个刷新周期
//   （WT_KASM_REFRESH_INTERVAL 默认 30s）把 registry 重写一遍。daemon 崩溃 / 刷新抛错 /
//   写盘失败（manager/registry.py = tmp + fsync + os.replace：写失败时**旧文件原样留在盘上**）
//   ⇒ 文件内容不再变化，mtime 停在最后一次成功写入。若入口只读 state，则该桌会被
//   **无限期**当运行中放行；本门把「快照过期」等价为 state=error。
//
// 新鲜度依据 = registry 文件的 stat mtime。**它的语义只有一条**：
//   mtime = **最近一次成功的 registry 文件写入时间**（manager 写入侧 tmp+fsync+os.replace）。
//   mtime **不**替代健康证据、**不**证明 healthEnd 新鲜，也**得不到**「attestedAt ≤ 90s」的严格保证：
//   manager 允许放行最旧 90s（attest.py HEALTH_MAX_AGE_S=90）的健康证据后**立刻**重写文件、
//   把 mtime 刷新到现在 ⇒ 同一条记录的可观察有效期最长接近 90 + 90 = **约 180s**。
//   因此本门是**弱证据兜底**（抓 daemon 冻结 / 写盘失败 / 崩溃后无限放行），
//   **不得**被叙述成「会话在 90s 内确认存活」，也不得据它宣称任何活体即时健康。
//   要严格 attestedAt 门禁 ⇒ 需 manager 在 registry 条目内**显式携带 attest 时间**
//   （例如 desktops[].attestedAt / healthEnd epoch）并由本门按该字段判 —— **本仓未实现**，
//   属后续独立契约变更（新增 reader/writer 双侧字段 + schema 口径），不在本门范围内。
//
// 作用面（**不得放大解读**）：
//   * 只影响「geometry 键**出现**」的条目（含 present-非法，它们本来就已 state=error）；
//     geometry 键缺席的 legacy 桌（现网 vcmi / chrome-1 / chrome-2）判定与输出**逐字节不变**；
//     全表无 geometry 键 ⇒ 门整体短路，连 stale 键都不注入（现网零行为变化）。
//   * **mtime 不可信 = fail-closed（2026-11-14 root 只读复核补口）**：mtimeMs 非有限正值
//     （= 0 / 负 / NaN / Infinity；例：合法 registry 被 fs.utimesSync 设成 Unix epoch，
//     或注入式视图给 mtimeMs:0）⇒ 新鲜度**无法判定**，此时**不得**按\"没有证据=放行\"处理：
//     表内含 geometry 键的条目一律标 state=error + geometryError（detail 明写\"mtime 不可信\"
//     以区别于\"陈旧\"）。空表 / 全 legacy 表仍原样返回（同对象引用、零新增键），
//     故现网 legacy 三桌与内存版 fake registry 依旧零行为变化。
//   * 门位于 **Registry.read() 内部**（不是 server.js 的四处门）⇒ 注入式 fake registry
//     （内存版 read() 返回 mtimeMs=0 / 不经本层）**不受本门约束**，四处 state 门照旧放行；
//     真实 Registry 才带新鲜度。server.js 只在自己的 registry 上接阈值，不改四处门的语义。
//   * 阈值随 cfg 下发；cfg 缺该键（旧 fixture）⇒ 回落 DEFAULTS 常量，不产生 NaN 放行。
//   * 每次 read() 都重算（**缓存命中也算**）：新鲜→陈旧翻转发生在同一个缓存文件上，
//     缓存键 size:mtimeMs 不变，因此门必须是 f(now, mtimeMs) 的逐次求值，不能只在 cache miss 时判。
//   * 命中即 state='error' + geometryError=true + geometryDetail ⇒ 直接复用既有 fail-closed 通道：
//     server.js 四处门（根选择器 / 桌面根文档 / 子资源 decideAsset / WS upgrade）都在
//     state 判定**之前**过 geometryError，pages.js 列表页同步不发链接。
//     本模块不改 site 级行为（/healthz、列表页仍 200），不删任何条目。
//   * 已知边界：**已建立的 WS 连接不会被本门切断**（proxy 与连接生命周期在 registry 之外）。
//     本门只约束**新准入**（HTTP 请求与 WS upgrade）⇒ daemon 冻结期间存量会话继续跑，
//     刷新恢复后新连接立即放行。
//   * 阈值与 skew 见 lib/config.js DEFAULTS.geometryStaleMs / geometrySkewMs
//     （env WTK_GEOMETRY_STALE_MS / WTK_GEOMETRY_SKEW_MS）；mtime 超前超过 skew
//     （时钟回拨 / 跨机偏差）同样判陈旧 = fail-closed。
//   * **env / 注入阈值只可收紧，不可放宽**：上限 = 上面的单点常量（90s / 60s）。
//     env 超上限 ⇒ config 层启动期抛错（不静默 clamp，避免运维以为放宽生效）；
//     直接注入 opts（测试/嵌入方）⇒ 本构造器按 min(注入值, 常量) 夹紧（clamp 朝严格方向，
//     与本门 fail-closed 语义一致），故任何注入路径都得不到 > 常量的阈值 ⇒
//     「state=running 快照最长约 180s 可观察有效期」这条边界不可被配置打破。

const fs = require('fs');
const path = require('path');
const { STATES, GEOMETRY_STALE_MS, GEOMETRY_SKEW_MS } = require('./config');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

const GEOMETRY_KEYS = ['mode', 'width', 'height'];
const GEOMETRY_MODES = ['auto', 'fixed'];
const GEOMETRY_W_MIN = 320;
const GEOMETRY_W_MAX = 4096;
const GEOMETRY_H_MIN = 240;
const GEOMETRY_H_MAX = 4096;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function emptyRegistry(error) {
  return { schemaVersion: 1, publicOrigin: null, desktops: [], error: error || null, source: 'empty', mtimeMs: 0 };
}

// generation 按契约保留原值：整数与字符串 nonce 都合法（不做 Number 强转）
function normalizeGeneration(g) {
  if (typeof g === 'number' && Number.isFinite(g)) return g;
  if (typeof g === 'string' && g.length <= 64) return g;
  return 0;
}

function validSlug(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return false;
  if (id.indexOf('..') >= 0 || id.indexOf('/') >= 0 || id.indexOf(String.fromCharCode(92)) >= 0) return false;
  return true;
}

// 严格校验并显式逐键复制 -> {mode,width,height}；非法抛 Error（调用侧转 geometryError）
function validateGeometry(g) {
  if (g === null || typeof g !== 'object' || Array.isArray(g)) {
    throw new Error('geometry 必须是对象，实为 ' + (Array.isArray(g) ? 'array' : (g === null ? 'null' : typeof g)));
  }
  const keys = Object.keys(g);
  for (const k of keys) {
    if (GEOMETRY_KEYS.indexOf(k) < 0) throw new Error('geometry 含未知键 ' + JSON.stringify(k));
  }
  for (const k of GEOMETRY_KEYS) {
    if (!hasOwn(g, k)) throw new Error('geometry 缺键 ' + k);
  }
  const mode = g.mode;
  if (typeof mode !== 'string' || GEOMETRY_MODES.indexOf(mode) < 0) {
    throw new Error('geometry.mode 必须是 auto/fixed，实为 ' + JSON.stringify(mode));
  }
  const w = g.width;
  if (typeof w !== 'number' || !Number.isInteger(w) || w < GEOMETRY_W_MIN || w > GEOMETRY_W_MAX) {
    throw new Error('geometry.width 必须是 ' + GEOMETRY_W_MIN + '..' + GEOMETRY_W_MAX +
      ' 的整数，实为 ' + JSON.stringify(w));
  }
  const h = g.height;
  if (typeof h !== 'number' || !Number.isInteger(h) || h < GEOMETRY_H_MIN || h > GEOMETRY_H_MAX) {
    throw new Error('geometry.height 必须是 ' + GEOMETRY_H_MIN + '..' + GEOMETRY_H_MAX +
      ' 的整数，实为 ' + JSON.stringify(h));
  }
  return { mode: mode, width: w, height: h };
}

function normalize(raw, sourcePath, mtimeMs) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reg: emptyRegistry('registry 根不是对象'), fatal: true };
  }
  if (raw.schemaVersion !== 1) {
    return { reg: emptyRegistry('registry schemaVersion 非 1'), fatal: true };
  }
  const list = Array.isArray(raw.desktops) ? raw.desktops : [];
  const seen = new Set();
  const desktops = [];
  for (const d of list) {
    if (d === null || typeof d !== 'object') continue;
    if (!validSlug(d.id) || seen.has(d.id)) continue;
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
    if (!STATES.has(d.state)) continue;
    seen.add(d.id);
    const entry = {
      id: d.id,
      name: (typeof d.name === 'string' && d.name) ? d.name : d.id,
      port: port,
      state: d.state,
      container: typeof d.container === 'string' ? d.container : '',
      containerId: typeof d.containerId === 'string' ? d.containerId : '',
      generation: normalizeGeneration(d.generation),
      appId: typeof d.appId === 'string' ? d.appId : '',
    };
    // 缺席 = legacy：不加任何新键（旧消费方逐字段比对无差异）
    if (hasOwn(d, 'geometry')) {
      try {
        entry.geometry = validateGeometry(d.geometry);
      } catch (e) {
        entry.geometryError = true;
        entry.geometryDetail = String(e.message).slice(0, 200);
        // fail-closed：几何元数据损坏即视该桌不可用（含旧 consumer），不做 legacy 放行
        entry.state = 'error';
      }
    }
    desktops.push(entry);
  }
  return {
    reg: {
      schemaVersion: 1,
      publicOrigin: typeof raw.publicOrigin === 'string' ? raw.publicOrigin : null,
      desktops: desktops,
      error: null,
      source: sourcePath,
      mtimeMs: mtimeMs,
    },
    fatal: false,
  };
}

class Registry {
  constructor(file, opts) {
    this.file = file;
    this.missingCacheMs = (opts && opts.missingCacheMs) || 2000;
    // 新鲜度门：可注入时钟（测试用假时间做 fresh→stale 翻转与未来 mtime，不 sleep、不动挂钟）
    this._now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
    // 注入阈值 clamp：非法/非正 ⇒ 常量；合法 ⇒ min(注入值, 常量)。上限锁在单点常量，
    // 因此**任何注入路径（含旧 fixture 传入的任意 cfg 值）都得不到 > 90s / 60s 的阈值**，
    // env 侧由 lib/config.js envIntNoRelax 在启动期拒掉放宽值 ⇒ 门不可被配置关掉。
    this.staleMs = (opts && Number.isFinite(opts.staleMs) && opts.staleMs > 0)
      ? Math.min(Math.floor(opts.staleMs), GEOMETRY_STALE_MS) : GEOMETRY_STALE_MS;
    this.skewMs = (opts && Number.isFinite(opts.skewMs) && opts.skewMs >= 0)
      ? Math.min(Math.floor(opts.skewMs), GEOMETRY_SKEW_MS) : GEOMETRY_SKEW_MS;
    this._cache = null;
    this._cacheKey = '';
    this._watchTimer = null;
    this.onUpdate = null;
  }

  // 每请求调用：size+mtime 命中缓存则复用，否则重读 => registry 状态变化即时生效。
  // 缓存里存的是**未门控**的规范视图；新鲜度在每次 read() 上重新求值（见文件头声明），
  // 因此「新鲜→陈旧」翻转在同一次缓存命中上也会生效（缓存键 size:mtimeMs 不变）。
  read() {
    return this._applyFreshness(this._readRaw());
  }

  _readRaw() {
    const now = this._now();
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch (e) {
      if (this._cache && this._cache.kind === 'missing' && now - this._cache.at < this.missingCacheMs) {
        return this._cache.reg;
      }
      this._cache = { kind: 'missing', at: now, reg: emptyRegistry('registry 文件缺失') };
      return this._cache.reg;
    }
    const key = st.size + ':' + st.mtimeMs;
    if (this._cache && this._cache.kind === 'ok' && this._cacheKey === key) {
      return this._cache.reg;
    }
    this._cacheKey = key;
    let text = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      this._cache = { kind: 'ok', reg: emptyRegistry('registry 读取失败') };
      return this._cache.reg;
    }
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      this._cache = { kind: 'ok', reg: emptyRegistry('registry JSON 解析失败') };
      return this._cache.reg;
    }
    const n = normalize(raw, this.file, st.mtimeMs);
    this._cache = { kind: 'ok', reg: n.reg };
    return n.reg;
  }

  // 新鲜度求值（fail-closed，见文件头「registry 新鲜度门」）：
  // 判序：① 空表 ⇒ 原对象；② mtime 非有限正值（空表 mtimeMs=0 / 被 utimes 设成 epoch /
  //   fake 视图）⇒ 新鲜度**无法判定** = fail-closed 标错（**不得**当成\"没证据就放行\"）；
  // ③ age 在阈值内且不在未来 skew 外 ⇒ 新鲜；④ 命中 ⇒ 只标 geometry 键出现的条目。
  // 两条 fail-closed 分支都经 _markGeometryError：全 legacy 表 touched=0 ⇒ **原对象逐字返回**
  // （零拷贝、零新增键）⇒ legacy 现网（vcmi / chrome-1 / chrome-2）输出与旧版逐字段一致。
  // 标写走浅拷贝，不污染缓存里的规范视图（同一次 read() 之后再恢复新鲜必须回到原值）。
  _applyFreshness(reg) {
    if (!reg || !Array.isArray(reg.desktops) || reg.desktops.length === 0) return reg;
    const m = reg.mtimeMs;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
      // mtime 不可信 ⇒ 新鲜度**无法判定** ⇒ fail-closed（\"没有证据\"不等于\"可以放行\"）。
      // 只标 geometry 条目；全 legacy 表 touched=0 ⇒ 原样返回（同对象引用、零新增键）。
      return this._markGeometryError(reg,
        'registry mtime 不可信（mtimeMs=' + String(m) + ' 非有限正值；新鲜度无法判定 ⇒ 拒绝新准入）',
        { staleReason: 'mtime-untrusted', staleAgeMs: null });
    }
    const age = this._now() - m;
    if (!(age > this.staleMs) && !(age < -this.skewMs)) return reg;
    const detail = 'registry 陈旧（age=' + Math.round(age) + 'ms > 阈值 ' + this.staleMs
      + 'ms；mtime=最后成功写入时间，非 healthEnd）';
    return this._markGeometryError(reg, detail, { staleReason: 'mtime-age', staleAgeMs: Math.round(age) });
  }

  // 新鲜度门命中（陈旧 / mtime 不可信）的共用落笔：geometry 条目复制标 state=error，
  // 已 geometryError 的条目**不覆盖**（形态坏的 detail 更精确，且本已 fail-closed）。
  // touched=0（全 legacy）⇒ 返回**原 reg 引用**，零新增键 ⇒ legacy 逐字节不变。
  _markGeometryError(reg, detail, extra) {
    let touched = 0;
    const desktops = reg.desktops.map((d) => {
      if (!hasOwn(d, 'geometry')) return d;
      if (d.geometryError === true) return d; // 形态坏已 state=error，保留更精确的原 detail
      touched += 1;
      const c = Object.assign({}, d);
      c.state = 'error';
      c.geometryError = true;
      c.geometryDetail = detail;
      return c;
    });
    if (touched === 0) return reg;
    const out = Object.assign({}, reg, { desktops: desktops });
    out.stale = true;
    Object.assign(out, extra || {});
    return out;
  }

  byId(id) {
    const reg = this.read();
    for (const d of reg.desktops) if (d.id === id) return d;
    return null;
  }

  // mtime 轮询 watch：预热缓存 + 通知；读路径仍每请求自校验（不依赖 watch）
  startWatch(intervalMs) {
    const ms = intervalMs || 1000;
    if (this._watchTimer) return;
    this._watchTimer = setInterval(() => {
      let st = null;
      try { st = fs.statSync(this.file); } catch (e) { st = null; }
      const key = st ? (st.size + ':' + st.mtimeMs) : 'missing';
      if (key === this._cacheKey) return;
      const before = this._cache ? this._cache.reg : null;
      const after = this.read();
      if (this.onUpdate) this.onUpdate(before, after);
    }, ms);
    if (this._watchTimer.unref) this._watchTimer.unref();
  }

  stopWatch() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
  }

  // 写侧（测试与本地 worker 等价实现）：同目录 tmp + rename 原子更新
  writeAtomic(obj) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(this.file) + '.tmp-' + process.pid + '-' + Date.now());
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + String.fromCharCode(10), 'utf8');
    fs.renameSync(tmp, this.file);
    this._cacheKey = '';
    this._cache = null;
  }
}

module.exports = {
  Registry, normalize, validSlug, emptyRegistry, normalizeGeneration,
  validateGeometry,
  GEOMETRY_KEYS, GEOMETRY_MODES,
  GEOMETRY_W_MIN, GEOMETRY_W_MAX, GEOMETRY_H_MIN, GEOMETRY_H_MAX,
};
