// wdev-webtop browser audio front-end (audio layer of the new webtop image).
//
// Injected into the desktop page as <script src="/audiojs/audio.js" defer>.
// It owns one control button and nothing else (the desktop shell may pre-place an
// element with id="wdev-audio-btn" / data-wdev-audio and this script will wire that
// element instead of creating its own). Appearance lives in the sibling stylesheet
// page.css - linked by this script if the page does not already link it - and its
// position comes from CSS custom properties set through the CSSOM. CSP claim as
// measured (Chromium 143 under style-src 'self'): custom properties written via
// element.style.setProperty ARE read by an external same-origin stylesheet with no
// violation, because CSP gates script-authored <style> elements and style
// attributes, not the CSSOM property store. Serialization does create a style
// attribute, so the accurate claim is "no inline style VALUES, no <style>
// element": that attribute carries custom properties only, never a layout value.
//
// Geometry: the control sits inside the blank band that the X-side taskbar keeps
// free at its right end (tint2 panel_size = 100% 30, clock_padding = 44 0 -> the
// rightmost ~44 X px of the band is panel background only, and the tint2rc comment
// names that band as reserved for this button). It is therefore anchored to the
// canvas right edge with a small gap, NOT pushed left by the width of the zone -
// pushing left by the zone width lands it on top of the clock. Size is capped by
// the zone, so the control can never overflow it. Being position:fixed with
// margin 0, it contributes no flow height; the earlier in-flow insertion added
// 21px to the page, which produced a browser scrollbar that cut the taskbar off.
//
// Chain: user gesture -> load /audiojs/jsmpeg.min.js -> JSMpeg.Player(ws://<same origin>/audio)
// -> WebAudio destination. The stream is MPEG-TS/MP2 mono 44.1 kHz produced by the in-container
// relay (relay.js). Nothing is fetched from a second origin, no credentials are involved, and
// the audio never plays before a click, which is what the browser autoplay policy requires.
//
// window.__wdevAudio is the evidence API: status() / connect() / disconnect() / sample()
// / openWindow(name) / closeWindow(name) / dump(). The analyser is tapped on JSMpeg's own
// gain node, i.e. post-MP2-decode, so a reading proves decoded samples carry the tone.
//
// Base path (K image): the desktop is served under a per-desktop prefix
// (WTK_BASE_PATH = /desktop/<id>/) behind a dispatcher, so the three URLs this
// script fetches cannot be root-absolute. The image injects
// <BASE>wtk-boot.js - a tiny external script, NOT an inline one, because the
// Kasm page's CSP refuses inline scripts - which sets window.__WTK_BASE before
// this file runs. Missing/blank base falls back to '/', which keeps the old
// root-served behaviour intact.
//
// The DOM id (wdev-audio-btn), the data attribute (data-wdev-audio) and the
// evidence API names (__wdevAudio / __wdevLayout) are external contract: the
// manager and the tester read them, so they are NOT renamed with the image.
'use strict';
(function () {
  const BASE = (function () {
    const b = (typeof window.__WTK_BASE === 'string' && window.__WTK_BASE) ? window.__WTK_BASE : '/';
    return b.endsWith('/') ? b : b + '/';
  })();
  // wsPath is consumed as an absolute path, not as a Kasm path= parameter:
  // connect() builds the socket URL itself with location.host + WS_TARGET (see
  // the url line in connect()), so the value has to carry its own leading slash.
  // BASE is guaranteed to start and end with '/' (fallback '/'), so BASE + 'audio'
  // is '/audio' with no base and '/desktop/<id>/audio' with one: the dispatcher
  // strips the prefix and the container nginx sees the exact location /audio.
  // Stripping the leading slash here would concatenate host and path
  // ("ws://127.0.0.1:25320desktop/probe/audio").
  const WTK_WS_PATH = BASE + 'audio';
  const A = (window.__wdevAudio = {
    version: '1',
    state: 'idle', // idle | loading | playing | stalled | stopped | failed
    error: null,
    player: null,
    analyser: null,
    ctxState: null,
    wsFrames: 0,
    wsBytes: 0,
    last: null,
    windows: {},
    log: [],
    // Connect generation. Every connect/disconnect advances it, and each socket
    // remembers the generation it was created under. Late events from a socket
    // that belongs to an earlier generation are dropped, which is what stops a
    // stale close from the previous session from stamping 'stalled' onto a
    // player that is already running (start -> stop -> start).
    gen: 0,
    stale: 0,   // events dropped because they came from an older generation
    cssState: 'none', // none | loading | ok | failed
    // Watcher counters, part of the evidence API: pass = layout runs driven by a
    // watcher (resize / scroll / mutation / resize-observer), bind = the number of
    // times a ResizeObserver was attached to a canvas. bind stays at 1 while the
    // same canvas is kept, so it doubles as the observer-leak counter.
    stats: { pass: 0, bind: 0 },
    opts: {
      wsPath: WTK_WS_PATH,
      jsUrl: BASE + 'audiojs/jsmpeg.min.js',
      // page.css is this layer's only stylesheet entry point: it is the sheet
      // that consumes the six --wdev-audio-* custom properties layout() writes,
      // restates [hidden], styles every data-state / data-mode / data-small
      // variant, and carries the z-index that keeps the control above the Kasm
      // bar. layout.css is the parent injection sheet and only sets the
      // position:fixed floor; it is loaded by the nginx-injected <link>, not by
      // opts.cssUrl, and has no geometry rules to apply.
      cssUrl: BASE + 'audiojs/page.css',
      autoButton: true,
      // X-side taskbar band, in X px (tint2 panel_size = 100% 30).
      barX: 30,
      // Blank band the clock leaves free at the right end of the bar
      // (tint2 clock_padding = 44 0). The control belongs INSIDE this zone.
      zoneX: 44,
      // Gap from the canvas right edge to the control, in X px.
      edgeX: 2,
      // A wide caption needs this many CSS px of zone (2 CJK glyphs at 13px plus
      // the glyph and padding); below it the control degrades to the glyph alone,
      // because overflowing the zone would cover the clock the zone keeps clear.
      wideMinCss: 56,
      // Smallest box that is still a click target (CSS px). Below it the control
      // is hidden with data-small=1 rather than drawn on top of the desktop,
      // because at that scale the taskbar band itself is thinner than a button.
      minSize: 14,
      // 'compact' (glyph only) | 'wide' (glyph + Chinese label) | '' = auto.
      mode: ''
    }
  });

  const note = (m) => {
    A.log.push(new Date().toISOString().slice(11, 23) + ' ' + m);
    if (A.log.length > 200) A.log.shift();
  };

  // --- WS traffic accounting (transport side of the evidence) -----------------
  // Count frames/bytes of the audio socket without perturbing JSMpeg's feature
  // detection: the native constructor is wrapped with a Proxy construct trap so
  // `new WebSocket(...)` keeps native semantics (a plain function wrapper made
  // JSMpeg silently fall back to its Ajax source in an earlier run).
  // Current-generation stream death during the connect handshake. Order matters:
  // the reason and the failed state are written first, then the generation goes up
  // (that is what makes the parked connect abort as 'cancelled'), and the connect
  // cancellation path deliberately leaves A.state alone - so 'failed' survives.
  function handshakeDied(gen, kind) {
    A.error = 'audio stream ' + kind + ' during handshake';
    A.state = 'failed';
    const p = A.player;
    A.player = null;
    A.analyser = null;
    if (p) { try { p.destroy(); } catch (e) {} }
    A.gen++;
    note('handshake died ' + kind + ' gen=' + gen + ' now=' + A.gen);
    render();
  }

  const NativeWS = window.WebSocket;
  const WS_TARGET = A.opts.wsPath;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(args[0], args[1]);
      const gen = A.gen;
      if (String(args[0]).indexOf(WS_TARGET) >= 0) {
        ws.binaryType = 'arraybuffer';
        ws.addEventListener('message', (e) => {
          if (gen !== A.gen) return;                    // stale session: not counted
          A.wsFrames++; A.wsBytes += (e.data && e.data.byteLength) || 0;
        });
        ws.addEventListener('open', () => { if (gen === A.gen) note('ws open'); });
        ws.addEventListener('close', () => {
          if (gen !== A.gen) {
            A.stale++;
            note('stale ws close gen=' + gen + ' now=' + A.gen);
            return;
          }
          note('ws close');
          // The relay closing the socket (container restarted, pulse source gone,
          // idle timeout) must not leave the control claiming to play. No automatic
          // reconnect here: the next start is a user action.
          if (A.state === 'playing') { A.state = 'stalled'; A.error = 'audio stream closed'; render(); return; }
          // Handshake window: connect() is parked in an await (jsmpeg download,
          // ctx.resume), so the socket can die before connect has committed
          // anything. Ignoring that let connect resume and unconditionally set
          // 'playing' on a dead stream. Report it and invalidate the generation so
          // the in-flight connect aborts at its next checkpoint.
          // The gate is (stream is loading OR a connect flight is in flight), so
          // a consumer that calls A.connect() directly without the button's
          // 'loading' state is covered too.
          if (A.state === 'loading' || A._connecting) handshakeDied(gen, 'close');
        });
        ws.addEventListener('error', () => {
          if (gen !== A.gen) return;
          note('ws error');
          // Browsers fire error before close; handling both keeps the outcome
          // independent of which one the transport delivers first.
          if (A.state === 'loading' || A._connecting) handshakeDied(gen, 'error');
        });
      }
      return ws;
    }
  });

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function binHz(n, fftSize, rate) { return (n * rate) / fftSize; }

  function sample() {
    if (!A.analyser) return null;
    const a = A.analyser, ctx = a.context;
    const freq = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(freq);
    const t = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(t);
    let sum = 0, peakDb = -400, peakN = 0;
    for (let i = 0; i < t.length; i++) sum += t[i] * t[i];
    const rms = Math.sqrt(sum / t.length);
    for (let n = 1; n < freq.length; n++) if (freq[n] > peakDb) { peakDb = freq[n]; peakN = n; }
    const band = (target, w) => {
      let acc = 0, c = 0;
      for (let n = Math.max(1, target - w); n <= target + w; n++) { acc += Math.pow(10, freq[n] / 20); c++; }
      return c ? 20 * Math.log10(acc / c + 1e-12) : -400;
    };
    const bin = (f) => Math.round((f * a.fftSize) / ctx.sampleRate);
    return {
      t: Date.now(),
      rms: +rms.toFixed(6),
      peakHz: Math.round(binHz(peakN, a.fftSize, ctx.sampleRate)),
      peakDb: +peakDb.toFixed(2),
      band440Db: +band(bin(440), 2).toFixed(2),
      band880Db: +band(bin(880), 2).toFixed(2),
      band2000Db: +band(bin(2000), 2).toFixed(2)
    };
  }
  A.sample = sample;

  A.openWindow = (name) => {
    A.windows[name] = { name: name, samples: [], wsFrames0: A.wsFrames, wsBytes0: A.wsBytes };
    note('window open ' + name);
    return A.windows[name];
  };
  A.closeWindow = (name) => {
    const w = A.windows[name];
    if (!w) return null;
    const s = w.samples;
    const med = (arr) => { const a2 = arr.slice().sort((x, y) => x - y); return a2.length ? a2[Math.floor(a2.length / 2)] : null; };
    const mx = (arr) => (arr.length ? Math.max.apply(null, arr) : null);
    const col = (k) => s.map((x) => x[k]);
    w.totals = { frames: A.wsFrames - w.wsFrames0, bytes: A.wsBytes - w.wsBytes0 };
    w.agg = {
      n: s.length,
      rmsMax: mx(col('rms')),
      rmsMed: med(col('rms')),
      band440Med: med(col('band440Db')),
      band880Med: med(col('band880Db')),
      band2000Med: med(col('band2000Db')),
      peakMode: s.length ? (() => {
        const c = {};
        s.forEach((x) => { const k = Math.round(x.peakHz / 10) * 10; c[k] = (c[k] || 0) + 1; });
        return +Object.keys(c).reduce((a, b) => (c[a] > c[b] ? a : b));
      })() : null
    };
    note('window close ' + name + ' n=' + s.length);
    return w;
  };

  async function ensureJsmpeg() {
    if (window.JSMpeg) return;
    A.state = 'loading';
    note('loading ' + A.opts.jsUrl);
    await loadScript(A.opts.jsUrl);
    if (!window.JSMpeg) throw new Error('jsmpeg did not register');
  }

  // Single-flight connect. The guard lives in connect() itself, not in the click
  // handler, because the API is public: two callers in the same frame (two
  // clicks, an embedder plus a click, a probe script) used to each run the whole
  // body and end up with two players on one gain graph - the second destroy
  // leaves the first socket streaming. The in-flight promise is shared, so the
  // second caller awaits the same session and gets the same result.
  // Single-flight connect. The guard lives in connect() itself, not in the click
  // handler, because the API is public: two callers in the same frame (two clicks,
  // an embedder plus a click, a probe script) used to each run the whole body and
  // end up with two players on one gain graph - the second destroy leaves the
  // first socket streaming. The in-flight promise is shared, so a concurrent
  // caller awaits the SAME session and gets the same result.
  //
  // Cancellation: the generation is taken before anything is built, and every
  // await point checks it. A disconnect() (or a newer connect) that lands while
  // jsmpeg is still downloading or the WebAudio context is still resuming makes
  // this connect stale: whatever it managed to build is destroyed, the state is
  // left alone, and the caller resolves with 'cancelled' instead of 'ok'.
  A._connecting = null;

  A.connect = function () {
    if (A._connecting) return A._connecting;
    if (A.player && A.state === 'playing') return Promise.resolve('already');
    const gen = ++A.gen;
    const lost = () => gen !== A.gen;
    const p = (async () => {
      // A stalled socket still owns a WebAudio graph and a dead player object; it
      // has to go before a new one is built, otherwise a start doubles outputs.
      if (A.player) {
        try { A.player.destroy(); } catch (e) { note('destroy ' + e.message); }
        A.player = null;
        A.analyser = null;
      }
      let built = null;
      try {
        await ensureJsmpeg();
        if (lost()) { note('connect cancelled gen=' + gen + ' at jsmpeg'); return 'cancelled'; }
        const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_TARGET;
        built = new window.JSMpeg.Player(url, {
          video: false, audio: true, loop: false, autoplay: true,
          maxAudioLag: 1.0, pauseWhenHidden: false, wasmDecodeFile: null,
          // Force jsmpeg's JS MP2 decoder. Its default path calls
          // WebAssembly.instantiate() on embedded bytes, which a page CSP of
          // script-src 'self' refuses (needs 'unsafe-eval') - the player then
          // 'connects' and stays silent. Decoding in JS keeps the strict CSP intact.
          disableWebAssembly: true
        });
        A.player = built;
        const ctx = window.JSMpeg.AudioOutput.WebAudio.CachedContext;
        if (!ctx) throw new Error('no WebAudio context created by jsmpeg');
        A.ctxState = ctx.state;
        try { await ctx.resume(); } catch (e) { note('resume ' + e.message); }
        A.ctxState = ctx.state;
        if (lost()) {
          note('connect cancelled gen=' + gen + ' after resume');
          try { built.destroy(); } catch (e) {}
          if (A.player === built) A.player = null;
          return 'cancelled';
        }
        const a = ctx.createAnalyser();
        a.fftSize = 4096;
        a.smoothingTimeConstant = 0;
        a.minDecibels = -110;
        a.maxDecibels = -10;
        built.audioOut.gain.connect(a);
        A.analyser = a;
        // Final commit gate: a stream that died while the analyser was being set
        // up (or a disconnect queued in the same turn) invalidated the generation,
        // and 'playing' must never be written for a stale flight.
        if (lost()) {
          note('connect cancelled gen=' + gen + ' before commit');
          try { built.destroy(); } catch (e) {}
          if (A.player === built) A.player = null;
          // The analyser is a node of the graph we are throwing away, and
          // handshakeDied already nulled it; clear it again only if this flight
          // is the one that wrote it, so a newer session's analyser survives.
          if (A.analyser === a) A.analyser = null;
          return 'cancelled';
        }
        A.state = 'playing';
        A.error = null;
        if (A._iv) clearInterval(A._iv);
        // One window entry removed by a consumer must not kill the sampler for
        // good (observed: a probe that deleted a window mid-run froze A.last).
        A._iv = setInterval(() => {
          const s = sample();
          if (!s) return;
          A.last = s;
          for (const k in A.windows) { const w = A.windows[k]; if (w && w.samples) w.samples.push(s); }
        }, 100);
        note('connected ' + url + ' ctx=' + A.ctxState);
        return 'ok ctx=' + A.ctxState;
      } catch (e) {
        // A connect that was cancelled mid-flight must not report 'failed' for a
        // session the user already stopped: the cancellation wins over the error.
        if (lost()) {
          note('connect cancelled gen=' + gen + ' (' + (e && e.message || e) + ')');
          if (built) { try { built.destroy(); } catch (e2) {} }
          if (A.player === built) A.player = null;
          return 'cancelled';
        }
        if (built && A.player === built) {
          try { built.destroy(); } catch (e2) {}
          A.player = null;
          A.analyser = null;
        }
        A.state = 'failed';
        A.error = String(e && e.message || e);
        note('connect failed ' + A.error);
        throw e;
      } finally {
        // Release the single-flight slot only if a later connect has not taken it.
        if (A._connecting === p) A._connecting = null;
      }
    })();
    A._connecting = p;
    return p;
  };

  A.disconnect = function () {
    if (A._iv) clearInterval(A._iv);
    A.gen++;                       // anything still in flight becomes stale
    try { if (A.player) A.player.destroy(); } catch (e) {}
    A.player = null;
    A.analyser = null;
    A.state = 'stopped';
    note('disconnected');
    return 'stopped';
  };

  A.status = function () {
    return { state: A.state, error: A.error, ctxState: A.ctxState, wsFrames: A.wsFrames, wsBytes: A.wsBytes, last: A.last, gen: A.gen, stale: A.stale, cssState: A.cssState };
  };
  A.dump = function () {
    return { state: A.state, error: A.error, ctxState: A.ctxState, wsFrames: A.wsFrames, wsBytes: A.wsBytes, last: A.last, windows: A.windows, log: A.log.slice(-40), gen: A.gen, stale: A.stale, cssState: A.cssState, geom: A.geom, stats: A.stats };
  };

  // --- control wiring ---------------------------------------------------------
  // Glyphs are built from code points, not \u escapes: the previous revision
  // wrote the two-character sequence backslash-u inside a single-quoted string,
  // so the control rendered the literal text "\u25B7 启用声音".
  const GLYPH = {
    off: String.fromCodePoint(0x25B7),    // right-pointing triangle: ready to start
    on: String.fromCodePoint(0x25C6),     // filled diamond: playing
    busy: String.fromCodePoint(0x23F3),   // hourglass: connecting
    stall: String.fromCodePoint(0x26A0)   // warning sign: stream died
  };
  const CAPTION = {
    idle: '启用声音',
    stopped: '启用声音',
    loading: '连接中…',
    playing: '音频播放中，点击停止',
    stalled: '音频流已断开，点击重试',
    failed: '音频连接失败，点击重试'
  };
  // Short form of the same states, for the body text of a wide control. The full
  // caption above stays in aria-label and title: the control sits on a ~44 X px
  // band, so the visible text has to be two glyphs, not a sentence.
  const LABEL = {
    idle: '开声',
    stopped: '开声',
    loading: '连接',
    playing: '播放',
    stalled: '断流',
    failed: '失败'
  };
  const TIP = '浏览器音频：播放容器内应用的声音。不采集麦克风，不读取宿主声卡，' +
    '授权按标签页生效（每个新标签页点一次）。';

  let BTN = null;
  // True until a layout pass proves the zone is wide enough for a caption.
  A.narrow = true;

  function caption() { return CAPTION[A.state] || CAPTION.idle; }
  function label() { return LABEL[A.state] || LABEL.idle; }
  function glyph() {
    if (A.state === 'playing') return GLYPH.on;
    if (A.state === 'loading') return GLYPH.busy;
    if (A.state === 'stalled' || A.state === 'failed') return GLYPH.stall;
    return GLYPH.off;
  }

  // compact = glyph only (the default: 26px over the remote desktop, the label
  // lives in aria-label/title), wide = glyph plus the Chinese caption.
  function modeOf(el) {
    const v = String(el.getAttribute('data-wdev-audio') || '').trim().toLowerCase();
    if (v === 'wide' || v === 'full' || v === 'label') return A.narrow ? 'compact' : 'wide';
    if (v === 'compact' || v === 'icon') return 'compact';
    if (v) return 'compact';
    return (A.opts.mode === 'wide' && !A.narrow) ? 'wide' : 'compact';
  }

  function render() {
    const el = BTN;
    if (!el) return;
    const g = glyph(), c = caption();
    el.textContent = modeOf(el) === 'wide' ? g + ' ' + label() : g;
    el.setAttribute('data-state', A.state);
    el.setAttribute('data-mode', modeOf(el));
    el.setAttribute('aria-pressed', A.state === 'playing' ? 'true' : 'false');
    el.setAttribute('aria-label', '声音：' + c);
    el.title = c + ' — ' + TIP + (A.error ? '（' + A.error + '）' : '');
  }
  A.render = render;

  // --- taskbar-band anchoring -------------------------------------------------
  // The control belongs to the X-side taskbar, which lives inside the remote
  // framebuffer, so every offset is derived from the canvas rect:
  //   scale   = displayed canvas height / canvas drawing-buffer height
  //   bottom  = distance from the canvas bottom edge to the viewport bottom,
  //             plus a small inset -> lands inside the 30*scale px band
  //   right   = distance from the canvas right edge to the viewport right, plus a
  //             small gap (edgeX * scale). The blank clock zone IS the slot, so
  //             the offset stays a gap and never grows into a leftward push.
  //   size    = capped by min(band height, zone width) so the control cannot
  //             spill out of the zone and cover the clock.
  // Letterboxing (resize=scale), a hidden Kasm top bar and classic scrollbars all
  // change the viewport maths and nothing of that matters here, because the canvas
  // rect is the ground truth. The values go out as CSS custom properties written
  // through the CSSOM (measured CSP-safe under style-src 'self'); the element
  // carries no inline layout values and this layer creates no <style> element.
  //
  // Picking the canvas is NOT a selector-chain question. The real Kasm page keeps
  // other canvases around - #noVNC_multiMonitorWidget holds a 700x230 desktop
  // preview that is display:none until a second screen shows up, and a
  // document.querySelector('canvas') happily returns it while the VNC canvas has
  // not been created yet (first connect: rect 0x0 -> geometry garbage). So every
  // canvas is measured, not matched:
  //   * a drawing buffer and a non-zero client rect are required (hidden -> out),
  //   * anything inside the multi-monitor widget is out by definition,
  //   * the rest is ranked by client area, preferring one inside #noVNC_container,
  //     because the session canvas is the largest visible thing on the page.
  const HIDDEN_HOST = 'noVNC_multiMonitorWidget';
  function clientId(el) {
    for (let n = el; n; n = n.parentNode) if (n.id === 'noVNC_container') return true;
    return false;
  }
  function hiddenEl(el) {
    if (typeof el.closest === 'function' && el.closest('#' + HIDDEN_HOST)) return true;
    const gcs = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
    if (!gcs) return false;
    return gcs.display === 'none' || gcs.visibility === 'hidden' || gcs.opacity === '0';
  }
  function canvasCandidates() {
    const list = document.querySelectorAll('canvas');
    const scored = [];
    for (const c of list) {
      if (typeof c.getBoundingClientRect !== 'function') continue;
      if (!c.width || !c.height) continue;            // no drawing buffer = not a screen
      if (hiddenEl(c)) continue;
      const r = c.getBoundingClientRect();
      if (!(r.width > 1 && r.height > 1)) continue;    // zero/hidden rect
      scored.push({ el: c, area: r.width * r.height, box: clientId(c) ? 1 : 0 });
    }
    scored.sort((a, b) => (b.box - a.box) || (b.area - a.area));
    return scored.map((s) => s.el);
  }
  function pickCanvas() {
    const c = canvasCandidates();
    return c.length ? c[0] : null;
  }

  function layout() {
    const el = BTN;
    if (!el) return null;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const canvas = pickCanvas();
    let geo = null;
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      const bufH = canvas.height || 0;
      const scale = (r.height > 0 && bufH > 0) ? r.height / bufH : 1;
      const bar = A.opts.barX * scale;
      const inset = Math.max(1, Math.round(2 * scale));
      const bandBottom = vh - r.bottom;   // canvas bottom edge in viewport coords
      // The blank zone in CSS px, and the largest control that fits inside it
      // with the edge gap kept on both the right side and the side facing the clock.
      const zone = A.opts.zoneX * scale;
      const edge = A.opts.edgeX * scale;
      // No floor yet: the honest fit inside band and zone.
      const fitW = Math.floor(zone - edge * 2);
      const fitH = Math.min(30, Math.round(bar - inset * 2));
      const fit = Math.min(fitW, fitH);
      // At a small client scale (a 44 X px zone on a 800x600 view, a phone tab)
      // the 16px floor that keeps the control clickable is TALLER than the whole
      // 30*scale band, so honouring it would paint the control over the desktop
      // content. Such a band gets no control: data-small records why and page.css
      // hides it. Offsets keep computing, so a scale-up brings it back.
      const small = fit < A.opts.minSize;
      const size = Math.max(16, fit);
      // A caption needs room in CSS px (the label is font-size 13, so it does not
      // scale with the canvas); a square glyph always fits. Re-measured on every
      // layout pass: a large display / high zoom gets the caption, a small one
      // silently keeps the glyph alone. zone scales, wideMinCss does not.
      const narrow = zone < A.opts.wideMinCss;
      // Hidden when the canvas has scrolled out of view upwards, and when the
      // taskbar band lies COMPLETELY below the viewport. The second case is what
      // resize=off produces (canvas shown at native size in a smaller window, no
      // CSS shell to fit it): the band is at y 1050..1080 of a 932 px viewport,
      // so clamping the offset to the viewport floor would park the control in
      // the middle of the game image. Partially visible (the band's top edge is
      // inside the viewport, the 25185 case) is still clamped, because there the
      // floor offset really does sit on the visible part of the band.
      const bandTop = r.bottom - bar;
      const bandOut = bandTop >= vh;
      const offscreen = r.bottom <= 0 || small || bandOut;
      const wantBottom = bandBottom + inset;
      const wantRight = (vw - r.right) + Math.round(edge);
      const bottom = Math.max(0, Math.min(vh - 12, wantBottom));
      const right = Math.max(0, wantRight);
      const clamped = Math.abs(bottom - wantBottom) > 0.5;
      el.style.setProperty('--wdev-audio-bar', bar.toFixed(2) + 'px');
      el.style.setProperty('--wdev-audio-bottom', bottom.toFixed(1) + 'px');
      el.style.setProperty('--wdev-audio-right', right.toFixed(1) + 'px');
      el.style.setProperty('--wdev-audio-height', size + 'px');
      el.style.setProperty('--wdev-audio-width', size + 'px');
      // Ceiling for a wide caption: the free zone minus the gaps, so a label can
      // extend the box leftward from the glyph but never past the zone.
      el.style.setProperty('--wdev-audio-maxw', Math.floor(zone - edge) + 'px');
      el.setAttribute('data-small', small ? '1' : '0');
      el.setAttribute('data-off', offscreen ? '1' : '0');
      el.setAttribute('data-nocanvas', '0');
      el.setAttribute('data-clamped', clamped ? '1' : '0');
      el.setAttribute('data-bandout', bandOut ? '1' : '0');
      el.setAttribute('data-narrow', narrow ? '1' : '0');
      if (narrow !== A.narrow) { A.narrow = narrow; render(); }
      // dpr is recorded, not used: the scale above already converts X px to CSS
      // px, and the browser converts CSS px to device px. It goes into the report
      // so a hidpi session can be told apart from a genuinely small window
      // (measured: at deviceScaleFactor 2 the ratio is unchanged, see
      // doc/webtop音频按钮布局-2026-11-13.md).
      // vw/vh ride along so a verifier can tell "the band is below the fold"
      // from "the window is short" without re-measuring the page.
      geo = { scale: +scale.toFixed(4), dpr: +(window.devicePixelRatio || 1).toFixed(3), vw: vw, vh: vh, bar: +bar.toFixed(2), zone: +zone.toFixed(2), edge: +edge.toFixed(1), size: size, fit: fit, small: small, maxW: fitW, narrow: narrow, bottom: +bottom.toFixed(1), right: +right.toFixed(1), wantBottom: +wantBottom.toFixed(1), clamped: clamped, bandOut: bandOut, offscreen: !!offscreen, canvas: { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1) } };
    } else {
      // No usable canvas: login page, KasmVNC not connected, or the session canvas
      // not created yet. There is no band to sit on, so the control is hidden
      // (data-off=1 -> page.css display:none) and every custom property is taken
      // back, which leaves it at the stylesheet fallbacks if a consumer un-hides
      // it by hand. The geometry stays null: an unanchored control is a visible
      // defect, so A.geom must not report a stale anchor from a previous canvas.
      el.setAttribute('data-off', '1');
      el.setAttribute('data-nocanvas', '1');
      el.setAttribute('data-small', '0');
      el.setAttribute('data-narrow', '1');
      el.setAttribute('data-bandout', '0');
      el.style.removeProperty('--wdev-audio-bottom');
      el.style.removeProperty('--wdev-audio-right');
      el.style.removeProperty('--wdev-audio-height');
      el.style.removeProperty('--wdev-audio-width');
      el.style.removeProperty('--wdev-audio-maxw');
      el.style.removeProperty('--wdev-audio-bar');
      A.narrow = true;
      geo = null;
    }
    A.geom = geo;
    return geo;
  }
  A.layout = layout;

  // --- canvas watching --------------------------------------------------------
  // Binding a ResizeObserver once at boot is not enough on a real Kasm page: at
  // first connect the session canvas does not exist yet, and the node is
  // REPLACED (not only resized) when the resolution changes, the view is
  // re-created, or a second monitor appears. Measured effect of the old
  // single-shot binding: the control stayed mis-anchored until a window resize.
  //
  // So the target is re-derived on every pass and kept under two observers:
  //   * ResizeObserver on the current canvas -> size changes,
  //   * one MutationObserver on <html> (childList/subtree + style/class/id)
  //     -> canvas inserted, removed, swapped or un-hidden.
  // The mutation callback is coalesced into a single microtask, so a reconnect
  // that churns the DOM costs one layout pass, not one per record, and there is
  // no polling anywhere. watchLayout() installs, stopWatching() tears all of it
  // down (both observers disconnected, all four window listeners removed by
  // reference) and is exposed as A.stopWatching for embedders and for the tests.
  let ro = null, roTarget = null, mo = null, queued = 0;
  const onResize = () => run();
  const onScroll = () => run();
  const onFonts = () => run();
  // Teardown on pagehide. KasmVNC is a single-page app: the desktop page does not
  // navigate while the session lives, so pagehide fires when the tab is closed,
  // reloaded, or navigated away - the moment at which an open WebAudio graph, a
  // live socket and two observers have no consumer left. visibilitychange is
  // deliberately NOT the teardown trigger: a backgrounded tab is a normal state
  // for this control (the stream is mono desktop audio, the user tabbed over to
  // read chat) and the audio relay keeps producing, so hiding the tab must not
  // cut playback. pagehide is the event that reliably fires on unload, including
  // on bfcache entry, where unload does not run.
  //
  // No KasmVNC-specific disconnect hook is wired: none is documented and none is
  // guaranteed to exist on the served page, and inventing a global name would be
  // a silent no-op. A consumer that knows the session went away can call
  // A.teardown() (public) with the same effect.
  const onPageHide = () => { try { A.teardown(); } catch (e) { note('pagehide ' + e.message); } };
  function run() {
    A.stats.pass++;
    try { bindCanvas(); layout(); } catch (e) { note('layout ' + e.message); }
  }
  function schedule() {
    if (queued) return;
    queued = 1;
    Promise.resolve().then(() => { queued = 0; if (mo) run(); });
  }
  function bindCanvas() {
    if (typeof ResizeObserver !== 'function') return;
    const target = pickCanvas();
    if (target === roTarget) return;
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; roTarget = null; }
    if (!target) return;
    roTarget = target;
    A.stats.bind++;
    try { ro = new ResizeObserver(run); ro.observe(target); } catch (e) { note('ro ' + e.message); }
  }
  // The listener options are shared constants on purpose: removeEventListener
  // matches on (type, callback, capture), so an add with capture:false and a
  // remove with capture:true silently removes nothing. Passing the same object
  // at both ends is what makes stopWatching() able to prove it left nothing
  // behind (fixture 13.8-13.10 assert the list is empty, not just short).
  const OPT_RESIZE = { passive: true };
  const OPT_SCROLL = { capture: true, passive: true };
  const OPT_PAGEHIDE = { passive: true };
  function watchLayout() {
    window.addEventListener('resize', onResize, OPT_RESIZE);
    window.addEventListener('scroll', onScroll, OPT_SCROLL);
    window.addEventListener('pagehide', onPageHide, OPT_PAGEHIDE);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      try {
        mo = new MutationObserver(schedule);
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['style', 'class', 'id']
        });
      } catch (e) { note('mo ' + e.message); mo = null; }
    }
    if (document.fonts && typeof document.fonts.addEventListener === 'function') {
      try { document.fonts.addEventListener('loadingdone', onFonts); } catch (e) {}
    }
    run();
  }
  A.stopWatching = function () {
    window.removeEventListener('resize', onResize, OPT_RESIZE);
    window.removeEventListener('scroll', onScroll, OPT_SCROLL);
    window.removeEventListener('pagehide', onPageHide, OPT_PAGEHIDE);
    if (document.fonts && typeof document.fonts.removeEventListener === 'function') {
      try { document.fonts.removeEventListener('loadingdone', onFonts); } catch (e) {}
    }
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    roTarget = null;
    queued = 0;
    return 'watchers stopped';
  };

  // Full teardown: stop the session, then the watchers. Idempotent, and safe to
  // call from pagehide. Anything that resolves later from an in-flight connect
  // sees a generation that no longer exists and returns 'cancelled'.
  A.teardown = function () {
    const was = A.state;
    if (A.state !== 'idle') A.disconnect();
    A.stopWatching();
    return 'teardown from ' + was;
  };

  // --- stylesheet gating (fail-closed) ---------------------------------------
  // The control is position:fixed only because page.css says so. Until that
  // stylesheet is applied, an in-flow element added to the body grows the page by
  // its own height, which is exactly the browser scrollbar that cut the taskbar
  // off in an earlier build. So the control starts life with the hidden attribute
  // and is revealed by the link's load event. If the stylesheet cannot load
  // (cssState=failed) the control stays hidden: a control that is invisible is a
  // degraded feature, a control that reflows the viewport is a broken desktop.
  // Revealing removes an attribute - never a style value write - which is also
  // the CSP-safe direction under style-src 'self'.
  function gate(el) {
    if (A.opts.cssGate === false) return;
    el.hidden = true;
    el.setAttribute('data-wdev-css', 'loading');
    // Invisible means it must also leave the a11y tree: a screen reader calling
    // the control would fire something the user can never see. The tab order
    // needs no extra work - the hidden attribute already removes an element from
    // sequential focus navigation, and writing tabindex here would clobber the
    // author's value on a preset element. reveal('ok') lifts the aria-hidden.
    el.setAttribute('aria-hidden', 'true');
  }
  function reveal(el, state) {
    // Fail-closed is terminal: an error event that is later followed by a load
    // (offline cache, abort-then-retry) must not reopen a gate that already
    // proved it cannot apply the stylesheet.
    if (A.cssState === 'failed') return;
    A.cssState = state;
    if (!el) return;
    el.setAttribute('data-wdev-css', state);
    if (state === 'ok') {
      el.hidden = false;
      if (A.opts.cssGate !== false) el.removeAttribute('hidden');
      el.removeAttribute('aria-hidden');
    }
  }
  function ensureStyle(el) {
    const url = A.opts.cssUrl;
    if (!url) { reveal(el, 'ok'); return; }
    const links = document.querySelectorAll('link[rel~="stylesheet"]');
    for (const l of links) {
      if (String(l.href).indexOf(url) >= 0) {
        // Already linked by the host page: the sheet is applied asynchronously,
        // so success is proven by sheet.cssRules becoming readable.
        // The read is wrapped because cssRules throws SecurityError for a
        // cross-origin sheet (an operator can point the href at a CDN). A sheet
        // we cannot inspect is treated as not-yet-proven and falls back to the
        // load event, which is the safe direction: the control stays gated a few
        // ms longer. A throwing probe must never escape into boot().
        let ready = false;
        try {
          ready = !!(l.sheet && l.sheet.cssRules && l.sheet.cssRules.length > 0);
        } catch (e) {
          note('cssRules unreadable: ' + (e && e.name || '') + ' ' + (e && e.message || e));
          ready = false;
        }
        reveal(el, ready ? 'ok' : 'loading');
        if (!ready) l.addEventListener('load', () => reveal(el, 'ok'));
        return;
      }
    }
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    l.addEventListener('load', () => { reveal(el, 'ok'); note('css ok ' + url); });
    l.addEventListener('error', () => { reveal(el, 'failed'); note('css failed ' + url); });
    document.head.appendChild(l);
    if (A.cssState === 'none') A.cssState = 'loading';
  }

  async function activate(el) {
    if (A.state === 'playing') { A.disconnect(); render(); return; }
    // Re-entrant clicks during the connect handshake would build a second player
    // and destroy the first one mid-handshake; the pending one already covers it.
    if (A.state === 'loading') return;
    A.state = 'loading';
    render();
    try { await A.connect(); } catch (e) { /* state and title carry the reason */ }
    render();
    // KasmVNC routes keystrokes through #noVNC_keyboardinput; a focused control
    // would swallow the next key press, so focus goes back to the page.
    try { el.blur(); } catch (e) {}
  }

  function wire(el) {
    if (el.__wdevAudioWired) { BTN = el; render(); return; }
    el.__wdevAudioWired = true;
    BTN = el;
    gate(el);
    el.setAttribute('data-wdev-audio', el.getAttribute('data-wdev-audio') || '');
    // A <div> preset has to be made into a real button for assistive tech and for
    // the keyboard; a <button> gets all of this natively.
    if (el.tagName !== 'BUTTON' && el.tagName !== 'INPUT') {
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    }
    render();
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); activate(el); });
    el.addEventListener('keydown', (e) => {
      if (el.tagName === 'BUTTON') return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); activate(el); }
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    ensureStyle(el);
    watchLayout();
  }
  A.wire = wire;

  function boot() {
    const preset = document.querySelector('[data-wdev-audio], #wdev-audio-btn');
    if (preset) { wire(preset); return; }
    if (!A.opts.autoButton) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'wdev-audio-btn';
    b.setAttribute('data-wdev-audio', '');
    // gate() in wire() is what sets aria-hidden/tabindex; boot() only marks the
    // element as not-yet-styled so a stylesheet-gated page cannot flash it.
    b.setAttribute('data-wdev-css', 'pending');
    // Appended, not inserted at body.firstChild: the control is position:fixed with
    // margin 0, so flow order is irrelevant and appending keeps it after the client's
    // own stacking contexts (the Kasm control bar), where page.css lifts it by z-index.
    document.body.appendChild(b);
    wire(b);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
