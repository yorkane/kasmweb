# kasmweb

`ghcr.io/yorkane/kasmweb` — KasmVNC 桌面容器 + loopback 单入口转发器 + 宿主应用接入

![image](https://img.shields.io/badge/image-ghcr.io%2Fyorkane%2Fkasmweb-2496ED?style=flat-square&logo=docker)
![base](https://img.shields.io/badge/base-baseimage--kasmvnc%3Aalpine317-1c1712?style=flat-square)
![entry](https://img.shields.io/badge/entry-127.0.0.1%3A25320-8ab4f8?style=flat-square)
![license](https://img.shields.io/badge/license-Apache--2.0-4c4c4c?style=flat-square)

一句话：把一台宿主机上的应用（官方入口 = Chrome）以浏览器里的远程桌面形式开放出来 ——
单镜像自包含、单端口入口、认证交给上游网关。

浏览器有两条**互相独立、可同时运行**的通道：宿主桥 Chrome（manager 经 `launch.sock` 在宿主侧
拉起）与容器内 Chromium 112（apk `chromium`，桌面第二个图标直接起容器内进程，不需要 manager、
不需要宿主 Chrome；细节见 deploy.md §6.5）。

## 能力

- **单镜像**：基座 `ghcr.io/linuxserver/baseimage-kasmvnc:alpine317` 按 digest 钉死，内含
  KasmVNC 1.1.0 Xvnc + Openbox + tint2 + pcmanfm + PulseAudio + nginx + 音频 relay + s6 服务图。
  **默认字体 = Noto Sans CJK SC**（镜像内 fontconfig 策略钉死 sans / serif / monospace，
  中文渲染不再是日文字形或方块；deploy.md §7.1）。
- **单入口**：dispatcher 只监听 `127.0.0.1:25320`，按 registry 路由到 `127.0.0.1:25321..25329`；
  `GET /?desktop=<id>` → 302 root-relative 规范 URL（Location 不拼 origin）。
- **画面通道**：容器内 nginx `:3000` → Xvnc 内置 httpd `127.0.0.1:6901` 的 `/websockify`；
  Xvnc 监听面收到只剩 loopback（`-interface 127.0.0.1 -rfbport 0 -nolisten tcp`）。
- **桌面两个官方图标 = Chrome + Chrome（容器内）**（两者都用 Chromium 官方 product logo）。
  `Chrome.desktop` = 宿主应用接入机制的入口示例：接别的应用按同一 `launch.sock` 协议加一个
  `.desktop` 即可。`Chrome-Local.desktop` = **容器内浏览器**通道：
  `Exec=/opt/wtk/bin/wtk-chrome-local` 直接 `exec /usr/bin/chromium-browser --no-sandbox`，不走
  `launch.sock`、不接任何外部输入，与宿主桥同 `DISPLAY=:1` ⇒ 两窗可并存。门禁把
  `/defaults/desktop` 断成恰好该二件集合（多一个少一个都 FAIL），`chromium` 二进制按
  `^Chromium 112.` 逐字断版本，并跑一次真 headless 渲染 smoke（`--dump-dom about:blank`）。
- **最简任务栏** = tint2 单面板 `panel_size = 100% 30` + `panel_items = TC`
  （任务列表 + 时钟；无 launcher、无托盘，出现 `systray_` / `launcher_` 键即构建 FAIL）。
- **默认打开器 = Sublime Text 4（build 4200，钉版钉 sha）**：.deb 纯 python 解包（镜像无 ar/dpkg）+
  7 字节注册补丁（唯一命中 @0x5b6283 强绑定）落 `/opt/sublime_text`；系统级
  `/etc/xdg/mimeapps.list` 把 13 个文本类类型（text/plain、json、shellscript、c、python、md、yaml、
  xml、js、css、html）默认指到 `sublime_text.desktop`，pcmanfm 双击文本文件直接进编辑器；
  desktop 文件 MimeType 行同步扩到同集合（libfm Open With 需要）。**不给 Sublime 桌面图标**
  （`/defaults/desktop` 门禁保持恰好 2 件）——它的角色是双击背后的默认打开器。gcompat 兼容层
  承载 glibc 二进制；许可通道与已知限制见 deploy.md §7.2。
- **页面默认（KasmVNC 客户端）**：打开桌面即 **IME Input Mode 已开启**、控制栏弹出把手默认停靠
  **屏幕右侧**；由注入的 `wtk-boot.js` 对 `enable_ime` / `controlbar_pos` 做 seed-once 预置
  （用户在 Settings 里的开关 / 拖动把手的显式选择永远优先；构建门禁逐字断言，deploy.md §7.3）。
- **最简音频** = 容器内 PulseAudio（app-share socket）→ ffmpeg MP2 → node relay →
  浏览器 jsmpeg，全链路无额外组件、无麦克风通道。
- **分辨率不固定**：`-geometry` 只是启动初值（取 `WTK_WIDTH` / `WTK_HEIGHT`，
  manager 注入 1600x900@30）；`resize=scale` 等比缩放显示、`resize=remote` 才真改分辨率；
  **不承诺「URL 无参即随 iframe 自适应」**。
- **纪律**：`restart: unless-stopped`；manager 零 pkill、零 `docker rm`、删除一律归档进
  `/data/.trash`；进程 kill 走 pid+comm+exe+starttime 四元组台账；每桌私有 Chrome profile。
- **可观测**：dispatcher `GET /healthz` → `ok desktops=<N>`；容器 `HEALTHCHECK` 十二门；
  manager `verify` 12 项 plumbing（`guiVerified=false` 是中性字段，工具永不自证 4 级）。

## 快速开始

```bash
# 1) 拉镜像
docker pull ghcr.io/yorkane/kasmweb:latest   # 已发布标签 latest / main / v0.2.0 / 0.2.0 / 0.2 / 2
# 2) 起桌面（最小 compose 见 deploy.md §3：三个 bind + loopback 发布 127.0.0.1:25322:3000）
docker compose -f compose.yaml up -d --pull never
# 3) 验入口（200 = backend ready，与 dispatcher 判 running 的同一判据）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25322/
```

宿主 Chrome 接入（§6）、dispatcher 单入口（§3 末）、多桌 manager（§5）、
音频启用与故障判据（§8）都在部署文档里。

## 文档导航

**[deploy.md](deploy.md)** 是本仓库唯一的部署与验收文档（细节只在它里面，本文不重复）：

| 章节 | 内容 |
|---|---|
| §1 | 定位与边界（与 Kasm / KasmVNC / Selkies 的关系；**不含 wdev 集成**） |
| §2 | 架构与数据流（dispatcher → 桌面容器 → 宿主应用 → appshare / Pulse 音频） |
| §3 | 快速开始：最小 compose、单容器直连、dispatcher 单入口 |
| §4 | 镜像与标签、CI 发布、本机构建、基座 digest、构建门禁摘要 |
| §5 | 多桌部署：unit 安装、registry、端口池、全部环境变量清单 |
| §6 | 宿主应用接入：appshare 契约文件、`launch.sock` 协议、`.desktop` 模板、PID 台账；**§6.5 双通道（宿主桥 Chrome / 容器内 Chromium 112）** |
| §7 | 桌面与任务栏：tint2 要点、`panel_items = TC`、`clock_padding = 44 0` 的用途、**系统默认字体 = Noto CJK SC**（§7.1） |
| §8 | 音频：链路图、Pulse 凭据、relay env、启用/关闭语义、常见故障判据 |
| §9 | URL 与分辨率：302 规范参数、`resize` 三档、geometry 三种模式与 409/503 |
| §10 | 配置项速查表（env / 默认 / 作用 / `file:line` 出处） |
| §11 | 验收清单：healthz / 302 / 容器 health / 逐桌 verify / 字体解析 / 浏览器出图与任务栏点击 / 音频频谱 |
| §12 | 运维：升级、回滚（旧容器保留策略 + 人工恢复顺序）、日志位置、备份范围 |
| §13 | 已知限制与未覆盖（9 条 + 明确「非全功能验收」） |
| §14 | 许可与商标 |

## 目录结构

```text
kasmweb/
├── README.md              本文件（入口，不重复细节）
├── deploy.md              部署与验收手册（唯一细节面）
├── docker/                镜像内容层（构建上下文 = 本目录，docker/Dockerfile 为入口）
│   ├── Dockerfile         两段构建（deps -> release）+ 十一项门禁
│   ├── apk/               构建期安装包清单
│   ├── fonts/             99-kasmweb-cjk.conf（系统默认字体 = Noto CJK SC 的 fontconfig 策略）
│   ├── s6/                服务图：svc-kasmvnc / svc-de / svc-nginx / svc-pulseaudio /
│   │                      svc-wtk-audio + init-nginx / init-wtk-appshare + s6-apply.sh
│   ├── windowing/         openbox（rc.xml / autostart / menu）、tint2/tint2rc、
│   │                      desktop/{Chrome.desktop,Chrome-Local.desktop,icons,libfm.conf}、startwm.sh
│   ├── audio/             relay.js + web/（audio.js、jsmpeg、page.css、layout.css/js）
│   ├── nginx/             wtk.conf.template + render-nginx.py
│   ├── pulse/             20-wtk-app-share.pa（app-share socket + null sink）
│   ├── bin/               wtk-launch、wtk-chrome-local、wtk-xauth-seed
│   └── healthcheck.sh     容器 HEALTHCHECK 十二门
├── dispatcher/            单入口转发器（Node 标准库）
│   ├── server.js          入口：路由 + 状态裁决 + WS upgrade
│   ├── lib/               config / selector / registry / proxy / pages
│   ├── test/              7 个 .test.js（`run-dispatcher.sh test` 用）
│   └── systemd/           unit 模板 + drop-in 样例
├── manager/               宿主管理面（Python，stdlib + PyYAML）
│   ├── config.py          常量与路径契约（单一来源）
│   ├── compose.py         逐桌渲染 compose + 归属核验 + 起停
│   ├── appshare.py        appshare 契约读取 + X 归属核对
│   ├── net.py             端口锁 + socat X11 relay + backend readiness
│   ├── process.py         四元组台账与精确 kill（零 pkill）
│   ├── hostapps.py        宿主应用白名单、私有 profile、launch/focus/stop
│   ├── actions.py         init/start/stop/verify（12 项）等动作面
│   ├── registry.py        dispatcher 消费契约（8 字段发布面，原子写）
│   ├── attest.py          显式几何桌的几何实况认证
│   ├── catalog.py         opt-in 追加桌面清单的解析与校验
│   ├── daemon.py          控制 socket + 每桌 launch.sock + 周期刷新
│   └── cli.py             `wt-kasm` 子命令
├── scripts/               install-manager.sh / run-dispatcher.sh / verify-image-layout.sh / wt-kasm
├── compose/               手跑示例：docker-compose.yml（单桌）+
│                          docker-compose.desktops.example.yml（三桌拓扑）
├── LICENSE / NOTICE         Apache-2.0 全文 + 第三方声明（含图标取源与 SHA256）
└── .github/workflows/     publish.yml（ghcr 发布 + 构建后布局自检）
```

运行时落点（不在仓库内）：部署根 `/data/app/webtop-kasmvnc/`（`desktops/<id>/`、
`registry.json`、`state/`、`logs/`、`sock/`）、端口锁 `/data/tmp/webtop-channel-port-locks/`、
删除归档 `/data/.trash/`。

## 许可

Apache-2.0（全文见 `LICENSE`）。第三方声明汇总在 `NOTICE`：`jsmpeg`
（`docker/audio/web/jsmpeg.min.js`，vendored）为 MIT，许可证文本随件在
`docker/audio/web/LICENSE-jsmpeg.txt`；dispatcher 包清单自述 `license: MIT`
（`dispatcher/package.json:7`，含 vendored `ws`，NOTICE 第 5 节）；基座镜像 `ghcr.io/linuxserver/baseimage-kasmvnc`
按 digest 钉死，其内含组件（KasmVNC、Openbox、tint2、pcmanfm、PulseAudio、nginx、
s6-overlay）各遵其上游许可证，本仓库不改变其条款。

**商标**：Chromium 与 Google Chrome 的名称与商标属各自权利人（Chromium 属 Chromium
project / Google LLC，Chrome 属 Google LLC）。桌面图标用的是 Chromium 项目的**开源**
product logo（取源与 SHA256 见 `NOTICE`），仅用于标注该启动器图标：无任何商标主张，
也不隐含赞助、隶属或背书关系。

