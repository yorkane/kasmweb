'use strict';
// 原生默认（native-default）opt-in 入口离线单测：node:test + 真 HTTP listen(0) + 内存 registry
// 契约（2026-11-16 授权口径，逐条对应断言）：
//   * WTK_NATIVE_DEFAULT_MODE **默认关闭**：关闭时 legacy 根选择 302 逐字旧行为
//     （注入 resize=scale），?resize=off / ?resize=remote 一律 400「不支持的参数: resize」
//   * 开启后 legacy 桌：规范集无 resize 键（其余 5 件逐字不变），客户端自带
//     resize ∈ {off,scale,remote} 合法并原样保留；桌面根文档带 resize 直出 200（无多余 302）
//   * 原生默认 ≠ remote：入口不强制 remote；Kasm iframe 客户端内置默认 off
//     （off = 不主动缩放、也不请求远端改尺寸）⇒ 本套件不宣称、也不断言「桌面尺寸自动跟随」
//   * fragment 优先级（取证 Kasm 1.1 webutil.js getConfigVar：注释「Fragment takes
//     precedence」，getHashVar 命中即返回）：# 覆盖 ? ⇒ **本入口只规范 query，
//     不宣称后端能约束客户端 hash**；断言只看 Location 的 query 部分
//   * fixed 几何的「真实固定」依赖后端 KasmVNC -AcceptSetDesktopSize=0（L1 由镜像/容器
//     参数决定），dispatcher 侧的门禁只是入口约束
//   * legacy + resolution 两种模式下都 409（原生默认不接受固定分辨率注入）
//   * 已登记几何的桌面不降级：auto 未开 preview ⇒ 503 fail-closed；fixed 缺参/不等 ⇒ 409；
//     auto/fixed 根选择带客户端 resize ⇒ 400（resize 由入口规范决定）
//   * 形态门禁：resize 重复 400、非法枚举 400、空值 400
//   * 缺陷回归（2026-11-16）：native + prefix 深链缺规范项 ⇒ bootstrap 302 必须
//     带上经校验的单个 resize；重复/非法 ⇒ 连先前有效值一起作废，回落无 resize 规范态
//   * 顺序无关（2026-11-16 复审缺陷）：resize 的全部 occurrences 先于其余强制参数**预扫定案**
//     ⇒ ?path=evil&resize=remote 与 ?resize=remote&path=evil 必须同判（保留 remote）；
//     重复/非法/编码坏键等作废场景一律 null，且危险键（FORBIDDEN / 白名单外）的 400
//     优先于引导（两种键序同判）；non-native 分支返回形状与登记几何行为不变
//   * 复审缺陷 2（2026-11-16）：native 引导判定**不得屏蔽**排在坏 forced 键之后的危险键
//     ⇒ ?path=evil&image=evil&resize=remote 与 ?image=evil&path=evil&resize=remote 同判 400；
//     重复 forced 键（同值/异值）判引导且保留合法 resize；non-native 短路顺序逐字不变
//   * WS：native + legacy 的 /websockify 与 /audio 放行（101）；带 resolution 仍 409；
//     auto WS 未开 preview 仍 503
// 本套件不写文件、不占固定端口、不启停容器、不触碰真实 registry / 真实服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const selector = require(path.join(ROOT, 'lib/selector'));
const cfgMod = require(path.join(ROOT, 'lib/config'));
const {
  canonicalParams, canonicalParamsNative,
  RESIZE_CLIENT_VALUES, envNativeDefault, resolveConfig,
} = cfgMod;
const { createDispatcher } = require(path.join(ROOT, 'server'));
const WS = require(path.join(ROOT, 'vendor/ws'));

const WSKEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const CRLF = String.fromCharCode(13, 10);

// ------------------------------------------------------------------
// 纯函数层：开关解析 / 规范参数集
// ------------------------------------------------------------------
test('envNativeDefault 只认逐字 1（默认关闭；0/空/true/乱码全判关）', () => {
  const saved = process.env.WTK_NATIVE_DEFAULT_MODE;
  const cases = [['1', true], [' 1 ', true], ['0', false], ['', false], ['true', false],
    ['yes', false], ['2', false], ['11', false], ['off', false], ['ON', false]];
  try {
    for (const [raw, want] of cases) {
      process.env.WTK_NATIVE_DEFAULT_MODE = raw;
      assert.equal(envNativeDefault(), want, 'WTK_NATIVE_DEFAULT_MODE=' + JSON.stringify(raw));
    }
    delete process.env.WTK_NATIVE_DEFAULT_MODE;
    assert.equal(envNativeDefault(), false, '未设置 = 默认关闭');
  } finally {
    if (saved === undefined) delete process.env.WTK_NATIVE_DEFAULT_MODE;
    else process.env.WTK_NATIVE_DEFAULT_MODE = saved;
  }
});

test('resolveConfig 默认不打开 native-default（env 未设置 ⇒ false）', () => {
  const saved = process.env.WTK_NATIVE_DEFAULT_MODE;
  try {
    delete process.env.WTK_NATIVE_DEFAULT_MODE;
    assert.equal(resolveConfig().nativeDefault, false, '默认必须关闭');
    process.env.WTK_NATIVE_DEFAULT_MODE = '1';
    assert.equal(resolveConfig().nativeDefault, true);
  } finally {
    if (saved === undefined) delete process.env.WTK_NATIVE_DEFAULT_MODE;
    else process.env.WTK_NATIVE_DEFAULT_MODE = saved;
  }
});

test('canonicalParamsNative = canonicalParams 去掉 resize，其余逐字逐序不变', () => {
  const full = canonicalParams('nd-1');
  const nat = canonicalParamsNative('nd-1');
  assert.equal(full.length, 6);
  assert.equal(nat.length, 5);
  assert.deepEqual(nat, full.filter((p) => p[0] !== 'resize'));
  assert.deepEqual(nat.map((p) => p[0]),
    ['autoconnect', 'path', 'idle_disconnect', 'clipboard_seamless', 'shared']);
  assert.deepEqual(canonicalParams('nd-1'), full, '旧函数产物不受影响');
});

test('RESIZE_CLIENT_VALUES = Kasm 客户端枚举 off/scale/remote', () => {
  assert.deepEqual([...RESIZE_CLIENT_VALUES].sort(), ['off', 'remote', 'scale']);
  for (const b of ['Remote', 'REMOTE', 'Scale', 'none', 'auto', 'session', '']) {
    assert.equal(RESIZE_CLIENT_VALUES.has(b), false, b + ' 不是合法枚举');
  }
});

const auto = { mode: 'auto', width: 1600, height: 900, canonical: null };
const fixed16 = { mode: 'fixed', width: 1600, height: 900, canonical: '1600x900' };
const res16 = { ok: true, width: 1600, height: 900, canonical: '1600x900' };
const res19 = { ok: true, width: 1920, height: 1080, canonical: '1920x1080' };

test('decideGeometry native：legacy 无参 = redirect 且 resizeMode null（不注入 resize）', () => {
  const e = { id: 'a' };
  const d = selector.decideGeometry(e, null, null, false, true);
  assert.deepEqual(d, { action: 'redirect', resizeMode: null, resolution: null, legacy: true, native: true });
  assert.equal(d.resizeMode, null, '原生默认 = 不注入：不是 scale，也不是 remote');
  assert.deepEqual(selector.decideGeometry(e, null, null, false, false),
    { action: 'redirect', resizeMode: 'scale', resolution: null, legacy: true },
    '关闭态逐字旧行为');
});

test('decideGeometry native：legacy+resolution 仍 409；auto/fixed 不降级', () => {
  const e = { id: 'a' };
  const l = selector.decideGeometry(e, null, res16, false, true);
  assert.equal(l.action, 'error');
  assert.equal(l.code, 409, '原生默认不接受固定分辨率参数');
  const a = selector.decideGeometry(e, auto, null, false, true);
  assert.equal(a.code, 503, 'auto 在 native-only 下仍 fail-closed，不隐式降级 legacy');
  assert.match(a.msg, /WTK_ENABLE_ADAPTIVE_PREVIEW/);
  assert.deepEqual(selector.decideGeometry(e, auto, null, true, true),
    { action: 'redirect', resizeMode: 'remote', resolution: null },
    'auto + preview 开的行为与 native 开关无关（逐字旧版）');
  assert.equal(selector.decideGeometry(e, fixed16, null, true, true).code, 409, 'fixed 缺参仍 409');
  assert.equal(selector.decideGeometry(e, fixed16, res19, true, true).code, 409);
  assert.deepEqual(selector.decideGeometry(e, fixed16, res16, false, true),
    { action: 'redirect', resizeMode: 'scale', resolution: res16 }, 'fixed 齐参行为不变');
  assert.equal(selector.decideGeometry({ id: 'a', geometryError: true }, null, null, false, true).code, 503,
    'geometryError 先于一切');
  assert.equal(selector.decideGeometry(e, 'invalid', null, false, true).code, 503);
});

test('decideAsset native：legacy allow 且 resizeMode null；auto 未开 preview 仍 503', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideAsset(e, null, null, false, true),
    { action: 'allow', resizeMode: null, legacy: true, native: true });
  assert.deepEqual(selector.decideAsset(e, null, null, false, false),
    { action: 'allow', resizeMode: 'scale', legacy: true });
  assert.equal(selector.decideAsset(e, null, res16, false, true).code, 409);
  assert.equal(selector.decideAsset(e, auto, null, false, true).code, 503);
  assert.deepEqual(selector.decideAsset(e, fixed16, null, false, true), { action: 'allow', resizeMode: 'scale' });
  assert.equal(selector.decideAsset(e, 'invalid', null, false, true).code, 503);
});

test('decideGeometryWs native：legacy 放行 resizeMode null；resolution 409；auto 503', () => {
  const e = { id: 'a' };
  assert.deepEqual(selector.decideGeometryWs(e, null, { nativeMode: true }),
    { action: 'allow', resizeMode: null, native: true });
  assert.deepEqual(selector.decideGeometryWs(e, null, { resize: 'off', nativeMode: true }),
    { action: 'allow', resizeMode: null, native: true },
    '不新增 resize 形态约束（Kasm WS URL 由 ui.js 拼接，不保证带 resize）');
  assert.deepEqual(selector.decideGeometryWs(e, null, { kind: 'audio', nativeMode: true }),
    { action: 'allow', resizeMode: null, native: true });
  assert.deepEqual(selector.decideGeometryWs(e, null, { nativeMode: false }),
    { action: 'allow', resizeMode: 'scale' }, '关闭态逐字旧行为');
  assert.equal(selector.decideGeometryWs(e, null, { resolutionPresent: true, nativeMode: true }).code, 409);
  const aw = selector.decideGeometryWs(e, auto, { nativeMode: true });
  assert.equal(aw.code, 503);
  assert.equal(aw.reason, 'previewDisabled');
  assert.equal(selector.decideGeometryWs(e, fixed16, { resize: 'remote', nativeMode: true }).code, 400,
    'fixed 显式 resize 必须 scale（不受 native 影响）');
  assert.equal(selector.decideGeometryWs({ id: 'a', geometryError: true }, null, { nativeMode: true }).code, 503);
  assert.equal(selector.decideGeometryWs(e, 'invalid', { nativeMode: true }).code, 503);
});
test('decideRoot native：resize 枚举/重复门禁；关闭态 resize 一律 400', () => {
  const q = (s) => selector.decideRoot('/', s, { nativeMode: true });
  for (const v of ['off', 'scale', 'remote']) {
    const d = q('desktop=nd-legacy&resize=' + v);
    assert.equal(d.kind, 'select', v + ' 必须放行解析');
    assert.equal(d.resize, v);
  }
  for (const s of ['desktop=nd-legacy&resize=off&resize=scale', 'desktop=nd-legacy&resize=scale&resize=scale']) {
    const d = q(s);
    assert.equal(d.kind, 'error', '重复 resize 判 400: ' + s);
    assert.equal(d.code, 400);
    assert.match(d.msg, /重复/);
  }
  for (const s of ['desktop=nd-legacy&resize=weird', 'desktop=nd-legacy&resize=', 'desktop=nd-legacy&resize=Scale']) {
    const d = q(s);
    assert.equal(d.kind, 'error', '非法枚举判 400: ' + s);
    assert.equal(d.code, 400);
  }
  assert.equal(q('desktop=nd-legacy&image=evil').msg, '不支持的参数: image', '未知参数门禁不变');
  const off = selector.decideRoot('/', 'desktop=nd-legacy&resize=off');
  assert.equal(off.kind, 'error', '关闭态 resize 仍旧 400');
  assert.equal(off.msg, '不支持的参数: resize', '关闭态逐字旧文案');
  assert.equal(selector.decideRoot('/', 'desktop=nd-legacy&resize=off', {}).msg, '不支持的参数: resize',
    'opts 缺省 = 旧语义');
});

// 2026-11-16 缺陷回归：结果必须回传**校验通过的单个 resize**（result.resize），
// 调用方（server 的 rootDoc 引导分支）据此在 302 里保参；重复/非法 ⇒ null（不猜值）。
test('bootstrapDecision native：无 resize 即规范态；客户端 resize 不改写；重复回落规范态', () => {
  const base = 'autoconnect=1&path=' + encodeURIComponent('desktop/nd-legacy/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
  const native = { nativeMode: true, resizeMode: null, resolution: null };
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', base, native),
    { action: 'pass', resize: null });
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', base + '&resize=off', native),
    { action: 'pass', resize: 'off' });
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', base + '&resize=remote', native),
    { action: 'pass', resize: 'remote' }, 'remote 也必须直出 200：原生默认不强制、不改写');
  const dup = selector.bootstrapDecision('nd-legacy', base + '&resize=scale&resize=off', native);
  assert.equal(dup.action, 'redirect', '重复 ⇒ 回落无 resize 规范态');
  assert.equal(dup.resize, null, '重复 resize 不得自动取其中一个');
  const bad = selector.bootstrapDecision('nd-legacy', base + '&resize=weird', native);
  assert.equal(bad.action, 'redirect', '非法枚举不引导');
  assert.equal(bad.resize, null, '非法枚举不得伪造');
  const off = selector.bootstrapDecision('nd-legacy', base, { resizeMode: 'scale', resolution: null });
  assert.equal(off.action, 'redirect', '关闭态 resize=scale 缺失仍引导（旧行为）');
  assert.equal(off.resize, null, '非 native 模式恒不回填 resize（旧语义）');
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', base + '&resize=scale', { resizeMode: 'scale' }),
    { action: 'pass', resize: null }, '关闭态带 resize=scale 仍是规范态（旧行为）');
  const res = selector.bootstrapDecision('nd-legacy', base + '&resolution=1600x900', native);
  assert.equal(res.action, 'redirect', 'native 下 resolution 永不进规范态');
  assert.equal(res.resize, null, '无 resize 时引导态不带 resize');
});

test('bootstrapDecision native：引导结果回传单个有效 resize（含缺规范项 / extras 场景）', () => {
  const pathKey = encodeURIComponent('desktop/nd-legacy/websockify');
  const full = 'autoconnect=1&path=' + pathKey + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
  const native = { nativeMode: true, resizeMode: null, resolution: null };
  // 深链直访：只有 resize，缺全部规范项 ⇒ redirect 且**必须**回传 remote
  const deep = selector.bootstrapDecision('nd-legacy', 'resize=remote', native);
  assert.equal(deep.action, 'redirect');
  assert.equal(deep.resize, 'remote', '引导 302 丢失显式 resize 即本用例针对的缺陷');
  // 部分规范项 + 显式 resize ⇒ 仍回传
  const part = selector.bootstrapDecision('nd-legacy', 'autoconnect=1&resize=off', native);
  assert.equal(part.action, 'redirect');
  assert.equal(part.resize, 'off');
  // 白名单 extras + 显式 scale ⇒ 仍回传（extras 由调用方 collectExtras 负责）
  const ext = selector.bootstrapDecision('nd-legacy', full + '&bell=on&resize=scale&show_control_bar=1', native);
  assert.equal(ext.action, 'pass', '规范 5 件齐备 ⇒ 直出');
  assert.equal(ext.resize, 'scale');
  // 非规范 extras（白名单外）⇒ error，不产生引导态伪值
  assert.equal(selector.bootstrapDecision('nd-legacy', 'resize=off&image=evil', native).action, 'error',
    '白名单外参数仍 400，不因引导保参放宽');
  // 重复 ⇒ null（先出现的有效值也不得回填）
  assert.equal(selector.bootstrapDecision('nd-legacy', 'resize=remote&resize=scale', native).resize, null,
    '重复顺序无关：一律不猜值');
  // 非法 + 有效混排 ⇒ null
  assert.equal(selector.bootstrapDecision('nd-legacy', 'resize=remote&resize=x', native).resize, null);
  // 顺序无关（2026-11-16 复审）：作废判定与键序无关，且**先出现的有效值也作废**
  assert.equal(selector.bootstrapDecision('nd-legacy', 'resize=&shared=true', native).resize, null,
    '空值不回填');
  assert.equal(selector.bootstrapDecision('nd-legacy', 'path=evil&resize=remote&resize=scale', native).resize,
    null, '坏 forced 键在前 + 重复 ⇒ 仍作废');
  assert.equal(selector.bootstrapDecision('nd-legacy', 'autoconnect=0&resize=off&resize=off', native).resize,
    null, '同值重复同样作废（重复即歧义）');
  // audio 无关：非 native 时即便 query 带 resize 也不回填
  assert.equal(selector.bootstrapDecision('nd-legacy', full + '&resize=scale',
    { resizeMode: 'scale' }).resize, null);
});

// 2026-11-16 复审缺陷：旧实现在扫到 resize **之前**遇到坏 forced 键就提前引导 ⇒ 丢已校验的
// resize（?path=evil&resize=remote 丢、?resize=remote&path=evil 保）。修复 = 预扫全部
// occurrences 先定案，判定与键序无关。
test('bootstrapDecision native：resize 预扫与键序无关（坏 forced 键在前/在后同判）', () => {
  const pathKey = encodeURIComponent('desktop/nd-legacy/websockify');
  const native = { nativeMode: true, resizeMode: null, resolution: null };
  // (a) 坏 forced 键 + 合法 resize：两种键序必须完全同判，且保留 resize
  for (const [v, s] of [
    ['remote', 'path=evil&resize=remote'], ['remote', 'resize=remote&path=evil'],
    ['off', 'autoconnect=0&resize=off'], ['off', 'resize=off&autoconnect=0'],
    ['scale', 'shared=false&path=' + pathKey + '&resize=scale'],
    ['scale', 'path=' + pathKey + '&resize=scale&shared=false'],
    ['remote', 'clipboard_seamless=true&resize=remote'],
    ['remote', 'resize=remote&clipboard_seamless=true'],
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', s);
    assert.equal(d.resize, v, '坏 forced 键不得吞掉已校验的 resize：' + s);
  }
  // (b) 编码坏键（decode 失败 ⇒ 判引导）同样不吞 resize
  for (const s of ['%zz=1&resize=off', 'resize=off&%zz=1']) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', s);
    assert.equal(d.resize, 'off', '编码坏键在前/在后同判：' + s);
  }
  // (c) 重复 / 非法：两种键序都作废（连有效值一起），且不 pass
  for (const s of [
    'path=evil&resize=remote&resize=scale', 'resize=remote&resize=scale&path=evil',
    'autoconnect=0&resize=off&resize=weird', 'resize=off&resize=weird&autoconnect=0',
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', '必判引导：' + s);
    assert.equal(d.resize, null, '作废不猜值：' + s);
  }
  // (d) 危险键 400 优先于引导，两种键序同判（保参修复不得让危险键降级成 redirect）
  for (const s of [
    'image=evil&resize=remote', 'resize=remote&image=evil',
    'token=x&resize=off', 'resize=off&token=x',
    'bell=maybe&resize=off', 'resize=off&bell=maybe',
    'weirdkey=1&resize=remote', 'resize=remote&weirdkey=1',
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'error', '危险/非法值必须 400：' + s);
    assert.equal(d.code, 400, s);
  }
  // (e) resolution 与 resize 混排：native 下 resolution 永不进规范态 ⇒ 引导并保留 resize
  for (const s of ['resolution=1600x900&resize=remote', 'resize=remote&resolution=1600x900']) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', s);
    assert.equal(d.resize, 'remote', s);
  }
  // (f) 规范 5 件齐备 + resize 在任意位置 ⇒ pass 且回传
  for (const s of [
    'resize=off&' + 'autoconnect=1&path=' + pathKey + '&idle_disconnect=0&clipboard_seamless=false&shared=true',
    'autoconnect=1&path=' + pathKey + '&resize=off&idle_disconnect=0&clipboard_seamless=false&shared=true',
    'autoconnect=1&path=' + pathKey + '&idle_disconnect=0&clipboard_seamless=false&shared=true&resize=off',
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.deepEqual(d, { action: 'pass', resize: 'off' }, '键序无关的直出：' + s);
  }
  // (g) 危险键不被 forced 顺序屏蔽（2026-11-16 复审缺陷 2）：旧实现在坏 forced 键处
  //     立即引导 ⇒ 排在其后的 image / 白名单外 / 白名单内非法值被静默跳过。
  //     native 改完整遍历后：只要 query 里存在任一危险键，无论排前后一律 400。
  for (const s of [
    'path=evil&image=evil&resize=remote',
    'image=evil&path=evil&resize=remote',
    'path=evil&resize=remote&image=evil',
    'autoconnect=0&weirdkey=1&resize=off',
    'weirdkey=1&autoconnect=0&resize=off',
    'shared=false&bell=maybe&resize=off',
    'bell=maybe&shared=false&resize=off',
    'autoconnect=0&url=x&token=1&resize=off',
    'path=' + pathKey + '&exec=/bin/sh&resize=scale',
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'error', '危险键必须 400（不被 forced 顺序屏蔽）：' + s);
    assert.equal(d.code, 400, s);
  }
  // (h) 重复 forced 键（同值重复 / 异值重复）⇒ 需引导，已校验的单个 resize 仍保留，
  //     两种键序同判
  for (const [v, s] of [
    ['remote', 'path=evil&path=evil&resize=remote'],
    ['remote', 'resize=remote&path=evil&path=evil'],
    ['remote', 'path=evil&path=' + pathKey + '&resize=remote'],
    ['remote', 'path=' + pathKey + '&path=evil&resize=remote'],
    ['off', 'autoconnect=0&autoconnect=1&resize=off'],
    ['scale', 'shared=true&shared=false&resize=scale'],
    ['off', 'path=evil&autoconnect=0&path=evil&resize=off'],
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', '重复 forced 键必判引导：' + s);
    assert.equal(d.resize, v, '重复 forced 键不得吞掉合法 resize：' + s);
  }
  // (i) 重复 forced + 重复 resize 混排 ⇒ 作废 resize（回落无 resize 规范态），两种键序同判
  for (const s of [
    'path=evil&path=evil&resize=remote&resize=scale',
    'resize=remote&resize=scale&path=evil&path=evil',
    'autoconnect=0&autoconnect=1&resize=off&resize=weird',
  ]) {
    const d = selector.bootstrapDecision('nd-legacy', s, native);
    assert.equal(d.action, 'redirect', '必判引导：' + s);
    assert.equal(d.resize, null, '作废不猜值：' + s);
  }
  // (j) non-native 分支：**逐字旧短路顺序不变**（先遇到者定局，旧行为不得改）
  {
    const scaleCtx = { resizeMode: 'scale', resolution: null };
    const d1 = selector.bootstrapDecision('nd-legacy', 'path=evil&image=evil&resize=remote', scaleCtx);
    assert.equal(d1.action, 'redirect', '非 native：坏 forced 在前 ⇒ 逐字旧行为（先判引导）');
    assert.deepEqual(Object.keys(d1), ['action', 'resize'], '非 native 形状不变');
    assert.equal(d1.resize, null, '非 native 恒 null');
    const d2 = selector.bootstrapDecision('nd-legacy', 'image=evil&path=evil&resize=remote', scaleCtx);
    assert.equal(d2.action, 'error', '非 native：危险键在前 ⇒ 400（同旧行为）');
    assert.equal(d2.code, 400);
  }
});

test('bootstrapDecision 非 native 分支：返回形状与登记几何行为不变（顺序无关修复不影响旧语义）', () => {
  const pathKey = encodeURIComponent('nd-legacy');
  const scaleCtx = { resizeMode: 'scale', resolution: null };
  const remoteCtx = { resizeMode: 'remote', resolution: null };
  for (const s of ['resize=remote&path=evil', 'path=evil&resize=remote',
    'resize=off', 'resize=scale&autoconnect=0', '']) {
    const d = selector.bootstrapDecision('nd-legacy', s, scaleCtx);
    assert.deepEqual(Object.keys(d), ['action', 'resize'], '形状只有 action/resize：' + s);
    assert.equal(d.resize, null, '非 native 恒 null：' + s);
    assert.equal(d.action, 'redirect', 'forced 键缺/改必引导：' + s);
  }
  const fullScale = 'autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/nd-legacy/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', fullScale, scaleCtx),
    { action: 'pass', resize: null }, '关闭态规范态 = scale 逐字旧行为');
  assert.deepEqual(selector.bootstrapDecision('nd-legacy', fullScale.replace('resize=scale', 'resize=remote'),
    remoteCtx), { action: 'pass', resize: null }, 'auto 桌规范 resize=remote 不受 native 修复影响');
  const r = selector.bootstrapDecision('nd-legacy', 'resolution=1600x900', remoteCtx);
  assert.equal(r.action, 'redirect', 'auto 桌带 resolution 仍引导（旧行为）');
  assert.equal(r.resize, null);
});

test('canonicalLocation native：无 resize 键 + root-relative + 客户端值原样 + extras 保留', () => {
  const nat = (o) => selector.canonicalLocation('http://127.0.0.1:1', 'nd-legacy', o.extras || [], o);
  const l1 = nat({ nativeMode: true, resizeMode: null, resolution: null });
  assert.ok(l1.startsWith('/desktop/nd-legacy/?'), l1);
  assert.ok(!l1.startsWith('//'), '不得协议相对');
  const q1 = new URL(l1, 'https://edge.example:99').searchParams;
  assert.equal(q1.get('resize'), null, '规范集不含 resize');
  assert.equal(q1.get('autoconnect'), '1');
  assert.equal(q1.get('path'), 'desktop/nd-legacy/websockify');
  assert.equal(q1.get('shared'), 'true');
  const l2 = nat({ nativeMode: true, resizeMode: null, resolution: null, resize: 'remote' });
  assert.equal(new URL(l2, 'https://e.x').searchParams.get('resize'), 'remote', '客户端显式值原样保留');
  const l3 = nat({ nativeMode: true, resizeMode: null, resolution: null, resize: 'off', extras: [['bell', 'on']] });
  const q3 = new URL(l3, 'https://e.x').searchParams;
  assert.equal(q3.get('resize'), 'off');
  assert.equal(q3.get('bell'), 'on', '白名单 extras 不受 native 影响');
  const old = selector.canonicalLocation('http://127.0.0.1:1', 'nd-legacy', [], { resizeMode: 'scale' });
  assert.equal(old.split('?')[1].split('&')[1], 'resize=scale', '关闭态字节序不变（resize 在第二位）');
});

// ------------------------------------------------------------------
// 集成层：真 HTTP + listen(0) + 内存 registry
// ------------------------------------------------------------------
const DESKS = {
  legacy: { id: 'nd-legacy', name: 'Legacy 桌', port: 0, state: 'running' },
  auto: { id: 'nd-auto', name: '自适应桌', port: 0, state: 'running', geometry: { mode: 'auto', width: 1600, height: 900 } },
  fixed: { id: 'nd-fixed', name: '固定桌', port: 0, state: 'running', geometry: { mode: 'fixed', width: 1600, height: 900 } },
  geomUndef: { id: 'nd-undef', name: 'present undefined', port: 0, state: 'running', geometry: undefined },
  geomErr: { id: 'nd-err', name: '几何坏桌', port: 0, state: 'running', geometryError: true },
};

function memoryRegistry() {
  const deskOf = (id) => {
    for (const k of Object.keys(DESKS)) if (DESKS[k].id === id) return DESKS[k];
    return null;
  };
  return {
    desktops: [],
    byId(id) {
      const d = deskOf(id);
      if (!d) return null;
      const e = { id: d.id, name: d.name, port: d.port, state: d.state, container: '', containerId: '', generation: 1, appId: '' };
      if (Object.prototype.hasOwnProperty.call(d, 'geometry')) e.geometry = d.geometry;
      if (d.geometryError === true) e.geometryError = true;
      return e;
    },
    read() { return { schemaVersion: 1, publicOrigin: null, desktops: [], error: null, source: 'memory', mtimeMs: 0 }; },
    startWatch() {}, stopWatch() {}, writeAtomic() {},
  };
}
const backendState = new Map();

function startBackend(id) {
  return new Promise((resolve, reject) => {
    const st = { httpCount: 0, wsCount: 0, lastUpgrade: null, lastRequest: null, marker: 'NATIVE_BACKEND_' + id };
    const server = http.createServer((req, res) => {
      st.httpCount += 1;
      st.lastRequest = { url: req.url, method: req.method };
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(st.marker);
    });
    const wss = new WS.Server({ server, verifyClient: () => true });
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

let app = null;
let dispatcherPort = 0;

function req(method, urlPath, o) {
  const opts = o || {};
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: opts.port || dispatcherPort, method, path: urlPath,
      headers: opts.headers || {}, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.setTimeout(opts.timeoutMs || 8000, () => { r.destroy(new Error('client request timeout')); });
    r.end();
  });
}
const get = (p, o) => req('GET', p, o);

// 101 路径必须用 rawStatus：rawHttp 会等连接关闭（升级后是隧道，不关闭）
function rawStatus(requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(dispatcherPort, '127.0.0.1', () => s.write(requestText));
    let buf = '';
    const finish = () => {
      s.removeAllListeners('data');
      try { s.destroy(); } catch (e) { /* ignore */ }
      resolve(buf.split(CRLF)[0]);
    };
    s.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.indexOf(CRLF + CRLF) >= 0) finish();
    });
    s.on('end', () => resolve(buf.split(CRLF)[0]));
    s.on('close', () => resolve(buf.split(CRLF)[0]));
    s.on('error', reject);
    s.setTimeout(timeoutMs || 5000, () => { s.destroy(); reject(new Error('raw status timeout')); });
  });
}

function upgradeText(p) {
  return 'GET ' + p + ' HTTP/1.1' + CRLF
    + 'host: 127.0.0.1:' + dispatcherPort + CRLF
    + 'upgrade: websocket' + CRLF
    + 'connection: Upgrade' + CRLF
    + 'sec-websocket-key: ' + WSKEY + CRLF
    + 'sec-websocket-version: 13' + CRLF + CRLF;
}

function wsConnect(pathStr) {
  return new Promise((resolve, reject) => {
    const client = new WS('ws://127.0.0.1:' + dispatcherPort + pathStr, { handshakeTimeout: 5000 });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDispatcher(opts) {
  const o = opts || {};
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
        adaptivePreview: o.preview === true,
        nativeDefault: o.native === true,
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

function canonicalScale(id) {
  return 'autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
}
function canonicalNative(id, resize) {
  return 'autoconnect=1&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true'
    + (resize ? '&resize=' + resize : '');
}
function qsOf(loc) {
  const i = loc.indexOf('?');
  return i < 0 ? '' : loc.slice(i + 1);
}
function assertRelativeLocation(loc, msg) {
  assert.equal(typeof loc, 'string', msg + ' 必须字符串');
  assert.ok(loc.startsWith('/desktop/'), msg + ' 必须 root-relative: ' + loc);
  assert.ok(!loc.startsWith('//'), msg + ' 不得协议相对');
  assert.ok(!/^[a-z]+:/i.test(loc), msg + ' 不得绝对 URL');
}

async function closeDispatcher() {
  if (!app) return;
  app.registry.stopWatch();
  await new Promise((r) => app.server.close(r));
  app = null;
}

test.before(async () => {
  for (const key of Object.keys(DESKS)) {
    const st = await startBackend(key);
    DESKS[key].port = st.port;
  }
});

test.after(async () => {
  await closeDispatcher();
  for (const [, b] of backendState) {
    for (const c of b.wss.clients) { try { c.terminate(); } catch (e) {} }
    await new Promise((r) => b.server.close(r));
  }
});
// ================= 默认关闭：旧行为字节不变 =================
test('关闭态（默认）：legacy 根选择 302 逐字旧行为；?resize=* 一律 400', async () => {
  await startDispatcher({ native: false, preview: false });
  try {
    const r = await get('/?desktop=nd-legacy');
    assert.equal(r.status, 302);
    assertRelativeLocation(r.headers.location, '关闭态 Location');
    assert.equal(qsOf(r.headers.location), canonicalScale('nd-legacy'), '字节序必须逐字不变');
    for (const v of ['off', 'scale', 'remote']) {
      const x = await get('/?desktop=nd-legacy&resize=' + v);
      assert.equal(x.status, 400, '关闭态 resize=' + v + ' 必须 400');
      assert.match(x.body, /不支持的参数/, '旧文案不变');
      assert.match(x.body, /resize/);
    }
    assert.equal(app.stats.get('native_select_pass'), 0, '关闭态不记 native 计数');
  } finally {
    await closeDispatcher();
  }
});

test('关闭态：桌面根文档带 resize=remote 仍 302 抹回 scale（旧引导语义）', async () => {
  await startDispatcher({ native: false });
  try {
    const r = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy', 'remote'));
    assert.equal(r.status, 302, '关闭态规范态含 resize=scale ⇒ 客户端改写必引导');
    assert.equal(qsOf(r.headers.location), canonicalScale('nd-legacy'));
  } finally {
    await closeDispatcher();
  }
});

// ================= 开启：legacy 不注入 resize =================
test('开启态：legacy 根选择 302 无 resize 键，其余 5 件 + extras 逐字保留', async () => {
  await startDispatcher({ native: true });
  try {
    const r = await get('/?desktop=nd-legacy');
    assert.equal(r.status, 302);
    assertRelativeLocation(r.headers.location, '开启态 Location');
    assert.equal(qsOf(r.headers.location), canonicalNative('nd-legacy'), '规范集 = 旧集去 resize');
    assert.ok(!/(^|&)resize=/.test(qsOf(r.headers.location)), '不得注入 resize');
    const e = await get('/?desktop=nd-legacy&bell=on');
    assert.equal(qsOf(e.headers.location), canonicalNative('nd-legacy') + '&bell=on', 'extras 追加位不变');
    assert.equal(app.stats.get('native_select_pass'), 2, 'native 计数逐次落地');
  } finally {
    await closeDispatcher();
  }
});

test('开启态：?resize=off|scale|remote 原样进 Location；重复/非法/空 = 400；未知参数 400', async () => {
  await startDispatcher({ native: true });
  try {
    for (const v of ['off', 'scale', 'remote']) {
      const r = await get('/?desktop=nd-legacy&resize=' + v);
      assert.equal(r.status, 302, 'resize=' + v);
      assert.equal(qsOf(r.headers.location), canonicalNative('nd-legacy', v), '客户端选择被尊重');
      const sp = new URL(r.headers.location, 'https://edge.example:99').searchParams;
      assert.equal(sp.get('resize'), v);
    }
    const dup = await get('/?desktop=nd-legacy&resize=scale&resize=off');
    assert.equal(dup.status, 400, '重复 resize = 400');
    assert.match(dup.body, /重复/);
    const bad = await get('/?desktop=nd-legacy&resize=weird');
    assert.equal(bad.status, 400, '非法枚举 = 400');
    assert.match(bad.body, /取值不合法/);
    assert.equal((await get('/?desktop=nd-legacy&resize=')).status, 400, '空值 = 400');
    assert.equal((await get('/?desktop=nd-legacy&image=evil')).status, 400, '未知参数门禁不因 native 放宽');
    assert.equal((await get('/?desktop=nd-legacy&path=evil')).status, 400, '禁止客户端指定 path');
  } finally {
    await closeDispatcher();
  }
});

test('开启态：桌面根文档带 resize 直出 200（无多余 302）；query 原样透传后端', async () => {
  await startDispatcher({ native: true });
  try {
    const a = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy'));
    assert.equal(a.status, 200, '规范态无 resize ⇒ 放行');
    assert.match(a.body, /NATIVE_BACKEND_legacy/);
    for (const v of ['off', 'scale', 'remote']) {
      const r = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy', v));
      assert.equal(r.status, 200, 'resize=' + v + ' 必直出 200，不得 302 抹平');
      assert.match(r.body, /NATIVE_BACKEND_legacy/);
    }
    assert.match(backendState.get('legacy').lastRequest.url, /resize=remote/, 'query 原样透传');
    const b = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy') + '&bell=on');
    assert.equal(b.status, 200, 'extras 参与放行判定');
    const missing = await get('/desktop/nd-legacy/?autoconnect=1');
    assert.equal(missing.status, 302, '缺规范参数仍引导');
    assert.equal(qsOf(missing.headers.location), canonicalNative('nd-legacy'));
    const dup = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy', 'off') + '&resize=scale');
    assert.equal(dup.status, 302, '重复 resize ⇒ 回落无 resize 规范态');
    assert.equal(qsOf(dup.headers.location), canonicalNative('nd-legacy'));
  } finally {
    await closeDispatcher();
  }
});

// ================= 开启：登记几何桌不降级 =================
// ============ 缺陷回归（2026-11-16）：prefix 深链引导 302 丢 resize ============
// 复现：native 开启 + legacy 桌，用户直访 /desktop/<id>/?resize=remote（缺规范 5 件）
// ⇒ bootstrapDecision 判 redirect，旧实现的 canonicalLocation 未传 resize ⇒ 静默丢参。
test('开启态：prefix 深链缺规范项时，302 必须保住经校验的 resize（off/scale/remote）', async () => {
  await startDispatcher({ native: true });
  try {
    for (const v of ['off', 'scale', 'remote']) {
      const r = await get('/desktop/nd-legacy/?resize=' + v);
      assert.equal(r.status, 302, 'resize=' + v + ' 缺规范项 ⇒ 引导');
      assertRelativeLocation(r.headers.location, '深链引导 Location');
      assert.equal(qsOf(r.headers.location), canonicalNative('nd-legacy', v),
        '引导 302 必须原样带上显式 resize（本用例针对的缺陷）');
      const sp = new URL(r.headers.location, 'https://edge.example:99').searchParams;
      assert.equal(sp.get('resize'), v);
      assert.equal(sp.get('autoconnect'), '1', '规范 5 件补齐');
      assert.equal(sp.get('path'), 'desktop/nd-legacy/websockify');
    }
    // extras 与显式 resize 同时保留，且 resize 不在 extras 里重复出现
    const e = await get('/desktop/nd-legacy/?resize=remote&bell=on&show_control_bar=1');
    assert.equal(e.status, 302);
    assert.equal(qsOf(e.headers.location),
      canonicalNative('nd-legacy', 'remote') + '&bell=on&show_control_bar=1',
      'extras 追加位不变 + 显式 resize 保留');
    const spE = new URL(e.headers.location, 'https://e.x').searchParams;
    assert.equal([...spE.getAll('resize')].length, 1, '302 里 resize 只出现一次');
    // 重复 / 非法：一律回落「无 resize」规范态，不得自动取其中一个
    for (const s of ['resize=remote&resize=scale', 'resize=scale&resize=remote',
      'resize=remote&resize=weird', 'resize=weird', 'resize=']) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 302, '引导回落：' + s);
      assert.equal(qsOf(x.headers.location), canonicalNative('nd-legacy'),
        '回落态无 resize，不猜值：' + s);
      assert.equal(new URL(x.headers.location, 'https://e.x').searchParams.get('resize'), null, s);
    }
    // 白名单外参数门禁不因保参放宽（FORBIDDEN 键 ⇒ 400，与保参无关）
    assert.equal((await get('/desktop/nd-legacy/?resize=remote&image=evil')).status, 400);
    // path 属规范参数族（FORCED 先判，与旧引导语义一致）⇒ 值不符走引导：
    // 客户端指定的 path 不生效、归规范值；已校验的显式 resize 属「缺/改其他规范项」
    // 场景 ⇒ 按本修复口径保留（不伪造、不猜值）
    const pEvil = await get('/desktop/nd-legacy/?resize=remote&path=evil');
    assert.equal(pEvil.status, 302, '客户端指定 path 不得生效（引导回规范值）');
    assert.equal(qsOf(pEvil.headers.location), canonicalNative('nd-legacy', 'remote'));
    assert.equal(new URL(pEvil.headers.location, 'https://e.x').searchParams.get('path'),
      'desktop/nd-legacy/websockify', 'path 归规范值');
    assert.equal(new URL(pEvil.headers.location, 'https://e.x').searchParams.get('resize'), 'remote',
      '规范项缺/改时显式 resize 保留（本修复的目标场景）');
    // off 闭环：深链 ⇒ 302 ⇒ 跟随 Location ⇒ 200 且后端实收 resize=off
    const d = await get('/desktop/nd-legacy/?resize=off');
    const follow = await get(d.headers.location);
    assert.equal(follow.status, 200, '引导后直出后端（无二次 302）');
    assert.match(follow.body, /NATIVE_BACKEND_legacy/);
    assert.match(backendState.get('legacy').lastRequest.url, /[?&]resize=off(&|$)/,
      '闭环后 query 原样透传后端：' + backendState.get('legacy').lastRequest.url);
    // 深链带完整规范项 ⇒ 直出 200（无多余 302，与既有用例同口径的闭环前置）
    const direct = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy', 'remote'));
    assert.equal(direct.status, 200);
    assert.match(direct.body, /NATIVE_BACKEND_legacy/);
  } finally {
    await closeDispatcher();
  }
});

// 端到端顺序无关回归：坏 forced 键（path / autoconnect / shared / clipboard_seamless）
// 与编码坏键排在 resize 之前或之后 ⇒ 302 的 Location 必须同判（保留已校验的 resize）。
// 复审缺陷复现串：?path=evil&resize=remote（旧实现丢 resize）。
test('开启态（HTTP 端到端）：坏 forced 键与 resize 的排列顺序不影响保参结论', async () => {
  await startDispatcher({ native: true });
  try {
    const pathKey = encodeURIComponent('desktop/nd-legacy/websockify');
    const keep = [
      ['remote', 'path=evil&resize=remote'],
      ['remote', 'resize=remote&path=evil'],
      ['off', 'autoconnect=0&resize=off'],
      ['off', 'resize=off&autoconnect=0'],
      ['scale', 'shared=false&path=' + pathKey + '&resize=scale'],
      ['scale', 'path=' + pathKey + '&resize=scale&shared=false'],
      ['remote', 'clipboard_seamless=true&resize=remote'],
      ['remote', 'resize=remote&clipboard_seamless=true'],
      ['off', '%zz=1&resize=off'],
      ['off', 'resize=off&%zz=1'],
    ];
    for (const [v, s] of keep) {
      const r = await get('/desktop/nd-legacy/?' + s);
      assert.equal(r.status, 302, '引导：' + s);
      assertRelativeLocation(r.headers.location, '排列保参 Location');
      const sp = new URL(r.headers.location, 'https://e.x').searchParams;
      assert.equal(sp.get('resize'), v, '坏 forced 键在前/在后都必须保留 resize：' + s
        + ' -> ' + r.headers.location);
      assert.equal([...sp.getAll('resize')].length, 1, 'resize 只出现一次：' + s);
      assert.equal(sp.get('path'), 'desktop/nd-legacy/websockify', 'path 归规范值：' + s);
      if (s.indexOf('resolution') < 0) assert.equal(sp.get('resolution'), null, '不注入 resolution：' + s);
    }
    // 重复 / 非法 + 坏 forced 键混排：两种键序都回落无 resize 规范态
    for (const s of [
      'path=evil&resize=remote&resize=scale', 'resize=remote&resize=scale&path=evil',
      'autoconnect=0&resize=off&resize=weird', 'resize=off&resize=weird&autoconnect=0',
      'shared=false&resize=scale&resize=', 'resize=scale&resize=&shared=false',
    ]) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 302, '引导回落：' + s);
      assert.equal(qsOf(x.headers.location), canonicalNative('nd-legacy'), '作废不猜值：' + s);
      assert.equal(new URL(x.headers.location, 'https://e.x').searchParams.get('resize'), null, s);
    }
    // 危险键组合：FORBIDDEN / 白名单外 一律 400（优先于引导），两种键序同判
    for (const s of [
      'image=evil&resize=remote', 'resize=remote&image=evil',
      'token=1&resize=off', 'resize=off&token=1',
      'url=x&resize=scale', 'resize=scale&url=x',
      'bell=maybe&resize=off', 'resize=off&bell=maybe',
    ]) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 400, '危险键必须 400（不被保参降级成引导）：' + s);
    }
    // 复审缺陷 2（端到端）：危险键排在坏 forced 键**之后**同样必须 400，
    // 不被「先判引导」屏蔽 ⇒ 完整遍历后位置无关
    for (const s of [
      'path=evil&image=evil&resize=remote', 'image=evil&path=evil&resize=remote',
      'path=evil&resize=remote&image=evil', 'resize=remote&path=evil&image=evil',
      'autoconnect=0&weirdkey=1&resize=off', 'weirdkey=1&autoconnect=0&resize=off',
      'shared=false&bell=maybe&resize=off', 'path=evil&url=x&token=1&resize=off',
    ]) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 400, '危险键不得被 forced 键顺序屏蔽：' + s);
    }
    // 重复 forced 键（同值 / 异值）+ 合法 resize ⇒ 302 且保留 resize（键序无关）
    for (const [v, s] of [
      ['remote', 'path=evil&path=evil&resize=remote'],
      ['remote', 'resize=remote&path=evil&path=evil'],
      ['remote', 'path=evil&path=' + pathKey + '&resize=remote'],
      ['off', 'autoconnect=0&autoconnect=1&resize=off'],
      ['scale', 'shared=true&shared=false&resize=scale'],
    ]) {
      const r = await get('/desktop/nd-legacy/?' + s);
      assert.equal(r.status, 302, '重复 forced 键 ⇒ 引导：' + s);
      const sp = new URL(r.headers.location, 'https://e.x').searchParams;
      assert.equal(sp.get('resize'), v, '重复 forced 键不吞 resize：' + s);
      assert.equal([...sp.getAll('resize')].length, 1, 'Location 里 resize 只一次：' + s);
      assert.equal(sp.get('path'), 'desktop/nd-legacy/websockify', 'path 归规范值：' + s);
    }
    // 重复 forced + 重复 resize 混排 ⇒ 回落无 resize 规范态
    for (const s of [
      'path=evil&path=evil&resize=remote&resize=scale',
      'resize=remote&resize=scale&path=evil&path=evil',
    ]) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 302, '引导回落：' + s);
      assert.equal(qsOf(x.headers.location), canonicalNative('nd-legacy'), '作废不猜值：' + s);
    }
    // 原 legacy 闭环回归：302 -> 跟随 -> 200，后端实收 query 含 resize
    const d = await get('/desktop/nd-legacy/?path=evil&resize=remote');
    const follow = await get(d.headers.location);
    assert.equal(follow.status, 200, '引导后直出后端');
    assert.match(follow.body, /NATIVE_BACKEND_legacy/);
    assert.match(backendState.get('legacy').lastRequest.url, /[?&]resize=remote(&|$)/,
      '端到端闭环：' + backendState.get('legacy').lastRequest.url);
    // 规范态直出（resize 在中间位）⇒ 200，无多余 302
    const mid = await get('/desktop/nd-legacy/?autoconnect=1&path=' + pathKey
      + '&resize=off&idle_disconnect=0&clipboard_seamless=false&shared=true');
    assert.equal(mid.status, 200, 'resize 位于规范键中间也直出');
    assert.match(mid.body, /NATIVE_BACKEND_legacy/);
    // 计数口径（实测事实）：native_select_pass 只挂在**根选择** 302（server.js:257），
    // prefix 深链的引导分支不记该计数 ⇒ 上面各次引导后仍为 0（负向断言）
    assert.equal(app.stats.get('native_select_pass'), 0,
      'prefix 深链引导不计 native_select_pass（该计数只挂根选择）');
    const rootSel = await get('/?desktop=nd-legacy');
    assert.equal(rootSel.status, 302, '根选择引导');
    assert.equal(app.stats.get('native_select_pass'), 1, 'native 计数在根选择处逐次落地');
    // resolution 与 resize 混排：几何门先判 ⇒ legacy + resolution 一律 409（不因保参放宽），
    // 两种键序同判
    for (const s of ['resolution=1600x900&resize=remote', 'resize=remote&resolution=1600x900']) {
      const x = await get('/desktop/nd-legacy/?' + s);
      assert.equal(x.status, 409, '几何门 409 优先于引导保参：' + s);
    }
  } finally {
    await closeDispatcher();
  }
});

test('关闭态：prefix 深链 resize 仍 302 抹回 scale（旧引导语义，不受保参修复影响）', async () => {
  await startDispatcher({ native: false });
  try {
    for (const v of ['off', 'scale', 'remote']) {
      const r = await get('/desktop/nd-legacy/?resize=' + v);
      assert.equal(r.status, 302, '关闭态 prefix 深链 resize=' + v + ' ⇒ 引导（与根路由 400 分工不变）');
      assert.equal(qsOf(r.headers.location), canonicalScale('nd-legacy'),
        '关闭态规范集仍含 resize=scale（逐字旧行为）');
      assert.equal(new URL(r.headers.location, 'https://e.x').searchParams.get('resize'), 'scale',
        '保参修复不得在关闭态生效');
    }
    // 顺序无关修复不得改关闭态：坏 forced 键在前 / 在后同判 = 抹回 scale
    for (const s of ['path=evil&resize=remote', 'resize=remote&path=evil', 'autoconnect=0&resize=off']) {
      const r = await get('/desktop/nd-legacy/?' + s);
      assert.equal(r.status, 302, '关闭态引导：' + s);
      assert.equal(qsOf(r.headers.location), canonicalScale('nd-legacy'), '逐字旧规范集：' + s);
    }
    assert.equal(app.stats.get('native_select_pass'), 0, '关闭态不记 native 计数');
    // 关闭态引导仍抹回 scale（保参只在 native 生效）
    const g = await get('/desktop/nd-legacy/?autoconnect=1');
    assert.equal(g.status, 302);
    assert.equal(qsOf(g.headers.location), canonicalScale('nd-legacy'), '关闭态规范集逐字旧版');
  } finally {
    await closeDispatcher();
  }
});

test('开启态：legacy + resolution = 409（原生默认不接受固定分辨率）', async () => {
  await startDispatcher({ native: true });
  try {
    const r = await get('/?desktop=nd-legacy&resolution=1600x900');
    assert.equal(r.status, 409);
    assert.match(r.body, /未登记几何/);
    const d = await get('/desktop/nd-legacy/?' + canonicalNative('nd-legacy') + '&resolution=1600x900');
    assert.equal(d.status, 409, '根文档同口径');
  } finally {
    await closeDispatcher();
  }
});

test('开启态：auto 未开 preview 503；fixed 缺参/不等 409；坏几何 503 先于 state', async () => {
  await startDispatcher({ native: true, preview: false });
  try {
    const a = await get('/?desktop=nd-auto');
    assert.equal(a.status, 503, 'auto 在 native-only 下仍 503，不得隐式降级 legacy');
    assert.match(a.body, /WTK_ENABLE_ADAPTIVE_PREVIEW/);
    const f1 = await get('/?desktop=nd-fixed');
    assert.equal(f1.status, 409);
    assert.match(f1.body, /1600x900/);
    assert.equal((await get('/?desktop=nd-fixed&resolution=1920x1080')).status, 409);
    assert.equal((await get('/?desktop=nd-undef')).status, 503, 'present undefined 不退化 legacy');
    assert.equal((await get('/?desktop=nd-err')).status, 503, 'geometryError 先于 state 与 native');
  } finally {
    await closeDispatcher();
  }
});

test('开启态：登记几何桌的 resize 由入口规范决定 ⇒ 客户端 resize 判 400（不降级 legacy）', async () => {
  await startDispatcher({ native: true, preview: true });
  try {
    const a = await get('/?desktop=nd-auto&resize=remote');
    assert.equal(a.status, 400, 'auto 桌带客户端 resize = 400');
    assert.match(a.body, /不接受客户端 resize/);
    const f = await get('/?desktop=nd-fixed&resolution=1600x900&resize=off');
    assert.equal(f.status, 400, 'fixed 桌带客户端 resize = 400');
    const af = await get('/?desktop=nd-auto');
    assert.equal(af.status, 302);
    assert.equal(qsOf(af.headers.location), canonicalScale('nd-auto').replace('resize=scale', 'resize=remote'),
      'auto + preview = 逐字旧 remote 行为（native 开关不改）');
    const ff = await get('/?desktop=nd-fixed&resolution=1600x900');
    assert.equal(ff.status, 302);
    assert.equal(qsOf(ff.headers.location), canonicalScale('nd-fixed') + '&resolution=1600x900',
      'fixed 齐参 = 逐字旧 scale 行为（native 开关不改）');
  } finally {
    await closeDispatcher();
  }
});

// ================= 开启：WS 通道 =================
test('开启态：legacy WS 放行 101；带 resolution 409；auto WS 未开 preview 503', async () => {
  await startDispatcher({ native: true, preview: false });
  try {
    const base = '/desktop/nd-legacy';
    assert.match(await rawStatus(upgradeText(base + '/websockify?resize=off')), / 101 /);
    assert.match(await rawStatus(upgradeText(base + '/websockify')), / 101 /, '不带 resize 同样放行');
    assert.match(await rawStatus(upgradeText(base + '/audio?resize=off')), / 101 /, 'audio 通道同门');
    assert.match(await rawStatus(upgradeText(base + '/websockify?resize=remote')), / 101 /,
      '客户端选 remote ⇒ 入口不拦（后端是否接受 SetDesktopSize 属镜像层 L1，不由本入口宣称）');
    assert.equal(app.stats.get('native_ws_pass') >= 4, true, 'native WS 计数落地');
    assert.match(await rawStatus(upgradeText(base + '/websockify?resolution=1600x900')), / 409 /,
      'legacy WS 带 resolution 逐字旧 409');
    assert.match(await rawStatus(upgradeText('/desktop/nd-auto/websockify?resize=remote')), / 503 /,
      'auto WS 未开 preview 仍 503（native 不开自动跟随口子）');
    assert.match(await rawStatus(upgradeText('/desktop/nd-undef/websockify')), / 503 /);
    const client = await wsConnect(base + '/websockify?resize=off');
    assert.match(await wsEcho(client, 'ping'), /^ECHO_legacy:ping$/, '升级后双向可透传');
    client.close();
    await sleep(80);
    assert.equal(backendState.get('legacy').lastUpgrade.url, '/websockify?resize=off',
      'WS query 原样透传（不注入、不改写）');
  } finally {
    await closeDispatcher();
  }
});

test('关闭态：WS 逐字旧行为（resize=off 放行；native 计数 0）', async () => {
  await startDispatcher({ native: false });
  try {
    assert.match(await rawStatus(upgradeText('/desktop/nd-legacy/websockify?resize=off')), / 101 /,
      '旧行为：WS 层从不约束 resize 形态');
    assert.equal(app.stats.get('native_ws_pass'), 0);
    assert.equal(app.stats.get('native_select_pass'), 0);
  } finally {
    await closeDispatcher();
  }
});
