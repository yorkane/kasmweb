#!/usr/bin/env node
'use strict';
// webtop-kasmvnc browser-audio relay (audio layer of the K image).
//
//   browser --ws--> dispatcher :25320 --/desktop/<id>/audio--> container nginx :3000
//                                          --/audio---------> 127.0.0.1:4901 (this process)
//                                                    --/audiojs/*--> static js for the page
//
// One ffmpeg child per relay process:
//   ffmpeg -f pulse -i <monitor> -f mpegts -codec:a mp2 -b:a 128k -ac 1 pipe:1
// The stdout of that child is an MPEG-TS/MP2 stream (mono, 44.1 kHz) and is fanned out
// verbatim to every browser websocket. That is the wire format the MIT jsmpeg decoder
// in web/ consumes, i.e. the same format the Kasm 4901 bridge produced in the 4-level
// verified candidate (doc/浏览器音频候选验证-0.1.md).
//
// Boundary (deliberately narrow; this process is a component, not a general proxy):
//   * listens on 127.0.0.1:4901 only - it is reachable solely through the container's
//     own nginx entry, so basic auth and the Host allowlist of that entry apply to
//     every audio connection;
//   * the only upstream it talks to is a pulse sink monitor inside this container
//     (WTK_AUDIO_MONITOR, default auto_null.monitor). No host audio device, no TCP
//     upstream, no microphone path, no path to any other container;
//   * the only HTTP paths answered are /audio (websocket), /audiojs/<file> (own static
//     assets) and /healthz. Everything else is rejected;
//   * request validation (loopback peer, Host allowlist, websocket Origin allowlist,
//     subprotocol allowlist, connection cap, byte-level backpressure) is kept here as
//     defence in depth even though nginx already gates the entry.
//
// Configuration is env-only, so the s6 service needs no shell quoting:
//   WTK_AUDIO_PORT             listen port, default 4901 (bind host fixed 127.0.0.1)
//   WTK_AUDIO_BIND             default 127.0.0.1; refuses any non-loopback value
//   WTK_AUDIO_MONITOR          pulse source to record, default auto_null.monitor
//   WTK_AUDIO_SAMPLE_RATE      default 44100
//   WTK_AUDIO_BITRATE          default 128k
//   WTK_AUDIO_CHANNELS         default 1 (mono; jsmpeg/Kasm parity, halves bandwidth)
//   WTK_PUBLIC_ORIGIN          browser-visible origin, e.g. http://127.0.0.1:25320;
//                               seeds BOTH the Host allowlist and the WS Origin allowlist
//   WTK_AUDIO_ALLOWED_HOSTS    comma list appended to the Host allowlist
//   WTK_AUDIO_ALLOWED_ORIGINS  comma list appended to the WS Origin allowlist
//   WTK_AUDIO_MAX_WS           concurrent browser streams, default 8
//   WTK_AUDIO_MAX_BUFFERED     per-client outbound high-water mark in bytes, default
//                               1048576 (1 MiB ~ 6 s of a 128k stream). Above it the
//                               relay queues/drops for *that* client only; see
//                               "byte-level backpressure" below.
//   WTK_AUDIO_MAX_QUEUED       per-client queue cap in bytes, default 4194304. Incoming
//                               chunks past the cap are tail-dropped (live audio: the
//                               newest frames are the useful ones).
//   WTK_AUDIO_MAX_DROP_BYTES   cumulative tail-drops that condemn a client, default
//                               8388608. A client that has lost that much is terminated
//                               instead of being carried forever.
//   WTK_AUDIO_MAX_PRODUCER_RESTARTS  consecutive zero-audio producer starts to
//                               retry before giving up, default 5. A new browser stream,
//                               or any producer that emitted audio, re-arms the budget.
//   WTK_AUDIO_WS_MODULE        path to a `ws` implementation (falls back to ./vendor/ws,
//                               then /kclient/node_modules/ws shipped by the base image)
//   WTK_AUDIO_STATIC_DIR       defaults to <dir of this file>/web
//   WTK_AUDIO_LOG              'json' (default) or 'quiet'
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SELF_DIR = __dirname;
const PORT = Number(process.env.WTK_AUDIO_PORT || 4901);
const BIND = process.env.WTK_AUDIO_BIND || '127.0.0.1';
const MONITOR = process.env.WTK_AUDIO_MONITOR || 'auto_null.monitor';
const SAMPLE_RATE = String(process.env.WTK_AUDIO_SAMPLE_RATE || '44100');
const BITRATE = String(process.env.WTK_AUDIO_BITRATE || '128k');
const CHANNELS = Number(process.env.WTK_AUDIO_CHANNELS || 1);
const MAX_WS = Number(process.env.WTK_AUDIO_MAX_WS || 8);
const STATIC_DIR = process.env.WTK_AUDIO_STATIC_DIR || path.join(SELF_DIR, 'web');
const QUIET = process.env.WTK_AUDIO_LOG === 'quiet';

// Byte-level flow control, per client. Numbers are byte counts of the *wire* stream,
// so they scale with WTK_AUDIO_BITRATE, not with frame size.
function numEnv(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const MAX_BUFFERED = numEnv('WTK_AUDIO_MAX_BUFFERED', 1048576);      // high-water mark
const MAX_QUEUED = numEnv('WTK_AUDIO_MAX_QUEUED', 4194304);
const MAX_DROP_BYTES = numEnv('WTK_AUDIO_MAX_DROP_BYTES', 8388608);
const FLUSH_MS = 100;
// How long a close handshake may take before the connection is cut. TCP is a byte
// stream: a close frame queued behind megabytes of audio reaches a lagging peer only
// after that audio, so 'stop' would be answered on the drain schedule of a client we
// are about to disconnect. beginClose() therefore drops the queued audio (it is
// worthless once we are closing, and dropping it frees the memory we bounded) and
// guarantees the handshake finishes within this grace.
const CLOSE_GRACE_MS = numEnv('WTK_AUDIO_CLOSE_GRACE_MS', 500);

function requireWs() {
  const tried = [];
  for (const m of [process.env.WTK_AUDIO_WS_MODULE, path.join(SELF_DIR, 'vendor', 'ws'), '/kclient/node_modules/ws']) {
    if (!m) continue;
    try { return require(m); } catch (e) { tried.push(m + ': ' + e.code); }
  }
  throw new Error('no ws implementation resolvable; tried ' + tried.join(' | '));
}
const WebSocket = requireWs();

function listFromEnv(name) {
  const v = process.env[name];
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
// Origin/Host allowlist. Asymmetry is deliberate:
//
// HOST = loopback wildcard + configured/operated hosts, NO literal port baked in.
// The dispatcher sits in front of this container and rewrites Host to its backend
// (127.0.0.1:<per-desktop port>), and those ports are allocated per desktop, so
// enumerating them here cannot work - the old image hardcoded its own front-door
// port, and that is exactly what broke once a dispatcher owned the port mapping.
// Wildcarding the
// loopback family is safe because the LISTENER is loopback-only (see BIND check
// at the bottom of this file): a Host header of 127.0.0.1:25321 can only have
// been produced by a peer that already reached 127.0.0.1:4901, i.e. this
// container's own nginx, and nothing outside can address that socket at all.
// A non-loopback Host still has to appear explicitly, from WTK_PUBLIC_ORIGIN
// (the dispatcher's public origin, e.g. http://127.0.0.1:25320) or from the
// operator's WTK_AUDIO_ALLOWED_HOSTS.
//
// ORIGIN = exact matches only, never wildcarded. Origin is the CSRF defence on
// the websocket handshake; a wildcard there would let any page in the world
// open a stream, so it accepts only the configured public origin plus the
// operator's explicit list. Loopback origins are NOT wildcarded.
const PUBLIC_ORIGIN = (process.env.WTK_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const HOSTS = new Set();
const ORIGINS = new Set();
if (PUBLIC_ORIGIN) {
  try {
    const u = new URL(PUBLIC_ORIGIN);
    ORIGINS.add(u.origin);
    HOSTS.add(u.host);
  } catch (e) {
    process.stderr.write('audio-relay: WTK_PUBLIC_ORIGIN is not an absolute URL, ignored\n');
  }
}
for (const h of listFromEnv('WTK_AUDIO_ALLOWED_HOSTS')) HOSTS.add(h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
for (const o of listFromEnv('WTK_AUDIO_ALLOWED_ORIGINS')) ORIGINS.add(o.replace(/\/+$/, ''));

// Loopback hosts are accepted on any port; see the block above for why.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
function hostAllowed(h) {
  if (!h) return false;
  if (LOOPBACK_HOST.test(h)) return true;
  return HOSTS.has(h);
}

const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const log = (...a) => { if (!QUIET) process.stdout.write(new Date().toISOString() + ' ' + a.join(' ') + '\n'); };

function audit(o) {
  try { fs.appendFileSync(process.env.WTK_AUDIO_AUDIT || path.join('/dev/null'), JSON.stringify(o) + '\n'); } catch (e) {}
}

function deny(res, code, why) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-audio-reject': why });
  res.end('rejected: ' + why + '\n');
  audit({ ev: 'reject', code, why });
}

function loopbackIp(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function hostOk(req) { return hostAllowed(String(req.headers.host || '')); }
function originOk(req) { return ORIGINS.has(String(req.headers.origin || '')); }

// --- static assets (/audiojs/*) ----------------------------------------------
function serveStatic(req, res, urlPath) {
  const rel = urlPath.slice('/audiojs/'.length);
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) return deny(res, 400, 'bad-static-path');
  const file = path.join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) return deny(res, 400, 'static-escape');
  let st;
  try { st = fs.statSync(file); } catch (e) { return deny(res, 404, 'no-such-asset'); }
  if (!st.isFile()) return deny(res, 404, 'not-a-file');
  res.writeHead(200, {
    'content-type': STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': String(st.size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// --- the capture pipeline -----------------------------------------------------
// Single producer, N consumers. ffmpeg is restarted on exit as long as at least one
// browser is connected, so a transient pulse restart does not kill the feature.
let producer = null;
let producerWanted = false;
const clients = new Set();
let bytesFromProducer = 0;

// --- per-client outbound flow control ------------------------------------------
// The vendored ws (8.17.1) gives a server-side WebSocket no writable stream:
//   * WebSocket#send() returns undefined, so "if (!socket.send(...))" is always true
//     (vendor/ws/lib/websocket.js:447-477 ends without a return value);
//   * WebSocket#pause() pauses the *inbound* socket (websocket.js:348 ->
//     this._socket.pause(), and socketOnData/receiverOnDrain are the only users of
//     that flag), so it is not outbound backpressure at all;
//   * a server-side WebSocket never emits 'drain' (only the Receiver does, wired at
//     websocket.js:224), so a resume() driven by ws.on('drain') never runs.
// Consequence of the previous shape: every client was paused on the first chunk and
// never resumed, which mutes the *control* channel (the client can no longer deliver
// {"cmd":"stop"}) and stalls clean close - i.e. one slow reader took the whole
// session down. The real outbound queue is ws.bufferedAmount (socket._writableState
// .length + sender._bufferedBytes, websocket.js:120), which is readable but not
// writable, so backpressure is implemented here as a bounded queue per client:
//   pump while bufferedAmount < MAX_BUFFERED; above it the client is "gated";
//   the queue is capped at MAX_QUEUED by tail-dropping the oldest bytes (live audio:
//   newest is the useful part), and a client that drops MAX_DROP_BYTES in total is
//   terminated. Every step is per-client: no shared state can throttle the fan-out,
//   and the producer itself is never paused, so one slow client cannot stop audio
//   for the others.
function gated(c) {
  try { return c.socket.bufferedAmount >= MAX_BUFFERED; } catch (e) { return false; }
}

// Tail-drop the oldest queued chunks until the queue fits MAX_QUEUED.
function trimQueue(c) {
  while (c.outBytes > MAX_QUEUED && c.out.length > 1) {
    const old = c.out.shift();
    c.outBytes -= old.length;
    c.dropped += old.length;
  }
  if (c.dropped > MAX_DROP_BYTES) {
    audit({ ev: 'ws-slow', frames: c.frames, bytes: c.bytes, dropped: c.dropped });
    log('ws slow: dropped=' + c.dropped + ' > ' + MAX_DROP_BYTES + ' -> terminate');
    c.condemned = true;
    try { c.socket.terminate(); } catch (e) {}
    dropClient(c, 'slow-client');
    return true;
  }
  return false;
}

// Move as much of c.out as the kernel will accept right now. Never throws: a
// send failure condemns this one client, not the relay.
function pump(c) {
  if (c.pumping) return;
  c.pumping = true;
  try {
    while (c.out.length && !gated(c)) {
      const chunk = c.out[0];
      try {
        c.socket.send(chunk, { binary: true, compress: false });
      } catch (e) {
        c.out.shift();
        c.outBytes -= chunk.length;
        c.condemned = true;
        log('ws send failed: ' + e.message + ' -> terminate');
        try { c.socket.terminate(); } catch (e2) {}
        dropClient(c, 'send-failed');
        return;
      }
      c.out.shift();
      c.outBytes -= chunk.length;
      c.frames += 1;
      c.bytes += chunk.length;
    }
  } finally {
    c.pumping = false;
  }
  if (c.out.length === 0) ungate(c);
}

// Gated clients get re-pumped on a timer: there is no 'drain' to wait for, and a
// polling pump is also what keeps a client that recovered from a long stall alive.
let flushTimer = null;
function armFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    for (const c of [...clients]) {
      if (!c.out.length) { ungate(c); continue; }
      if (!gated(c)) pump(c);
    }
  }, FLUSH_MS);
  flushTimer.unref();
}
function disarmFlush() {
  if (flushTimer && clients.size === 0) { clearInterval(flushTimer); flushTimer = null; }
}
function ungate(c) {
  if (!c.gated) return;
  c.gated = false;
  if (![...clients].some((x) => x.gated && x.out.length)) disarmFlush();
}

function enqueue(c, chunk) {
  if (c.condemned || c.closing || c.socket.readyState !== WebSocket.OPEN) return;
  c.received += 1;
  c.out.push(chunk);
  c.outBytes += chunk.length;
  if (trimQueue(c)) return;
  if (gated(c)) {
    c.gated = true;
    armFlush();
    return;                      // queue only; the flush timer resumes the pump
  }
  pump(c);
}

// Close a client promptly, whatever its outbound queue is doing. The queued audio is
// discarded (a closing stream has no use for it, and discarding is what keeps the
// bound honest), the handshake is started, and a timer guarantees it ends: an
// unresponsive peer is terminated after CLOSE_GRACE_MS instead of being waited for.
function beginClose(c, code, reason) {
  if (c.closing) return;
  c.closing = true;
  c.out.length = 0;
  c.outBytes = 0;
  ungate(c);
  disarmFlush();
  const t = setTimeout(() => { try { c.socket.terminate(); } catch (e) {} }, CLOSE_GRACE_MS);
  if (t.unref) t.unref();
  try { c.socket.close(code, reason); } catch (e) {
    try { c.socket.terminate(); } catch (e2) {}
  }
}

function producerArgs() {
  return [
    '-v', 'error',
    '-fflags', '+genpts',
    '-f', 'pulse', '-i', MONITOR,
    '-vn', '-sn', '-dn',
    '-ar', SAMPLE_RATE,
    '-ac', String(CHANNELS),
    '-f', 'mpegts',
    '-codec:a', 'mp2',
    '-b:a', BITRATE,
    '-muxdelay', '0', '-muxpreload', '0',
    'pipe:1',
  ];
}

// Producer lifecycle: one producer, restarted while a client is connected.
//
// Both ways a producer can disappear end up in scheduleProducerRestart():
//   * child 'exit'  - the process ran and died (transient pulse restart, the original case);
//   * child 'error' - the spawn itself failed (ENOENT / EACCES). Node emits 'error' and NO
//     'exit' for those, and the previous code returned from the 'error' handler without
//     scheduling anything, so one transient PATH/mount/apparmor failure left a healthy
//     node process permanently silent: the browser stayed 'playing', the control channel
//     worked, and no audio ever came back.
// The scheduler is a singleton timer, cancelled by stopProducer(), so a close can never be
// followed by a resurrected producer, and it is bounded: consecutive starts that produced
// zero bytes (spawn failed, or ffmpeg died before the first frame - the loop that would
// otherwise run forever) give up after MAX_RESTARTS and are re-armed by the next browser
// stream. A producer that emitted audio resets the budget, so the normal pulse-restart
// path keeps its original behaviour.
//
// The one window that "the next browser stream re-arms the budget" does NOT cover: a
// viewer arriving while the previous producer is still tearing down. startProducer()
// therefore records demand before its `if (producer) return` guard, so the deferred
// exit of that dying child finds the room wanting audio and schedules the restart.
// Demand is sticky for the lifetime of the room; stopProducer() is the only thing
// that clears it (empty room => no restart, as asserted by C4 / D3).
const RESTART_MS = 1500;   // unchanged from the original exit path
const MAX_RESTARTS = numEnv('WTK_AUDIO_MAX_PRODUCER_RESTARTS', 5);
let restartTimer = null;
let producerFailures = 0;  // consecutive producer attempts that yielded no audio

function scheduleProducerRestart(why) {
  if (restartTimer) return;                       // at most one restart in flight
  if (!producerWanted || clients.size === 0) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    // Re-check at fire time: the delay is long enough for the last client to leave, and
    // restarting on an empty room would leak a producer with no consumer.
    if (producerWanted && clients.size > 0) startProducer();
  }, RESTART_MS);
  log('producer restart scheduled in ' + RESTART_MS + ' ms (' + why + ')');
}

function cancelProducerRestart() {
  if (!restartTimer) return;
  clearTimeout(restartTimer);
  restartTimer = null;
  log('producer restart cancelled');
}

// One accounting step per child. 'produced' is the reset signal: audio that reached the
// relay proves the pipeline works, so the retry budget starts over for the next death.
function noteProducerDeath(kind, produced) {
  if (!producerWanted || clients.size === 0) { producerFailures = 0; return; }
  if (produced) {
    producerFailures = 0;
    scheduleProducerRestart(kind);
    return;
  }
  producerFailures += 1;
  if (producerFailures > MAX_RESTARTS) {
    producerWanted = false;
    cancelProducerRestart();
    audit({ ev: 'producer-giveup', failures: producerFailures, kind: kind });
    log('producer: ' + MAX_RESTARTS + ' consecutive starts with no audio -> give up (next client re-arms)');
    return;
  }
  scheduleProducerRestart(kind + ' #' + producerFailures);
}

function startProducer() {
  // Demand is recorded BEFORE the liveness guard: `producer` is cleared only in the
  // child exit/error handler, so a producer that lingers after SIGTERM keeps that guard
  // armed. A viewer arriving inside the teardown window must still set producerWanted,
  // otherwise the dying child's exit finds wanted=false and schedules nothing - one
  // reconnect landing in that window leaves a healthy node process permanently silent.
  producerWanted = true;
  if (producer) return;
  const child = spawn('ffmpeg', producerArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { HOME: process.env.HOME || '/tmp' }),
  });
  producer = child;
  let stderrBuf = '';
  let settled = false;
  let produced = false;
  child.stdout.on('data', (chunk) => {
    produced = true;
    producerFailures = 0;
    bytesFromProducer += chunk.length;
    for (const c of clients) {
      if (c.socket.readyState !== WebSocket.OPEN) continue;
      enqueue(c, chunk);
    }
  });
  child.stderr.on('data', (d) => {
    stderrBuf = (stderrBuf + d.toString('utf8')).slice(-2000);
  });
  // 'error' and 'exit' can both fire for the same child; the first one to settle wins, so
  // a child is counted (and rescheduled) exactly once.
  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    producer = null;
    if (stderrBuf.trim()) process.stderr.write('audio-relay ffmpeg: ' + stderrBuf.trim().slice(0, 600) + '\n');
    log('producer exit code=' + code + ' signal=' + signal + ' bytes=' + bytesFromProducer);
    noteProducerDeath('exit code=' + code, produced);
  });
  child.on('error', (e) => {
    if (settled) return;
    settled = true;
    producer = null;
    process.stderr.write('audio-relay: ffmpeg spawn failed: ' + e.message + '\n');
    log('producer spawn error code=' + (e.code || '?'));
    noteProducerDeath('spawn-error ' + (e.code || '?'), produced);
  });
  log('producer started (' + MONITOR + ' -> mpegts/mp2 ' + SAMPLE_RATE + 'Hz ' + CHANNELS + 'ch ' + BITRATE + ')');
}

function stopProducer() {
  producerWanted = false;
  cancelProducerRestart();
  producerFailures = 0;   // an empty room is not a failure; the next stream starts fresh
  if (producer) { try { producer.kill('SIGTERM'); } catch (e) {} }
}

// Single removal path: every way a client can leave (clean close, peer reset, spawn
// error, send error, condemned slow client) ends up here exactly once, so the
// bookkeeping (clients.size, audit, producer lifecycle, flush timer) cannot leak.
function dropClient(c, why) {
  if (!clients.has(c)) return;
  clients.delete(c);
  c.out.length = 0;
  c.outBytes = 0;
  audit({ ev: 'ws-drop', why: why, received: c.received, frames: c.frames, bytes: c.bytes,
    dropped: c.dropped, ms: Date.now() - c.since });
  log('ws drop ' + why + ' received=' + c.received + ' frames=' + c.frames +
    ' bytes=' + c.bytes + ' dropped=' + c.dropped + ' live=' + clients.size);
  ungate(c);
  disarmFlush();
  if (clients.size === 0) stopProducer();
}

// --- websocket handling -------------------------------------------------------
// One Server instance for the whole process. It is a EventEmitter: a per-request
// instance would have no 'error' listener, so a ClientHandshakeError emitted on the
// shared 'upgrade' path (e.g. a duplicate Sec-WebSocket-Protocol header) becomes an
// unhandled 'error' and kills the relay. 'connection' is our only entry point, so
// the shared instance adds no accept surface - all gating stays in onUpgrade.
const wss = new WebSocket.Server({
  noServer: true,
  handleProtocols: (protos) => {
    for (const p of protos) if (p === 'binary' || p === 'base64') return p;
    return false;
  },
});
wss.on('error', (e) => { process.stderr.write('audio-relay: wss: ' + e.message + '\n'); });

function wsReject(socket, code, why) {
  try { socket.write('HTTP/1.1 ' + code + ' ' + (code === 403 ? 'Forbidden' : code === 421 ? 'Misdirected Request' : 'Service Unavailable') + '\r\n\r\n'); } catch (e) {}
  socket.destroy();
  audit({ ev: 'ws-reject', why, origin: '', host: '' });
  log('ws reject ' + why);
}

function onUpgrade(req, socket, head) {
  const url = (req.url || '').split('?')[0];
  if (!loopbackIp(req)) return wsReject(socket, 403, 'non-loopback');
  if (!hostOk(req)) return wsReject(socket, 421, 'host-mismatch');
  if (url !== '/audio') return wsReject(socket, 404, 'path-not-proxied');
  // The browser page is same-origin with the entry, so an Origin header must exist and
  // must be one of the allowed origins. Missing Origin = non-browser client: refused.
  if (!originOk(req)) return wsReject(socket, 403, 'origin-mismatch');
  if (clients.size >= MAX_WS) return wsReject(socket, 503, 'ws-cap');
  const proto = String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = {
      socket: ws,
      // counted = what actually reached this socket's writer. 'received' counts every
      // producer chunk accepted for this client, i.e. including the bytes tail-dropped
      // because this client was the slow one; the two only ever differ for a gated
      // client, and the gap is reported as entry.dropped.
      bytes: 0, frames: 0, received: 0,
      out: [], outBytes: 0, dropped: 0,
      gated: false, pumping: false, condemned: false, closing: false,
      since: Date.now(),
    };
    clients.add(entry);
    ws.on('message', (data) => {
      // Control channel is one JSON frame: {"cmd":"stop"}. Nothing else is honoured;
      // in particular there is no path that lets a browser write into the sink.
      let msg = null;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) {}
      if (msg && msg.cmd === 'stop') beginClose(entry, 1000, 'client stop');
    });
    // No ws.on('drain')/resume() pair: a server-side WebSocket has no writable stream
    // and never emits 'drain' (see the flow-control block above). The control channel
    // therefore stays readable at all times, which is what makes stop responsive.
    ws.on('close', () => dropClient(entry, 'close'));
    ws.on('error', () => { try { ws.terminate(); } catch (e) {} dropClient(entry, 'error'); });
    audit({ ev: 'ws-open', origin: req.headers.origin, host: req.headers.host });
    log('ws open origin=' + req.headers.origin + ' live=' + clients.size);
    producerFailures = 0;   // a fresh viewer re-arms the bounded restart budget
    startProducer();
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (!loopbackIp(req)) return deny(res, 403, 'non-loopback');
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, live: clients.size, producer: !!producer, bytes: bytesFromProducer, monitor: MONITOR }) + '\n');
    return;
  }
  if (!hostOk(req)) return deny(res, 421, 'host-mismatch');
  if (url === '/audiojs' || url === '/audiojs/' || url.startsWith('/audiojs/')) return serveStatic(req, res, url);
  if (url === '/audio') return deny(res, 426, 'websocket-upgrade-required');
  return deny(res, 404, 'path-not-proxied');
});

server.on('upgrade', onUpgrade);

// Without this listener a listen-time failure (EADDRINUSE when a previous instance is
// still holding the port) is an unhandled 'error' event and Node aborts the process;
// and a runtime accept error would be logged as an unhandled event too. Split the two:
// a bind failure is fatal by design (s6 restarts the service, and a relay that is not
// listening has no reason to live), a runtime socket error is not.
let listening = false;
server.on('error', (e) => {
  process.stderr.write('audio-relay: server error: ' + e.code + ' ' + e.message + '\n');
  if (!listening) process.exit(1);
});

if (BIND !== '127.0.0.1' && BIND !== 'localhost' && BIND !== '::1') {
  process.stderr.write('audio-relay: refusing to bind non-loopback address ' + BIND + '\n');
  process.exit(2);
}
server.listen(PORT, BIND, () => {
  listening = true;
  log('audio relay http://' + BIND + ':' + PORT + ' (loopback only) monitor=' + MONITOR);
  log('  /audio  -> ws fan-out (Host: loopback wildcard'
      + (HOSTS.size ? ' + ' + [...HOSTS].join(' ') : '') + '; Origins: '
      + (ORIGINS.size ? [...ORIGINS].join(' ') : 'none configured') + ')');
  log('  /audiojs/* -> ' + STATIC_DIR);
});

process.on('SIGTERM', () => { stopProducer(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
process.on('SIGINT', () => { stopProducer(); process.exit(0); });
