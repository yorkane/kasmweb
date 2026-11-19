'use strict';
// K 线 registry 可选几何元数据契约（node:test，纯离线：不启服务、不 bind 端口、不碰容器/桌面）
// 临时面 = /data/tmp/webtop-kasmvnc-adaptive-registry-test-<pid>，teardown 整体 rename 进 /data/.trash（零 rm）
//
// 判据（root 契约 2026-11-14）：
//  1) 旧输入（无 geometry）normalize 输出与旧实现逐字段一致：8 个键、顺序、无新增键；
//  2) 合法 auto/fixed 往返保留（写文件 → read() 取回同值）；
//  3) geometry 出现且非法（类型/缺键/超界/bool/数组/null/未知键/__proto__/循环）
//     ⇒ 该桌 **state 强制 'error'** + geometryError=true、**不注入 geometry、不降级 legacy**，
//     且同文件其它桌不丢；state=error 是承重设计：未升级的 consumer 只放行 running，
//     因此旧 server.js / pages.js 也会对该桌 503 / 显示异常 = 整体 fail-closed；
//  4) geometry 合法或缺席时 state / port 不受影响（running 仍只来自后端 200，不宣称 GUI）；
//     geometry 非法时的 state=error 是唯一被授权的 state 覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { Registry, normalize, validateGeometry } = require(path.join(ROOT, 'lib/registry'));
const { STATES } = require(path.join(ROOT, 'lib/config'));

const TMP = fs.mkdtempSync(path.join('/data/tmp', 'webtop-kasmvnc-adaptive-registry-test-'));
const FILE = path.join(TMP, 'registry.json');

test.after(() => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = '/data/.trash/webtop-kasmvnc-adaptive-registry-test-' + stamp;
  try { fs.mkdirSync('/data/.trash', { recursive: true }); fs.renameSync(TMP, dest); } catch (e) { /* 尽力而为 */ }
});

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

function norm(desktops) {
  const n = normalize(regObj(desktops), FILE, 1);
  assert.equal(n.fatal, false, '根结构合法时不应 fatal');
  return n.reg;
}

function byId(reg, id) {
  const hit = reg.desktops.filter((d) => d.id === id);
  assert.equal(hit.length, 1, id + ' 必须恰好一条（不丢桌）');
  return hit[0];
}

const OLD_KEYS = ['id', 'name', 'port', 'state', 'container', 'containerId', 'generation', 'appId'];

// __proto__ 作为 **own 键** 的几何件：只能由 JSON.parse 造出（真实注入面 = registry 文件）。
// 对象字面量写 __proto__: 是**设原型**、不是 own 键，不能用来代表污染 ⇒ 判据会静默失效。
function ownProto(jsonText) {
  const parsed = JSON.parse(jsonText);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), true,
    'fixture 必须留下 own __proto__，否则判据静默失效');
  return parsed;
}
const OWN_PROTO_WITH_ALL = ownProto(
  '{"__proto__":{"polluted":true},"mode":"auto","width":1280,"height":720}');
const OWN_PROTO_ONLY = ownProto('{"__proto__":{"mode":"auto"}}');

// ------------------------------------------------------------------ 1) 旧面零差异
test('旧 registry（无 geometry）normalize 输出 = 旧实现逐字段一致', () => {
  const input = [desk('vcmi'), desk('chrome-1', { port: 25322 }), desk('chrome-2', { port: 25323 })];
  const reg = norm(input);
  assert.deepEqual(reg.desktops, input.map((d) => {
    const o = {};
    for (const k of OLD_KEYS) o[k] = d[k];
    return o;
  }));
  for (const d of reg.desktops) {
    assert.deepEqual(Object.keys(d), OLD_KEYS, '键集合与键顺序都不得变化');
    assert.equal('geometry' in d, false);
    assert.equal('geometryError' in d, false);
  }
  assert.equal(reg.schemaVersion, 1, 'schemaVersion 保持 1');
});

test('字段缺席 = legacy：不产生 geometryError，也不被标错', () => {
  const reg = norm([desk('vcmi'), desk('chrome-1', { port: 25322 })]);
  assert.equal(reg.desktops.length, 2);
  for (const d of reg.desktops) {
    assert.equal(Object.keys(d).length, 8);
    assert.equal(d.state, 'running');
    assert.equal('geometryError' in d, false);
  }
});

test('键存在值为 undefined = 出现且非法（严格口径，不视同缺席）', () => {
  const reg = norm([desk('vcmi', { geometry: undefined })]);
  const d = byId(reg, 'vcmi');
  assert.equal(d.geometryError, true);
  assert.equal(d.state, 'error', 'geometry 键出现即不得按 legacy 放行');
});

// ------------------------------------------------------------------ 2) 合法往返
test('合法 auto/fixed：normalize 显式逐键复制并保留', () => {
  const reg = norm([
    desk('vcmi', { geometry: { mode: 'auto', width: 1280, height: 720 } }),
    desk('chrome-1', { port: 25322, geometry: { height: 1080, width: 1920, mode: 'fixed' } }),
  ]);
  assert.deepEqual(byId(reg, 'vcmi').geometry, { mode: 'auto', width: 1280, height: 720 });
  assert.deepEqual(byId(reg, 'chrome-1').geometry, { mode: 'fixed', width: 1920, height: 1080 });
  assert.equal(byId(reg, 'vcmi').geometryError, undefined);
  assert.deepEqual(Object.keys(byId(reg, 'vcmi')), OLD_KEYS.concat(['geometry']));
});

test('闭区间边界 320/240 与 4096/4096 合法', () => {
  const reg = norm([
    desk('vcmi', { geometry: { mode: 'auto', width: 320, height: 240 } }),
    desk('chrome-1', { port: 25322, geometry: { mode: 'fixed', width: 4096, height: 4096 } }),
  ]);
  assert.deepEqual(byId(reg, 'vcmi').geometry, { mode: 'auto', width: 320, height: 240 });
  assert.deepEqual(byId(reg, 'chrome-1').geometry, { mode: 'fixed', width: 4096, height: 4096 });
});

test('JSON 标量无整数/浮点之分：手改文件的 1280.0 归一为 1280（producer 侧 Python 更严）', () => {
  const raw = JSON.parse('{"schemaVersion":1,"publicOrigin":"http://x","desktops":[{"id":"vcmi",'
    + '"name":"VCMI","port":25321,"state":"running","container":"","containerId":"",'
    + '"generation":"","appId":"chrome","geometry":{"mode":"auto","width":1280.0,"height":720}}]}');
  const d = normalize(raw, FILE, 1).reg.desktops[0];
  assert.deepEqual(d.geometry, { mode: 'auto', width: 1280, height: 720 });
  assert.equal(d.state, 'running');
});

// 未升级 consumer 的等价判据（与 server.js handleDesktop 同一条款：只放行 state==='running'）
// ⇒ 坏 geometry 的桌必须落进"非 running"分支 = 503，不需要 consumer 认识 geometry 字段。
function legacyConsumerVerdict(entry) {
  return entry.state === 'running' ? 'proxy' : '503';
}

test('未升级 consumer 也 fail-closed：坏 geometry 桌判 503，合法桌照旧代理', () => {
  const reg = norm([
    desk('vcmi'),
    desk('chrome-1', { port: 25322, geometry: { mode: 'auto', width: 1280, height: 720 } }),
    desk('chrome-2', { port: 25323, geometry: { mode: 'auto', width: 1280, height: 4097 } }),
  ]);
  assert.equal(legacyConsumerVerdict(byId(reg, 'vcmi')), 'proxy');
  assert.equal(legacyConsumerVerdict(byId(reg, 'chrome-1')), 'proxy');
  assert.equal(legacyConsumerVerdict(byId(reg, 'chrome-2')), '503');
  assert.equal(reg.desktops.length, 3, 'fail-closed 靠 state，不靠丢桌');
});

test('validateGeometry 返回副本，不改入参', () => {
  const src = { mode: 'auto', width: 1280, height: 720, extra: 'x' };
  const out = validateGeometry({ mode: 'auto', width: 1280, height: 720 });
  assert.deepEqual(out, { mode: 'auto', width: 1280, height: 720 });
  assert.notEqual(out, src);
  assert.deepEqual(Object.keys(src), ['mode', 'width', 'height', 'extra']);
});

test('经文件往返：Registry.read() 取回 geometry（每请求读 + mtime 失效）', () => {
  const r = new Registry(FILE, { missingCacheMs: 0 });
  r.writeAtomic(regObj([desk('vcmi', { geometry: { mode: 'auto', width: 1280, height: 720 } })]));
  assert.deepEqual(r.byId('vcmi').geometry, { mode: 'auto', width: 1280, height: 720 });
  r.writeAtomic(regObj([desk('vcmi', { geometry: { mode: 'fixed', width: 800, height: 600 } })]));
  assert.deepEqual(r.byId('vcmi').geometry, { mode: 'fixed', width: 800, height: 600 });
  r.writeAtomic(regObj([desk('vcmi')]));
  assert.equal('geometry' in r.byId('vcmi'), false);
  r.stopWatch();
});

// ------------------------------------------------------------------ 3) fail-closed
const BAD = [
  ['null', null],
  ['string', 'auto'],
  ['number', 1280],
  ['bool', true],
  ['array', []],
  ['array-wrapped', [{ mode: 'auto', width: 1280, height: 720 }]],
  ['empty-object', {}],
  ['missing-height-width', { mode: 'auto' }],
  ['missing-height', { mode: 'auto', width: 1280 }],
  ['missing-mode', { width: 1280, height: 720 }],
  ['mode-illegal', { mode: 'dyn', width: 1280, height: 720 }],
  ['mode-number', { mode: 1, width: 1280, height: 720 }],
  ['mode-bool', { mode: true, width: 1280, height: 720 }],
  ['width-string', { mode: 'auto', width: '1280', height: 720 }],
  ['width-nan', { mode: 'auto', width: NaN, height: 720 }],
  ['width-noninteger', { mode: 'auto', width: 1280.5, height: 720 }],
  ['width-bool', { mode: 'auto', width: true, height: 720 }],
  ['width-null', { mode: 'auto', width: null, height: 720 }],
  ['width-below', { mode: 'auto', width: 319, height: 720 }],
  ['width-above', { mode: 'auto', width: 4097, height: 720 }],
  ['height-below', { mode: 'auto', width: 1280, height: 239 }],
  ['height-above', { mode: 'auto', width: 1280, height: 4097 }],
  ['height-bool', { mode: 'auto', width: 1280, height: true }],
  ['height-string', { mode: 'auto', width: 1280, height: '720' }],
  ['extra-key', { mode: 'auto', width: 1280, height: 720, scale: 1 }],
  ['extra-empty-key', { mode: 'auto', width: 1280, height: 720, '': 0 }],
  // __proto__ 只在 **own 属性**口径下才是未知键（真实注入面 = JSON.parse 出的 registry 文件；
  // 对象字面量里写 __proto__: 是设原型，不构成污染，也不该出现在这里）
  ['proto-extra-own', OWN_PROTO_WITH_ALL],
  ['proto-only-own', OWN_PROTO_ONLY],
  ['constructor-key', { mode: 'auto', width: 1280, height: 720, constructor: 'x' }],
  ['inherited-name', { mode: 'auto', width: 1280, height: 720, toString: 'x' }],
];

for (const [name, bad] of BAD) {
  test('非法 geometry[' + name + '] = 该桌 state=error + geometryError，不降级 legacy', () => {
    const reg = norm([desk('vcmi', { geometry: bad })]);
    const d = byId(reg, 'vcmi');
    assert.equal(d.geometryError, true, name);
    assert.equal('geometry' in d, false, name + '：可疑值不得被采用');
    assert.equal(typeof d.geometryDetail, 'string');
    assert.equal(d.state, 'error', name + '：必须强制 error（旧 consumer 只放行 running）');
    assert.equal(STATES.has(d.state), true, 'error 仍是合法 state 取值');
    assert.equal(d.port, 25321);
  });
}

for (const [name, bad] of BAD) {
  test('非法 geometry[' + name + '] 不丢同文件其它桌', () => {
    const reg = norm([
      desk('vcmi'),
      desk('chrome-1', { port: 25322, geometry: { mode: 'fixed', width: 800, height: 600 } }),
      desk('chrome-2', { port: 25323, geometry: bad }),
    ]);
    assert.equal(reg.desktops.length, 3, name);
    assert.equal('geometry' in byId(reg, 'vcmi'), false, name);
    assert.equal(byId(reg, 'vcmi').state, 'running', name + '：合法桌 state 不受牵连');
    assert.deepEqual(byId(reg, 'chrome-1').geometry, { mode: 'fixed', width: 800, height: 600 }, name);
    assert.equal(byId(reg, 'chrome-2').geometryError, true, name);
    assert.equal(byId(reg, 'chrome-2').state, 'error', name);
  });
}

test('validateGeometry 对全部非法输入抛 Error', () => {
  for (const [name, bad] of BAD) {
    assert.throws(() => validateGeometry(bad), Error, name);
  }
});

test('__proto__ 污染件（JSON.parse 口径）不升级、不污染原型', () => {
  const text = JSON.stringify(regObj([desk('vcmi')])).replace(
    '"appId":"chrome"}',
    '"appId":"chrome","geometry":{"__proto__":{"polluted":true},"mode":"auto","width":1280,"height":720}}');
  const raw = JSON.parse(text);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.desktops[0].geometry, '__proto__'), true,
    'JSON.parse 必须留下 own __proto__，否则本用例判据失效');
  const reg = normalize(raw, FILE, 1).reg;
  const d = byId(reg, 'vcmi');
  assert.equal(d.geometryError, true);
  assert.equal('geometry' in d, false);
  assert.equal({}.polluted, undefined, 'Object.prototype 未被污染');
  assert.equal(reg.desktops.length, 1);
});

test('循环引用 geometry = geometryError，不抛出到读路径', () => {
  const cyc = { mode: 'auto', width: 1280, height: 720 };
  cyc.self = cyc;
  const reg = norm([desk('vcmi', { geometry: cyc })]);
  assert.equal(byId(reg, 'vcmi').geometryError, true);
  assert.equal('geometry' in byId(reg, 'vcmi'), false);
});

test('读路径整体不抛：坏 geometry 的 registry 文件仍可 read()', () => {
  const r = new Registry(FILE, { missingCacheMs: 0 });
  r.writeAtomic(regObj([
    desk('vcmi', { geometry: { mode: 'auto', width: 99999, height: 720 } }),
    desk('chrome-1', { port: 25322 }),
  ]));
  const reg = r.read();
  assert.equal(reg.error, null);
  assert.equal(reg.desktops.length, 2);
  assert.equal(r.byId('vcmi').geometryError, true);
  assert.equal('geometryError' in r.byId('chrome-1'), false);
  r.stopWatch();
});

test('既有安全门不受影响：重复 id 仍只留首条、非法 id/端口/state 仍整桌剔除', () => {
  const reg = norm([
    desk('vcmi', { geometry: { mode: 'auto', width: 1280, height: 720 } }),
    desk('vcmi', { port: 25322, geometry: { mode: 'fixed', width: 800, height: 600 } }),
    desk('BAD_ID'),
    desk('chrome-1', { port: 80 }),
    desk('chrome-2', { state: 'not-a-state' }),
  ]);
  assert.deepEqual(reg.desktops.map((d) => d.id), ['vcmi']);
  assert.deepEqual(reg.desktops[0].geometry, { mode: 'auto', width: 1280, height: 720 },
    '重复 id 时保留首条（含其 geometry）');
});


