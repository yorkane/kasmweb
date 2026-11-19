'use strict';
// 逐桌 auto 画面 WS 准入（进程内）真实并发/释放单测：node:test + 真 HTTP/WS 假后端 + listen(0)
// 口径（与 server.js 文件头范围声明一致，不得放大解读）：
//   * 名额 = 每个 createDispatcher 实例内的一张 Map ⇒ **per-process** 单 viewer，
//     两个 dispatcher 进程各自计数互不可见；客户端直连后端 loopback 端口完全绕过本门。
//     ⇒ 本门**不是生产安全锁**，只是多桌面隔离分辨率测试预览的安全底座。
//   * 只在 cfg.adaptivePreview === true（本套件由 cfg 显式 opt-in，不改任何全局 env，
//     默认 flag 仍为 false）+ registry 登记 geometry.mode === 'auto' + tail 逐字 '/websockify' 时生效。
//   * 同桌 /audio 是独立通道，不占画面名额；legacy（geometry 键缺席）与 fixed 桌不受本门约束，
//     仍只受全局 maxWs 约束。
//   * 本套件不写文件、不删文件、不占固定端口、不启停任何容器或服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createDispatcher } = require(path.join(ROOT, 'server'));
const WS = require(path.join(ROOT, 'vendor/ws'));

const CRLF = String.fromCharCode(13, 10);
const WSKEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// 假后端：每桌一套 http + WS.Server（echo），全部 listen(0)
// ------------------------------------------------------------------
const DESKS = [
  { id: 'auto-a', geometry: { mode: 'auto', width: 1600, height: 900 } },
  { id: 'auto-b', geometry: { mode: 'auto', width: 1600, height: 900 } },
  { id: 'fixed-1', geometry: { mode: 'fixed', width: 1600, height: 900 } },
  { id: 'legacy-1', geometry: null },
];
const PORT = new Map();      // id -> 当前登记端口（测试期可改写为坏端口）
const REALPORT = new Map();  // id -> 假后端真实端口
const BK = new Map();        // id -> 后端状态

function startBackend(id) {
  return new Promise((resolve, reject) => {
    const st = { httpCount: 0, wsCount: 0, wsClose: 0, marker: 'ADMIT_BACKEND_' + id, socks: new Set() };
    const server = http.createServer((req, res) => {
      st.httpCount += 1;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(st.marker);
    });
    const wss = new WS.Server({ server, verifyClient: () => true });
    wss.on('connection', (sock) => {
      st.wsCount += 1;
      st.socks.add(sock);
      sock.on('close', () => { st.wsClose += 1; st.socks.delete(sock); });
      sock.on('message', (m) => { try { sock.send('ECHO_' + id + ':' + m.toString('utf8')); } catch (e) {} });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      st.port = server.address().port;
      st.server = server;
      st.wss = wss;
      BK.set(id, st);
      PORT.set(id, st.port);
      REALPORT.set(id, st.port);
      resolve(st);
    });
  });
}

function closePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// 内存 registry：逐字保留「geometry 键缺席」= legacy 的口径
function memoryRegistry() {
  const deskOf = (id) => DESKS.find((d) => d.id === id) || null;
  return {
    byId(id) {
      const d = deskOf(id);
      if (!d) return null;
      const e = {
        id: d.id, name: d.id, port: PORT.get(d.id), state: 'running',
        container: '', containerId: '', generation: 1, appId: '',
      };
      if (d.geometry !== null) e.geometry = d.geometry;
      return e;
    },
    read() { return { schemaVersion: 1, publicOrigin: null, desktops: [], error: null, source: 'memory', mtimeMs: 0 }; },
    startWatch() {}, stopWatch() {}, writeAtomic() {},
  };
}

// ------------------------------------------------------------------
// dispatcher：listen(0)，并登记本测试自己拥有的入站 socket 以便收尾
// ------------------------------------------------------------------
function startDispatcher(o) {
  const cfg = {
    host: '127.0.0.1', port: 0, registry: '/nonexistent/wtk-admission-registry.json',
    publicOrigin: 'http://127.0.0.1:1', browserOrigin: '', browserOriginHost: '',
    backendHost: '127.0.0.1',
    backendPortMin: 1, backendPortMax: 999999,
    maxWs: o.maxWs === undefined ? 64 : o.maxWs,
    httpTimeoutMs: 1500, missingCacheMs: 0, prefix: '/desktop/',
    adaptivePreview: o.preview === true,
  };
  const app = createDispatcher({ registry: memoryRegistry(), cfg, logger: () => {} });
  const inbound = new Set();
  app.server.on('connection', (s) => { inbound.add(s); s.on('close', () => inbound.delete(s)); });
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      resolve({ app, port: app.server.address().port, inbound, cfg });
    });
  });
}

function stopDispatcher(h) {
  return new Promise((resolve) => {
    h.app.registry.stopWatch();
    for (const s of h.inbound) { try { s.destroy(); } catch (e) {} }
    h.inbound.clear();
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    const t = setTimeout(fin, 1500);
    t.unref();
    h.app.server.close(() => { clearTimeout(t); fin(); });
  });
}

// ------------------------------------------------------------------
// 请求构造
// ------------------------------------------------------------------
function upgradeReq(pathStr) {
  return 'GET ' + pathStr + ' HTTP/1.1' + CRLF
    + 'Host: 127.0.0.1' + CRLF
    + 'Upgrade: websocket' + CRLF
    + 'Connection: Upgrade' + CRLF
    + 'Sec-WebSocket-Version: 13' + CRLF
    + 'Sec-WebSocket-Key: ' + WSKEY + CRLF + CRLF;
}
function canonicalScale(id) {
  return 'autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
}
function canonicalRemote(id) {
  return 'autoconnect=1&resize=remote&path=' + encodeURIComponent('desktop/' + id + '/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
}
function videoPath(id) {
  const q = (id.indexOf('auto') === 0) ? canonicalRemote(id) : canonicalScale(id);
  return '/desktop/' + id + '/websockify?' + q;
}
function audioPath(id) { return '/desktop/' + id + '/audio'; }

// 完整读到一个会被服务端关闭的响应（503 / 409 / 502）；读流异常按已到字节收口
function rawText(port, requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(requestText));
    const chunks = [];
    const stop = () => resolve(Buffer.concat(chunks).toString('latin1'));
    s.on('data', (c) => chunks.push(c));
    s.on('end', stop);
    s.on('close', stop);
    s.on('error', stop);
    s.setTimeout(timeoutMs || 5000, () => { try { s.destroy(); } catch (e) {} reject(new Error('raw text timeout')); });
  });
}

// 只取响应头块（101 会升级为隧道、不会关闭）；socket 交给调用方销毁
function rawUpgradeHead(port, requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(requestText));
    let buf = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      s.removeAllListeners('data');
      resolve({ line: buf.split(CRLF)[0], head: buf, socket: s });
    };
    s.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.indexOf(CRLF + CRLF) >= 0) done();
    });
    s.on('end', done);
    s.on('close', done);
    s.on('error', () => done());
    s.setTimeout(timeoutMs || 5000, () => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch (e) {}
      reject(new Error('raw upgrade timeout'));
    });
  });
}

function wsConnect(port, pathStr) {
  return new Promise((resolve, reject) => {
    const c = new WS('ws://127.0.0.1:' + port + pathStr, { handshakeTimeout: 5000 });
    c.once('open', () => resolve(c));
    c.once('error', (e) => reject(e));
  });
}
function wsEcho(client, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('echo timeout')), 4000);
    client.once('message', (m) => { clearTimeout(t); resolve(m.toString('utf8')); });
    client.send(msg);
  });
}
function closeClient(c) {
  return new Promise((resolve) => {
    if (!c) return resolve();
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    c.once('close', fin);
    c.once('error', fin);
    setTimeout(fin, 1200).unref();
    try { c.terminate(); } catch (e) { fin(); }
  });
}
function statusOf(t) { return String(t).split(CRLF)[0]; }
const S = (h, n) => h.app.stats.get(n);
const slots = (h) => h.app.desktopWsSlots.size;

let H = null;          // preview 开启的主实例
let DEADPORT = 0;      // 绑定过又关闭的端口 ⇒ 握手期 ECONNREFUSED

test.before(async () => {
  for (const d of DESKS) await startBackend(d.id);
  DEADPORT = await closePort();
  H = await startDispatcher({ preview: true });
});

test.after(async () => {
  if (H) await stopDispatcher(H);
  for (const [, b] of BK) {
    for (const c of b.socks) { try { c.terminate(); } catch (e) {} }
    await new Promise((r) => b.server.close(r));
  }
});

// ==================================================================
// 1. 默认 flag 不改：preview 关闭时 auto 的 WS 一律 503，legacy 逐字放行
// ==================================================================
test('preview 关闭：auto 画面/音频一律 503，零名额占用，legacy 画面照旧 101', async () => {
  const off = await startDispatcher({ preview: false });
  const baseBusy = S(off, 'ws_desktop_busy');
  const aw = await rawText(off.port, upgradeReq(videoPath('auto-a')));
  const aa = await rawText(off.port, upgradeReq(audioPath('auto-a')));
  assert.match(statusOf(aw), /^HTTP\/1\.1 503/, 'auto 画面未开预览必须 503：' + statusOf(aw));
  assert.match(statusOf(aa), /^HTTP\/1\.1 503/, 'auto 音频未开预览必须 503：' + statusOf(aa));
  assert.equal(slots(off), 0, '未开预览不建名额');
  assert.equal(S(off, 'ws_desktop_busy'), baseBusy, '未开预览不得计 busy');
  assert.equal(BK.get('auto-a').wsCount, 0, '未开预览后端零 WS');
  const l1 = await rawUpgradeHead(off.port, upgradeReq(videoPath('legacy-1')));
  assert.match(l1.line, /^HTTP\/1\.1 101/, 'legacy 逐字不变：' + l1.line);
  try { l1.socket.destroy(); } catch (e) {}
  await stopDispatcher(off);
});

// ==================================================================
// 2. 名额互斥：同桌第 2 个画面 WS = 409，且零副作用
// ==================================================================
let KEEP = null;
test('同桌第 2 个画面 WS = 409，零副作用（不进 proxy、名额不虚增、stats 不串计）', async () => {
  const b0 = BK.get('auto-a');
  const base = { open: S(H, 'ws_open'), close: S(H, 'ws_close'), fail: S(H, 'upstream_fail'), busy: S(H, 'ws_desktop_busy') };
  KEEP = await wsConnect(H.port, videoPath('auto-a'));
  assert.equal(await wsEcho(KEEP, 'v1'), 'ECHO_auto-a:v1');
  assert.equal(slots(H), 1, '1 条画面占 1 名额');
  assert.equal(H.app.desktopWsSlots.held('auto-a'), true);
  assert.equal(H.app.wsActive, 1);
  // 后端侧基线取在**首条合法连接建立之后**：要证的是「被拒的第 2 条零副作用」，
  // 首条连接本身必然让后端 wsCount +1，不能算进 409 的账。
  const bBase = { h: b0.httpCount, w: b0.wsCount };
  const t = await rawText(H.port, upgradeReq(videoPath('auto-a')));
  assert.match(statusOf(t), /^HTTP\/1\.1 409/, '第 2 条画面必须 409：' + statusOf(t));
  assert.match(t, /desktop screen busy/, '409 需给短原因');
  assert.equal(S(H, 'ws_desktop_busy') - base.busy, 1, '忙计数 +1');
  assert.equal(S(H, 'ws_open') - base.open, 1, 'ws_open 只计首条（409 不进 proxy）');
  assert.equal(S(H, 'ws_close') - base.close, 0, '409 不得产生 ws_close');
  assert.equal(S(H, 'upstream_fail') - base.fail, 0, '409 与后端故障无关');
  assert.equal(b0.wsCount, bBase.w, '被拒连接不得到后端（零新增 WS）');
  assert.equal(b0.httpCount, bBase.h, '被拒连接不得到后端（零新增 HTTP）');
  assert.equal(slots(H), 1, '被拒连接不得占名额');
  assert.equal(H.app.wsActive, 1, '被拒连接不得增全局计数');
});

// ==================================================================
// 3. 释放：客户端断开后名额恰好释放一次并立即可复用
// ==================================================================
test('客户端断开 ⇒ 名额与全局计数各释放恰好一次，随后立即可复用', async () => {
  const b0 = BK.get('auto-a');
  const baseClose = S(H, 'ws_close');
  await closeClient(KEEP);
  KEEP = null;
  await sleep(250);
  assert.equal(slots(H), 0, '断开后名额归零');
  assert.equal(H.app.wsActive, 0, '断开后全局计数归零（不为负）');
  assert.ok(S(H, 'ws_close') - baseClose >= 1, 'proxy 的 release 回调被走到');
  assert.ok(b0.wsClose >= 1, '后端看到连接关闭');
  const c2 = await wsConnect(H.port, videoPath('auto-a'));
  assert.equal(await wsEcho(c2, 'v2'), 'ECHO_auto-a:v2', '释放后立即可复用');
  assert.equal(slots(H), 1);
  await closeClient(c2);
  await sleep(250);
  assert.equal(slots(H), 0);
  assert.equal(H.app.wsActive, 0);
});

// ==================================================================
// 4. /audio 不占画面名额
// ==================================================================
test('同桌 /audio 不占画面名额：画面占用中音频两条并发，第 2 条画面仍 409', async () => {
  const v = await wsConnect(H.port, videoPath('auto-a'));
  assert.equal(slots(H), 1);
  const a1 = await wsConnect(H.port, audioPath('auto-a'));
  assert.equal(await wsEcho(a1, 'a1'), 'ECHO_auto-a:a1');
  const a2 = await wsConnect(H.port, audioPath('auto-a'));
  assert.equal(await wsEcho(a2, 'a2'), 'ECHO_auto-a:a2');
  assert.equal(slots(H), 1, '音频不得占/不得扩画面名额');
  assert.equal(H.app.wsActive, 3, '三条连接各计一次全局名额');
  const t = await rawText(H.port, upgradeReq(videoPath('auto-a')));
  assert.match(statusOf(t), /^HTTP\/1\.1 409/, '音频并发不得挤掉画面互斥：' + statusOf(t));
  await closeClient(a1);
  await closeClient(a2);
  await sleep(200);
  assert.equal(slots(H), 1, '音频关闭也不得释放画面名额');
  await closeClient(v);
  await sleep(250);
  assert.equal(slots(H), 0);
  assert.equal(H.app.wsActive, 0, '音频 + 画面全部收口后计数归零');
});

// ==================================================================
// 5. 跨桌独立 + legacy / fixed 不受本门约束
// ==================================================================
test('跨桌互不干扰；legacy 与 fixed 双画面并发且零名额占用', async () => {
  const v1 = await wsConnect(H.port, videoPath('auto-a'));
  const v2 = await wsConnect(H.port, videoPath('auto-b'));
  assert.equal(slots(H), 2, '两个 auto 桌各占 1');
  assert.equal(H.app.desktopWsSlots.held('auto-a') && H.app.desktopWsSlots.held('auto-b'), true);
  const f1 = await wsConnect(H.port, videoPath('fixed-1'));
  const f2 = await wsConnect(H.port, videoPath('fixed-1'));
  assert.equal(await wsEcho(f2, 'f2'), 'ECHO_fixed-1:f2', 'fixed 第 2 条画面直连');
  const l1 = await wsConnect(H.port, videoPath('legacy-1'));
  const l2 = await wsConnect(H.port, videoPath('legacy-1'));
  assert.equal(await wsEcho(l1, 'l1'), 'ECHO_legacy-1:l1');
  assert.equal(slots(H), 2, 'legacy / fixed 不建名额');
  assert.equal(H.app.wsActive, 6, '六条连接全在全局计数内');
  for (const c of [v1, v2, f1, f2, l1, l2]) await closeClient(c);
  await sleep(300);
  assert.equal(slots(H), 0);
  assert.equal(H.app.wsActive, 0);
});

// ==================================================================
// 6. 真实并发：reserve 先进 proxy ⇒ 恰好 1 个 101
// ==================================================================
test('同桌 6 路并发 upgrade：恰好 1 条 101 + 5 条 409，名额不双发', async () => {
  const reqs = [];
  for (let i = 0; i < 6; i += 1) reqs.push(rawUpgradeHead(H.port, upgradeReq(videoPath('auto-a'))));
  const res = await Promise.all(reqs);
  const ok = res.filter((r) => /^HTTP\/1\.1 101/i.test(r.line));
  const busy = res.filter((r) => /^HTTP\/1\.1 409/i.test(r.line));
  assert.equal(ok.length, 1, '并发下只允许 1 条握手成功：' + res.map((r) => r.line).join(' | '));
  assert.equal(busy.length, 5, '其余全部 409');
  assert.equal(slots(H), 1, '并发只发 1 个名额');
  assert.equal(H.app.wsActive, 1, '被拒连接不进全局计数');
  for (const r of res) { try { r.socket.destroy(); } catch (e) {} }
  await sleep(300);
  assert.equal(slots(H), 0);
  assert.equal(H.app.wsActive, 0);
});

// ==================================================================
// 7. 三条异常释放路径：握手失败 / socket 提前拆 / proxy 同步抛
// ==================================================================
test('后端握手失败(502)：名额与全局计数各释放恰好一次', async () => {
  const baseReject = S(H, 'ws_rejected');
  PORT.set('auto-a', DEADPORT);
  const t = await rawText(H.port, upgradeReq(videoPath('auto-a')));
  assert.match(statusOf(t), /^HTTP\/1\.1 502/, '后端不可达回显 502：' + statusOf(t));
  assert.equal(slots(H), 0, '握手失败必须释放逐桌名额');
  assert.equal(H.app.wsActive, 0, '握手失败必须释放全局计数');
  assert.ok(S(H, 'ws_rejected') - baseReject >= 1);
  PORT.set('auto-a', REALPORT.get('auto-a'));
  const c = await wsConnect(H.port, videoPath('auto-a'));
  assert.equal(await wsEcho(c, 'after-502'), 'ECHO_auto-a:after-502', '失败后名额可复用');
  await closeClient(c);
  await sleep(250);
  assert.equal(slots(H), 0);
});

test('客户端极早拆与隧道期拆：两条路径均恰好释放，计数不为负', async () => {
  for (const ms of [3, 40]) {
    const s = net.connect(H.port, '127.0.0.1', () => s.write(upgradeReq(videoPath('auto-a'))));
    s.on('error', () => {});
    await sleep(ms);
    try { s.destroy(); } catch (e) {}
    await sleep(320);
    assert.equal(slots(H), 0, ms + 'ms 拆除后名额归零');
    assert.equal(H.app.wsActive, 0, ms + 'ms 拆除后全局计数归零');
  }
});

test('proxy 同步抛异常：当场释放两计数并精确销毁该 socket，进程存活', async () => {
  const baseSync = S(H, 'ws_proxy_sync_error');
  const baseOpen = S(H, 'ws_open');
  PORT.set('auto-b', 70000); // 越界端口：net.connect 同步 RangeError
  const t = await rawText(H.port, upgradeReq(videoPath('auto-b')));
  assert.equal(t, '', '同步抛错不得留下半截响应');
  assert.equal(S(H, 'ws_proxy_sync_error') - baseSync, 1, '同步抛异常单独计数');
  assert.equal(S(H, 'ws_open') - baseOpen, 0, 'net.connect 同步抛 ⇒ 不计 ws_open');
  assert.equal(slots(H), 0, '同步抛必须释放逐桌名额');
  assert.equal(H.app.wsActive, 0, '同步抛必须释放全局计数');
  PORT.set('auto-b', REALPORT.get('auto-b'));
  const h = await rawText(H.port, 'GET /healthz HTTP/1.1' + CRLF + 'Host: 127.0.0.1' + CRLF
    + 'connection: close' + CRLF + CRLF);
  assert.match(h, /^HTTP\/1\.1 200/, '抛异常不得打穿 dispatcher');
  const c = await wsConnect(H.port, videoPath('auto-b'));
  assert.equal(await wsEcho(c, 'after-sync'), 'ECHO_auto-b:after-sync');
  await closeClient(c);
  await sleep(250);
  assert.equal(slots(H), 0);
});

// ==================================================================
// 8. 全局 maxWs 语义不变：legacy / fixed 只受全局约束
// ==================================================================
test('全局 maxWs 门语义不变：legacy 超限 503 且逐桌名额为 0', async () => {
  const lim = await startDispatcher({ preview: true, maxWs: 2 });
  const baseOver = S(lim, 'ws_over_limit');
  const c1 = await wsConnect(lim.port, videoPath('legacy-1'));
  const c2 = await wsConnect(lim.port, videoPath('legacy-1'));
  assert.equal(lim.app.wsActive, 2);
  const t = await rawText(lim.port, upgradeReq(videoPath('legacy-1')));
  assert.match(statusOf(t), /^HTTP\/1\.1 503/, '超全局上限 503：' + statusOf(t));
  assert.equal(S(lim, 'ws_over_limit') - baseOver, 1, '仍计 ws_over_limit');
  assert.equal(slots(lim), 0, 'legacy 不建逐桌名额');
  await closeClient(c1);
  await closeClient(c2);
  await stopDispatcher(lim);
});

// ==================================================================
// 9. server.close 只做优雅关闭
// ==================================================================
test('server.close 不杀已建立的外部连接，连接自然结束后回调才触发', async () => {
  const c = await wsConnect(H.port, videoPath('auto-a'));
  assert.equal(slots(H), 1);
  let fired = false;
  H.app.server.close(() => { fired = true; });
  await sleep(350);
  assert.equal(fired, false, '有活跃连接时 close 回调不得提前触发（不批量杀连接）');
  assert.equal(await wsEcho(c, 'alive'), 'ECHO_auto-a:alive', '关闭期已建立连接必须可用');
  await closeClient(c);
  await sleep(250);
  assert.equal(fired, true, '连接自然结束后 close 回调触发');
  assert.equal(slots(H), 0);
  assert.equal(H.app.wsActive, 0);
});

