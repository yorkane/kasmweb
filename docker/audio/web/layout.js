// wtib layout.js — 页面布局层的"体检探针"（只读，不改 Kasm 任何设置）。
//
// 分工（本层刻意保持被动）：
//  - 整页 100% 布局 = layout.css 独立承担（html/body 无滚动条 +
//    #noVNC_container 铺满视口 + 注入件脱离文档流）。
//  - 音频按钮的最终摆位 = 音频层 page.css / audio.js（本层不抢设计，
//    layout.css 里的 #wdev-audio-btn{position:fixed} 是布局地板，
//    不是按钮样式定义）。
//  - 显示缩放模式 = 用户在 Kasm 控制栏 / URL ?resize= 里选（Kasm 原生语义）。
//    本脚本不写 localStorage、不调 UI.forceSetting、不轮询覆盖用户设置。
//
// 本脚本只提供几何取证 API，给驱动脚本判定"有没有浏览器滚动条 /
// 画面是否被裁 / 底部任务栏带是否在视口内"，作为决策依据：
//   window.__wdevLayout.info()      全量几何 + 审计结论
//   window.__wdevLayout.audit()     只返回审计判定（滚动条、裁切、任务栏带）
//   window.__wdevLayout.explain(x,y) 页面坐标 → 远端帧缓冲坐标（与 Kasm 同式）
//
// Kasm 内部结构（1.3.3，取证见 doc 报告）：
//   #noVNC_container > div(display:flex;overflow:auto) > canvas(style.width/height=px)
//   鼠标：_handleMouse → clientToElement(clientX, clientY, canvas) 用 getBoundingClientRect
//   ⇒ 取点公式与 explain() 一致，坐标随 rect 走，DOM 覆盖层不污染取点。
'use strict';
(function () {
  var L = {
    version: '1',
    mode: 'passive',
    notes: []
  };
  window.__wdevLayout = L;

  function canvasEl() {
    var c = document.querySelector('#noVNC_container canvas');
    return c && c.tagName === 'CANVAS' ? c : null;
  }

  function geom() {
    var c = canvasEl();
    var o = {
      vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
      docScrollH: document.documentElement.scrollHeight,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      docClientH: document.documentElement.clientHeight,
      scrollbarY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      scrollbarX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      container: null, canvas: null,
      kasmResize: null,
      clipViewport: null, scaleViewport: null, resizeSession: null
    };
    // 只读取（不写入）Kasm 的连接状态，用于给审计结论标注当前缩放语义。
    var UI = window.UI;
    if (UI) {
      try { o.kasmResize = UI.getSetting ? UI.getSetting('resize') : null; } catch (e) { o.kasmResize = 'n/a'; }
      var r = UI.rfb;
      if (r) {
        o.clipViewport = !!r.clipViewport;
        o.scaleViewport = !!r.scaleViewport;
        o.resizeSession = !!r.resizeSession;
      }
    }
    var box = document.getElementById('noVNC_container');
    if (box) {
      var b = box.getBoundingClientRect();
      o.container = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                      scrollH: box.scrollHeight, scrollT: box.scrollTop };
    }
    if (c) {
      var q = c.getBoundingClientRect();
      var cs = getComputedStyle(c);
      o.canvas = {
        x: Math.round(q.x), y: Math.round(q.y),
        w: Math.round(q.width), h: Math.round(q.height),
        right: Math.round(q.right), bottom: Math.round(q.bottom),
        fbW: c.width, fbH: c.height,
        styleW: cs.width, styleH: cs.height,
        scaleX: c.width ? +(q.width / c.width).toFixed(6) : 0,
        scaleY: c.height ? +(q.height / c.height).toFixed(6) : 0
      };
    }
    return o;
  }
  L.geom = geom;

  // 审计：判"内容完整可见"而不是"看不见滚动条"。
  // overflow:hidden 只藏条不藏裁切，所以这里全部按几何判定：
  //   scrollbar  = html 的 scroll/client 差（CSS 外壳生效时应恒为 0）
  //   containerFit = #noVNC_container 四边 == 视口（顶 0、底 vh）
  //   canvasFit  = canvas 完整落在视口内（等比缩放模式的硬判据）
  //   clipped    = canvas 超出视口 ⇒ 存在被裁内容（off / 小窗非等比时正常出现，
  //                由 Kasm 内部滚动容器 #noVNC_container 的子孙 div 承担）
  L.audit = function (opts) {
    opts = opts || {};
    var g = geom();
    var a = {
      pass: true,
      scrollbarY: g.scrollbarY,
      scrollbarX: g.scrollbarX,
      containerFit: !!g.container && g.container.x === 0 && g.container.y === 0 &&
                    g.container.w === g.vw && g.container.h === g.vh,
      canvasVisible: null,
      canvasClipped: null,
      taskbarBand: null,
      kasmResize: g.kasmResize,
      geom: g
    };
    if (g.canvas) {
      a.canvasVisible = g.canvas.x >= 0 && g.canvas.y >= 0 &&
                        g.canvas.right <= g.vw && g.canvas.bottom <= g.vh;
      a.canvasClipped = !a.canvasVisible;
      if (opts.band) {
        // 远端 tint2 任务栏带（帧缓冲底部 band px）是否整条在视口内
        var bandTopFb = g.canvas.fbH - opts.band;
        var bandTopCss = g.canvas.y + bandTopFb * (g.canvas.h / g.canvas.fbH);
        a.taskbarBand = {
          bandCssTop: Math.round(bandTopCss),
          bandCssH: Math.round(opts.band * (g.canvas.h / g.canvas.fbH)),
          fullyVisible: bandTopCss >= 0 && (bandTopCss + opts.band * (g.canvas.h / g.canvas.fbH)) <= g.vh + 0.5
        };
      }
    }
    var fails = [];
    if (a.scrollbarY > 0) fails.push('browser-vertical-scrollbar');
    if (a.scrollbarX > 0) fails.push('browser-horizontal-scrollbar');
    if (!a.containerFit) fails.push('container-not-viewport');
    if (a.canvasClipped === true) fails.push('canvas-clipped');
    if (opts.band && a.taskbarBand && !a.taskbarBand.fullyVisible) fails.push('taskbar-band-clipped');
    a.fails = fails;
    a.pass = fails.length === 0;
    return a;
  };

  // 页面坐标 → 远端帧缓冲坐标，取点公式与 Kasm clientToElement 一致，
  // 供驱动脚本证明"点击位置 == 显示位置"。
  L.explain = function (px, py) {
    var c = canvasEl();
    if (!c) return null;
    var q = c.getBoundingClientRect();
    var lx, ly;
    if (px < q.left) lx = 0;
    else if (px >= q.right) lx = q.width - 1;
    else lx = px - q.left;
    if (py < q.top) ly = 0;
    else if (py >= q.bottom) ly = q.height - 1;
    else ly = py - q.top;
    return {
      fbX: Math.floor(lx / (q.width / c.width)),
      fbY: Math.floor(ly / (q.height / c.height)),
      fbW: c.width, fbH: c.height
    };
  };
  L.info = function () {
    return { version: L.version, mode: L.mode, notes: L.notes.slice(), geom: geom(), audit: L.audit() };
  };
})();
