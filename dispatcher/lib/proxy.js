
'use strict';
// 前缀反代：strip 一次 /desktop/<id> 前缀后转发到该桌面登记的固定后端 root
// HTTP 字节直通（不解析 body、不重写 JSON、不改 content-type / content-length / content-encoding）
// WS 原始代理：重建 Upgrade 握手（显式 Connection: Upgrade / Upgrade / Host），
//   响应头有界累计后解析（支持 HTTP 头被拆包），之后双向 raw pipe + 背压

const http = require('http');
const net = require('net');

const REQ_STRIP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'host', 'upgrade',
]);
const RES_STRIP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding',
]);
const CRLF = String.fromCharCode(13, 10);
const HEAD_END = Buffer.from(String.fromCharCode(13, 10, 13, 10), 'latin1');
const MAX_WS_HEADER_BYTES = 64 * 1024;

function cloneHeaders(headers, stripSet) {
  const out = {};
  for (const k of Object.keys(headers)) {
    if (stripSet.has(k.toLowerCase())) continue;
    const v = headers[k];
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

// 后端目标：只允许登记值落在 loopback + 授权端口区间（不读 registry 之外的任意 URL）
function backendTarget(entry, cfg) {
  const port = Number(entry.port);
  if (!Number.isInteger(port)) return null;
  if (port < cfg.backendPortMin || port > cfg.backendPortMax) return null;
  return { host: cfg.backendHost, port: port };
}

// 把 req.url 的桌面前缀 strip 一次；query 原样透传（不重新编码 ⇒ 无双重编码）
function stripPrefix(url, id) {
  const prefix = '/desktop/' + id;
  let rest = url.slice(prefix.length);
  if (rest === '') rest = '/';
  if (rest.charCodeAt(0) !== 47) rest = '/' + rest;
  return rest;
}

// 转发给后端的 Host：保留浏览器原入口 Host（image 侧 audio gate 用 $http_host 对 PUBLIC_ORIGIN）
// 纯功能适配：连接目标仍固定 127.0.0.1:<登记端口>，不做 Origin/Host 安全矩阵
function publicHost(cfg) {
  const s = String(cfg.publicOrigin || '');
  const m = /^[a-z]+:\/\/([^\/]*)/i.exec(s);
  return m ? m[1] : '127.0.0.1:' + cfg.port;
}

function forwardHost(reqHeaders, cfg) {
  const h = reqHeaders && reqHeaders.host;
  if (typeof h === 'string' && h) return h;
  return publicHost(cfg);
}

// 显式外域音频适配（2026-11-13）：外域入口访问音频通道时后端 relay 只认内部 origin ⇒ 421。
// 只对**音频内部 hop**（/audio、/audio/…、/audiojs/…，按 pathStr 的 ? 前 pathname 判定）生效，
// 且必须 cfg.browserOrigin 显式配置（WTK_BROWSER_ORIGIN，部署层设定；不从 Host/X-Forwarded 动态信任）。
// 命中条件：请求 Host 精确 = browserOrigin.host，且 Origin 缺省（静态资源常无）或精确 = browserOrigin。
// 命中 ⇒ 上游 Host 改写为 publicHost(cfg)（loopback 内部值），Origin 存在时改写为 cfg.publicOrigin；
// 连接目标不变（127.0.0.1:<登记端口>）。其余请求与非音频路径全部走原透传逻辑。
// 这是合法具体域名 ↔ 内部 origin 的功能映射，不是来源校验矩阵。
function audioInternalPath(pathStr) {
  const q = pathStr.indexOf('?');
  const p = q < 0 ? pathStr : pathStr.slice(0, q);
  return p === '/audio' || p.startsWith('/audio/') || p.startsWith('/audiojs/');
}

// 返回 { host, origin }：host = 上游 Host；origin = 上游 Origin（'' = 不写该头）
// 内部规范 origin 用 URL.origin 归一（尾 '/' 等直接消费原值会与 relay 规范化不一致）；
// cfg.publicOrigin 非合法 http(s) origin ⇒ 不映射（启动期 resolveConfig 已拒绝，此处运行期兜底）。
function internalOrigin(cfg) {
  try {
    const u = new URL(String(cfg.publicOrigin));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch (e) { /* fallthrough */ }
  return null;
}

function forwardHop(reqHeaders, cfg, pathStr) {
  const host = forwardHost(reqHeaders, cfg);
  const rawOrigin = reqHeaders && reqHeaders.origin;
  const origin = (typeof rawOrigin === 'string' && rawOrigin) ? rawOrigin : '';
  if (cfg.browserOrigin && cfg.browserOriginHost
    && host.toLowerCase() === String(cfg.browserOriginHost).toLowerCase()
    && (origin === '' || origin === cfg.browserOrigin)
    && audioInternalPath(pathStr)) {
    const inner = internalOrigin(cfg);
    if (origin === '') return { host: publicHost(cfg), origin: '' };
    if (inner) return { host: publicHost(cfg), origin: inner };
  }
  return { host: host, origin: origin };
}

// 上游 Location 加前缀：root 绝对 / 协议相对指向本后端 ⇒ 补 prefix；相对路径原样
// 识别两种「后端视角 origin」：登记的 127.0.0.1:<port> 与入口 publicOrigin host
function rewriteLocation(loc, entry, cfg, target) {
  const prefix = cfg.prefix + encodeURIComponent(entry.id) + '/';
  const origins = new Set([
    (target.host + ':' + target.port).toLowerCase(),
    publicHost(cfg).toLowerCase(),
  ]);
  const stripLead = (s) => {
    let i = 0;
    while (i < s.length && s.charCodeAt(i) === 47) i++;
    return s.slice(i);
  };
  const sameOrigin = (hostPart) => origins.has(hostPart.toLowerCase());
  if (loc.charCodeAt(0) === 47) {
    if (loc.charCodeAt(1) === 47) {
      const rest = loc.slice(2);
      const slash = rest.indexOf('/');
      if (sameOrigin(slash < 0 ? rest : rest.slice(0, slash))) {
        return prefix + stripLead(slash < 0 ? '' : rest.slice(slash));
      }
      return loc;
    }
    return prefix + stripLead(loc);
  }
  const m = /^(https?):[\/]{2}/i.exec(loc);
  if (m) {
    const rest = loc.slice(m[0].length);
    const slash = rest.indexOf('/');
    if (sameOrigin(slash < 0 ? rest : rest.slice(0, slash))) {
      return prefix + stripLead(slash < 0 ? '' : rest.slice(slash));
    }
    return loc;
  }
  return loc; // 相对 Location：在前缀下自然解析
}

// pathStr 由调用方给出（selector 的原始 tail + 原样 query），保证 strip 一次且无重编码
function proxyHttpRequest(req, res, entry, cfg, target, stats, pathStr) {
  const headers = cloneHeaders(req.headers, REQ_STRIP);
  const hop = forwardHop(req.headers, cfg, pathStr);
  headers.host = hop.host;
  if (hop.origin === '') delete headers.origin;
  else headers.origin = hop.origin;
  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: pathStr,
    headers: headers,
    agent: false,
  });
  let responded = false;
  let timedOut = false;
  let upstreamEnded = false;
  const fail = (code, note) => {
    if (responded) {
      // 响应已在途/已完成：上游断链属正常收尾噪声，不拆已在写的 res
      if (!upstreamEnded) res.destroy();
      return;
    }
    responded = true;
    stats.count('upstream_fail');
    stats.log('warn', 'upstream ' + code + ' desktop=' + entry.id + ' note=' + String(note).slice(0, 160));
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(code === 504 ? 'backend timeout' : 'backend unavailable');
  };
  upstream.setTimeout(cfg.httpTimeoutMs, () => {
    timedOut = true;
    upstream.destroy(new Error('timeout'));
  });
  upstream.on('error', (e) => {
    const code = (timedOut || (e && e.code === 'ETIMEDOUT')) ? 504 : 502;
    fail(code, (e && (e.code || e.message)) || 'error');
  });
  upstream.on('response', (up) => {
    responded = true;
    const h = cloneHeaders(up.headers, RES_STRIP);
    if (typeof h.location === 'string') h.location = rewriteLocation(h.location, entry, cfg, target);
    res.writeHead(up.statusCode || 502, h);
    // 响应体读完整后上游连接被拆（keep-alive 关闭 + RST）属正常收尾：
    // 不再 destroy res，否则已写完的 body 被截断（root 实测 test13 = 502 根因）
    up.on('end', () => { upstreamEnded = true; });
    up.on('error', () => { if (!upstreamEnded) res.destroy(); });
    up.pipe(res);
  });
  res.on('close', () => {
    // 客户端提前离开才掐上游；响应完整送达后的 close 属正常收尾
    if (!upstreamEnded && !upstream.destroyed) upstream.destroy(new Error('client_close'));
  });
  req.on('error', () => { if (!upstream.destroyed) upstream.destroy(new Error('req_error')); });
  req.pipe(upstream);
}

// 重建客户端 Upgrade 握手：Connection / Upgrade / Host / Origin 由代理显式生成（不依赖客户端原值）
// Host/Origin 来自 forwardHop（外域音频命中时映射为内部值，其余透传原逻辑）
function buildHandshake(pathStr, headers, fwdHost, fwdOrigin) {
  const lines = ['GET ' + pathStr + ' HTTP/1.1'];
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (REQ_STRIP.has(lk) || lk === 'origin') continue;
    const v = headers[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); continue; }
    lines.push(k + ': ' + v);
  }
  const upg = headers.upgrade;
  lines.push('Connection: Upgrade');
  lines.push('Upgrade: ' + (typeof upg === 'string' && upg ? upg : 'websocket'));
  lines.push('Host: ' + fwdHost);
  if (fwdOrigin) lines.push('Origin: ' + fwdOrigin);
  return lines.join(CRLF) + CRLF + CRLF;
}

function proxyWebSocket(req, socket, head, entry, cfg, target, stats, release, pathStr) {
  const hop = forwardHop(req.headers, cfg, pathStr);
  const blob = buildHandshake(pathStr, req.headers, hop.host, hop.origin);
  const upstream = net.connect(target.port, target.host);
  stats.count('ws_open');
  const t0 = Date.now();

  let done = false;
  let mode = 'handshake';           // handshake -> body
  let timedOut = false;
  const headChunks = [];
  let headSize = 0;

  // finish(grace): grace=true 时 socket 走 end() + 250ms 兜底 destroy，
  //   保证刚排入的响应字节（101 头 / 拒绝状态行）真正送达客户端；
  //   直接 destroy 会把写缓冲冲掉（root 实测：客户端 0 字节拿不到状态行）。
  const finish = (grace) => {
    if (done) return;
    done = true;
    stats.count('ws_close');
    stats.timing(Date.now() - t0);
    release();
    if (!upstream.destroyed) upstream.destroy();
    if (!socket.destroyed) {
      if (grace) {
        socket.setTimeout(250, () => { if (!socket.destroyed) socket.destroy(); });
        if (!socket.writableEnded) socket.end();
      } else {
        socket.destroy();
      }
    }
  };

  const forward = (chunk, to, from) => {
    if (done || to.destroyed) return;
    if (!to.write(chunk)) {
      from.pause();
      to.once('drain', () => { if (!from.destroyed) from.resume(); });
    }
  };

  // headBlock = 上游握手响应头块（含结尾 CRLFCRLF），pending = 同包余下字节
  // 两者都必须写给客户端：只写 pending 会让客户端永远收不到 101
  const goBody = (headBlock, pending) => {
    mode = 'body';
    upstream.setTimeout(0);
    if (headBlock && headBlock.length) forward(headBlock, socket, upstream);
    if (pending && pending.length) forward(pending, socket, upstream);
  };

  // 握手阶段上游不可达 ⇒ 必须回显状态行，不能让客户端看到 0 字节
  // （root 实测：一桌后端故障时 WS 返回空）
  const rejectWithStatus = (code, reason) => {
    stats.count('ws_rejected');
    stats.log('warn', 'ws upstream unavailable desktop=' + entry.id + ' code=' + code + ' note=' + String(reason).slice(0, 80));
    if (!socket.destroyed) {
      const body = 'backend unavailable';
      socket.end(
        'HTTP/1.1 ' + code + ' Bad Gateway' + CRLF
        + 'content-type: text/plain; charset=utf-8' + CRLF
        + 'content-length: ' + Buffer.byteLength(body) + CRLF
        + 'connection: close' + CRLF + CRLF + body
      );
    }
    finish(true);
  };

  const refuse = (statusLine, joined) => {
    stats.count('ws_refused');
    stats.log('warn', 'ws handshake refused desktop=' + entry.id + ' status=' + String(statusLine).slice(0, 40));
    if (!socket.destroyed) {
      if (joined.length) socket.end(joined); else socket.end();
    }
    finish(true);
  };

  const parseHead = (chunk) => {
    headChunks.push(chunk);
    headSize += chunk.length;
    const joined = Buffer.concat(headChunks);
    const idx = joined.indexOf(HEAD_END);
    if (idx < 0) {
      if (headSize > MAX_WS_HEADER_BYTES) {
        stats.count('ws_refused');
        stats.log('warn', 'ws handshake header overflow desktop=' + entry.id);
        finish();
      }
      return;
    }
    const headText = joined.slice(0, idx).toString('latin1');
    const statusLine = headText.split(String.fromCharCode(13, 10))[0];
    if (/^HTTP\/1\.[01] 101/i.test(statusLine)) {
      goBody(joined.slice(0, idx + HEAD_END.length), joined.slice(idx + HEAD_END.length));
      return;
    }
    refuse(statusLine, joined);
  };

  upstream.setTimeout(cfg.httpTimeoutMs, () => {
    timedOut = true;
    stats.log('warn', 'ws handshake timeout desktop=' + entry.id);
    finish();
  });
  upstream.on('error', (e) => {
    const code = (timedOut || (e && e.code === 'ETIMEDOUT')) ? 504 : 502;
    if (!done && mode === 'handshake' && headSize === 0) { rejectWithStatus(code, (e && e.code) || 'error'); return; }
    stats.log('warn', 'ws upstream error desktop=' + entry.id + ' code=' + (e && e.code ? e.code : (timedOut ? 'timeout' : 'err')));
    finish();
  });
  upstream.on('close', finish);
  const onClose = () => { socket.setTimeout(0); finish(false); };
  socket.on('error', () => { socket.setTimeout(0); finish(false); });
  socket.on('close', onClose);
  socket.on('end', () => { if (!socket.destroyed) socket.destroy(); finish(false); });
  upstream.on('connect', () => {
    upstream.write(blob);
    if (head && head.length && !upstream.destroyed) upstream.write(head);
  });

  socket.on('data', (chunk) => {
    if (done) return;
    if (mode === 'handshake') {
      if (!upstream.destroyed) upstream.write(chunk); // net 会排队 connect 前的写入
      return;
    }
    forward(chunk, upstream, socket);
  });
  upstream.on('data', (chunk) => {
    if (done) return;
    if (mode === 'handshake') { parseHead(chunk); return; }
    forward(chunk, socket, upstream);
  });

  return { close: finish, get mode() { return mode; } };
}

module.exports = {
  proxyHttpRequest,
  proxyWebSocket,
  backendTarget,
  rewriteLocation,
  cloneHeaders,
  stripPrefix,
  buildHandshake,
  REQ_STRIP,
  RES_STRIP,
  MAX_WS_HEADER_BYTES,
};
