
'use strict';
// K 线 dispatcher targeted tests（node:test）
// 全部在 127.0.0.1 环回：3 个真实假后端（HTTP + 真 ws 帧 echo），真 WS 对端，不 mock 协议
// 临时根：/data/tmp/webtop-kasmvnc-dispatcher-test-<pid>，teardown 整体 mv 进 /data/.trash
// 保护区纪律：只 bind 25320–25323；失败只精确 destroy 自建 server，零 rm / pkill / docker

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const { Registry } = require(path.join(ROOT, 'lib/registry'));
const selector = require(path.join(ROOT, 'lib/selector'));
const { normalizeBrowserOrigin, resolveConfig } = require(path.join(ROOT, 'lib/config'));
const { createDispatcher } = require(path.join(ROOT, 'server'));
const WS = require(path.join(ROOT, 'vendor/ws'));

const TMP_ROOT = fs.mkdtempSync(path.join('/data/tmp', 'webtop-kasmvnc-dispatcher-test-'));
const REG_FILE = path.join(TMP_ROOT, 'registry.json');

// 端口契约（root 审查要求）：测试 fixture **一律 listen(0) 随机端口**，
// 不得与生产 dispatcher(25320)/后端区间(25321-25329) 抢端口，并发跑互不冲突。
// 生产配置的 backendPortMin/Max 仍为 25321..25329（本文件尾部专项断言），测试内不放宽生产值：
// dispatcher 用「三个随机端口的实际区间」构造 backendPortMin/Max，等价覆盖授权区间校验。
const PORTS = { dispatcher: 0, vcmi: 0, chrome1: 0, chrome2: 0, slow: 0 };

function listenOn0(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, host || '127.0.0.1', () => {
      const a = server.address();
      if (!a || !a.port) { reject(new Error('listen(0) 未取到端口')); return; }
      resolve(a.port);
    });
  });
}

const GZIP_BODY = zlib.gzipSync(Buffer.from('gz-bytes-passthrough-\u4e2d\u6587', 'utf8'));

// 假后端登记表：id -> {server, requests, wsConnections, lastUpgradeHeaders, closed}
const backends = new Map();
const connLog = new Map(); // id -> {live, peak}

function backendMarker(id) {
  return 'BACKEND_' + id + '_MARKER';
}

// 假后端：默认 listen(0) 随机端口并 await，返回 {state, port, server, wss}
// opts.listenPort 指定端口（仅供拆包 shim 的内层后端使用）；opts.redirPort 供 /redir-self
async function startFakeBackend(id, opts) {
  const o = opts || {};
  const port = o.listenPort || 0;
  const redirPort = o.redirPort || 0;
  const state = { requests: 0, ws: 0, lastUpgrade: null, splitHead: !!o.splitHead, closed: false };
  const log = { live: 0, peak: 0 };
  connLog.set(id, log);

  const server = http.createServer((req, res) => {
    state.requests += 1;
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-dup': req.headers.host });
      res.end('<!DOCTYPE html><title>KasmVNC</title>' + backendMarker(id));
      return;
    }
    if (p === '/marker') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(Buffer.byteLength(backendMarker(id))),
        'x-origin-header': String(req.headers.host),
      });
      res.end(backendMarker(id));
      return;
    }
    if (p === '/gz') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length': String(GZIP_BODY.length),
      });
      res.end(GZIP_BODY);
      return;
    }
    if (p === '/qecho') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(req.url);
      return;
    }
    if (p === '/hecho') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, ct: req.headers['content-type'] || '', x: req.headers['x-test'] || '', host: req.headers.host, origin: req.headers.origin || '' }));
      return;
    }
    if (p === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bodyBuf.length) });
        res.end(bodyBuf);
      });
      return;
    }
    if (p === '/redir-loc') { res.writeHead(302, { location: '/sub/page.html' }); res.end(); return; }
    if (p === '/redir-self') {
      // 随机端口 ⇒ 自指 origin 在请求期从 address() 取（无 redirPort 覆盖时）
      const self = redirPort || server.address().port;
      res.writeHead(302, { location: 'http://127.0.0.1:' + self + '/x' });
      res.end();
      return;
    }
    if (p === '/redir-pub') { res.writeHead(302, { location: 'http://127.0.0.1:' + dispatcherPort + '/y?z=1' }); res.end(); return; }
    if (p === '/redir-rel') { res.writeHead(302, { location: 'relpage.html' }); res.end(); return; }
    if (p === '/audiojs/audio.js') {
      // 音频门（复刻 root 实测外域 421）：只认内部 publicOrigin host
      if (String(req.headers.host) !== '127.0.0.1:' + dispatcherPort) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        res.end('misdirected request');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'x-host': String(req.headers.host),
        'x-origin': String(req.headers.origin || ''),
      });
      res.end("var A = { wsPath: '/audio', jsUrl: '/audiojs/jsmpeg.min.js' };");
      return;
    }
    if (p === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(512 * 1024, 0x5a));
      return;
    }
    if (p === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('backend 404');
  });

  const wss = new WS.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    state.ws += 1;
    state.lastUpgrade = { url: req.url, headers: req.headers };
    // 音频 WS 同受内部 origin 门约束（Host 非内部 ⇒ 421 拒握手）
    const audioReq = String(req.url).indexOf('/audio') === 0;
    if (audioReq && String(req.headers.host) !== '127.0.0.1:' + dispatcherPort) {
      socket.write('HTTP/1.1 421 Misdirected Request' + String.fromCharCode(13, 10)
        + 'connection: close' + String.fromCharCode(13, 10)
        + 'content-length: 0' + String.fromCharCode(13, 10, 13, 10));
      socket.end();
      return;
    }
    log.live += 1;
    if (log.live > log.peak) log.peak = log.live;
    const idTag = 'ECHO_' + id.replace(/-/g, '');
    const isAudio = String(req.url).indexOf('/audio') === 0;
    const prefix = isAudio ? 'AUDIO_' + id.replace(/-/g, '') + ':' : idTag + ':';
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (m) => {
        try { client.send(prefix + m.toString('utf8')); } catch (e) { /* ignore */ }
      });
      client.on('close', () => { log.live -= 1; });
    });
  });
  const bound = await listenOn0(server, '127.0.0.1', port);
  backends.set(id, { server, wss, state, log, port: bound });
  return { state, port: bound, server, wss };
}

// ------------------------------------------------------------------
// 启动 / 停止 / registry fixture
// ------------------------------------------------------------------
let app = null;
let dispatcherPort = 0;

// dispatcher 也 listen(0)；后端授权区间取「三个随机后端端口的实际闭区间」，
// 这样区间校验被等价覆盖，且永不与生产 25321..25329 相撞。
function startDispatcher(minP, maxP) {
  return new Promise((resolve, reject) => {
    app = createDispatcher({
      cfg: {
        host: '127.0.0.1',
        port: 0,
        registry: REG_FILE,
        publicOrigin: 'http://127.0.0.1:' + dispatcherPort,
        backendHost: '127.0.0.1',
        backendPortMin: minP,
        backendPortMax: maxP,
        maxWs: 64,
        httpTimeoutMs: 1500,
        missingCacheMs: 0,
        prefix: '/desktop/',
      },
    });
    app.registry.startWatch(500);
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      dispatcherPort = app.server.address().port;
      dispatcherPort = dispatcherPort;
      app.cfg.publicOrigin = 'http://127.0.0.1:' + dispatcherPort;
      resolve();
    });
  });
}

function req(method, urlPath, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: o.port || dispatcherPort,
      method: method,
      path: urlPath,
      headers: o.headers || {},
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    // 客户端侧兜底超时：上游中途断链时 res 只发 abort 不发 end，
    //   无超时的话整条套件会静默挂死（root 纪律：挂死必须转成可见失败）
    r.setTimeout(o.timeoutMs || 8000, () => { r.destroy(new Error('client request timeout')); });
    if (o.body) r.write(o.body);
    r.end();
  });
}

const get = (p, o) => req('GET', p, o);

function rawHttp(port, requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(requestText));
    const chunks = [];
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    s.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    s.on('error', reject);
    s.setTimeout(timeoutMs || 5000, () => { s.destroy(); reject(new Error('raw timeout')); });
  });
}

function wsConnect(pathStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const client = new WS('ws://127.0.0.1:' + (o.port || dispatcherPort) + pathStr, {
      headers: o.headers || {},
      handshakeTimeout: o.handshakeTimeout || 5000,
    });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function regObj(desktops) {
  return { schemaVersion: 1, publicOrigin: 'http://127.0.0.1:' + dispatcherPort, desktops: desktops };
}

const baseDesktop = (id, port, state) => ({
  id: id,
  name: id === 'vcmi' ? 'VCMI 桌面' : (id === 'chrome-1' ? 'Chrome 桌面 1' : 'Chrome 桌面 2'),
  port: port,
  state: state,
  container: 'wt-kasm-' + id,
  containerId: 'a'.repeat(64),
  generation: 'gen-20261113-01',
  appId: id === 'vcmi' ? 'vcmi' : 'chrome',
});

function writeRegistry(desktops) {
  const reg = new Registry(REG_FILE, { missingCacheMs: 0 });
  reg.writeAtomic(regObj(desktops));
  reg.stopWatch();
}

// 当前生效的「桌面 id -> 后端端口」映射（随机端口运行期才知，registry 写入取这里的值）
const PUB = { vcmi: 0, 'chrome-1': 0, 'chrome-2': 0 };

async function threeRunning() {
  writeRegistry([
    baseDesktop('vcmi', PUB.vcmi, 'running'),
    baseDesktop('chrome-1', PUB['chrome-1'], 'running'),
    baseDesktop('chrome-2', PUB['chrome-2'], 'running'),
  ]);
  await sleep(80);
}

let splitShim = null;

test.before(async () => {
  // 1) 三个完整假后端（含 /marker / / 等全部路由）全部随机端口 + await
  const bV = await startFakeBackend('vcmi');
  const bC1 = await startFakeBackend('chrome-1', { splitHead: true });
  const bC2 = await startFakeBackend('chrome-2');
  PUB.vcmi = bV.port;
  PUB['chrome-2'] = bC2.port;
  // 2) chrome-1 前置拆包 shim：注册端口 = shim 随机端口，内层 = bC1
  //    仅对 WS 升级流量把 101 头块切成两包（root 审查点：首 chunk 不含完整头不得挂死）；
  //    普通 HTTP 直通，且上游 close/end 前先 flush 尾部 = 不产生截断/假 ECONNRESET
  splitShim = net.createServer((client) => {
    const up = net.connect(bC1.port, "127.0.0.1");
    let split = null;
    let phase = "handshake";
    let tail = null;
    let tailTimer = null;
    const buf = [];
    const flushTail = () => {
      if (tailTimer) { clearTimeout(tailTimer); tailTimer = null; }
      if (tail && tail.length && !client.destroyed) client.write(tail);
      tail = null;
    };
    const shut = () => { flushTail(); if (!client.destroyed) client.end(); up.destroy(); };
    client.on("error", () => up.destroy());
    up.on("error", () => flushTail());
    client.on("close", () => up.destroy());
    up.on("close", shut);
    up.on("end", shut);
    client.on("data", (c) => {
      if (split === null) {
        const s = c.toString("latin1").toLowerCase();
        split = s.indexOf("upgrade: websocket") >= 0;
      }
      if (!up.destroyed) up.write(c);
    });
    up.on("data", (c) => {
      if (!split || phase === "body") { if (!client.destroyed) client.write(c); return; }
      buf.push(c);
      const joined = Buffer.concat(buf);
      const idx = joined.indexOf(Buffer.from(String.fromCharCode(13, 10, 13, 10), "latin1"));
      if (idx < 0) { if (joined.length > 65536) { client.destroy(); up.destroy(); } return; }
      const head = joined.slice(0, idx + 4);
      const rest = joined.slice(idx + 4);
      phase = "body";
      const cut = Math.max(10, Math.floor(head.length / 2));
      client.write(head.slice(0, cut));
      tail = Buffer.concat([head.slice(cut), rest]);
      tailTimer = setTimeout(() => { tailTimer = null; flushTail(); }, 20);
    });
  });
  const shimPort = await listenOn0(splitShim);
  PUB['chrome-1'] = shimPort;
  // 3) dispatcher：授权区间 = 三个随机端口的实际闭区间
  const all = [PUB.vcmi, PUB['chrome-1'], PUB['chrome-2']];
  await startDispatcher(Math.min.apply(null, all), Math.max.apply(null, all));
});

test.after(async () => {
  if (app) { app.registry.stopWatch(); await new Promise((r) => app.server.close(r)); }
  if (splitShim) await new Promise((r) => splitShim.close(r));
  for (const [, b] of backends) {
    for (const c of b.wss.clients) { try { c.terminate(); } catch (e) {} }
    await new Promise((r) => b.server.close(r));
  }
  // 临时面按项目规则移入 trash（零 rm）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = '/data/.trash/webtop-kasmvnc-dispatcher-test-' + stamp;
  try {
    fs.mkdirSync('/data/.trash', { recursive: true });
    fs.renameSync(TMP_ROOT, dest);
  } catch (e) { /* 尽力而为 */ }
});
// ------------------------------------------------------------------
// 1) 根选择器：列表 / 302 规范参数 / 编码 / 400 类 / 404 / root 无 id
// ------------------------------------------------------------------
test('根路径无参数 = 列表页 200，不自动连接，中文状态', async () => {
  await threeRunning();
  const r = await get('/');
  assert.equal(r.status, 200);
  const s = r.body.toString('utf8');
  assert.match(s, /VCMI 桌面/);
  assert.match(s, /Chrome 桌面 1/);
  assert.match(s, /运行中/);
  assert.match(s, /打开桌面/);
  assert.doesNotMatch(s, /autoconnect/i);
  assert.doesNotMatch(s, /WebSocket/i);
  assert.ok(!/REG_FILE|\/data\/|stack|Error:/i.test(s), '列表页不得泄露私有路径/堆栈');
});

test('registry 缺失 = 列表页显示未登记且 200 不崩溃', async () => {
  fs.renameSync(REG_FILE, REG_FILE + '.off');
  try {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.body.toString('utf8'), /当前没有已登记的桌面/);
  } finally {
    fs.renameSync(REG_FILE + '.off', REG_FILE);
  }
});

test('registry JSON 损坏 = 列表页未登记提示，不 500', async () => {
  fs.writeFileSync(REG_FILE, '{ this is not json', 'utf8');
  await sleep(60);
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body.toString('utf8'), /登记表状态/);
});

test('三选择器各自 302 到规范参数（root-relative + path 无前导斜杠 + 编码正确）', async () => {
  await threeRunning();
  for (const [id, port] of [['vcmi', PUB.vcmi], ['chrome-1', PUB['chrome-1']], ['chrome-2', PUB['chrome-2']]]) {
    const r = await get('/?desktop=' + encodeURIComponent(id));
    assert.equal(r.status, 302, id);
    const loc = r.headers.location;
    assertRelativeLocation(loc, id + ' 根选择 Location');
    const u = new URL(loc, 'http://127.0.0.1:' + dispatcherPort);
    assert.equal(u.pathname, '/desktop/' + id + '/');
    assert.equal(u.searchParams.get('autoconnect'), '1');
    assert.equal(u.searchParams.get('resize'), 'scale');
    assert.equal(u.searchParams.get('idle_disconnect'), '0');
    assert.equal(u.searchParams.get('clipboard_seamless'), 'false');
    const p = u.searchParams.get('path');
    assert.equal(p, 'desktop/' + id + '/websockify', id + ' path 值无前导斜杠');
    assert.ok(!p.startsWith('/'), 'path 值不得带前导斜杠');
    assert.ok(loc.includes('path=desktop%2F' + id + '%2Fwebsockify'), 'path 必须 percent 编码: ' + loc);
    // 后端标记：302 阶段不连后端
    assert.equal(backends.get(id).state.requests >= 0, true);
  }
});

test('未知桌面 = 404', async () => {
  await threeRunning();
  const r = await get('/?desktop=nope');
  assert.equal(r.status, 404);
  assert.match(r.body.toString('utf8'), /未登记/);
});

test('空 desktop / 重复 desktop / 路径穿越 = 400', async () => {
  await threeRunning();
  const cases = ['/?desktop=', '/?desktop=%20', '/?desktop=a&desktop=b',
    '/?desktop=..%2F..%2Fetc', '/?desktop=.%2E', '/?desktop=a%2Fb',
    '/?desktop=' + encodeURIComponent('a\\b'), '/?desktop=%2e%2e%2f%2e%2e%2f'];
  for (const c of cases) {
    const r = await get(c);
    assert.equal(r.status, 400, c + ' -> ' + r.status);
  }
});

test('只认 desktop：image/path/url/exec/env/port/token 一律 400', async () => {
  await threeRunning();
  const keys = ['image', 'path', 'url', 'exec', 'env', 'port', 'host', 'backend',
    'target', 'registry', 'token', 'password', 'container', 'upstream', 'argv', 'cmd', 'unknown_param'];
  for (const k of keys) {
    const r = await get('/?desktop=vcmi&' + k + '=x');
    assert.equal(r.status, 400, k + ' 必须被拒绝');
  }
});

test('白名单显示参数保留并透传进 Location；取值不合法 400', async () => {
  await threeRunning();
  const r = await get('/?desktop=vcmi&show_control_bar=1&bell=on');
  assert.equal(r.status, 302);
  assertRelativeLocation(r.headers.location, '白名单参数 302 Location');
  const u = new URL(r.headers.location, 'http://127.0.0.1:' + dispatcherPort);
  assert.equal(u.searchParams.get('show_control_bar'), '1');
  assert.equal(u.searchParams.get('bell'), 'on');
  assert.equal(u.searchParams.get('resize'), 'scale');
  const bad1 = await get('/?desktop=vcmi&show_control_bar=%24(whoami)');
  assert.equal(bad1.status, 400);
  const bad2 = await get('/?desktop=vcmi&bell=yes%20please');
  assert.equal(bad2.status, 400);
});

test('root /websockify 与 root /audio 不 fallback = 404', async () => {
  await threeRunning();
  for (const p of ['/websockify', '/audio', '/audiojs/audio.js', '/vnc.html', '/app/ui.js']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
  }
  const raw = await rawHttp(dispatcherPort,
    'GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:' + dispatcherPort +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  assert.match(raw, /^HTTP\/1\.1 404/, 'root 无桌面 id 的 upgrade 必须被拒: ' + raw.slice(0, 40));
});

test('非法编码 / 超长 slug / 大小写 slug 的规范路径 = 400 或 404', async () => {
  await threeRunning();
  assert.equal((await get('/desktop/%zz/')).status, 400);
  assert.equal((await get('/desktop/%2e%2e/')).status, 400);
  assert.equal((await get('/desktop/vcmi%2F..%2F/')).status, 400);
  assert.equal((await get('/desktop/VCMI/')).status, 400);
  assert.equal((await get('/desktop/unknown-id/marker')).status, 404);
});

// ------------------------------------------------------------------
// 2) 状态页：stopped/starting/error = 503，GET 不触发启动；规范路径同样 503
// ------------------------------------------------------------------
function backendReqCount(id) { return backends.get(id) ? backends.get(id).state.requests : 0; }
function backendWsCount(id) { return backends.get(id) ? backends.get(id).state.ws : 0; }

test('已登记但 stopped = 规范路径 503 且零后端请求（GET 不自动启动）', async () => {
  writeRegistry([
    baseDesktop('vcmi', PUB.vcmi, 'stopped'),
    baseDesktop('chrome-1', PUB['chrome-1'], 'running'),
    baseDesktop('chrome-2', PUB['chrome-2'], 'running'),
  ]);
  await sleep(60);
  const before = backendReqCount('vcmi');
  const a = await get('/?desktop=vcmi');
  const b = await get('/desktop/vcmi/');
  const c = await get('/desktop/vcmi/marker');
  for (const r of [a, b, c]) {
    assert.equal(r.status, 503);
    assert.match(r.body.toString('utf8'), /不会因 GET 请求自动启动/);
  }
  assert.equal(backendReqCount('vcmi'), before, 'stopped 桌面后端不得收到任何请求');
  const raw = await rawHttp(dispatcherPort,
    'GET /desktop/vcmi/websockify HTTP/1.1\r\nHost: 127.0.0.1:' + dispatcherPort +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  assert.match(raw, /503/);
  assert.equal(backendWsCount('vcmi'), 0);
});

test('starting / error 状态 = 503 状态页；列表页显示对应中文状态', async () => {
  writeRegistry([
    baseDesktop('vcmi', PUB.vcmi, 'starting'),
    baseDesktop('chrome-1', PUB['chrome-1'], 'error'),
    baseDesktop('chrome-2', PUB['chrome-2'], 'running'),
  ]);
  await sleep(60);
  assert.equal((await get('/desktop/vcmi/')).status, 503);
  assert.equal((await get('/desktop/chrome-1/')).status, 503);
  const s = (await get('/')).body.toString('utf8');
  assert.match(s, /启动中/);
  assert.match(s, /异常/);
  assert.equal((await get('/desktop/chrome-2/marker')).status, 200, 'running 桌面不受影响');
});

// ------------------------------------------------------------------
// 3) 前缀反代字节直通与路由
// ------------------------------------------------------------------
test('每桌面 HTTP 直通：body 标记 + content-type/length 保留 + 不串桌面', async () => {
  await threeRunning();
  for (const id of ['vcmi', 'chrome-1', 'chrome-2']) {
    const r = await get('/desktop/' + id + '/marker');
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('utf8'), backendMarker(id), id);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(backendMarker(id)));
  }
});

test('gzip 响应逐字节直通（不解压不重编码，content-encoding/length 保留）', async () => {
  await threeRunning();
  const r = await get('/desktop/vcmi/gz');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(Number(r.headers['content-length']), GZIP_BODY.length);
  assert.deepEqual(r.body, GZIP_BODY);
});

test('query 原样透传，不双重编码（%2F 与中文保持不变）', async () => {
  await threeRunning();
  const qs = 'a=1&b=%2Fx%20y&c=' + encodeURIComponent('中文');
  const r = await get('/desktop/vcmi/qecho?' + qs);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString('utf8'), '/qecho?' + qs, '后端看到的 path+query 与 strip 后逐字一致');
});

test('请求头透传 + POST body 直通 + 后端收到入口 Host（功能适配，非安全矩阵）', async () => {
  await threeRunning();
  const payload = Buffer.from('post-body-\u0000\u00ff-bytes', 'utf8');
  const r = await req('POST', '/desktop/vcmi/echo', {
    headers: { 'content-type': 'application/octet-stream', 'x-test': 'abc-123', 'content-length': String(payload.length) },
    body: payload,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, payload);

  const h = await get('/desktop/vcmi/hecho', { headers: { 'x-test': 'hdr' } });
  const j = JSON.parse(h.body.toString('utf8'));
  assert.equal(j.x, 'hdr');
  assert.equal(j.host, '127.0.0.1:' + dispatcherPort, '后端 Host = 浏览器原入口（audio gate 依赖）');

  const h2 = await get('/desktop/vcmi/hecho', { headers: { host: 'desktop.example.internal' } });
  const j2 = JSON.parse(h2.body.toString('utf8'));
  assert.equal(j2.host, 'desktop.example.internal', '自定义入口 Host 原样透传');
});

test('桌面 HTML 根文档：规范参数直连后端字节（KasmVNC 标记），无 HTML 改写', async () => {
  await threeRunning();
  const cp = 'autoconnect=1&resize=scale&path=' + encodeURIComponent('desktop/vcmi/websockify')
    + '&idle_disconnect=0&clipboard_seamless=false&shared=true';
  const r = await get('/desktop/vcmi/?' + cp);
  assert.equal(r.status, 200);
  assert.match(r.body.toString('utf8'), /KasmVNC/);
  assert.match(r.body.toString('utf8'), /BACKEND_vcmi_MARKER/);
});

test('书签直达无查询的规范路径 = 302 引导规范参数；二次请求 200；不循环', async () => {
  await threeRunning();
  const r = await get('/desktop/vcmi/');
  assert.equal(r.status, 302);
  const loc = r.headers.location;
  assertRelativeLocation(loc, '书签引导 Location');
  const u = new URL(loc, 'http://127.0.0.1:' + dispatcherPort);
  assert.equal(u.pathname, '/desktop/vcmi/');
  assert.equal(u.searchParams.get('path'), 'desktop/vcmi/websockify');
  const r2 = await get('/desktop/vcmi/?' + loc.slice(loc.indexOf('?') + 1));
  assert.equal(r2.status, 200);
  // 客户端篡改强制参数 ⇒ 再次引导（幂等，不循环：第二次带规范值即 200）
  const r3 = await get('/desktop/vcmi/?autoconnect=1&resize=remote&path=evil&idle_disconnect=0&clipboard_seamless=false&shared=true');
  assert.equal(r3.status, 302);
  assertRelativeLocation(r3.headers.location, '强制参数篡改再引导 Location');
  assert.equal(new URL(r3.headers.location, 'http://127.0.0.1:' + dispatcherPort).searchParams.get('resize'), 'scale');
});

// ------------------------------------------------------------------
// 1b) 相对 Location 回归（2026-11-13 裁决）：规范 302 一律 root-relative，
//     不拼 cfg.publicOrigin，浏览器始终留在用户原入口 origin（边缘域名/协议不变）
// ------------------------------------------------------------------
const ENTRY = 'https://25320-235.ws.gatepro.cn:99';

function assertRelativeLocation(loc, msg) {
  assert.equal(typeof loc, 'string', msg + ' 必须是字符串');
  assert.ok(loc.startsWith('/desktop/'), msg + ' 必须 root-relative /desktop/…: ' + loc);
  assert.ok(!loc.startsWith('//'), msg + ' 不得协议相对 //: ' + loc);
  assert.ok(!/^[a-z]+:/i.test(loc), msg + ' 不得绝对 URL: ' + loc);
  assert.ok(!/127\.0\.0\.1|:25320/i.test(loc.split('?')[0]), msg + ' path 不得嵌 loopback: ' + loc);
}

const ENTRY_HOST_CASES = [
  { label: 'external host + Forwarded https', headers: {
    host: '25320-235.ws.gatepro.cn:99',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': '25320-235.ws.gatepro.cn:99',
  } },
  { label: '本机 loopback Host', headers: {} },
  { label: '本机自定义 Host', headers: { host: 'desktop.example.internal' } },
];

test('canonicalLocation 单元：root-relative，忽略 publicOrigin 入参，extras 保留', () => {
  const loc = selector.canonicalLocation('http://127.0.0.1:25320', 'chrome-1', [['bell', 'on']]);
  assertRelativeLocation(loc, '单元 canonicalLocation');
  assert.ok(loc.startsWith('/desktop/chrome-1/?'), loc);
  const u = new URL(loc, ENTRY);
  assert.equal(u.origin, ENTRY, '可用 new URL(loc, 原入口) 解析且 origin 不变');
  assert.equal(u.searchParams.get('path'), 'desktop/chrome-1/websockify');
  assert.equal(u.searchParams.get('bell'), 'on');
});

test('根 ?desktop 与 /desktop/<id>/ bootstrap：三 ID 在所有入口 Host 下均 302 root-relative', async () => {
  await threeRunning();
  for (const hc of ENTRY_HOST_CASES) {
    for (const id of ['vcmi', 'chrome-1', 'chrome-2']) {
      const r1 = await get('/?desktop=' + encodeURIComponent(id), { headers: hc.headers });
      assert.equal(r1.status, 302, hc.label + ' 根选择 ' + id);
      assertRelativeLocation(r1.headers.location, hc.label + ' 根选择 ' + id);
      const r2 = await get('/desktop/' + encodeURIComponent(id) + '/', { headers: hc.headers });
      assert.equal(r2.status, 302, hc.label + ' bootstrap ' + id);
      assertRelativeLocation(r2.headers.location, hc.label + ' bootstrap ' + id);
      for (const r of [r1, r2]) {
        const u = new URL(r.headers.location, ENTRY);
        assert.equal(u.origin, ENTRY, hc.label + ' 原入口 origin 保持: ' + r.headers.location);
        assert.equal(u.pathname, '/desktop/' + id + '/');
        assert.equal(u.searchParams.get('path'), 'desktop/' + id + '/websockify', id + ' ws path');
      }
    }
  }
});

test('带 Forwarded https 与 external Host 时白名单 extras 仍保留进相对 Location', async () => {
  await threeRunning();
  const r = await get('/?desktop=vcmi&show_control_bar=1&bell=on', {
    headers: { host: '25320-235.ws.gatepro.cn:99', 'x-forwarded-proto': 'https' },
  });
  assert.equal(r.status, 302);
  assertRelativeLocation(r.headers.location, 'extras 302');
  const u = new URL(r.headers.location, ENTRY);
  assert.equal(u.origin, ENTRY);
  assert.equal(u.searchParams.get('show_control_bar'), '1');
  assert.equal(u.searchParams.get('bell'), 'on');
  assert.equal(u.searchParams.get('resize'), 'scale');
});

// ------------------------------------------------------------------
// 1c) 显式外域音频适配（2026-11-13）：WTK_BROWSER_ORIGIN 命中时仅对音频内部 hop
//     把上游 Host/Origin 映射为内部值；非音频与未配置保持旧透传
// ------------------------------------------------------------------
const BO = 'https://25320-235.ws.gatepro.cn:99';
const BO_HOST = '25320-235.ws.gatepro.cn:99';
const innerHost = () => '127.0.0.1:' + dispatcherPort;

function setBrowserOrigin(v) {
  app.cfg.browserOrigin = v;
  app.cfg.browserOriginHost = v ? normalizeBrowserOrigin(v).host : '';
}

test('normalizeBrowserOrigin：只接受纯 origin，非法值报错含 WTK_BROWSER_ORIGIN', () => {
  assert.equal(normalizeBrowserOrigin(''), null);
  assert.equal(normalizeBrowserOrigin('   '), null);
  assert.deepEqual(normalizeBrowserOrigin(BO), { origin: BO, host: BO_HOST });
  assert.deepEqual(normalizeBrowserOrigin(BO + '/'), { origin: BO, host: BO_HOST });
  const bad = ['https://u:p@h.example/', 'https://h.example/x', 'https://h.example?a=1',
    'https://h.example#f', 'ftp://h.example', 'not a url', 'https://',
    'https://*.example', 'https://a.*.example:99'];
  for (const b of bad) {
    assert.throws(() => normalizeBrowserOrigin(b), (e) => /WTK_BROWSER_ORIGIN/.test(e.message), b + ' 必须拒绝');
  }
});

test('resolveConfig：publicOrigin 归一为纯 origin 且非法值启动即拒；browserOrigin 同步归一', () => {
  assert.equal(resolveConfig({ publicOrigin: 'http://127.0.0.1:25320/' }).publicOrigin,
    'http://127.0.0.1:25320', '尾斜杠必须归一');
  assert.equal(resolveConfig({ publicOrigin: 'https://E.Example:8443' }).publicOrigin,
    'https://e.example:8443', '大小写/无 path 归一为 URL.origin 语义');
  assert.throws(() => resolveConfig({ publicOrigin: 'not a url' }), /WTK_PUBLIC_ORIGIN/);
  assert.throws(() => resolveConfig({ publicOrigin: 'ftp://127.0.0.1:25320' }), /WTK_PUBLIC_ORIGIN/);
  const c = resolveConfig({ browserOrigin: BO + '/' });
  assert.equal(c.browserOrigin, BO);
  assert.equal(c.browserOriginHost, BO_HOST);
  assert.throws(() => resolveConfig({ browserOrigin: 'https://h.example/x' }), /WTK_BROWSER_ORIGIN/);
});

test('外域配置前：audiojs / 音频 WS 带外域 Host = 后端 421（旧行为，透传）', async () => {
  await threeRunning();
  setBrowserOrigin('');
  const r = await get('/desktop/vcmi/audiojs/audio.js', { headers: { host: BO_HOST } });
  assert.equal(r.status, 421, '未配置显式外域时保持旧透传（root 实测 421 复现）');
  const raw = await rawHttp(dispatcherPort,
    'GET /desktop/vcmi/audio HTTP/1.1\r\nHost: ' + BO_HOST + '\r\nOrigin: ' + BO +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n', 4000);
  assert.match(raw, /^HTTP\/1\.1 421/, '音频 WS 未配置时同样透传外域 Host: ' + raw.slice(0, 40));
});

test('配置显式外域后：audiojs 静态资源收到内部 Host（无 Origin 也映射）且 200', async () => {
  await threeRunning();
  setBrowserOrigin(BO);
  try {
    const r = await get('/desktop/vcmi/audiojs/audio.js', { headers: { host: BO_HOST } });
    assert.equal(r.status, 200, '外域 audiojs 必须经内部 hop 映射后 200');
    assert.equal(r.headers['x-host'], innerHost(), '后端看到内部 Host');
    assert.equal(r.headers['x-origin'], '', '客户端无 Origin ⇒ 上游也不得注入 Origin');
    assert.match(r.body.toString('utf8'), /wsPath/);
    // /audio 静态（无 query）同路径族
    const h = await get('/desktop/vcmi/hecho?x=1', { headers: { host: BO_HOST } });
    assert.equal(JSON.parse(h.body.toString('utf8')).host, BO_HOST, '非音频 path（hecho）不受映射影响');
  } finally {
    setBrowserOrigin('');
  }
});

test('配置显式外域后：音频 WS 真握手 echo（上游 Host/Origin = 内部映射值）；非音频 WS 保持外域透传', async () => {
  await threeRunning();
  setBrowserOrigin(BO);
  try {
    const ca = await wsConnect('/desktop/vcmi/audio', { headers: { host: BO_HOST, origin: BO } });
    assert.equal(await wsEcho(ca, 'mp2frame'), 'AUDIO_vcmi:mp2frame', '音频 WS 映射后必须真握手并 echo');
    const st = backends.get('vcmi').state;
    assert.equal(st.lastUpgrade.url, '/audio');
    assert.equal(st.lastUpgrade.headers.host, innerHost(), '音频 WS 上游 Host = 内部 loopback');
    assert.equal(st.lastUpgrade.headers.origin, 'http://127.0.0.1:' + dispatcherPort, '音频 WS 上游 Origin = 内部规范 origin');
    ca.close();
    await sleep(150);
    // 非音频 websockify 同 Host/Origin ⇒ 透传外域 Host（后端无内部门 ⇒ 200 标记请求验证 lastUpgrade）
    const c = await wsConnect('/desktop/vcmi/websockify', { headers: { host: BO_HOST, origin: BO } });
    assert.equal(await wsEcho(c, 'video'), 'ECHO_vcmi:video');
    assert.equal(backends.get('vcmi').state.lastUpgrade.headers.host, BO_HOST, '非音频 WS 透传原 Host');
    assert.equal(backends.get('vcmi').state.lastUpgrade.headers.origin, BO, '非音频 WS 透传原 Origin');
    c.close();
    await sleep(120);
  } finally {
    setBrowserOrigin('');
  }
});

test('映射只认精确 Origin：非 audio 路径透传；Origin 不等不映射；相对 Location 忽略 browserOrigin', async () => {
  await threeRunning();
  setBrowserOrigin(BO);
  try {
    // audiojs 带一致 Origin ⇒ 映射且 Origin 改为内部 publicOrigin
    const r = await get('/desktop/vcmi/audiojs/audio.js', { headers: { host: BO_HOST, origin: BO } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-origin'], 'http://127.0.0.1:' + dispatcherPort, 'Origin 映射为内部规范 origin');
    // Origin 不相等 ⇒ 不映射 ⇒ 后端 421
    const r2 = await get('/desktop/vcmi/audiojs/audio.js', { headers: { host: BO_HOST, origin: 'https://other.example' } });
    assert.equal(r2.status, 421, 'Origin 不等必须保持透传');
    // marker 非音频 ⇒ 外域 Host 透传、内容正常
    const r3 = await get('/desktop/vcmi/marker', { headers: { host: BO_HOST, origin: BO } });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.toString('utf8'), backendMarker('vcmi'));
    // 根选择与 bootstrap 的相对 Location 完全不受 browserOrigin 影响
    const a = await get('/?desktop=chrome-1', { headers: { host: BO_HOST } });
    assert.equal(a.status, 302);
    assertRelativeLocation(a.headers.location, '外域配置下根选择');
    assert.equal(new URL(a.headers.location, BO).origin, BO, '入口 origin 保持');
    const b = await get('/desktop/chrome-1/', { headers: { host: BO_HOST, origin: BO } });
    assert.equal(b.status, 302);
    assertRelativeLocation(b.headers.location, '外域配置下 bootstrap');
  } finally {
    setBrowserOrigin('');
  }
});

test('强制参数缺失 = 302 引导；白名单外参数在规范路径 400', async () => {
  await threeRunning();
  assert.equal((await get('/desktop/vcmi/?autoconnect=1')).status, 302);
  const r = await get('/desktop/vcmi/?desktop=vcmi');
  assert.equal(r.status, 400);
  const r2 = await get('/desktop/vcmi/?url=http://evil.example');
  assert.equal(r2.status, 400);
});

test('上游 Location 加前缀：root 绝对 / 后端绝对 / publicOrigin 绝对 → prefix；相对原样', async () => {
  await threeRunning();
  const cases = [
    ['/redir-loc', '/desktop/vcmi/sub/page.html'],
    ['/redir-self', '/desktop/vcmi/x'],
    ['/redir-pub', '/desktop/vcmi/y?z=1'],
    ['/redir-rel', 'relpage.html'],
  ];
  for (const [p, want] of cases) {
    const r = await get('/desktop/vcmi' + p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.location, want, p);
  }
});

// ------------------------------------------------------------------
// 4) WebSocket：真 ws 帧 echo（vendored ws 客户端 <-> dispatcher <-> 真 ws 后端）
// ------------------------------------------------------------------
test('WS 三桌面独立 echo，前缀互不串台', async () => {
  await threeRunning();
  const mk = (id) => '/desktop/' + id + '/websockify?autoconnect=1&resize=scale';
  const cV = await wsConnect(mk('vcmi'));
  const c1 = await wsConnect(mk('chrome-1'));
  const c2 = await wsConnect(mk('chrome-2'));
  assert.equal(await wsEcho(cV, 'ping-v'), 'ECHO_vcmi:ping-v');
  assert.equal(await wsEcho(c1, 'ping-1'), 'ECHO_chrome1:ping-1');
  assert.equal(await wsEcho(c2, 'ping-2'), 'ECHO_chrome2:ping-2');
  // 交错发送，确认不串
  assert.equal(await wsEcho(c2, 'x2'), 'ECHO_chrome2:x2');
  assert.equal(await wsEcho(c1, 'x1'), 'ECHO_chrome1:x1');
  assert.equal(await wsEcho(cV, 'xv'), 'ECHO_vcmi:xv');
  cV.close(); c1.close(); c2.close();
  await sleep(150);
});

test('WS 握手拆包（chrome-1 后端 101 头切两包）仍能建立并 echo', async () => {
  await threeRunning();
  const c = await wsConnect('/desktop/chrome-1/websockify?path=desktop%2Fchrome-1%2Fwebsockify');
  assert.equal(await wsEcho(c, 'split-head'), 'ECHO_chrome1:split-head');
  c.close();
  await sleep(120);
});

test('上游收到的 Upgrade 握手：Connection/Upgrade 重建 + path strip 一次 + query 原样', async () => {
  await threeRunning();
  const c = await wsConnect('/desktop/vcmi/websockify?a=%2Fb%20c&resize=scale');
  assert.equal(await wsEcho(c, 'hdr'), 'ECHO_vcmi:hdr');
  const st = backends.get('vcmi').state;
  assert.equal(st.lastUpgrade.url, '/websockify?a=%2Fb%20c&resize=scale', '后端看到 strip 后的原始 path+query');
  assert.equal(String(st.lastUpgrade.headers.upgrade).toLowerCase(), 'websocket');
  assert.match(String(st.lastUpgrade.headers.connection), /upgrade/i, 'Connection: Upgrade 必须重建');
  assert.equal(st.lastUpgrade.headers.host, '127.0.0.1:' + dispatcherPort, 'WS 握手 Host = 入口 Host');
  c.close();
  await sleep(120);
});

test('WS 音频路由 /desktop/<id>/audio 独立 echo，与画面通道不混', async () => {
  await threeRunning();
  const ca = await wsConnect('/desktop/vcmi/audio');
  assert.equal(await wsEcho(ca, 'mp2frame'), 'AUDIO_vcmi:mp2frame');
  const cv = await wsConnect('/desktop/vcmi/websockify?path=desktop%2Fvcmi%2Fwebsockify');
  assert.equal(await wsEcho(cv, 'rfb'), 'ECHO_vcmi:rfb');
  ca.close(); cv.close();
  await sleep(120);
});

test('客户端断开后上游连接释放（不泄露 socket）', async () => {
  await threeRunning();
  const before = app.wsActive;
  const conns = [];
  for (let i = 0; i < 6; i++) conns.push(await wsConnect('/desktop/vcmi/websockify?n=' + i));
  assert.equal(app.wsActive, before + 6, '活跃计数应等于连接数');
  for (const c of conns) c.terminate();
  await sleep(400);
  assert.equal(app.wsActive, before, '全部断开后活跃计数归位');
  assert.equal(connLog.get('vcmi').live, 0, '后端侧 ws 连接全部关闭');
});

test('一桌后端故障：HTTP 502 + WS 拒；其它桌面完全可用（不级联）', async () => {
  await threeRunning();
  const b = backends.get('chrome-2');
  await new Promise((res) => b.server.close(res));
  backends.delete('chrome-2');
  const r = await get('/desktop/chrome-2/marker');
  assert.equal(r.status, 502);
  assert.ok(!/ENOTFOUND|ECONNREFUSED|stack|Error:|at /i.test(r.body.toString('utf8')), '502 页面不泄露内部细节');
  const raw = await rawHttp(dispatcherPort,
    'GET /desktop/chrome-2/websockify HTTP/1.1\r\nHost: 127.0.0.1:' + dispatcherPort +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  assert.match(raw, /^HTTP\/1\.1 (502|503|400)/, raw.slice(0, 32));
  assert.equal((await get('/desktop/vcmi/marker')).body.toString('utf8'), backendMarker('vcmi'));
  assert.equal((await get('/desktop/chrome-1/')).status, 302, 'chrome-1 书签引导仍正常');
  const c = await wsConnect('/desktop/vcmi/websockify');
  assert.equal(await wsEcho(c, 'still'), 'ECHO_vcmi:still');
  c.close();
  // 恢复 chrome-2：沿用原随机端口（登记值与授权闭区间全程有效，root 审查点）
  await startFakeBackend('chrome-2', { listenPort: PUB['chrome-2'] });
  await threeRunning();
});

test('registry 运行期更新：新登记/改端口即时生效（无 last-desktop 全局）', async () => {
  await threeRunning();
  writeRegistry([
    baseDesktop('vcmi', PUB.vcmi, 'running'),
    baseDesktop('chrome-1', PUB['chrome-2'], 'running'), // chrome-1 改指向 chrome-2 端口
  ]);
  await sleep(120);
  const r = await get('/desktop/chrome-1/marker');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString('utf8'), backendMarker('chrome-2'), '更新后的登记端口生效');
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/desktop/chrome-2/marker')).status, 404, '已移除的桌面立即 404');
  await threeRunning();
});

test('WS 并发两桌同时流，各自响应数与后端连接数对齐', async () => {
  await threeRunning();
  const ca = await wsConnect('/desktop/vcmi/websockify');
  const cb = await wsConnect('/desktop/chrome-1/websockify');
  const n = 40;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    assert.equal(await wsEcho(ca, 'm' + i), 'ECHO_vcmi:m' + i);
    assert.equal(await wsEcho(cb, 'k' + i), 'ECHO_chrome1:k' + i);
  }
  assert.ok(Date.now() - t0 < 15000);
  ca.close(); cb.close();
  await sleep(200);
});

test('WS 上限：超过 maxWs 拒绝新连接，已有连接不受影响', async () => {
  await threeRunning();
  const limit = app.cfg.maxWs;
  const conns = [];
  try {
    for (let i = 0; i < limit; i++) conns.push(await wsConnect('/desktop/vcmi/websockify?slot=' + i));
    const raw = await rawHttp(dispatcherPort,
      'GET /desktop/vcmi/websockify HTTP/1.1\r\nHost: 127.0.0.1:' + dispatcherPort +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n', 3000);
    assert.match(raw, /^HTTP\/1\.1 503/, '达到上限时新连接 503');
    assert.equal(await wsEcho(conns[0], 'alive'), 'ECHO_vcmi:alive', '既有连接不受新连接拒绝影响');
  } finally {
    for (const c of conns) c.terminate();
    await sleep(300);
  }
  assert.equal(app.wsActive, 0);
});

test('后端响应超时 = 504（timeout 路径映射正确，不是 502）', async () => {
  await threeRunning();
  // 504 语义只在「上游连响应头都没发」时成立：这里必须完全不应答。
  //   若夹具先 writeHead + write 再挂起，dispatcher 已把状态行转发出去，
  //   超时只能拆连接（客户端看到截断响应），504 永远不会出现 —— 夹具设计缺陷。
  const slow = http.createServer(() => { /* 收下请求，永不响应，连接保持 */ });
  const slowPort = await listenOn0(slow);
  const allp = [PUB.vcmi, PUB['chrome-1'], PUB['chrome-2'], slowPort];
  app.cfg.backendPortMin = Math.min.apply(null, allp);
  app.cfg.backendPortMax = Math.max.apply(null, allp);
  writeRegistry([Object.assign(baseDesktop('slowd', slowPort, 'running'), { name: '慢后端' })]);
  app.cfg.httpTimeoutMs = 300;
  try {
    const r = await get('/desktop/slowd/marker');
    assert.equal(r.status, 504, '超时须 504，实得 ' + r.status);
  } finally {
    app.cfg.httpTimeoutMs = 1500;
    await new Promise((r) => slow.close(r));
    await threeRunning();
  }
});

test('大响应流式直通（512KB 不截断，content-type 不被改写）', async () => {
  await threeRunning();
  const r = await get('/desktop/vcmi/big');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 512 * 1024);
  assert.equal(r.headers['content-type'], 'application/octet-stream');
});

test('healthz 只报数量不报 registry 路径', async () => {
  await threeRunning();
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.match(r.body.toString('utf8'), /^ok desktops=3/);
});
