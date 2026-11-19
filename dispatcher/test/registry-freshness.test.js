'use strict';
// registry 新鲜度门（fail-closed）契约测试 — node:test，纯离线
//
// 判据（root 契约 2026-11-14）：
//  1) state=running 是**快照**：mtime 停止推进（daemon 崩溃 / 刷新抛错 / 写盘失败）超过
//     阈值 ⇒ 登记了 geometry 的桌面**不得**被无限期放行；
//  2) 门在**每次 read()** 求值（缓存命中也算）⇒ 新鲜→陈旧翻转发生在同一个缓存文件上；
//  3) 命中即 state='error' + geometryError=true ⇒ 复用既有 503 通道（HTTP 与 WS 四处门全过）；
//  4) geometry 键**缺席**的 legacy 桌逐字节不受影响（同对象引用、键集合不变、仍 running）；
//  5) 未来 mtime 超过 skew 容忍 ⇒ 同样 fail-closed；skew 内 ⇒ 放行；
//  6) present-非法 geometry（已 state=error）⇒ 保留原 geometryDetail，不被陈旧文案覆盖；
//  7) 边界：age === 阈值 ⇒ 新鲜；age === 阈值+1 ⇒ 陈旧；
//  8) 已知边界（必须断言）：**已建立连接不受影响**，门只作用于新准入
//     ⇒ HTTP 侧断言 503 且**假后端零请求**（证明在进 proxy 之前就被拒）。
//
// 时间注入 = Registry opts.now（不改系统挂钟、不 sleep）。
// 临时面 = /data/tmp/wtk-freshness-test-<pid>，teardown 整体 rename 进 /data/.trash（零 rm）。
// 保护区：dispatcher 与假后端一律 listen(0)，绝不 bind 25320-25329，不碰生产容器。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { Registry } = require(path.join(ROOT, 'lib/registry'));
const { resolveConfig, envIntNoRelax, GEOMETRY_STALE_MS, GEOMETRY_SKEW_MS } = require(path.join(ROOT, 'lib/config'));
const { createDispatcher } = require(path.join(ROOT, 'server'));
const WS = require(path.join(ROOT, 'vendor/ws'));

const TMP = fs.mkdtempSync(path.join('/data/tmp', 'wtk-freshness-test-'));
const FILE = path.join(TMP, 'registry.json');

test.after(() => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = '/data/.trash/wtk-freshness-test-' + stamp;
  try { fs.mkdirSync('/data/.trash', { recursive: true }); fs.renameSync(TMP, dest); } catch (e) { /* 尽力而为 */ }
});

// ------------------------------------------------------------------ fixtures
function desk(id, over) {
  return Object.assign({
    id: id,
    name: id + ' 桌面',
    port: 25321,
    state: 'running',
    container: 'wt-kasm-' + id,
    containerId: 'a'.repeat(64),
    generation: 'gen-20261114-01',
    appId: 'chrome',
  }, over || {});
}
function regObj(desktops) {
  return { schemaVersion: 1, publicOrigin: 'http://127.0.0.1:25320', desktops: desktops };
}
const AUTO = { mode: 'auto', width: 1280, height: 720 };
const FIXED = { mode: 'fixed', width: 800, height: 600 };

// 假时钟：T.now() 读写；T.at(mtimeMs, ageMs) = 让 now = mtime + age
function clock(base) {
  const st = { v: base };
  const fn = () => st.v;
  fn.set = (v) => { st.v = v; };
  fn.advance = (ms) => { st.v += ms; };
  fn.at = (ageMs) => { st.v = mtime() + ageMs; };
  return fn;
}
function mtime() {
  return fs.statSync(FILE).mtimeMs;
}

function newRegistry(o) {
  const opts = Object.assign({ missingCacheMs: 0 }, o || {});
  const r = new Registry(FILE, opts);
  return r;
}

// 写一次 registry（用 writeAtomic ⇒ 真实 tmp+rename 原子写，mtime 由 fs 决定）
function write(desktops) {
  const r = newRegistry();
  r.writeAtomic(regObj(desktops));
  r.stopWatch();
}

// ------------------------------------------------------------------ 0) 常量口径
test('阈值常量单点定义且与 manager 侧口径一致（90s / skew 60s）', () => {
  assert.equal(GEOMETRY_STALE_MS, 90000);
  assert.equal(GEOMETRY_SKEW_MS, 60000);
  const cfg = resolveConfig();
  assert.equal(cfg.geometryStaleMs, 90000, 'resolveConfig 缺省 = 同一常量');
  assert.equal(cfg.geometrySkewMs, 60000);
});

// 口径（2026-11-14 root 契约补口）：**只可收紧，不可放宽**。envInt 接受任意正数 ⇒
// WTK_GEOMETRY_STALE_MS=31536000000（一年）等于把门关掉，直接打破
// 「state=running 快照最长约 180s 可观察有效期」这条边界（90s 陈旧 + 90s 健康证据）。
// 单点常量 = 上限：超上限启动即抛错（不静默 clamp）；非法/非正/小数 ⇒ 回落默认（不放宽）。
test('env 只可收紧：正数 <= 上限采纳；非法/非正/小数回落默认', () => {
  process.env.WTK_GEOMETRY_STALE_MS = '15000';
  process.env.WTK_GEOMETRY_SKEW_MS = '5000';
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.geometryStaleMs, 15000);
    assert.equal(cfg.geometrySkewMs, 5000);
  } finally {
    delete process.env.WTK_GEOMETRY_STALE_MS;
    delete process.env.WTK_GEOMETRY_SKEW_MS;
  }
  // 边界：正好等于上限 ⇒ 采纳（等价默认，不算放宽）
  process.env.WTK_GEOMETRY_STALE_MS = String(GEOMETRY_STALE_MS);
  process.env.WTK_GEOMETRY_SKEW_MS = String(GEOMETRY_SKEW_MS);
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.geometryStaleMs, GEOMETRY_STALE_MS);
    assert.equal(cfg.geometrySkewMs, GEOMETRY_SKEW_MS);
  } finally {
    delete process.env.WTK_GEOMETRY_STALE_MS;
    delete process.env.WTK_GEOMETRY_SKEW_MS;
  }
  // 非法 / 非正 / 空 ⇒ 一律回落默认（= 不放宽），且**不得抛错**（保持既有 envInt 宽容口径）
  for (const bad of ['0', '-1', 'abc', '', 'Infinity', 'NaN', '  ']) {
    process.env.WTK_GEOMETRY_STALE_MS = bad;
    try {
      assert.equal(resolveConfig().geometryStaleMs, GEOMETRY_STALE_MS,
        '非法值 ' + JSON.stringify(bad) + ' 必须回落默认，不得放宽');
    } finally {
      delete process.env.WTK_GEOMETRY_STALE_MS;
    }
  }
  // 小数：Math.floor 后更严 ⇒ 收紧方向合法（0.4 floor=0 ⇒ 回落默认）
  process.env.WTK_GEOMETRY_STALE_MS = '30000.9';
  try { assert.equal(resolveConfig().geometryStaleMs, 30000, '小数 floor 后采纳（只可能更严）'); }
  finally { delete process.env.WTK_GEOMETRY_STALE_MS; }
  process.env.WTK_GEOMETRY_STALE_MS = '0.4';
  try { assert.equal(resolveConfig().geometryStaleMs, GEOMETRY_STALE_MS, 'floor 后为 0 ⇒ 回落默认'); }
  finally { delete process.env.WTK_GEOMETRY_STALE_MS; }
});

test('env 超上限 ⇒ 启动期抛错（fail closed，不静默 clamp）；抛错必含变量名与上限', () => {
  const cases = [
    ['31536000000', 'WTK_GEOMETRY_STALE_MS'], // 一年
    ['90001', 'WTK_GEOMETRY_STALE_MS'],       // 上限 +1ms
    ['999999999999999999999', 'WTK_GEOMETRY_STALE_MS'], // 超安全整数
    ['60001', 'WTK_GEOMETRY_SKEW_MS'],
    ['86400000', 'WTK_GEOMETRY_SKEW_MS'],     // 一天
  ];
  for (const [val, name] of cases) {
    const other = name === 'WTK_GEOMETRY_STALE_MS' ? 'WTK_GEOMETRY_SKEW_MS' : 'WTK_GEOMETRY_STALE_MS';
    process.env[name] = val;
    try {
      assert.throws(() => resolveConfig(), (e) => {
        const msg = String(e && e.message);
        assert.match(msg, new RegExp(name), '报错必须点名变量: ' + msg);
        assert.match(msg, /只允许收紧|<=/, '报错必须给出上限口径: ' + msg);
        assert.match(msg, /180/, '报错必须说明被打破的边界: ' + msg);
        return true;
      }, name + '=' + val + ' 必须启动即拒（放宽被禁）');
    } finally {
      delete process.env[name];
      delete process.env[other];
    }
  }
});

test('envIntNoRelax 单点：cap 由调用方给（不引入第二处字面量），未设置 = cap', () => {
  delete process.env.WTK_GEOMETRY_STALE_MS;
  assert.equal(envIntNoRelax('WTK_GEOMETRY_STALE_MS', GEOMETRY_STALE_MS), GEOMETRY_STALE_MS);
  process.env.WTK_GEOMETRY_STALE_MS = '100000';
  try { assert.throws(() => envIntNoRelax('WTK_GEOMETRY_STALE_MS', 90000), /只允许收紧/); }
  finally { delete process.env.WTK_GEOMETRY_STALE_MS; }
  process.env.WTK_GEOMETRY_STALE_MS = '30';
  try { assert.equal(envIntNoRelax('WTK_GEOMETRY_STALE_MS', 60), 30, '收紧采纳'); }
  finally { delete process.env.WTK_GEOMETRY_STALE_MS; }
});

test('注入阈值同样不得放宽：opts.staleMs/skewMs 超常量 ⇒ clamp 到常量（朝严格方向）', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T, staleMs: 31_536_000_000, skewMs: 31_536_000_000 });
  assert.equal(r.staleMs, GEOMETRY_STALE_MS, '注入超上限必须被夹到常量，不得生效');
  assert.equal(r.skewMs, GEOMETRY_SKEW_MS);
  T.at(GEOMETRY_STALE_MS + 1); // 阈值已被夹到 90s ⇒ age 90001 立刻陈旧
  assert.equal(r.byId('auto-1').state, 'error', '注入放宽不得生效：90s+1 仍判陈旧');
  r.stopWatch();
  // 非法注入（NaN / 字符串 / 负数 / Infinity / null / undefined）⇒ 回落常量，
  // 不得变成 Infinity（= 永不陈旧 = 放宽）之类。
  // 0 的语义逐字段不同，且**都朝严格方向**：
  //   staleMs=0 非法（零阈值 = 恒陈旧，会让入口全站不可用）⇒ 回落常量；
  //   skewMs=0 合法 = **零时钟容忍**（最严），故不回落。
  for (const bad of [NaN, '90000', -5, Infinity, null, undefined]) {
    const rr = newRegistry({ now: T, staleMs: bad, skewMs: bad });
    assert.equal(rr.staleMs, GEOMETRY_STALE_MS, '非法注入 ' + String(bad) + ' 必须回落常量');
    assert.equal(rr.skewMs, GEOMETRY_SKEW_MS, '非法注入 ' + String(bad) + ' 必须回落常量');
    rr.stopWatch();
  }
  const z = newRegistry({ now: T, staleMs: 0, skewMs: 0 });
  assert.equal(z.staleMs, GEOMETRY_STALE_MS, 'staleMs=0 非法（恒陈旧）⇒ 回落常量');
  assert.equal(z.skewMs, 0, 'skewMs=0 = 零时钟容忍（最严），合法收紧不回落');
  z.stopWatch();
});

// ------------------------------------------------------------------ 1) 新鲜 = 零差异
test('新鲜 geometry 桌：read() 返回同一对象引用（零拷贝、零新增键）', () => {
  write([desk('auto-1', { geometry: AUTO }), desk('vcmi')]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(1000); // age = 1s << 90s
  const reg = r.read();
  assert.equal(reg.stale, undefined, '新鲜时不得注入 stale 键');
  const a = reg.desktops.find((d) => d.id === 'auto-1');
  assert.equal(a.state, 'running');
  assert.equal('geometryError' in a, false);
  assert.deepEqual(a.geometry, AUTO);
  const legacy = reg.desktops.find((d) => d.id === 'vcmi');
  assert.deepEqual(Object.keys(legacy), ['id', 'name', 'port', 'state', 'container', 'containerId', 'generation', 'appId'],
    'legacy 键集合逐字不变');
  r.stopWatch();
});

test('边界：age == 阈值 ⇒ 新鲜；age == 阈值+1 ⇒ 陈旧', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(90000);
  assert.equal(r.byId('auto-1').state, 'running', '等于阈值仍新鲜（闭区间在新鲜侧）');
  T.at(90001);
  assert.equal(r.byId('auto-1').state, 'error', '超过阈值 1ms 即 fail-closed');
  r.stopWatch();
});

// ------------------------------------------------------------------ 2) 缓存命中也求值
test('同一个缓存文件上发生新鲜→陈旧翻转（门逐次求值，不只在 cache miss 时判）', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(1000);
  const first = r.read();
  assert.equal(r.byId('auto-1').state, 'running');
  assert.equal(r.read(), first, '新鲜期缓存命中 = 复用同一规范视图对象');
  // 文件此后**未被再写**（缓存键 size:mtimeMs 全程不变）⇒ 下面翻转只能来自逐次求值的门
  T.at(95000);
  const e = r.byId('auto-1');
  assert.equal(e.state, 'error', '同一缓存文件上必须发生新鲜→陈旧翻转');
  assert.equal(e.geometryError, true);
  assert.match(e.geometryDetail, /陈旧/);
  assert.match(e.geometryDetail, /healthEnd/, 'detail 必须点明 mtime ≠ healthEnd 的口径限制');
  const staleView = r.read();
  assert.equal(staleView.stale, true);
  assert.equal(staleView.desktops.length, 1, '不删条目（fail-closed 靠 state，不靠丢桌）');
  assert.notEqual(staleView, first, '陈旧视图是派生副本 ⇒ 缓存规范视图不得被就地改写');
  T.at(1000);
  assert.equal(r.read(), first, '回到新鲜即返回原规范对象（缓存未被污染）');
  r.stopWatch();
});

test('陈旧标记不污染缓存：文件恢复写入后同一实例立即回到 running', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(120000);
  assert.equal(r.byId('auto-1').state, 'error');
  // manager 恢复 ⇒ 重写文件（mtime + size 同时变化，缓存键必然失效）
  write([desk('auto-1', { geometry: AUTO, state: 'running' })]);
  T.at(500);
  const e = r.byId('auto-1');
  assert.equal(e.state, 'running', '文件重写后必须恢复放行');
  assert.equal('geometryError' in e, false, '恢复后不留 geometryError');
  assert.equal(r.read().stale, undefined, '恢复后不留 stale 键');
  r.stopWatch();
});

test('时钟回拨：mtime 超前但在 skew 内 ⇒ 放行；超过 skew ⇒ 陈旧', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(-30000); // now 比 mtime 早 30s（< skew 60s）
  assert.equal(r.byId('auto-1').state, 'running', 'skew 内的未来 mtime 不判陈旧');
  T.at(-61000); // 超过 skew
  const e = r.byId('auto-1');
  assert.equal(e.state, 'error', '未来 mtime 超 skew = fail-closed');
  assert.equal(e.geometryError, true);
  assert.match(e.geometryDetail, /陈旧/);
  r.stopWatch();
});

// ------------------------------------------------------------------ 3) legacy 不受影响
test('陈旧时 legacy 桌逐字节不变（同对象引用）；geometry 桌被标错', () => {
  write([desk('vcmi'), desk('chrome-1', { port: 25322 }), desk('auto-1', { port: 25323, geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(1000);
  const fresh = r.read();
  const legacy0 = fresh.desktops.find((d) => d.id === 'vcmi');
  T.at(200000);
  const stale = r.read();
  assert.equal(stale.desktops.length, 3, '不丢桌');
  const legacy1 = stale.desktops.find((d) => d.id === 'vcmi');
  assert.equal(legacy1, legacy0, 'legacy 条目必须是同一对象引用 ⇒ 逐字节零差异');
  assert.equal(legacy1.state, 'running');
  assert.equal(Object.keys(legacy1).length, 8);
  assert.equal(stale.desktops.find((d) => d.id === 'chrome-1').state, 'running', '全部 legacy 不受影响');
  const a = stale.desktops.find((d) => d.id === 'auto-1');
  assert.equal(a.state, 'error');
  assert.equal(a.geometryError, true);
  assert.deepEqual(a.geometry, AUTO, 'geometry 值保留（可诊断），判定靠 state/geometryError');
  assert.equal(a.port, 25323);
  r.stopWatch();
});

test('全表无 geometry 时：陈旧文件也返回原对象（现网 3 桌零行为变化）', () => {
  write([desk('vcmi'), desk('chrome-1', { port: 25322 }), desk('chrome-2', { port: 25323 })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(1000);
  const first = r.read();
  T.at(999999999);
  const second = r.read();
  assert.equal(second, first, '无 geometry 条目 ⇒ 门整体短路，返回同一对象');
  assert.equal(second.stale, undefined);
  for (const d of second.desktops) assert.equal(d.state, 'running');
  r.stopWatch();
});

test('present-非法 geometry 已 state=error：陈旧不得覆盖原 geometryDetail', () => {
  write([desk('bad-1', { geometry: { mode: 'auto', width: 99999, height: 720 } })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(1000);
  const before = r.byId('bad-1');
  assert.equal(before.state, 'error');
  assert.equal(before.geometryError, true);
  assert.match(before.geometryDetail, /width/);
  T.at(300000);
  const after = r.byId('bad-1');
  assert.equal(after.state, 'error');
  assert.equal(after.geometryDetail, before.geometryDetail, '保留更精确的形态诊断，不被陈旧文案覆盖');
  r.stopWatch();
});

test('文件缺失 / JSON 坏 / 根非法：行为不变（无 geometry 条目可标）', () => {
  const T = clock(0);
  const r = newRegistry({ now: T });
  fs.renameSync(FILE, FILE + '.off');
  try {
    T.set(10_000_000);
    const reg = r.read();
    assert.equal(reg.desktops.length, 0);
    assert.equal(reg.stale, undefined, '空表不注入 stale');
    assert.equal(reg.mtimeMs, 0);
  } finally {
    fs.renameSync(FILE + '.off', FILE);
  }
  fs.writeFileSync(FILE, '{ not json', 'utf8');
  T.set(10_000_000);
  const bad = r.read();
  assert.equal(bad.desktops.length, 0);
  assert.equal(bad.stale, undefined, '解析失败空表（mtimeMs=0）不得被标陈旧');
  r.stopWatch();
});

// ----------------------------------------------------- 3b) mtime 不可信 = fail-closed
// 2026-11-14 root 只读复核补口：mtimeMs 非有限正值 ⇒ 新鲜度**无法判定** ⇒ 必须 fail-closed。
// 旧实现（mtimeMs<=0 直接 return reg）= fail-open：合法 registry 被 fs.utimesSync 设成
// Unix epoch（mtime=0）⇒ 永远判新鲜 ⇒ 无限放行。新实现判不可信 ⇒ geometry 桌 state=error；
// 空表 / 全 legacy 表仍**原对象返回**（现网 legacy 三桌与 fake 内存视图零行为变化）。
function setEpochMtime() {
  const st = fs.statSync(FILE);
  fs.utimesSync(FILE, new Date(0), new Date(0));
  assert.equal(fs.statSync(FILE).mtimeMs, 0, "夹具自检：mtime 必须真为 epoch");
  return st;
}
function restoreMtime(st) {
  fs.utimesSync(FILE, new Date(st.atimeMs), new Date(st.mtimeMs));
}

test('mtime=epoch(0) + geometry 桌 ⇒ 不可信 fail-closed（state=error，不是放行）', () => {
  write([desk('auto-1', { geometry: AUTO }), desk('vcmi')]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  const before = setEpochMtime();
  try {
    T.set(1_700_000_000_000); // 挂钟正常；epoch 走"不可信"分支，不是 age 分支
    const reg = r.read();
    assert.equal(reg.mtimeMs, 0);
    assert.equal(reg.stale, true, '不可信必须显式置 stale');
    assert.equal(reg.staleReason, 'mtime-untrusted', '与陈旧分支可区分');
    assert.equal(reg.staleAgeMs, null, '不可信时 age 无意义');
    const a = reg.desktops.find((d) => d.id === 'auto-1');
    assert.equal(a.state, 'error', 'geometry 桌不得被放行');
    assert.equal(a.geometryError, true);
    assert.match(a.geometryDetail, /mtime 不可信/, 'detail 必须点名成因: ' + a.geometryDetail);
    const leg = reg.desktops.find((d) => d.id === 'vcmi');
    assert.equal(leg.state, 'running', 'legacy 不受影响');
    assert.equal(Object.keys(leg).join(','), Object.keys(desk('vcmi')).join(','), 'legacy 键集合不变');
  } finally {
    restoreMtime(before);
    r.stopWatch();
  }
});

test('mtime 不可信 + 全 legacy 表 ⇒ 原对象引用（现网零行为变化）', () => {
  write([desk('vcmi'), desk('chrome-1'), desk('chrome-2')]);
  const T = clock(1_700_000_000_000);
  const r = newRegistry({ now: T });
  const before = setEpochMtime();
  try {
    const reg = r.read();
    assert.equal(r._cache.reg, reg, '缓存视图原样');
    assert.equal(reg.stale, undefined, '全 legacy 不得注入 stale');
    assert.equal(reg.desktops.every((d) => d.state === 'running'), true);
  } finally {
    restoreMtime(before);
    r.stopWatch();
  }
});

test('mtime 非有限 / 负 / 非数字（直驱门）⇒ 一律不可信；空表原样', () => {
  const T = clock(1_700_000_000_000);
  const r = newRegistry({ now: T });
  const desks = () => [desk('auto-1', { geometry: AUTO }), desk('vcmi')];
  for (const m of [Infinity, -Infinity, -1, NaN, "123", undefined, null]) {
    const out = r._applyFreshness({
      schemaVersion: 1, publicOrigin: null, error: null, source: 'fixture',
      desktops: desks(), mtimeMs: m,
    });
    const a = out.desktops.find((d) => d.id === 'auto-1');
    assert.equal(a.state, "error", "mtimeMs=" + String(m) + " 必须 fail-closed");
    assert.equal(out.stale, true, "mtimeMs=" + String(m) + " 必须置 stale");
    assert.equal(out.staleReason, 'mtime-untrusted');
    assert.equal(out.desktops.find((d) => d.id === 'vcmi').state, 'running', 'legacy 不动');
  }
  const empty = [];
  const out = r._applyFreshness({
    schemaVersion: 1, publicOrigin: null, desktops: empty, error: 'x', source: 'fixture', mtimeMs: 0,
  });
  assert.equal(out.stale, undefined, '空表不得注入 stale');
  assert.equal(out.desktops, empty, '空表原引用');
  r.stopWatch();
});

test('mtime 被设成 epoch 后由 manager 重写文件 ⇒ 立即恢复放行（不可信不是永久封印）', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  setEpochMtime();
  T.set(1_700_000_000_000);
  assert.equal(r.byId('auto-1').state, 'error', '夹具自检：epoch 期间拒绝');
  r.writeAtomic(regObj([desk("auto-1", { geometry: AUTO })])); // 重写 ⇒ mtime = 现在
  // writeAtomic 走真实 fs ⇒ 新 mtime = **真实挂钟**；假时钟必须对齐真实 now，
  // 否则 1.7e12(2023-11) 相对现在 = 未来 ~3 年 ⇒ 命中 skew 分支，测不到恢复。
  T.set(Date.now());
  assert.equal(r.byId('auto-1').state, 'running', '重写后恢复');
  assert.equal(r.read().stale, undefined, '恢复后不留 stale 键');
  r.stopWatch();
});

test('进程内：mtime=epoch 的 geometry 桌 HTTP 与 WS 新准入 503，后端零请求', async () => {
  let hits = 0;
  const backend = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('MUST_NOT_BE_REACHED');
  });
  const bp = await listen0(backend);
  write([desk('auto-1', { port: bp, geometry: AUTO })]);
  const T = clock(0);
  const registry = newRegistry({ now: T });
  const app = createDispatcher({
    registry: registry,
    cfg: {
      host: "127.0.0.1", port: 0, registry: FILE,
      publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
      backendHost: '127.0.0.1', backendPortMin: bp, backendPortMax: bp,
      maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
      adaptivePreview: true,
    },
    logger: () => {},
  });
  const dp = await listen0(app.server);
  const before = setEpochMtime();
  try {
    T.set(1_700_000_000_000);
    for (const p of ['/?desktop=auto-1', '/desktop/auto-1/', '/desktop/auto-1/api/status']) {
      const res = await get(dp, p);
      assert.equal(res.status, 503, p + ' mtime 不可信必须 503');
    }
    for (const tail of ['/websockify?resize=remote', '/audio']) {
      const raw = await rawUpgrade(dp, '/desktop/auto-1' + tail);
      assert.match(raw.split(CRLF)[0], / 503 /, 'WS 通道同门: ' + tail);
    }
    assert.equal(hits, 0, '拒绝必须发生在进 proxy 之前');
  } finally {
    restoreMtime(before);
    registry.stopWatch();
    await new Promise((res) => { app.server.close(() => res()); });
    backend.close();
    try { backend.closeAllConnections(); } catch (e) { /* ignore */ }
  }
});

// ------------------------------------------------------------------ 4) 注入阈值 + 只读门
test('opts.staleMs / opts.skewMs 生效（测试可收紧，不改全局常量）', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T, staleMs: 1000, skewMs: 1000 });
  T.at(900);
  assert.equal(r.byId('auto-1').state, 'running');
  T.at(1500);
  assert.equal(r.byId('auto-1').state, 'error');
  r.stopWatch();
});

test('陈旧标记只读：改写返回条目不得影响后续 read（无缓存污染）', () => {
  write([desk('auto-1', { geometry: AUTO })]);
  const T = clock(0);
  const r = newRegistry({ now: T });
  T.at(200000);
  const e = r.byId('auto-1');
  e.state = 'running';
  e.geometryError = false;
  assert.equal(r.byId('auto-1').state, 'error', '消费方改写视图不得放宽门（每读重新派生）');
  r.stopWatch();
});

// ================================================================== 5) 进程内 503（进 proxy 之前）
function listen0(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: port, method: 'GET', path: p, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('client timeout')));
    r.end();
  });
}

const CRLF = String.fromCharCode(13, 10);
// 后端 ws 库要求 Sec-WebSocket-Key 为 24 字符 base64（/^[+/0-9A-Za-z]{22}==$/），
// 随手写 'AAAA' 会被**后端**判 400，掩盖 dispatcher 自己的状态行 ⇒ 用合法 key。
const WSKEY = 'AAAAAAAAAAAAAAAAAAAAAA==';
function rawUpgrade(port, p) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET ' + p + ' HTTP/1.1' + CRLF + 'Host: 127.0.0.1' + CRLF
        + 'Upgrade: websocket' + CRLF + 'Connection: Upgrade' + CRLF
        + 'Sec-WebSocket-Version: 13' + CRLF + 'Sec-WebSocket-Key: ' + WSKEY + CRLF + CRLF);
    });
    const chunks = [];
    const stop = () => resolve(Buffer.concat(chunks).toString('latin1'));
    s.on('data', (c) => chunks.push(c));
    s.on('end', stop);
    s.on('close', stop);
    s.on('error', stop);
    s.setTimeout(5000, () => { try { s.destroy(); } catch (e) {} reject(new Error('upgrade timeout')); });
  });
}

// 放行态的 WS 用真客户端握手 + 回显（握手成功后连接保持 ⇒ raw 只会拿到头块后空闲超时）
function wsConnect(port, p) {
  return new Promise((resolve, reject) => {
    const client = new WS('ws://127.0.0.1:' + port + p, { handshakeTimeout: 5000 });
    client.once('open', () => resolve(client));
    client.once('error', (e) => reject(e));
  });
}
function wsEcho(client, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('echo timeout')), timeoutMs || 4000);
    client.once('message', (m) => { clearTimeout(t); resolve(m.toString('utf8')); });
    client.send(msg);
  });
}

test('进程内门：陈旧 geometry 桌的 HTTP 与 WS 新准入 503，且假后端零请求（未进 proxy）', async () => {
  let backendHits = 0;
  const backend = http.createServer((req, res) => {
    backendHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('BACKEND_SHOULD_NOT_BE_REACHED');
  });
  const bp = await listen0(backend);
  write([desk('auto-1', { port: bp, geometry: AUTO })]);
  const T = clock(0);
  const registry = newRegistry({ now: T });
  const app = createDispatcher({
    registry: registry,
    cfg: {
      host: '127.0.0.1', port: 0, registry: FILE,
      publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
      backendHost: '127.0.0.1', backendPortMin: bp, backendPortMax: bp,
      maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
      adaptivePreview: true,
      geometryStaleMs: GEOMETRY_STALE_MS, geometrySkewMs: GEOMETRY_SKEW_MS,
    },
    logger: () => {},
  });
  const dp = await listen0(app.server);
  try {
    // 新鲜基线：根选择器 302（放行）
    T.at(1000);
    const okSel = await get(dp, '/?desktop=auto-1');
    assert.equal(okSel.status, 302, '新鲜时必须放行（证明 503 来自陈旧门而非其它门）');
    assert.equal(backendHits, 0, '302 引导阶段不碰后端');

    T.at(120000); // 越过 90s 阈值
    const root = await get(dp, '/?desktop=auto-1');
    assert.equal(root.status, 503);
    assert.match(root.body, /failclosed|几何/);
    const doc = await get(dp, '/desktop/auto-1/?autoconnect=1&resize=remote&path='
      + encodeURIComponent('desktop/auto-1/websockify') + '&idle_disconnect=0&clipboard_seamless=false&shared=true');
    assert.equal(doc.status, 503, '桌面根文档同门');
    const asset = await get(dp, '/desktop/auto-1/app.js');
    assert.equal(asset.status, 503, '子资源同门');
    const ws = await rawUpgrade(dp, '/desktop/auto-1/websockify?resize=remote');
    assert.match(ws.split(CRLF)[0], / 503 /, 'WS upgrade 同门（进 proxy 之前拒绝）');
    const aud = await rawUpgrade(dp, '/desktop/auto-1/audio');
    assert.match(aud.split(CRLF)[0], / 503 /, 'audio 通道同门');
    assert.equal(backendHits, 0, '全部拒绝发生在进 proxy 之前 ⇒ 后端零请求');

    // 站点级不整体下线：列表页 200（该桌显示异常），healthz 200 且桌面计数不变
    const list = await get(dp, '/');
    assert.equal(list.status, 200, '不整体停用站点');
    assert.match(list.body, /异常/);
    assert.match(list.body, /auto-1/, '条目仍在列表（不删）');
    const hz = await get(dp, '/healthz');
    assert.equal(hz.status, 200);
    assert.match(hz.body, /desktops=1/);

    // 恢复：manager 重写文件 ⇒ 新准入立即放行
    write([desk('auto-1', { port: bp, geometry: AUTO })]);
    T.at(600);
    const back = await get(dp, '/?desktop=auto-1');
    assert.equal(back.status, 302, '重写后恢复放行');
  } finally {
    registry.stopWatch();
    await new Promise((res) => { app.server.close(() => res()); });
    backend.close();
    try { backend.closeAllConnections(); } catch (e) { /* ignore */ }
  }
});

test('进程内门不影响 legacy 桌（现网 vcmi 陈旧文件仍可访问）', async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html>LEGACY_OK');
  });
  const bp = await listen0(backend);
  write([desk('vcmi', { port: bp })]);
  const T = clock(0);
  const registry = newRegistry({ now: T });
  const app = createDispatcher({
    registry: registry,
    cfg: {
      host: '127.0.0.1', port: 0, registry: FILE,
      publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
      backendHost: '127.0.0.1', backendPortMin: bp, backendPortMax: bp,
      maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
      geometryStaleMs: GEOMETRY_STALE_MS, geometrySkewMs: GEOMETRY_SKEW_MS,
    },
    logger: () => {},
  });
  const dp = await listen0(app.server);
  try {
    T.at(9_999_999); // 远超阈值
    const r = await get(dp, '/?desktop=vcmi');
    assert.equal(r.status, 302, 'legacy 不受新鲜度门影响');
    const loc = r.headers.location;
    assert.match(loc, /^\/desktop\/vcmi\/\?autoconnect=1&resize=scale/);
    // 根文档必须按**规范参数 URL**（跟随上面 302 的 location）访问：
    // legacy 无参 /desktop/vcmi/ 会被引导层 302 到规范参数，这是既有引导行为，
    // 与新鲜度门无关（本测试的判据 = legacy 全链路语义逐字不变）。
    const prox = await get(dp, loc);
    assert.equal(prox.status, 200);
    assert.match(prox.body, /LEGACY_OK/);
  } finally {
    registry.stopWatch();
    await new Promise((res) => { app.server.close(() => res()); });
    backend.close();
    try { backend.closeAllConnections(); } catch (e) { /* ignore */ }
  }
});

// ------------------------------------------------------------------ 6) 四处门的 registry 兼容性
// 门在 Registry.read() 内部 ⇒ 注入式 fake registry（内存版、read() 返回 mtimeMs=0）
// 不受本门约束：既有套件（adaptive-admission / adaptive-route）的内存 registry 语义不变；
// 同时真实 Registry 在 cfg **不带** geometryStaleMs（旧 fixture 形态）时必须回落常量，
// 不得因 undefined 阈值把 age 比较算成 NaN ⇒ 恒不陈旧 = 静默放宽门。
function fakeRegistry(desks) {
  const byId = (id) => desks.find((d) => d.id === id) || null;
  return {
    byId(id) {
      const d = byId(id);
      if (!d) return null;
      return Object.assign({
        id: d.id, name: d.id, state: 'running', container: '', containerId: '',
        generation: 1, appId: '',
      }, d.geometry ? { geometry: d.geometry } : {}, { port: d.port });
    },
    read() { return { schemaVersion: 1, publicOrigin: null, desktops: [], error: null, source: 'memory', mtimeMs: 0 }; },
    startWatch() {}, stopWatch() {}, writeAtomic() {},
  };
}

test('fake registry（mtimeMs=0 内存版）不受新鲜度门约束：四处门照旧放行 auto 桌', async () => {
  let hits = 0;
  const backend = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html>FAKE_REG_OK');
  });
  // 真 WS 后端（vendor/ws noServer + handleUpgrade）⇒ 能拿到真实 101，
  // 用裸 http 假后端会把转发的 upgrade 答成 200，掩盖握手语义。
  const wss = new WS.Server({ noServer: true });
  backend.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (m) => { try { client.send('ECHO:' + m.toString('utf8')); } catch (e) { /* ignore */ } });
    });
  });
  const bp = await listen0(backend);
  const app = createDispatcher({
    registry: fakeRegistry([{ id: 'auto-1', port: bp, geometry: AUTO }]),
    cfg: {
      host: '127.0.0.1', port: 0, registry: '/nonexistent/wtk-freshness-fake.json',
      publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
      backendHost: '127.0.0.1', backendPortMin: bp, backendPortMax: bp,
      maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
      adaptivePreview: true,
    },
    logger: () => {},
  });
  const dp = await listen0(app.server);
  try {
    const sel = await get(dp, '/?desktop=auto-1');
    assert.equal(sel.status, 302, '内存 registry 不得被新鲜度门拦下');
    assert.match(sel.headers.location, /resize=remote/, '仍按 auto 语义给 resize=remote');
    const doc = await get(dp, '/desktop/auto-1/?autoconnect=1&resize=remote&path='
      + encodeURIComponent('desktop/auto-1/websockify') + '&idle_disconnect=0&clipboard_seamless=false&shared=true');
    assert.equal(doc.status, 200, '桌面根文档 + 反代都照旧');
    assert.equal(hits, 1);
    const asset = await get(dp, '/desktop/auto-1/app.js');
    assert.equal(asset.status, 200, '子资源门照旧');
    const c = await wsConnect(dp, '/desktop/auto-1/websockify?resize=remote');
    assert.equal(await wsEcho(c, 'fake-reg-ok'), 'ECHO:fake-reg-ok', 'WS upgrade 门照旧（真握手 + 回显）');
    c.close();
    wss.close();
  } finally {
    app.registry.stopWatch();
    await new Promise((res) => { app.server.close(() => res()); });
    backend.close();
    try { backend.closeAllConnections(); } catch (e) { /* ignore */ }
  }
});

test('真实 Registry + cfg 不带 geometryStaleMs（旧 fixture 形态）⇒ 回落常量，不产生 NaN 放行', async () => {
  let hits = 0;
  const backend = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html>REAL_REG_STALE_MUST_503');
  });
  const bp = await listen0(backend);
  write([desk('auto-1', { port: bp, geometry: AUTO })]);
  const T = clock(0);
  const registry = newRegistry({ now: T });
  const app = createDispatcher({
    registry: registry,
    cfg: {
      host: '127.0.0.1', port: 0, registry: FILE,
      publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
      backendHost: '127.0.0.1', backendPortMin: bp, backendPortMax: bp,
      maxWs: 64, httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
      adaptivePreview: true,
      // 故意**不给** geometryStaleMs / geometrySkewMs（既有测试 fixture 的 cfg 形态）
    },
    logger: () => {},
  });
  const dp = await listen0(app.server);
  try {
    assert.equal(registry.staleMs, GEOMETRY_STALE_MS, '缺 cfg 阈值必须回落常量，不得为 NaN');
    assert.equal(registry.skewMs, GEOMETRY_SKEW_MS);
    T.at(120000);
    const r = await get(dp, '/?desktop=auto-1');
    assert.equal(r.status, 503, '阈值回落后台仍必须 fail-closed（NaN 比较会静默放行）');
    assert.equal(hits, 0);
  } finally {
    registry.stopWatch();
    await new Promise((res) => { app.server.close(() => res()); });
    backend.close();
    try { backend.closeAllConnections(); } catch (e) { /* ignore */ }
  }
});
