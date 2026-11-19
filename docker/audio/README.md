# 音频层（移植自 script/webtop-image/audio/）

源 = 旧包 4 级已验候选 `script/webtop-image/audio/`（见
`doc/浏览器音频候选验证-0.1.md`）。本层只做**改名与部署适配**，
三个已验证修复逐字保留（行号 = 本目录 `relay.js` 现势，2026-11-13 复核）：

| 修复 | 位置 | 内容 |
|---|---|---|
| (i) 背压 | 203-223 注释 + `gated()` 224-226 / `trimQueue()` 229-244 / `FLUSH_MS = 100` 83 + `armFlush` 泵 279-288 | 用 `ws.bufferedAmount` + 每客户端有界队列 + 100ms 泵；`send()` 返回值与 `ws.on('drain')` 在服务端 WebSocket 上不成立，旧写法会把慢读者的会话整体拖死 |
| (ii) 生产者在 `error` 上重启 | 346-360 注释 + `MAX_RESTARTS` 369 / `scheduleProducerRestart` 373 / `noteProducerDeath` 394-410 / `child.on('error')` 450-457 | ffmpeg `spawn` 失败（`ENOENT` 等）也必须走重启调度，并有连续零音频上限；有音频则预算归零 |
| (iii) teardown 竞态 | 346-360 注释 + `startProducer` 412-419 | `producerWanted = true`（418）记录在 `if (producer) return`（419）**之前**，否则重连落在旧子进程退出窗口内会永久静音 |

复验方式（反演改名后与旧包逐行 diff）：差异只剩 8 处 hunk（归并 6 组）= 头注释 old 3 与 5 /
拓扑注释 old 36 / 白名单说明块 old 105-109 与 111-112（→ new 106-128）/ `LOOPBACK_HOST`+`hostAllowed` 插入 new 140-147 / `hostOk` 174 /
启动日志 old 560（→ new 584-586）。三修复所在区间零命中 ⇒ 逐字未动。

自检：`node --check relay.js`、`node --check web/audio.js` 通过；
`grep -n 'WDEV_\|WTIB_\|21100' relay.js web/audio.js` 零命中。

## 改名映射

| 旧 | 新 |
|---|---|
| `WDEV_AUDIO_*`（14 项） | `WTK_AUDIO_*` |
| `WTIB_PUBLIC_ORIGIN` | `WTK_PUBLIC_ORIGIN` |
| 硬编码 `21100` 的 Host/Origin 白名单 | 删除，改 loopback 通配 + 配置注入 |
| `vendor/ws/`（未移植） | 基座 a317 自带 `/kclient/node_modules/ws`（ws@8.17.1） |

对外契约名**不改**：DOM id `wdev-audio-btn`、`data-wdev-audio`、
`window.__wdevAudio` / `window.__wdevLayout`（manager 与 tester 依赖）。

## basepath 注入链（root 2026-11-13 裁决）

Kasm 页 CSP 拒 inline script，因此 base 由**外部脚本**给出：镜像内
`/opt/wtk/web/wtk-boot.js`，内容只有 `window.__WTK_BASE="/desktop/<id>/";`，
由容器 nginx 以 `<BASE>wtk-boot.js` 提供，注入顺序在 `audio.js` 之前
（该注入件属 `image/nginx/`，不在本目录）。`audio.js` 读不到 `__WTK_BASE`
时回退 `'/'`，保持根路径部署的老行为。

注入顺序（父级 nginx 的 `sub_filter` 负责，本层不生成）：

1. `<script src="<BASE>wtk-boot.js">` — 必须先于 `audio.js`
2. `<link rel="stylesheet" href="<BASE>audiojs/layout.css">` — 布局地板
3. `<script src="<BASE>audiojs/audio.js" defer>` — 本层入口

### `wsPath` 必须带前导斜杠（`web/audio.js` 60）

`WTK_WS_PATH = BASE + 'audio'`。
它**不是** Kasm `ui.js` 的 `path=` 参数（那是给 Kasm 客户端的查询串），而是本脚本
自己拼绝对 ws URL 的片段：`connect()` 用
`location.host + WS_TARGET`（`web/audio.js` 307）直接拼接，中间不补斜杠。
BASE 已保证首尾都是 `'/'`（缺省回退 `'/'`），所以：

- 有 base ⇒ `ws://127.0.0.1:25320/desktop/probe/audio`
- 无 base ⇒ `ws://127.0.0.1:25320/audio`

去掉前导斜杠（移植首版的做法）会得到 `ws://127.0.0.1:25320desktop/probe/audio`，
host 与路径粘连 ⇒ 握手直接失败。dispatcher 剥掉 `/desktop/<id>/` 前缀后，容器
nginx 看到的仍是精确 location `/audio`。

### `page.css` 与 `layout.css` 的分工（`cssUrl` 指前者）

| 件 | 承担什么 | 谁加载 |
|---|---|---|
| `web/page.css` | **几何与状态的全部消费方**：读 `--wdev-audio-bottom/right`（49-50）与 `--wdev-audio-height/width`（59-62，另有 `--wdev-audio-maxw` 90），文档区声明 `--wdev-audio-bar`（22）；显式重写 `[hidden]`（178）、逐 `data-state` 配色（124-143）、`z-index` 抬到 Kasm 控制条之上（48） | 本层 `audio.js` 的 `opts.cssUrl`（唯一样式入口，770 起 `ensureStyle` 自动注入 `<link>`） |
| `web/layout.css` | **只有布局地板**：`#wdev-audio-btn{position:fixed}`（50-52）与 `#noVNC_container` 以视口为包含块铺满（40-46），让注入件脱离文档流 | 父级 nginx 注入的 `<link>`（不属本层 opts） |

CSS 门禁是 fail-closed 的：`ensureStyle()` 在样式表证明可用之前给控件挂
`hidden` + `aria-hidden`，只有 `<link>` 的 `load` 才放行。因此 `cssUrl` 指向
哪张表不是风格问题——指向 `layout.css` 时，六个自定义属性无人消费，控件会
停在样式表兜底位置（2px/48px/26px）并随画布缩放脱位，`data-state` 配色与
`[hidden]` 规则同时失效。`layout.css` 仍需由父级注入，它保证控件在
`page.css` 到达之前不撑出浏览器滚动条。

## 离线测试（无需浏览器 / 无网络 / 不开端口）

```bash
cd script/webtop-kasmvnc/image/audio
node --check relay.js && node --check web/audio.js
node test/test-audio-offline.js           # 18 checks，全 PASS 才 exit 0
node test/test-audio-offline.js --legacy  # 反注入两个已知 bug，必须报 FAIL
```

`test/test-audio-offline.js` 用 `vm` + 假 DOM（window / document / location /
ResizeObserver / MutationObserver / 假 JSMpeg）跑真实 `web/audio.js`，
`location.host` 固定 `127.0.0.1:25320`，逐场景断言：

1. `opts.wsPath` = `/desktop/probe/audio`（有 base）/ `/audio`（无 base）
2. 交给 `JSMpeg.Player` 的 URL = `ws://127.0.0.1:25320/desktop/probe/audio` /
   `ws://127.0.0.1:25320/audio`（即 host 与路径之间确有 `/`）
3. 注入的 `<link>` href = `<BASE>audiojs/page.css`（两种 base 各一次）
4. `layout()` 把六个 `--wdev-audio-*` 自定义属性全部写进控件（证明 `page.css` 有用），
   且 `state` 到 `playing`
5. `audio.js` 的 WebSocket Proxy 仍能按 `WS_TARGET` 子串认到音频 socket
   （`binaryType=arraybuffer` + message 监听 + 计数 +1），并且**不**统计
   `/karellen/websocket` 这类同页非音频 socket
6. `teardown()` 清掉采样定时器（无计时器泄漏）

`--legacy` 模式按字面替换把两处改回旧写法（锚点缺失即抛错，禁止空跑），
用于证明上述断言真的会咬：实测 `checks=18 failures=6`（两组 `opts.wsPath`、
两组粘连 Player URL、两组 `layout.css` href），`failures>0` 时该模式 exit 1。
本测试只覆盖 URL 拼接与样式入口，**不覆盖** relay 的 Host/Origin 握手矩阵。

## relay 配置（全部 env，s6 服务不需要 shell 引号）

拓扑：browser → dispatcher :25320 →（剥 `/desktop/<id>/`）容器 nginx :3000
→ `127.0.0.1:4901`（本进程）。只监听 loopback；上游只有本容器内的
`auto_null.monitor`；HTTP 路径只有 `/audio`(ws)、`/audiojs/*`(静态)、`/healthz`。

| env | 默认 |
|---|---|
| `WTK_AUDIO_PORT` | 4901（绑定地址固定 loopback，非 loopback 值直接 exit 2） |
| `WTK_AUDIO_BIND` | 127.0.0.1 |
| `WTK_AUDIO_MONITOR` | auto_null.monitor |
| `WTK_AUDIO_SAMPLE_RATE` / `WTK_AUDIO_BITRATE` / `WTK_AUDIO_CHANNELS` | 44100 / 128k / 1 |
| `WTK_PUBLIC_ORIGIN` | 无；同时播 Host 与 WS Origin 两份白名单 |
| `WTK_AUDIO_ALLOWED_HOSTS` / `WTK_AUDIO_ALLOWED_ORIGINS` | 空（追加） |
| `WTK_AUDIO_MAX_WS` | 8 |
| `WTK_AUDIO_MAX_BUFFERED` / `MAX_QUEUED` / `MAX_DROP_BYTES` | 1MiB / 4MiB / 8MiB |
| `WTK_AUDIO_MAX_PRODUCER_RESTARTS` | 5 |
| `WTK_AUDIO_CLOSE_GRACE_MS` | 500 |
| `WTK_AUDIO_WS_MODULE` | 无；回退顺序 = 本目录 `vendor/ws` → `/kclient/node_modules/ws` |
| `WTK_AUDIO_STATIC_DIR` | `<本文件目录>/web` |
| `WTK_AUDIO_LOG` | `json`（`quiet` 静音） |
| `WTK_AUDIO_AUDIT` | /dev/null（逐事件 JSONL） |

## Host / Origin 白名单的非对称（本层唯一设计判断）

Host 接受 `^(127\.0\.0\.1|localhost)(:\d{1,5})?$` 通配 +
`WTK_PUBLIC_ORIGIN` 的 host + `WTK_AUDIO_ALLOWED_HOSTS`。逐端口枚举不可持续
（dispatcher 每桌面分配端口），而 relay 只监听 loopback，
所以任何 loopback Host 都不构成外部攻击面。
Origin 只精确匹配（CSRF 防线），**通配不适用**；未配置 `WTK_PUBLIC_ORIGIN`
时 Origin 集合为空 = 所有浏览器握手被拒（fail-closed）。

