# kasmweb 部署手册

> 仓库 = `yorkane/kasmweb`，镜像 = `ghcr.io/yorkane/kasmweb`。
> 本文所有端口 / 路径 / 环境变量 / 参数名逐条取自本仓库源码，出处按 `file:line` 标注；
> 源码里没有的东西本文不写（§13 明列未核实项）。

## 1. 这是什么 / 不是什么

**一句话**：一个自包含的 KasmVNC 桌面容器 + 一个只监听 loopback 的单入口转发器 +
一套「宿主应用接入」协议，把宿主机上的应用（官方入口 = Chrome）以浏览器里的远程桌面开放出来，
认证交给上游网关。

| 关系 | 事实 |
|---|---|
| 与 KasmVNC | 容器内的 Xvnc **就是** KasmVNC 1.1.0，来自基座镜像 `ghcr.io/linuxserver/baseimage-kasmvnc:alpine317`（按 digest 钉死，`docker/Dockerfile:40,98`；KasmVNC 版本与行为事实的取证 = 基座 digest + 外部调研件，**不随仓发布**）。本仓库不 fork、不改 KasmVNC 源码。 |
| 与 Kasm Workspaces | **不是** Kasm Workspaces。没有 Kasm 平台的 API / 用户库 / 镜像库 / 连接簿。`?desktop=` 之外的规范 URL 参数由 KasmVNC **内置 web 客户端**（noVNC 血统的 `ui.js`）消费。 |
| 与 Selkies | 无代码关系，同一问题的不同实现。 |
| 与 wdev | **本仓库是独立通道，不含 wdev 集成**。认证 / 授权由部署者自己的网关（authz、APISIX、nginx…）承担；本服务只监听 loopback、自身不判安全矩阵。 |
| 不是什么 | 不是多租户平台；不含认证；不管容器编排之外的东西；manager **不 build 也不 pull 镜像**；不做开机自愈（§13）。 |

桌面**有两个官方图标 = Chrome + Chrome（容器内）**（两者都用 Chromium 官方 product logo，
`docker/windowing/desktop/Chrome.desktop` 与 `Chrome-Local.desktop`）。构建门禁要求
`/defaults/desktop` **恰好等于该二件集合**（多一个少一个都 FAIL，`docker/Dockerfile:184-211`）。
两条浏览器通道**互不依赖、可同时运行**：

| 图标 | 通道 | Exec | 依赖 |
|---|---|---|---|
| `Chrome.desktop` | 宿主桥 | `/opt/wtk/bin/wtk-launch chrome` | manager 活着 + appshare 卷已挂 + 宿主 Chrome 就位（§6.1-§6.4） |
| `Chrome-Local.desktop` | 容器内 Chromium 112 | `/opt/wtk/bin/wtk-chrome-local` | 只依赖镜像内 apk `chromium`；manager 缺席、无宿主 Chrome 也能起（§6.5） |

宿主桥图标仍是宿主应用接入机制的入口示例：接别的应用按同一 `launch.sock` 协议加一个
`.desktop` 即可（§6）。

## 2. 架构与数据流

```text
                     浏览器（认证由上游网关完成，本仓库不含认证）
                                    |
                  部署者自己的 HTTPS 反代（authz / APISIX / nginx）
                                    |
  +-------------------------------v----------------------------------+
  | dispatcher（Node 标准库，只监听 127.0.0.1:25320）                  |
  |  GET /?desktop=<id>  --302(root-relative)-->  /desktop/<id>/?<规范参数>|
  |  /desktop/<id>/**  剥一次前缀后反代到 127.0.0.1:<登记端口 25321..25329>|
  |  只读 registry.json（写面归 manager），不写、不启停容器              |
  +----|--------------------------|--------------------------|--------+
       | HTTP 页面                | WS .../websockify         | WS .../audio
       v                          v                           v
  +--------------------------------------------------------------------------+
  | 桌面容器 wt-kasm-<id>：容器内 nginx :3000 = 唯一入口                      |
  |   /            -> Xvnc 内置 httpd 127.0.0.1:6901（注入四件，见 §8.2）|
  |   /websockify  -> 同上（KasmVNC 画面通道，精确匹配 location）              |
  |   /audio、/audiojs/*、/audio/healthz -> 音频 relay 127.0.0.1:4901          |
  | Xvnc = KasmVNC 1.1.0，DISPLAY=:1，-interface 127.0.0.1 -rfbport 0          |
  |          -nolisten tcp -AlwaysShared -DisconnectClients 0 -MaxIdleTime 0   |
  | s6: svc-kasmvnc / svc-de(openbox + tint2 + pcmanfm) / svc-nginx            |
  |     svc-pulseaudio / svc-wtk-audio + init-nginx / init-wtk-appshare        |
  +----|-------------------------------------------|----------------------------+
       | bind mount                                 | Pulse null sink
  /tmp/.X11-unix  <- <APP_ROOT>/desktops/<id>/runtime/x11   auto_null.monitor
  /run/wt-kasm-app<- <APP_ROOT>/desktops/<id>/runtime/appshare        |
  /config         <- <APP_ROOT>/desktops/<id>/config                 v
       |                                       ffmpeg(MP2) -> node relay :4901
       v                                                (回到上面的 /audio)
  宿主 manager daemon（Unix socket 控制面 + 每桌 launch.sock 图标面）
    - 收到 {"action":"launch","appId":"chrome"} 后在**宿主侧**拉起 Chrome：
      DISPLAY=127.0.0.1:<310|311|312>，私有 HOME/profile，X/Pulse 凭据取 appshare
    - 每桌一条 X11 relay：socat TCP-LISTEN 127.0.0.1:<6310..6312>,fork -> UNIX:.../x11/X1
    - 事件后与每 30s 刷新 registry.json  <- dispatcher 只读它路由
```

三个要点：**画面与音频是两条独立通道**；**桌面内的应用进程不在容器里**（Chrome 由宿主提供，
经 appshare 的 X 与 Pulse 凭据接入该桌显示）；**dispatcher 与 manager 分工**
（前者只读路由、后者写 registry 与拉起一切）。

## 3. 快速开始（最小路径）

单桌面直接跑容器；要多桌统一入口与规范参数注入再叠 dispatcher（§5）。
镜像内只有 `EXPOSE 3000`（`docker/Dockerfile:490`），6901 / 4901 只绑容器 loopback。

```bash
# 0) 仓库里已有两份可直接改用的示例：
#    compose/docker-compose.yml                  单桌（手跑等价物）
#    compose/docker-compose.desktops.example.yml 三桌拓扑（manager 自动化的形状）

# 1) 拉镜像
docker pull ghcr.io/yorkane/kasmweb:latest

# 2) 建目录（三个 bind 的宿主侧）
D=/data/app/kasmweb/desktops/chrome-1
mkdir -p "$D/runtime/x11" "$D/runtime/appshare" "$D/config"

# 3) 写 compose（字段与 manager 渲染面逐字一致，manager/compose.py:50-73）
cat > "$D/compose.yaml" <<'YAML'
name: wt-kasm-chrome-1-v012
services:
  desktop:
    image: ghcr.io/yorkane/kasmweb:latest
    container_name: wt-kasm-chrome-1
    hostname: wt-kasm-chrome-1
    restart: unless-stopped
    network_mode: bridge
    shm_size: 1g
    ports: ["127.0.0.1:25322:3000"]
    tmpfs: ["/tmp"]
    environment:
      WTK_DESKTOP_ID: chrome-1
      WTK_BASE_PATH: /desktop/chrome-1/
      WTK_WIDTH: "1600"
      WTK_HEIGHT: "900"
      WTK_FRAMERATE: "30"
      WTK_PUBLIC_ORIGIN: http://127.0.0.1:25320
      PUID: "1000"
      PGID: "1000"
      DISPLAY: ":1"
      START_DOCKER: "false"
    volumes:
      - ./runtime/x11:/tmp/.X11-unix
      - ./runtime/appshare:/run/wt-kasm-app
      - ./config:/config
    labels:
（本节 `D=/data/app/kasmweb/...` = 手跑示例目录；生产与 manager 现势根 = `/data/app/webtop-kasmvnc`，见 §5.1。）

      wt-kasm.managed: "true"
      wt-kasm.route: webtop-kasmvnc
      wt-kasm.desktop: chrome-1
YAML

# 4) 起容器并验入口（200 = backend ready，与 manager 判 running 的同一判据）
cd "$D" && docker compose up -d --pull never
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25322/

# 5) 容器健康（docker 记账的 HEALTHCHECK，十二门，见 §11）
docker inspect -f '{{.State.Health.Status}}' wt-kasm-chrome-1
```

`labels.wt-kasm.route` 的值 = `manager/config.py:14` 的 `PRODUCT = "webtop-kasmvnc"`；
容器名前缀 = `CONTAINER_PREFIX = "wt-kasm-"`（`config.py:233`）。
**单容器直连（不挂 dispatcher）**就是产品契约里的「直接暴露容器 3000」形态：
`compose/docker-compose.yml` 把容器 `:3000` 直接发布到 `127.0.0.1:25320`，
并设 `WTK_BASE_PATH: /`（页面前缀为空），`WTK_PUBLIC_ORIGIN` 与发布 origin 同值即可。
注入件的 base 由 `WTK_BASE_PATH` 决定（`docker/nginx/render-nginx.py:59-62,69-71,80`）：
文法 = `/` 后接零个或多个 `[A-Za-z0-9._-]` 段、每段以 `/` 结尾 ⇒ `/`（单容器根部署）
与 `/desktop/<id>/`（dispatcher 多桌挂载）**两种形态都支持**；非法形态与含 `..` 的穿越段
显式拒绝（exit 2，fail-closed）。构建门禁对两种形态各渲染一次 vhost 并分别 `nginx -t`，
全过才放行（`Dockerfile:314-342`）——旧文法拒 `/` 导致根部署起不来的缺陷已修复并进门禁。

（本节 `D=/data/app/kasmweb/...` = 手跑示例目录；生产与 manager 现势根 = `/data/app/webtop-kasmvnc`，见 §5.1。）

加 dispatcher 单入口（选择页 + 规范参数注入 + 音频 Host/Origin 适配）：

```bash
cd kasmweb/dispatcher
WTK_LISTEN_HOST=127.0.0.1 WTK_PORT=25320 \
WTK_REGISTRY=/data/app/kasmweb/registry.json \
WTK_PUBLIC_ORIGIN=http://127.0.0.1:25320 node server.js &

cat > /data/app/kasmweb/registry.json <<'JSON'
{"schemaVersion":1,"publicOrigin":"http://127.0.0.1:25320",
 "desktops":[{"id":"chrome-1","name":"Chrome 1","port":25322,"state":"running",
 "container":"wt-kasm-chrome-1","containerId":"","generation":"","appId":"chrome"}]}
JSON

curl -s http://127.0.0.1:25320/healthz                       # 期望 ok desktops=1
curl -s -o /dev/null -D - 'http://127.0.0.1:25320/?desktop=chrome-1' | sed -n '1,6p'
```

桌面图标（§6）有两条通道：`Chrome`（宿主桥）**不是**起容器就可用——需要 manager 与宿主 Chrome
就位；`Chrome（容器内）` 起容器即可双击使用（不经 manager、不需要宿主 Chrome）。音频（§8）
需要在浏览器里点音频按钮（用户手势门）。

## 4. 镜像与标签

| 项 | 值 | 出处 |
|---|---|---|
| 镜像 | `ghcr.io/yorkane/kasmweb:<tag>` | 产品契约 |
| 发布流水线 | `.github/workflows/publish.yml`：tag `v*` → semver 三档 + tag + sha；`main` → `latest` / `main` / `sha`（HEAD 已打 tag 时跳过分支构建）；`workflow_dispatch` → 自定义 tag | `publish.yml:17-28,48-61` |
| 构建上下文 | `./docker`，Dockerfile = `./docker/Dockerfile`，构建后 `load: true` 供自检 | `publish.yml:90-101` |
| 构建后自检 | `bash scripts/verify-image-layout.sh <tag>`（离线 `docker save` + tar 解包，**不 run 不 create**）十三项自检：桌面二件集合 + 两个 `Exec` 逐字 + 容器内启动器可执行 + `/usr/bin/chromium-browser` 存在 + tint2 + svc argv + healthcheck 门 + jsmpeg + 图标 PNG | `publish.yml:106-115`，`scripts/verify-image-layout.sh:1-36` |
| 两段构建 | `FROM <base> AS deps`（apk 层）+ `FROM deps AS release`（内容层） | `docker/Dockerfile:42,84` |
| 基座（钉 digest） | `ghcr.io/linuxserver/baseimage-kasmvnc@sha256:e67ff31da12e6908fc6acbeaba499f9339794b1b622bcb2d945286a7257b755d`，LABEL 记 name=`:alpine317` | `docker/Dockerfile:40,97-98` |
| 版本标签 | `ARG WTK_VERSION=0.1.0`（两段共用） | `docker/Dockerfile:43,85` |
| 暴露端口 | `EXPOSE 3000`（仅此一个） | `docker/Dockerfile:490` |
| HEALTHCHECK | `--interval=20s --timeout=30s --start-period=60s --retries=6` → `/opt/wtk/bin/healthcheck.sh` | `docker/Dockerfile:496-497` |

本机构建（CI 会 `--pull` 基座 digest；离线开发机把 `WTK_BASE` 指到本地别名 tag）：

```bash
cd kasmweb
docker build -f docker/Dockerfile --build-arg WTK_VERSION=0.1.0 \
  -t ghcr.io/yorkane/kasmweb:latest docker
# 离线机（基座已按精确 ID 打好本地别名 tag 时）：
docker build -f docker/Dockerfile \
  --build-arg WTK_BASE=webtop-kasmvnc-base:alpine317-527bb89e --pull=false \
  -t kasmweb:local docker
bash scripts/verify-image-layout.sh ghcr.io/yorkane/kasmweb:latest   # 十三项布局自检
```

已发布标签 = `latest` / `v0.1.0` / `0.1.0`；后续重建会重推同名标签，digest 以 CI 实际产出为准。

构建门禁摘要（`docker/Dockerfile`，任一不过即构建失败）：

1. **仓库源钉文件**：Alpine v3.17 已 EOL，`/etc/apk/repositories` 写死
   `dl-cdn.alpinelinux.org` 的 v3.17 main + community，两个 `APKINDEX.tar.gz` 先 `--spider`
   探测，不可达即 `exit 3`，**不回落镜像站**（`Dockerfile:55-63`）。
2. **native 几何门禁**：`svc-kasmvnc/run` 与 `healthcheck.sh` 按 sha256 自锁
   （`WTK_NATIVE_SVC_SHA256` / `WTK_NATIVE_HC_SHA256`，`Dockerfile:91-92`），
   且 argv 里 `-AcceptSetDesktopSize` 出现次数**必须为 0**（`Dockerfile:165-166`）。
3. **桌面图标门禁**：`/defaults/desktop` 的条目**恰好等于集合** {`Chrome.desktop`,
   `Chrome-Local.desktop`}（数量 = 2 且逐名比对，多一个少一个都 FAIL）；两个条目的 `Exec`
   分别逐字断言（`Chrome` → `/opt/wtk/bin/wtk-launch chrome` 前缀；`Chrome-Local` →
   `/opt/wtk/bin/wtk-chrome-local`），mode 逐字 = 755，`Icon=` 指向的文件存在且是 PNG，
   `/opt/wtk/bin/wtk-chrome-local` 必须存在且可执行（`Dockerfile:184-211`）。
4. **autostart / 菜单门禁**：播种清单逐字 = `for f in Chrome Chrome-Local; do`，且强制
   `chmod 0755 "$HOME/Desktop/Chrome.desktop" "$HOME/Desktop/Chrome-Local.desktop"`；
   `/defaults/menu.xml` 必须含 `<command>/opt/wtk/bin/wtk-chrome-local</command>`
   （两条浏览器通道在右键菜单与桌面同源）；出现 `cp -n` 播种或 `VCMI` 残留 = FAIL
   （`Dockerfile:249-255`）。
5. **任务栏门禁**：`panel_items` 必须逐字 = `TC`、`clock_padding = 44 0`、
   `panel_size = 100% 30`、`panel_window_name = wtk-taskbar`、
   `rc.xml` 保留 `wtk-taskbar` 匹配；出现 `systray_` / `launcher_` 键 = FAIL（`Dockerfile:258-267`）。
6. **libfm quick_exec 合并**：只把注入键合进基座 `[config]`，基座键与 section 数逐字保留，
   原件 `mv` 归档（零 rm）（`Dockerfile:224-248`）。
7. **vhost 门禁**：对 `/desktop/demo/` 与 `/` 两种 base 形态**各渲染一次** vhost 并分别
   `nginx -t`，被拒即 FAIL（`Dockerfile:314-342`）。
8. **s6 图门禁**：`s6-apply.sh` 归档式摘除 `svc-kclient` / `svc-docker` /
   `init-mods-package-install` 并改写边，随后逐边断言 + 悬空边审计 + `s6-rc-compile` RC=0 +
   编译图服务数 ≥ 20 + 保留 `/kclient/node_modules/ws`（音频 relay 的 ws 回退依赖）
   （`Dockerfile:350-379`）。
9. **CJK 字体门禁**：`/etc/fonts/conf.d/99-kasmweb-cjk.conf` 必须存在且权限 `644`；
   `fc-list` 必须暴露 `Noto Sans CJK SC`；四条 `fc-match -f '%{family[0]}'` 断言**逐字**命中
   `sans-serif:lang=zh-cn` → `Noto Sans CJK SC`、`sans-serif` → `Noto Sans CJK SC`、
   `serif` → `Noto Serif CJK SC`、`monospace` → `Noto Sans Mono CJK SC`，另加 DejaVu
   负例（zh-cn 落 DejaVu 族即 FAIL）。任一失配 = 构建失败，JP/KR/TC/DejaVu 兜底
   在构建期就出局，不留到桌面（`Dockerfile:390-420`）。策略文件本体见 §7.1。
10. **容器内浏览器门禁（Chrome-Local 通道）**：`command -v chromium-browser` 必须命中；
    `chromium-browser --version` 首行逐字匹配 `^Chromium 112\.`（钉 Alpine 3.17 community 的
    112.0.5615.165-r0）；并跑一次**真 headless smoke**：`chromium-browser --headless=new
    --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=<residue>/...
    --dump-dom about:blank` 退出 0 且输出含 `<html`。版本串只证明装上了，smoke 才证明
    它能渲染（缺库 / sandbox / 字体配置洞都会在这里出局）。构建环境无 X 无 GPU、
    `/dev/shm` 仅 64MB ⇒ headless=new + `--disable-gpu` + `--disable-dev-shm-usage`。
    **硬门禁，未降级**（`Dockerfile:454-469`）。
11. **零 rm 纪律**：门禁止物进 `/opt/wtk-build-residue` 保留，`/var/cache/apk` 不清理。

镜像内容层的完整 COPY 落位表由镜像侧文档维护（`docker/` 树 = 镜像内容层（CI 构建上下文即
本目录），落位见 `Dockerfile:102-128`）。

## 5. 多桌部署（manager + dispatcher）

### 5.1 目录与端口契约

| 项 | 值 | 出处 |
|---|---|---|
| app root | `/data/app/webtop-kasmvnc`（`WT_KASM_APP_ROOT` 覆盖，去尾斜杠） | `manager/config.py:15` |
| 桌面目录 | `<APP_ROOT>/desktops/<id>/{runtime/x11,runtime/appshare,config,apps}` | `config.py:16,753-778` |
| 消费契约 | `<APP_ROOT>/registry.json` | `config.py:17` |
| 状态台账 | `<APP_ROOT>/state/`（`daemon.pid`、`<desk>/relay.pid`、`<desk>/app-<app>.pid`、`<desk>/desktop.cid`） | `config.py:18,781-790` |
| 日志 | `<APP_ROOT>/logs/`（`daemon.log`、`relay-<desk>.log`、`app-<desk>-<app>.log`、`dispatcher.stderr.log`） | `config.py:19`，`manager/net.py:227`，`hostapps.py:108`，`scripts/run-dispatcher.sh:53` |
| 控制 socket | `<APP_ROOT>/sock/control.sock`（CLI ↔ daemon，**不挂进容器**） | `config.py:20-21`，`daemon.py:3` |
| 端口锁目录 | `/data/tmp/webtop-channel-port-locks`（跨通道共享，不可覆盖） | `config.py:27` |
| 删除归档根 | `/data/.trash`（`WT_KASM_TRASH` 覆盖） | `config.py:26` |
| dispatcher 入口 | `127.0.0.1:25320` | `dispatcher/lib/config.js:40-41` |
| 后端端口池 | 闭区间 `25321..25329` | `config.js:44-45,125-126,148` |
| 容器内入口 | `:3000`（nginx） | `config.py:599` |
| 容器内 X 显示 | `:1` ⇒ 宿主 bind 目录里的 socket 文件名是 **`X1`** | `config.py:596`，`appshare.py:38` |
| 宿主 relay 显示号 | `127.0.0.1:<310|311|312>` == `relay_port - 6000` | `config.py:598,793-794` |

基础三桌注册表（`config.py:701-705`，参数序 = id / 显示名 / backend 端口 / relay 端口 /
宿主显示号 / 默认 app）：

| desktop id | 显示名 | backend | relay | 宿主显示 | 默认 app |
|---|---|---|---|---|---|
| `vcmi` | VCMI | 25321 | 6310 | :310 | vcmi |
| `chrome-1` | Chrome 1 | 25322 | 6311 | :311 | chrome |
| `chrome-2` | Chrome 2 | 25323 | 6312 | :312 | chrome |

追加桌面走 opt-in 清单 `WT_KASM_CATALOG_FILE`（只**追加**，不改三桌基线；
相对路径 / 软链 / 超 64KB / 坏 JSON / schema 不符全拒，`config.py:802-855,931-946`）。


### 5.2 安装 manager

```bash
cd kasmweb
bash scripts/install-manager.sh                      # 默认 user 模式（uid 1000）
WT_KASM_INSTALL_MODE=root bash scripts/install-manager.sh   # /etc/systemd/system/，需免密 sudo
```

它做六件事（`scripts/install-manager.sh:42-125`）：建骨架（app root 与端口锁目录
`chmod 770` 并复核权限位）→ 写 systemd unit → 等 daemon 登记 pidfile（≤30 次轮询）→
调 `init`（写 compose + registry，**不启动容器**）→ 核镜像门禁（**绝不 build / pull**）→ 打印落点。

unit 关键项（`install-manager.sh:54-79`）：`KillMode=process`（daemon 是 relay / chrome / vcmi
的父进程，默认 `control-group` 会让 manager 重启连带杀掉活性桌面应用）、`Restart=on-failure`、
`UMask=0027`，并把 `WT_KASM_APP_ROOT / WT_KASM_PUID / WT_KASM_PGID / WT_KASM_IMAGE /
WT_KASM_PROJECT_SUFFIX` 写进 `Environment=`（`:58-61`）⇒ **重装不带 env 会把 unit 写回默认值**。

依赖命令：`docker flock socat xdotool xprop xwininfo ss dbus-run-session` + `python3`
（`install-manager.sh:22-26`，PyYAML 预检 `:27-33`）。

### 5.3 安装 dispatcher

```bash
cd kasmweb
bash scripts/run-dispatcher.sh precheck          # 只读预检：LISTEN / docker 预留 / registry 可读 / require server
bash scripts/run-dispatcher.sh install-hint      # 渲染 unit 并【只打印】安装命令
install -Dm644 /data/app/webtop-kasmvnc/dispatcher/wt-kasm-dispatcher.service.rendered \
  ~/.config/systemd/user/wt-kasm-dispatcher.service
env XDG_RUNTIME_DIR=/run/user/$(id -u) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
  systemctl --user daemon-reload
env XDG_RUNTIME_DIR=/run/user/$(id -u) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
  systemctl --user enable --now wt-kasm-dispatcher
```

`install-hint` 把模板里的 `__NODE__` / `__DISPATCHER_DIR__` 用 sed 渲染后连同渲染件放进
`<APP_ROOT>/dispatcher/`，脚本**从不自行安装**（`run-dispatcher.sh:138-151`）。
无用户总线的 shell（cron / 远程命令）里调 `systemctl --user` 必须显式给
`XDG_RUNTIME_DIR` + `DBUS_SESSION_BUS_ADDRESS`——继承来的 `disabled:` 形态会让
`is-active` 假报「服务没起」（`run-dispatcher.sh:71-75`）。

`run-dispatcher.sh` 的 `start / stop / status` 与 systemd unit **不要同时用**（两套记账面）。
`start` 的纪律：先全状态 `precheck`（本端 LISTEN + docker published 含 stopped 的逻辑预留）
→ 抢 `flock -n` 端口锁 → 真 bind 自证 → `setsid --fork` 起进程 → 监听 + `/healthz` 双验
→ 登记五元组台账（pid/comm/exe/starttime/argv，comm 允许 `node` ↔ `MainThread`）→
才释放锁；`stop` 五元组逐项比对后才 `kill -TERM`，SIGKILL 前再核一次，台账归档进
`/data/.trash`（`run-dispatcher.sh:14-16,126-135,226-292`）。

`test` 子命令 = 包内 `node --test test/`（`dispatcher/test/` 7 个 `.test.js`、231 tests；`dispatcher/vendor/ws`（MIT，NOTICE 第 5 节）随包发布），全随机端口不占入口；测试线未随包时明确 die（`run-dispatcher.sh:294-303`）。

外域浏览器入口要放开音频：给 dispatcher unit 加 drop-in 设 `WTK_BROWSER_ORIGIN`
（只改音频内部 hop 的上游 Host/Origin，不改监听地址、不管认证、不重建桌面），
然后只重启 dispatcher。

### 5.4 日常操作

```bash
cd kasmweb
./scripts/wt-kasm list                      # 读 registry.json，不需要 daemon
./scripts/wt-kasm status chrome-1           # 读实况（含每桌 app 台账）
./scripts/wt-kasm start chrome-1            # 幂等：已运行不 recreate，app 不双开
./scripts/wt-kasm start chrome-1 --no-app   # 只起桌面，不拉宿主应用
./scripts/wt-kasm app start chrome-1 --app chrome
./scripts/wt-kasm app focus chrome-1 --app chrome
./scripts/wt-kasm app stop chrome-1 --app chrome
./scripts/wt-kasm stop chrome-1             # 收 app + relay + compose stop，不 rm
./scripts/wt-kasm verify chrome-1           # 12 项只读体检，rc=0 = 12/12
./scripts/wt-kasm registry --refresh
./scripts/wt-kasm daemon status | daemon --detach | daemon stop
```

`wt-kasm` 是薄壳，逻辑全在 `manager/` 包（`scripts/wt-kasm:1-11`）。
`app --test-cdp` 只在桌面 id 以 `chrome-` 开头时允许，且 `--remote-debugging-port=0`
（端口由 `profile/DevToolsActivePort` 回读，生产默认无调试端口）。

幂等与门禁语义（`manager/compose.py:274-341`、`manager/actions.py:264-336`）：

- 同名容器缺本路线 label = foreign ⇒ **拒绝操作**（不代其动手）。
- 已 owned + running ⇒ `kept`，不 recreate。
- 镜像不在位 ⇒ `blocked`（镜像由 image worker 构建，本模块不 build / pull）。
- 起容器 = `docker compose -p <project> -f <compose> up -d --pull never`（`compose.py:154,327`），
  **无** `--remove-orphans`。
- `stop` 两道硬门：发命令前逐个核对运行中容器的 `com.docker.compose.project == spec.project`
  （漂移 ⇒ 拒绝，防 rc=0 假成功，`compose.py:234-273`）；`rc=0` 后逐个复查 inspect，
  仍 running 或 inspect 不可读 ⇒ 判 FAIL。全程零 `docker rm`、零 `down -v`。

`verify` 的 12 项（`manager/actions.py:395-446`）：容器归属 / compose 在位且与渲染一致 /
appshare 契约齐备 / X1 socket 存在 / relay 存活 / X 归属核对（desktop + generation）/
backend HTTP 200 / registry 与实况一致 / registry 发布面字段合规 / 逐 app 台账身份匹配 /
镜像引用在位。**GUI 实证不进 checks**，由中性字段 `guiVerified=false` +
`guiLevel="not-auto-checkable"` 承担 ⇒ 12/12 只等于 3 级 plumbing。

### 5.5 环境变量清单

manager 侧（全部只在模块导入期读一次，无热重载；非法即抛错 = fail-closed）：

| env | 默认 | 作用 | 出处 |
|---|---|---|---|
| `WT_KASM_APP_ROOT` | `/data/app/webtop-kasmvnc` | 部署根（去尾斜杠） | `config.py:15` |
| `WT_KASM_IMAGE` | `ghcr.io/yorkane/kasmweb:latest` | 规范镜像引用；生产建议显式钉已发布 tag 或 digest | `config.py:36` |
| `WT_KASM_PROJECT_SUFFIX` | `-v012` | compose project 后缀；project = `wt-kasm-<id><suffix>`，容器名恒 `wt-kasm-<id>`；导入期形态校验（非法即抛，`` 合法） | `config.py:248,233-234,684` |
| `WT_KASM_PUID` / `WT_KASM_PGID` | `os.getuid()` / `os.getgid()` | 写进容器 `PUID/PGID`；共享组按**数字 gid** 契约 | `config.py:732-733` |
| `WT_KASM_TRASH` | `/data/.trash` | 删除归档根 | `config.py:26` |
| `WT_KASM_REFRESH_INTERVAL` | `30`（秒） | registry 周期刷新；dispatcher 新鲜度门按它 ×3 = 90s 对齐 | `manager/daemon.py:25` |
| `WT_KASM_CHROME_BIN` | `/home/aigc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` | 宿主 Chrome 绝对路径（必须绝对、无空白/换行/控制字符） | `config.py:515-516,523-551` |
| `WT_KASM_CHROME_VERSION` | `153.0.8010.12` | 宿主 Chrome 期望版本（严格 4 段点分数字，空串拒绝） | `config.py:517-518,554-575` |
| `WT_KASM_PUBLIC_ORIGIN` | `http://127.0.0.1:25320` | 只接受 `http://127.0.0.1:<port>`；端口与全部桌面 / relay 端口互斥（导入期检查） | `config.py:436-499` |
| `WT_KASM_CATALOG_FILE` | 未设置 = 零读取 | opt-in **追加**桌面清单 | `config.py:802-855,931-946` |
| `WT_KASM_BASE_AUTO_DESKTOPS` | 未设置 = 未启用 | 把基础桌几何翻成 `auto`（逗号分隔，重复即拒） | `config.py:966-1076` |
| `WT_KASM_ADAPTIVE_IMAGE` | 空 = 未启用 | **只**让 `resize_mode=auto` 的桌换镜像（拒绝 `latest`、拒绝空白） | `config.py:59,158-218` |
| `WT_KASM_ADAPTIVE_PROJECT_SUFFIX` | 空 = 未启用 | **只**让 `auto` 桌换 project 后缀 | `config.py:297-371` |
| `WT_KASM_EASYCONNECT` | 未设置 = 不注册 | opt-in 第三宿主应用（固定二进制 + 两个固定旗标，仅 `chrome-1`） | `config.py:721-724,1089-1172` |
| `WT_KASM_IMAGE_ATTEST` | `<APP_ROOT>/image-attest.json` | 几何实况认证文件路径 | `manager/attest.py:50-51,89-102` |
| `WT_KASM_VCMI_SRC_DATA` / `WT_KASM_VCMI_SRC_CONFIG` | `/home/aigc/.local/share/vcmi` / `/home/aigc/.config/vcmi` | VCMI 种子源双通道；**公开机自建 VCMI 数据源时设置**（空值回落默认） | `config.py:729-730` |
| `WT_KASM_PYTHON` | `python3` | `wt-kasm` 用的解释器 | `scripts/wt-kasm:10` |
| `WT_KASM_MARK` | — | manager 注入子进程的私有归属标记（killpg 证据） | `manager/process.py:24,117-120` |

容器 env（compose 注入实名，`manager/compose.py:86-107`）：`WTK_DESKTOP_ID` /
`WTK_BASE_PATH=/desktop/<id>/` / `WTK_WIDTH` / `WTK_HEIGHT` /
`WTK_ALLOW_RESIZE`（**只在显式几何时写**，auto=`1` / fixed=`0`）/ `WTK_FRAMERATE` /
`WTK_PUBLIC_ORIGIN` / `PUID` / `PGID` / `DISPLAY=:1` / `START_DOCKER=false`。

dispatcher 侧（`dispatcher/lib/config.js`）：

| env | 默认 | 作用 | 出处 |
|---|---|---|---|
| `WTK_LISTEN_HOST` | `127.0.0.1` | 只允许 `127.0.0.1` / `localhost`，其它值启动期抛错 | `config.js:40,72,119,142-143` |
| `WTK_PORT` | `25320` | 唯一对外监听端口 | `config.js:41,120` |
| `WTK_REGISTRY` | `/data/app/webtop-kasmvnc/registry.json` | 必须绝对路径；只读 | `config.js:42,121,146` |
| `WTK_PUBLIC_ORIGIN` | `http://127.0.0.1:25320` | 后端 Host 透传与上游 Location 改写的内部规范 origin；启动期归一为纯 origin | `config.js:43,122,152-160` |
| `WTK_BROWSER_ORIGIN` | 空 = 关闭 | 显式外域 origin；命中时**仅**音频内部 hop 改写上游 Host/Origin | `config.js:47,123,138-140,93-113` |
| `WTK_BACKEND_PORT_MIN` / `_MAX` | `25321` / `25329` | 后端端口闭区间；越界 ⇒ 503「后端登记不合法」 | `config.js:44-45,125-126,148` |
| `WTK_MAX_WS` | `64` | 并发 WS 上限 ⇒ 503 | `config.js:127` |
| `WTK_HTTP_TIMEOUT_MS` | `60000` | 上游首字节超时 ⇒ 504 | `config.js:128` |
| `WTK_MISSING_CACHE_MS` | `2000` | registry 缺失的负缓存窗口 | `config.js:129` |
| `WTK_ENABLE_ADAPTIVE_PREVIEW` | 关闭 | 只认逐字 `1`；`auto` 几何预览总开关 | `config.js:48,78-80` |
| `WTK_NATIVE_DEFAULT_MODE` | 关闭 | 只认逐字 `1`；legacy 桌入口**不注入 resize** | `config.js:50-61,86-88` |
| `WTK_GEOMETRY_STALE_MS` | `90000` | registry 新鲜度门，**只可收紧**，超默认值启动期抛错 | `config.js:16-34,66,134` |
| `WTK_GEOMETRY_SKEW_MS` | `60000` | mtime 超前容忍，同样只可收紧 | `config.js:68-69,135` |

后端连接 host **恒为** `cfg.backendHost` = 固定 `127.0.0.1`（registry 里的 host 字段不被信任，
`config.js:46,124`）。

`run-dispatcher.sh` 自身另读 `WTK_NODE`（node 绝对路径）、`WTK_APP_ROOT`、
`WTK_PORT_LOCK_DIR`、`WTK_TRASH`、`WTK_TEST_LOG`、`WTK_TEST_TIMEOUT`
（`run-dispatcher.sh:24-44,52,296,303`）。
node 解析口径 = `WTK_NODE` 覆盖 > `command -v node`，并校验可执行与主版本 ≥18，找不到 / 版本不足即明确 FATAL 退出（`run-dispatcher.sh:24-42`），不写死私有路径。


## 6. 宿主应用接入

### 6.1 appshare 契约目录

容器侧 bind 到 `/run/wt-kasm-app`（宿主 = `<APP_ROOT>/desktops/<id>/runtime/appshare`，
`manager/compose.py:67`）。契约件（`manager/appshare.py:30-38`）：

| 文件 | 谁写 | 作用 |
|---|---|---|
| `native` | Pulse（drop-in 监听它） | app 侧 Pulse native socket |
| `pulse-cookie` | `init-wtk-appshare`，`0640 abc:$PGID` | Pulse 服务 cookie |
| `xauth` | 同上（`wtk-xauth-seed` 写 Wildcard 0xffff 条目），`0640` | X 授权 |
| `generation` | `svc-kasmvnc/run`，**每次 spawn Xvnc 前** | 32-hex 换代令牌 |
| `app.json` | `init-wtk-appshare` | 纯数据桌面描述（无命令 / argv / url） |
| `launch.sock` | **manager**（每桌一个） | 图标点击回传通道 |

X socket 路径 = `<desk>/runtime/x11/X1`（容器 `DISPLAY=:1` ⇒ 文件名是 `X1`，**不是** `X310`）。
组模型：`2770 abc:$PGID` 的共享目录 + `0640` 凭证 ⇒ root / abc / 宿主 gid $PGID 可读，
nginx(102)、messagebus(101) 不可读；共享组按**数字 gid**（基座组名会指错，
`docker/s6/init-wtk-appshare/run:14-20`）。

### 6.2 launch.sock 协议

协议 = **一行 JSON**，键集合必须**恰好**等于 `{action, appId}`（`manager/daemon.py:4-6`）：

```text
{"action":"launch","appId":"chrome"}
{"action":"focus","appId":"chrome"}
```

回复 = 一行 JSON：`{"ok":bool,"appId":...,"action":...,"reason":...}`。
**没有 argv / url / exec / env / timeout 通道** —— 参数只来自 manager 注册表白名单。
旧文本协议仅作滚动升级兼容（标 `protocol=legacy-text`），新组件不得发文本。

容器内唯一客户端 = `wtk-launch`（`docker/bin/wtk-launch`）：

```bash
/opt/wtk/bin/wtk-launch chrome            # = launch
/opt/wtk/bin/wtk-launch chrome focus
WTK_APPSHARE=/run/wt-kasm-app /opt/wtk/bin/wtk-launch chrome
```

退出码（`docker/bin/wtk-launch:27-31,38-41`）：`0` manager 答 ok / `2` 用法或 appId·action
非法（不碰 socket）/ `3` socket 创建或连接失败（manager 未起、卷未挂）/ `4` manager 明确拒绝 /
`5` 超时、空回复、不可解析、超 `MAX_REPLY=4096`。socket 超时 `TIMEOUT_S=60.0`。
本地图词表 `APP_IDS=("chrome","vcmi")`、`ACTIONS=("launch","focus")`。

### 6.3 桌面图标与 .desktop 模板

镜像内置**两个**图标 `/defaults/desktop/Chrome.desktop` 与 `Chrome-Local.desktop`，
`/defaults/autostart` 每次启动对这两个名字**强制复制**（`cp -f`）到 `$HOME/Desktop` 并
`chmod 0755`（构建门禁明查播种清单与 chmod 行，`docker/Dockerfile:249-255`；禁止 `cp -n`，
禁止 VCMI 播种残留。播种无条件 ⇒ **旧 /config 卷换新镜像后，新图标在第一次启动即自动
出现在桌面**，部署侧无需手工步骤，见 §6.5）。宿主桥逐字模板：

```ini
[Desktop Entry]
Type=Application
Name=Chrome
Comment=Open Chrome on the host
Exec=/opt/wtk/bin/wtk-launch chrome
Icon=/opt/wtk/windowing/desktop/icons/chrome.png
Terminal=false
StartupNotify=false
```

容器内通道逐字模板（`Chrome-Local.desktop`，图标复用同款官方 logo PNG）：

```ini
[Desktop Entry]
Type=Application
Name=Chrome（容器内）
Comment=Launch the in-container Chromium
Exec=/opt/wtk/bin/wtk-chrome-local
Icon=/opt/wtk/windowing/desktop/icons/chrome.png
Terminal=false
StartupNotify=false
```

**接别的宿主应用 = 按同一协议加一个 `.desktop`**：`Exec` 必须是
`/opt/wtk/bin/wtk-launch <appId>`（构建门禁按该前缀逐字断言），
`Icon` 指向镜像内 PNG，mode 0755；同时在 manager 侧把该 `appId` 注册进该桌白名单
`APP_IDS_BY_DESKTOP`（`config.py:710`，opt-in 桌面清单 `WT_KASM_CATALOG_FILE` 可带自己的
appIds，`config.py:938-946`）并给 `wtk-launch` 的本地词表加名。
`libfm quick_exec=1` 在构建期合入基座配置，消掉双击时的「可执行脚本，要执行吗」对话框
（`docker/Dockerfile:224-248`）。

### 6.4 宿主进程环境、PID 台账与零 pkill

manager 在**宿主侧**拉起应用（Chrome 走 `dbus-run-session` 私有 bus 作最外层启动器）。
环境白名单重建（`manager/hostapps.py:522-556`）：私有 `HOME` / `XDG_*`、
`DISPLAY = 127.0.0.1:<310|311|312>`（`spec.client_display`）、
`XAUTHORITY=<appshare>/xauth`、`PULSE_SERVER=unix:<appshare>/native`、
`PULSE_COOKIE=<appshare>/pulse-cookie`，**不继承**宿主 `DBUS_* / PULSE_* / DISPLAY /
LD_PRELOAD / PYTHON*`。

Chrome argv = 固定白名单（`hostapps.py:583-620`）：`--user-data-dir=<桌面私有 profile>`、
`--class=Chrome`、`--no-first-run`、`--no-default-browser-check`、
`--disable-session-crashed-bubble`、`--disable-features=Translate`、
`--window-position=40,40`、`--window-size=1280,780`，末位固定首页（默认 `about:blank`）。
`--url`（首页覆盖）**只接受 `http://` / `https://` 开头的绝对 URL**：`-` 起头的旗标注入与
data:/file:/javascript: 等旁路方案一律 ValueError 拒绝（校验点 = CLI 与 daemon 双通道汇合的
argv 消费处，`hostapps.py:583-600`）。
**不加 `--no-sandbox`**（宿主 uid 1000 + 正常 sandbox 优先）。私有 profile 路径 =
`desktops/<id>/apps/chrome/profile`（`hostapps.py:51-53`，两个 Chrome 天然隔离），
并被写入 `browser.custom_chrome_frame=false`（`hostapps.py:61-103`，只写本桌私有副本）。

进程纪律（`manager/process.py:1-14,117-200`）：台账 = pidfile JSON
（pid + comm + exe + starttime + pgid + role + desktop + label + 时间）；kill 前
`pid+comm+exe+starttime` 四元组必须全部命中；`killpg` 只在台账声明 setsid 组长
（`setsid=True` 且 `pgid==pid`）且现场 `os.getpgid(pid)==pid` 时下发；台账 `exe` 为空时
要求 `comm+starttime` 命中且私有标记 `WT_KASM_MARK` 出现在 `/proc/pid/environ`。
启动器链的白名单：`comm_accept=["dbus-run-sessio","chrome"]`（comm 被内核截断到 15 字符）、
`exe_accept=[/usr/bin/dbus-run-session, CHROME_BIN]`（`hostapps.py:1063-1073`）。
Chrome profile 的 `SingletonLock` 只回收**已确认死亡**的锁（移入 trash）；锁主未确认死亡
⇒ 拒绝同 profile 再开，不自动删锁（`hostapps.py:963-1018`）。**全程零 pkill、零模式匹配 kill。**

### 6.5 双通道：宿主桥 Chrome 与容器内 Chromium 112（2026-11-20 新增）

镜像内的浏览器入口从 1 个变 2 个，两条通道**互不依赖、可同时启动**（同 `DISPLAY=:1`，两个独立进程、两份独立 profile、两个独立窗口，任务栏各一条目）：

| | 宿主桥 Chrome | 容器内 Chromium 112 |
|---|---|---|
| 桌面图标 | `Chrome.desktop`（Name=Chrome） | `Chrome-Local.desktop`（Name=Chrome（容器内）） |
| 启动链 | 图标 → `wtk-launch chrome` → `launch.sock` → manager → **宿主** Chrome | 图标 → `/opt/wtk/bin/wtk-chrome-local` → `exec /usr/bin/chromium-browser`（容器内） |
| 二进制 | `WT_KASM_CHROME_BIN`（宿主侧，期望 153.0.8010.12） | apk `chromium` = 112.0.5615.165-r0（Alpine 3.17 community） |
| profile | 宿主私有 profile（manager 管理 + SingletonLock 纪律） | 容器内默认 profile（`$HOME/.config/chromium`，随 /config 卷持久） |
| 音频 | 宿主 Chrome → appshare native socket → 容器 pulse → relay | 容器内 pulse：会话环境已带 `PULSE_SERVER=unix:/run/wt-kasm-app/native`（init-wtk-appshare 发布，经 with-contenv 进桌面会话）；裸 shell 里启动器回落 `unix:/run/pulse/native`。两条 socket 都汇入 `auto_null` sink → 现有 MP2 relay → 浏览器音频按钮 |
| 依赖 | manager 活着 + appshare 卷已挂 + 宿主 Chrome 就位 | 只依赖镜像自身（manager 可缺席） |
| 沙箱 | 宿主正常 sandbox（**不加** `--no-sandbox`） | `--no-sandbox`（见下） |

**容器内通道的固定 argv**（`docker/bin/wtk-chrome-local`）：`exec /usr/bin/chromium-browser --no-sandbox --no-first-run --no-default-browser-check "$@"`。
（Alpine `chromium` 包**不提供** `/usr/bin/chromium`，其入口 = `/usr/bin/chromium-browser` →
`/usr/lib/chromium/chromium-launcher.sh`，launcher 自身不加旗标，故上面这行就是完整旗标集。）`$@` 直通给 Chromium 本体：这个入口只服务容器内浏览器，**不接外部输入** —— 没有控制 socket、没有 argv/url/env 注入通道、没有管理面，`launch.sock` 协议（§6.2）与它无关；能给它传参的只有桌面会话里的人。

**`--no-sandbox` 取舍**：桌面会话进程是 `abc`（uid 1000，svc-de 经 s6-setuidgid 降权），Alpine chromium 在本容器形态下没有可用的 setuid sandbox helper（镜像未带该 helper，容器也未授予 user namespaces），不加旗标 Chromium 直接拒绝启动。接受的代价 = 渲染进程隔离弱于宿主桥（宿主 Chrome 跑真沙箱）⇒ 容器内通道定位是**便利面**，不可声明为加固面；对安全边界敏感的访问走宿主桥。

**旧 /config 卷换新镜像的行为**：新图标**会**自动出现，部署侧无需手工步骤。机制在 `/defaults/autostart`：每次 openbox 启动对管理名单 {`Chrome`, `Chrome-Local`} 逐名 `cp -f`（覆盖式，非 `cp -n`）+ `chmod 0755`，与 `$HOME/Desktop` 既有内容无关 ⇒ 已有 Desktop 目录的老卷在换新镜像后的第一次启动就多出 `Chrome-Local.desktop`（同机制还会把旧的 0644 副本刷新成 0755）。要在**不重启会话**的情况下立刻见效，可手工执行同一动作：`cp -f /defaults/desktop/Chrome-Local.desktop ~/Desktop/ && chmod 0755 ~/Desktop/Chrome-Local.desktop`。

**已知限制（容器内通道）**：112 是 Alpine 3.17 archive 仓库钉死的版本，比宿主 Chrome 153 旧约 41 个大版本（无新平台特性，安全补丁止于 archive 冻结点）；`--no-sandbox` 弱化渲染隔离；profile 落在 /config 卷上随桌持久（共桌即共享 profile，没有 manager 侧的私有 profile 隔离）；KasmVNC 无 GPU 加速，Chromium 走软件光栅（与宿主桥同条件）。构建门禁 = 版本逐字断言 + 真 headless 渲染 smoke（§4 门禁 10）。

## 7. 桌面与任务栏

会话 = `svc-de/run` → `/defaults/startwm.sh`（等 X 就绪、写 root 归属属性并读回校验）→
`exec openbox-session`；openbox 的 `/defaults/autostart` 再拉起 tint2 与 pcmanfm
（`docker/s6/svc-de/run:31-40`、`docker/windowing/startwm.sh:40-97`）。
桌面底色 = `xsetroot -solid '#1c1712'` 纯色，镜像不带壁纸；pcmanfm 只做桌面层与图标网格，
openbox 是唯一 WM（`docker/windowing/openbox/autostart:24,45-93`）。

tint2（`docker/windowing/tint2/tint2rc`，构建门禁逐字断言）：

| 键 | 值 | 行 | 说明 |
|---|---|---|---|
| `panel_items` | `TC` | 84 | **任务列表 + 时钟**，无 launcher、无托盘（`LTSBC` 已移除，出现 `systray_`/`launcher_` 键 = 构建 FAIL） |
| `panel_size` | `100% 30` | 85 | 整宽、30px 高（实测几何） |
| `panel_window_name` | `wtk-taskbar` | 100 | openbox `rc.xml` 按此名匹配（门禁要求） |
| `taskbar_mode` | `single_desktop` | 110 | 单工作区显示 |
| `clock_padding` | `44 0` | 173 | 时钟左右各留 44px |
| `time1_format` | `%H:%M` | 163 | 时钟格式 |

`clock_padding = 44 0` 的**右段是浏览器音频按钮的暗色落脚带**：Kasm 前端在每个观看者浏览器里
把音频开关渲染在画布右下角，正好落在这条空白面板底上，不遮时钟 / 任务按钮。
改小 → 按钮压住时钟；改大 → 时钟被推到过左（`tint2rc:169-173` 注释，`Dockerfile:261` 门禁）。

### 7.1 系统默认字体 = Noto CJK SC

镜像在 fontconfig 层把系统默认字体钉成 **Noto CJK SC**：策略文件
`docker/fonts/99-kasmweb-cjk.conf`（172 行）装到容器
`/etc/fonts/conf.d/99-kasmweb-cjk.conf`（0644，`Dockerfile:112` COPY +
`Dockerfile:141` 强制权限）。凡走 fontconfig 解析通用族的应用全部受益 ——
GTK 应用、openbox 窗口标题与右键菜单、pcmanfm、xterm 等（tint2 与 openbox 另有显式字体，见下）；
编号 99 保证它在通用/语言规则（45/60/65 系）之后解析，alias-prefer 与 prepend
赢得族序。三个 generic family 的映射（Latin 回退保留）：

| generic | 解析到（family[0]） | 回退链 |
|---|---|---|
| `sans-serif` / `sans` | **Noto Sans CJK SC** | DejaVu Sans → Liberation Sans → Noto Sans |
| `serif` | **Noto Serif CJK SC** | DejaVu Serif → Liberation Serif → Noto Serif |
| `monospace` | **Noto Sans Mono CJK SC** | DejaVu Sans Mono → Liberation Mono |

语言规则：`lang` 含 `zh`（`zh / zh-cn / zh-hans / zh-sg / zh-tw / zh-hk`，按
`compare="contains"` 匹配）时对四个 generic 强前置 SC 族，并把 Chrome/GTK 硬编码的
`Noto Sans CJK JP/KR/TC/HK` 请求在 zh 语境下前置 SC。**设计取舍：zh-tw / zh-hk
也落 SC** —— SC 字形可读繁体，逐区路由（繁落 TC/HK）明确不在本期范围。
另含 CJK 渲染 hygiene（对族名含 CJK 的字体统一 antialias + hintslight +
rgb/lcddefault + `embeddedbitmap=false`，用矢量轮廓不用位图点阵）。

openbox 侧不依赖该层兜底：`docker/windowing/openbox/rc.xml:70-123` 的六个
`<font place>`（ActiveWindow / InactiveWindow / MenuHeader / MenuItem /
ActiveOnScreenDisplay / InactiveOnScreenDisplay）显式写死 `Noto Sans CJK SC`。
tint2 的任务按钮 / 时钟 / 提示字体本来就是 `Noto Sans CJK SC 9`
（`tint2rc:138,167,212`，本轮未改）。

字体包 = apk `font-noto-cjk`（+`font-noto-emoji` / `font-dejavu` /
`ttf-liberation`；基座自带 `font-noto` 无 CJK），见 `docker/apk/packages.txt:12-15`。
`docker/.dockerignore` 的 allowlist 已含 `!fonts/` 与 `!fonts/99-kasmweb-cjk.conf`
（`.dockerignore:26-27`）—— 漏了这两行 conf 就进不了构建上下文。

## 8. 最简音频

### 8.1 链路

```text
容器内应用发声
  -> PulseAudio（/etc/pulse/default.pa.d/20-wtk-app-share.pa）
     两条 native socket：/run/pulse/native（容器内部） + /run/wt-kasm-app/native（app 侧）
     均 auth-anonymous=0 + auth-cookie-enabled=1；null sink = auto_null（set-default-sink）
  -> svc-wtk-audio：ffmpeg 打开 auto_null.monitor -> MP2
  -> node relay（docker/audio/relay.js）监听 127.0.0.1:4901
  -> 容器 nginx /audio（WS）
  -> dispatcher /desktop/<id>/audio
  -> 浏览器 audio.js + jsmpeg 解码（页面右下角的音频按钮）
```

全链路**无额外组件**：无 pipewire、无 jack、无 WebRTC，**也没有麦克风通道**
（drop-in 不载任何 record source，relay 只打开 `<sink>.monitor`）。
relay 只监听 loopback，非 loopback 的 `WTK_AUDIO_BIND` 值直接拒绝（`relay.js:30-31,64-66`）。

### 8.2 凭据与启用/关闭语义

- 宿主应用侧由 manager 注入：`PULSE_SERVER=unix:<appshare>/native` +
  `PULSE_COOKIE=<appshare>/pulse-cookie`（`hostapps.py:549-555`）。
- relay 服务侧：`svc-wtk-audio/run` 设 `PULSE_RUNTIME_PATH=/run/pulse`、
  `PULSE_SERVER=unix:$SHARE/native`，启动前最多等 60 秒让 `auto_null.monitor` 出现（`docker/s6/svc-wtk-audio/run:19-36`）。
- 浏览器侧是**用户手势门**：音频按钮由注入件创建，relay 只在有客户端连上时才起 producer。
  点按钮 ⇒ `state=playing`；关按钮 ⇒ `state=stopped` 且 relay `bytes` 冻结。
- relay env 实名与默认（`docker/audio/relay.js:29-56,64-94`）：
  `WTK_AUDIO_PORT=4901`、`WTK_AUDIO_BIND=127.0.0.1`、`WTK_AUDIO_MONITOR=auto_null.monitor`、
  `WTK_AUDIO_SAMPLE_RATE=44100` / `WTK_AUDIO_BITRATE=128k` / `WTK_AUDIO_CHANNELS=1`、
  `WTK_PUBLIC_ORIGIN`（同时播 Host 与 WS Origin 两份白名单）、
  `WTK_AUDIO_ALLOWED_HOSTS` / `WTK_AUDIO_ALLOWED_ORIGINS`（追加）、
  `WTK_AUDIO_MAX_WS=8`、`WTK_AUDIO_MAX_BUFFERED=1MiB` / `WTK_AUDIO_MAX_QUEUED=4MiB` /
  `WTK_AUDIO_MAX_DROP_BYTES=8MiB`、`WTK_AUDIO_MAX_PRODUCER_RESTARTS=5`、
  `WTK_AUDIO_CLOSE_GRACE_MS=500`、`WTK_AUDIO_WS_MODULE`（回退顺序：显式值 →
  `<本目录>/vendor/ws` → 基座自带 `/kclient/node_modules/ws`）、
  `WTK_AUDIO_STATIC_DIR=<本文件目录>/web`、`WTK_AUDIO_LOG=json`（`quiet` 静音）、
  `WTK_AUDIO_AUDIT=/dev/null`（逐事件 JSONL）。
- **Host 与 Origin 的非对称**：Host 接受 loopback 通配（dispatcher 每桌分配端口，逐端口枚举
  不可持续，而 relay 只听 loopback ⇒ 不构成外部攻击面）；Origin **只精确匹配**（CSRF 防线）。
  未配 `WTK_PUBLIC_ORIGIN` ⇒ Origin 集合为空 = 所有浏览器握手被拒（fail-closed）。
- 外域入口下音频被拒（421）⇒ 设 dispatcher 的 `WTK_BROWSER_ORIGIN`（§5.3/§5.5），
  它只对音频内部 hop 改写上游 Host/Origin，连接目标不变（`dispatcher/lib/proxy.js:66-99`）。
- 注入件的 base：Kasm 页 CSP 拒 inline script ⇒ `window.__WTK_BASE` 由**外部** `/wtk-boot.js`
  给出（容器 nginx 从磁盘提供，渲染件由 `render-nginx.py` 每启动原子写），注入顺序 =
  `wtk-boot.js` → `audiojs/layout.css` → `audiojs/layout.js` → `audiojs/audio.js`
  （`docker/nginx/wtk.conf.template:42-46,98-115`、`render-nginx.py:12-19,69-71,80`、`docker/audio/web/layout.js:14-16`）。
  音频取证 API 名是对外契约：DOM id `wdev-audio-btn`、`data-wdev-audio`、
  `window.__wdevAudio` / `window.__wdevLayout`（`docker/audio/web/audio.js:5,31,43-46`、`docker/audio/web/layout.js:14-16`）。

### 8.3 常见故障判据

| 现象 | 判据 / 动作 |
|---|---|
| 按钮停在 idle、无声音 | 容器内 `curl -s http://127.0.0.1:4901/healthz` → `{"ok":true,"live":N,"producer":bool,"bytes":B,"monitor":...}`（`relay.js:553-556`）。 `live=0` = 没有浏览器连上（按钮未点，或 Origin 白名单未命中） |
| 说「sink 无输入」 | 容器内 `pactl list sink-inputs short`（以 abc + 注入的 PULSE_* 身份）应见 `protocol-native.c float32le 2ch 44100Hz`；`pactl list sinks short` 里 `auto_null` 播放时应 `RUNNING`、停止后 `IDLE`、长期无客户端 `SUSPENDED` |
| 怀疑音频没在动 | 连采两次 `/healthz` 的 `bytes`，**播放中必须递增**；关按钮后应**连续 5 次全等**（冻结判据：间隔 5s、窗口 ≥12s） |
| 健康检查第 12 门 FAIL | 要求 native socket 恰好 2 个、sink 恰好 1 个；出现 `auto_null.2` = 启动脚本跑了两遍（`docker/healthcheck.sh:234-243`） |
| 慢客户端拖死会话 | relay 用 `ws.bufferedAmount` + 每客户端有界队列 + 100ms 泵（三个已验证修复随层继承，见 `docker/audio/README.md` 首表）；producer 不受单客户端背压影响 |
| 第 8 门 FAIL（relay/monitor） | 先看 `auto_null.monitor` 是否存在（Pulse 未起 / drop-in 未加载），再看 relay 进程（`svc-wtk-audio` 崩溃环） |

## 9. URL 与分辨率语义

### 9.1 规范 URL

`GET /?desktop=<id>` ⇒ 302 到 **root-relative** 的 `/desktop/<id>/?` + 规范参数
（`dispatcher/server.js:251-258`、`lib/selector.js:258-266`）。Location **不拼 origin**，
也不从 `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` 推断 ⇒ 浏览器始终留在用户原入口。
规范参数（`lib/config.js:165-177`，键序固定）：

```text
autoconnect=1&resize=scale&path=desktop%2F<id>%2Fwebsockify&idle_disconnect=0
&clipboard_seamless=false&shared=true
```

- `path` 值**不带前导斜杠**（Kasm `ui.js` 是 `url += '/' + path` 的拼接语义，
  取证注释 `docker/nginx/wtk.conf.template:11-13`）。
- 这 6 个键 = `FORCED_PARAM_KEYS`（`lib/config.js:291`）：用户显式传 `autoconnect=0`
  属「覆盖强制参数」⇒ **400**，不被静默改写。
- 根查询另允许 `show_control_bar` / `bell` / `reconnect` / `reconnect_delay`
  （`lib/config.js:284-290`）；`path` `url` `host` `port` `token` `exec` `env` `argv`
  `cmd` 等选择类参数一律 400（`lib/selector.js:18-22`）。
- `shared=true` 只是 iframe 地址参数，**不**代表后端互斥 / 单用户限制（`lib/config.js:179`）。

### 9.2 resize 三档

Kasm / noVNC 客户端 `resize` 的合法枚举 = `off` / `scale` / `remote`（`lib/config.js:191`）：

| 值 | 含义 |
|---|---|
| `off` | **不缩放、也不请求远端改尺寸**（不是「本地缩放」）。Kasm 1.1 客户端在 iframe 内的内置默认就是 `off`，且 URL query 优先于 localStorage |
| `scale` | 等比**缩放显示**，帧缓冲尺寸不变 |
| `remote` | 真改分辨率：客户端发 SetDesktopSize，帧缓冲跟随视口 |

**本项目不承诺「URL 无参即随 iframe 自适应」**。本仓库镜像是 native 变体：Xvnc argv
**不传** `-AcceptSetDesktopSize`，由 KasmVNC 1.1.0 原生默认（accept）接管 ⇒ 打开的是
**服务端许可**这一层（L1）。`-geometry` 只是**启动初值**，取 `WTK_WIDTH` / `WTK_HEIGHT`
（manager 注入 1600x900；svc 文件里的 `1024x768` 仅是「变量未设时」的 shell fallback，
**不是本产物默认值**，`docker/s6/svc-kasmvnc/run:108-124`）。
客户端要不要发 remote-resize（L2）与入口是否注入 resize（L3）是**另外两条独立通道**：
L2 未验（Kasm iframe 内置默认 `off` ⇒ 不发请求），L3 由 `WTK_NATIVE_DEFAULT_MODE` 决定
（开启 = 不注入，交给客户端自选）。三层不得合并叙述。

### 9.3 geometry 注册 opt-in 的三种模式

registry 条目里 `geometry` 键**缺席** = legacy；键存在且非法 ⇒ 该桌 `state=error` +
`geometryError=true`（消费侧不回落 legacy、不丢其它桌；`state=error` 是承重设计，
未升级的一侧同样 503，`dispatcher/lib/registry.js:9-14,162-165`、`lib/config.js:272-280`）。

| 登记模式 | URL 要求 | 不满足时 | 出处 |
|---|---|---|---|
| legacy（键缺席） | 无参 ⇒ `resize=scale`；`WTK_NATIVE_DEFAULT_MODE=1` ⇒ **不注入 resize**（nativelegacy） | 带 `resolution` ⇒ **409** | `lib/selector.js:294-311` |
| `auto` | 不接受 `resolution`；规范集用 `resize=remote` | 未开 `WTK_ENABLE_ADAPTIVE_PREVIEW=1` ⇒ **503** fail-closed；带 `resolution` ⇒ **409** | `lib/selector.js:311-317` |
| `fixed` | 入口文档必须带**精确** `resolution=<WxH>` | 缺参 / 与登记不等 ⇒ **409**；形态非法 ⇒ 400 | `lib/selector.js:318-325` |

`resolution` 形态：小写 `x`、3..4 位、无前导 0，宽 320..4096 / 高 240..4096
（`lib/config.js:203-231`）；Location 只用解析后的整数字符串，不透传原样字节。
子资源（`/audiojs/*` 等）走 `decideAsset`：不要求 `resolution`，只在显式带上且冲突时拒
（`lib/selector.js:337-361`）。WS 升级走 `decideGeometryWs`，画面与音频**同门**
（`lib/selector.js:380-420`）。
新鲜度门（默认 90s = manager 刷新周期 ×3）命中 ⇒ 条目复制标 `state=error`（陈旧快照
等价 error，`lib/registry.js:24,38,269-280`）。
`auto` 桌的画面通道另有每桌 1 个连接名额（预留 + 已连接合并计数），第 2 个 upgrade 在进
proxy 之前直接 409（`dispatcher/server.js:22-38,441-446`）⇒ `WTK_ENABLE_ADAPTIVE_PREVIEW=1`
只限隔离测试环境。

manager 侧的显式几何桌面还有**几何实况认证**（A 能力锚 digest / B 直读 Xvnc 进程 argv /
C dockerd 记账的 health OK 行 / D 声明-实值一致 + 时间因果，`manager/attest.py:15-26,56-58,359`）。
注意：本仓库镜像是 native argv（无 `-AcceptSetDesktopSize`），
**B/D 会拒签 ⇒ 只适用于「无显式几何声明的 legacy 桌」**（`docker/healthcheck.sh:42-50`）。


## 10. 配置项速查

| 项 | 值 | 出处 |
|---|---|---|
| 三桌 backend / relay / 宿主显示 | 25321·6310·:310 / 25322·6311·:311 / 25323·6312·:312 | `manager/config.py:701-705` |
| dispatcher 入口 | `127.0.0.1:25320` | `dispatcher/lib/config.js:40-41` |
| 后端端口池 | `25321..25329`（连接 host 恒 `127.0.0.1`） | `config.js:44-46,125-126` |
| 容器内端口 | nginx 3000（唯一发布）/ Xvnc httpd 6901 / 音频 relay 4901（后二只绑 loopback） | `config.py:599`，`docker/s6/svc-kasmvnc/run:143`，`docker/audio/relay.js:64-65`，`docker/Dockerfile:475-486` |
| 启动几何 / 帧率（manager 注入） | 1600 x 900 @ 30 | `config.py:581-583` |
| 几何合法区间 | W 320..4096，H 240..4096 | `config.py:589-592` |
| compose 固定面 | `restart: unless-stopped` / `network_mode: bridge` / `shm_size: 1g` / `tmpfs: [/tmp]` / 三 bind / 三 label | `manager/compose.py:56-73`，`config.py:595` |
| 容器 env 实名清单 | 见 §5.5 | `manager/compose.py:86-107` |
| registry schema | v1；发布面 8 字段 `id,name,port,state,container,containerId,generation,appId`；`state ∈ running,starting,stopped,error` | `manager/registry.py:31-32` |
| appshare 契约文件 | `native, pulse-cookie, xauth, generation, app.json`（+ manager 建的 `launch.sock`） | `manager/appshare.py:30-36` |
| X root 归属属性 | `_WT_KASM_DESKTOP_ID` / `_WT_KASM_GENERATION` | `appshare.py:126`，`docker/windowing/startwm.sh:73-79` |
| launch.sock 键集合 | 恰好 `{action, appId}` | `manager/daemon.py:4-6` |
| tint2 | `panel_items = TC` / `panel_size = 100% 30` / `clock_padding = 44 0` / `panel_window_name = wtk-taskbar` | `docker/windowing/tint2/tint2rc:84,85,173,100` |
| 系统默认字体 | fontconfig 钉 `Noto Sans CJK SC`（sans/sans-serif）、`Noto Serif CJK SC`（serif）、`Noto Sans Mono CJK SC`（monospace）；`lang=zh` 强前置 SC | `docker/fonts/99-kasmweb-cjk.conf`，`docker/Dockerfile:112,141,390-420`（§7.1） |
| 字体安装包 | apk `font-noto-cjk` + `font-noto-emoji` + `font-dejavu` + `ttf-liberation`（基座自带 `font-noto` 无 CJK） | `docker/apk/packages.txt:12-15` |
| openbox 字体 | `rc.xml` 六个 `<font place>` 显式 `Noto Sans CJK SC` | `docker/windowing/openbox/rc.xml:70-123` |
| Xvnc 监听面与会话寿命 | `-interface 127.0.0.1 -websocketPort 6901 -rfbport 0 -nolisten tcp -sslOnly 0 -PublicIP 127.0.0.1`；`-AlwaysShared -DisconnectClients 0 -MaxIdleTime 0 -IdleTimeout 0` | `docker/s6/svc-kasmvnc/run:142-148` |
| 音频 relay env | 见 §8.2 | `docker/audio/relay.js:29-56` |
| 容器健康 OK 行 | `healthcheck: OK (http=… geom=… resize=native gen=… cjk=…)` | `docker/healthcheck.sh:247` |
| dispatcher 健康 | `GET /healthz` → `ok desktops=<N>` | `dispatcher/server.js:203-206` |
| 音频 relay 健康 | `GET :4901/healthz` → `{ok,live,producer,bytes,monitor}` | `docker/audio/relay.js:553-556` |
| 基座 digest | `sha256:e67ff31da12e6908fc6acbeaba499f9339794b1b622bcb2d945286a7257b755d` | `docker/Dockerfile:40,98` |
| 浏览器通道 | 两条，可同时运行：宿主桥 Chrome（图标 `Chrome.desktop`）+ 容器内 Chromium 112（图标 `Chrome-Local.desktop` → `/opt/wtk/bin/wtk-chrome-local`） | `docker/windowing/desktop/`，`docker/bin/wtk-chrome-local`，§6.5 |
| 容器内浏览器包 | apk `chromium` = 112.0.5615.165-r0（Alpine 3.17 community）；入口 `/usr/bin/chromium-browser`（**无** `/usr/bin/chromium`） | `docker/apk/packages.txt:8`，`Dockerfile:454-469` |
| 容器内浏览器 argv | 固定 `--no-sandbox --no-first-run --no-default-browser-check` + 透传 `$@`（不接外部输入通道） | `docker/bin/wtk-chrome-local:55` |
| 新鲜度门 | 90000ms / 60000ms（只可收紧） | `dispatcher/lib/config.js:66,69,134-135` |

## 11. 验收清单

只读、可复制。`<D>` ∈ `vcmi chrome-1 chrome-2`；端口见 §5.1。

```bash
APP=/data/app/webtop-kasmvnc

# 1) dispatcher 活着 + 桌面数
curl -fsS http://127.0.0.1:25320/healthz                      # 期望 ok desktops=3

# 2) 规范 302（逐字对参数）
curl -s -o /dev/null -D - 'http://127.0.0.1:25320/?desktop=chrome-1' | sed -n '1,8p'
#   期望 location: /desktop/chrome-1/?autoconnect=1&resize=scale
#                  &path=desktop%2Fchrome-1%2Fwebsockify&idle_disconnect=0
#                  &clipboard_seamless=false&shared=true
#   （WTK_NATIVE_DEFAULT_MODE=1 时规范集不含 resize 键 = nativelegacy）

# 3) 参数矩阵（应当 400 / 404，不是被静默改写）
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:25320/?desktop=chrome-1&autoconnect=0'  # 400 覆盖强制参数
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:25320/?path=evil'                       # 400 禁用键
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:25320/?desktop=nope'                    # 404 未登记

# 4) backend 直连 200（与 dispatcher 判 running 的同一判据：只认 200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25322/

# 5) 容器健康（docker 记账的十二门）
docker inspect -f '{{.State.Health.Status}} failing={{.State.Health.FailingStreak}}' wt-kasm-chrome-1
docker exec wt-kasm-chrome-1 /opt/wtk/bin/healthcheck.sh
#   期望末行 healthcheck: OK (http=200 geom=<W>x<H> resize=native gen=… cjk=…)
#   十二门 = 入口 / 接口地址可达 / 注入锚点 / 6901 仅 loopback / framebuffer 读数合法（native：
#   只验两个正整数，**不断言相等**）/ generation 握手 / tint2 存活 / relay+monitor /
#   CJK / app.json / nginx worker=1 / pulse 2 socket+1 sink（docker/healthcheck.sh:54-74）
#   全绿 = 管道通 = 3 级；不声明窗口可见、可点、像素在流

# 5b) 系统默认字体解析（与构建期硬门禁同一探针）
docker exec wt-kasm-chrome-1 sh -c 'fc-match -f "%{family[0]}\n" sans-serif "sans-serif:lang=zh-cn"'
#   期望两行逐字 = Noto Sans CJK SC（serif / monospace 分别 → Noto Serif CJK SC /
#   Noto Sans Mono CJK SC；映射表见 §7.1）。构建期已有硬门禁逐字断言这四条
#   （§4 门禁 9，`Dockerfile:390-420`）；运行时这条只用于复核现容器没被后续层
#   改动破坏字体策略（healthcheck 门 9 是弱判，见 §13 第 9 条）

# 5c) 容器内浏览器通道在运行容器里可用（与构建期门禁同一探针；GUI 可见另算 4 级）
docker exec wt-kasm-chrome-1 sh -c 'command -v chromium-browser && chromium-browser --version'
#   期望 /usr/bin/chromium-browser + 'Chromium 112.0.5615.165'
docker exec wt-kasm-chrome-1 sh -c 'ls -l /defaults/desktop'
#   期望恰好 Chrome.desktop + Chrome-Local.desktop（0755）

# 6) 逐桌 12 项 plumbing 体检（rc=0 = 12/12）
cd kasmweb
for d in vcmi chrome-1 chrome-2; do ./scripts/wt-kasm verify "$d" >/dev/null; echo "$d rc=$?"; done

# 7) relay / 台账 / X 归属
ls -l $APP/desktops/chrome-1/runtime/x11/X1
cat $APP/state/chrome-1/relay.pid
ss -tanH | awk '$4 ~ /:631[0-9]$/ {print}'
xprop -root _WT_KASM_DESKTOP_ID _WT_KASM_GENERATION   # 需带 appshare 的 XAUTHORITY + DISPLAY=127.0.0.1:311

# 8) 音频：状态 + bytes 递增 + 冻结（按钮已点 = live>0）
docker exec wt-kasm-chrome-1 curl -s http://127.0.0.1:4901/healthz
#   间隔 5s 再取一次：播放中 bytes 必须递增
#   关按钮后：连续 5 次全等（间隔 5s、窗口 >=12s）
docker exec wt-kasm-chrome-1 pactl list sink-inputs short
docker exec wt-kasm-chrome-1 pactl list sinks short

# 9) 浏览器出图 + 任务栏真点（playwright-cli）
URL='http://127.0.0.1:25320/desktop/chrome-1/?autoconnect=1&resize=scale&path=desktop%2Fchrome-1%2Fwebsockify&idle_disconnect=0&clipboard_seamless=false&shared=true'
playwright-cli open "$URL"          # url 是位置参数（`playwright-cli open [url]`）
playwright-cli screenshot        # 出图（默认产物面见 AGENTS.md：/data/.trash/.playwright/output）
playwright-cli eval "() => window.__wdevAudio && window.__wdevAudio.status()"
playwright-cli eval "() => window.__wdevLayout && window.__wdevLayout.audit()"
# 闭环取证四件事（缺一不可）：
#   (a) 目标素材比对 = 音频按钮在右下角时钟带内 + 任务栏像素 ROI
#   (b) 语义反馈 = 真点任务钮后焦点窗变化（xdotool getwindowfocus 前/后对照）
#   (c) 目标区域命中 = bbox 落在该对象区域（不接受全图动画噪声）
#   (d) 真键盘在页面内键入标记 -> 宿主 Chrome 地址栏回显

# 10) 音频频谱量化（替代耳听）
#   页面内 window.__wdevAudio.sample() 取 FFT：播 440Hz 单音时 peakMode=440、
#   band440 中位约 -38 dB、rms 中位 > 0（n>=60）；停止后 n>=60 全零。
#   停止侧必须与播放侧**同进程**采样并附进程存活快照，否则「归零」可能只是应用退出的混合因子。
```

**验收纪律**：容器 healthy、`verify` 12/12、`/healthz` 200、页面出现、`bytes` 递增
都只证明到 3 级（plumbing / 加载）。「桌面真的渲染出画面、任务栏按钮真的可点、
声音真的能停」是 4 级，需浏览器侧取证，单列核销。

## 12. 运维

### 12.1 升级

```bash
cd kasmweb
docker pull ghcr.io/yorkane/kasmweb:latest            # 已发布 latest / v0.1.0 / 0.1.0；digest 以 CI 实际产出为准
WT_KASM_IMAGE='ghcr.io/yorkane/kasmweb:latest' bash scripts/install-manager.sh   # 写进 unit 持久化
./scripts/wt-kasm stop chrome-1 && ./scripts/wt-kasm start chrome-1
./scripts/wt-kasm verify chrome-1                    # 期望 12/12
```

要点：manager **只核镜像在位**，起容器用 `--pull never`（`compose.py:130-139,327`），
本仓库运行面从不 build / pull。认领按 `Config.Image` **逐字相等**比对
（不 strip tag、不按仓库前缀放宽、不 fallback digest，`compose.py:274-308`）⇒
换 tag 后旧容器会被判「image 不符」而拒绝认领，需先 `stop` 再起。
逐桌灰度用 `WT_KASM_ADAPTIVE_IMAGE` + `WT_KASM_ADAPTIVE_PROJECT_SUFFIX`
（只作用于 `resize_mode=auto` 的桌，§5.5）。
`install-manager.sh` 重装会从 `manager.config` 现值生成 `Environment=` 行 ⇒
**升级镜像引用必须带 env 重装**，否则 unit 被写回默认值。

### 12.2 回滚（旧容器保留策略 + 人工恢复顺序）

**保留策略**：本通道**永不删除容器**。迁移类工具只执行三条写命令
`docker update --restart=no <cid>` → `docker rename <cid> wt-kasm-<id>-prior-<line>-<UTC-stamp>`
→ `docker stop -t 30 <cid>`，台账 / `desktop.cid` / 旧 `compose.yaml` 归档进
/data/.trash/<线>-<stamp>-<desk>`（该口径记录在 `production/` 线的 README = **仓库外文档**，本仓库不含）。
**无自动回滚**：FAIL 保现场，恢复由运维决策。

人工恢复顺序（**必须照此做**，直接 rename 回原名会冲突）：

```bash
# 1) 处置现容器（它占着原名 wt-kasm-<id>）
docker stop wt-kasm-<id>
docker rename wt-kasm-<id> wt-kasm-<id>-rollback-$(date -u +%Y%m%dT%H%M%SZ)
# 2) 恢复留证容器原名与重启策略
docker rename wt-kasm-chrome-1-prior-k012-<stamp> wt-kasm-chrome-1
docker update --restart=unless-stopped wt-kasm-chrome-1
docker start wt-kasm-chrome-1
# 3) 把 unit 的 WT_KASM_IMAGE / WT_KASM_PROJECT_SUFFIX 写回旧值（§12.1），然后复跑 12 项
./scripts/wt-kasm verify chrome-1
```

appshare 目录与凭证未动、可直接复用；`generation` 随 Xvnc 每次启动换代（属预期，
恢复后 `verify` 的「X 归属核对」会看到新值）。

### 12.3 日志与台账位置

| 内容 | 位置 |
|---|---|
| daemon | `<APP_ROOT>/logs/daemon.log`；台账 `<APP_ROOT>/state/daemon.pid` |
| X11 relay | `<APP_ROOT>/logs/relay-<desk>.log`；台账 `<APP_ROOT>/state/<desk>/relay.pid` |
| 宿主应用 | `<APP_ROOT>/logs/app-<desk>-<app>.log`；台账 `<APP_ROOT>/state/<desk>/app-<app>.pid` |
| dispatcher（unit 形态） | journal：`journalctl --user -u wt-kasm-dispatcher` |
| dispatcher（脚本形态） | `<APP_ROOT>/logs/dispatcher.stderr.log`；五元组台账 `<APP_ROOT>/dispatcher/dispatcher.state` |
| 容器健康历史 | dockerd 记账（`inspect` 的 `State.Health.Log`，`compose.py:160-209` 一并捕） |
| 桌面图标层 | 容器内 `$HOME/.local/state/wtk-pcmanfm.log` |
| 删除归档 | `/data/.trash/`（零 rm 纪律） |

### 12.4 备份要备份什么

`<APP_ROOT>/desktops/<id>/config/`（容器 `/config`：abc 的会话与配置）、
`<APP_ROOT>/desktops/<id>/apps/chrome/profile/`（**私有 Chrome profile**，登录态与扩展在这里）、
`<APP_ROOT>/desktops/`（渲染出的 `compose.yaml` = 意图面）、
systemd unit 与其 drop-in（`WT_KASM_IMAGE` / `WT_KASM_PROJECT_SUFFIX` / `WTK_BROWSER_ORIGIN`
的**持久化现势只在这里**，不在仓库）、镜像 digest 记录、
`<APP_ROOT>/registry.json` 与 `<APP_ROOT>/state/`（诊断面，可重建）。
**不需要**备份 `<desk>/runtime/`（X socket / appshare 凭证 / `launch.sock` 每次启动生成，
由镜像 init 与 manager 重建）。

## 13. 已知限制与未覆盖（如实列出）

1. **宿主桥图标（`Chrome`）双击依赖宿主应用与 `launch.sock` 已就位**：manager 未起、卷未挂、
   `appId` 未注册 ⇒ `wtk-launch` 退出码 3 / 4 / 5。**不提供「双击恢复」**：图标点击失败后
   由 manager 的 `app start` / `app focus` 恢复，容器侧无自愈逻辑。容器内图标
   （`Chrome（容器内）`）不受此限制（§6.5），它的双击只依赖镜像内的 apk `chromium`。
2. **Kasm 1.1 客户端在 iframe 内默认 `resize=off`**，URL query 优先于 localStorage
   ⇒ **无参 URL 的 iframe 表现未验证**。本项目不承诺「URL 无参即随 iframe 自适应」：
   服务端许可（本镜像 argv 不传 `-AcceptSetDesktopSize` = 原生 accept）、
   客户端是否请求（未验）、入口是否注入（`WTK_NATIVE_DEFAULT_MODE`）是三层独立事实，
   许可打开而客户端不请求 = 两侧像素都不变。
3. **某虚拟工作区（current desktop ≠ 0）下 tint2 可能不渲染任务按钮**：现象已复现、
   **根因未定位**。规避 = 在窗口管理器里切回主工作区（desktop 0），已验证任务钮恢复渲染
   且可点切换。正证范围只到主 workspace 0 ⇒ 不承诺切到其它 workspace 可用。
4. **单 tab 的 Chrome profile 里不要用 `Ctrl+W` 收尾**：会关掉整个浏览器（已复现事故，
   随后由 launcher 重取得到新 pid）。收尾只用 `Ctrl+L` 覆盖地址栏；要「新开 tab 测后关闭」
   必须先确认真有第二个 tab。
5. **容器不提供开机自愈 / 应用自启**：宿主应用与每桌 X11 relay 由 manager 按需拉起，
   容器由 `restart: unless-stopped` + docker 守护负责，daemon **不做 keepalive 循环**
   （`manager/daemon.py:8`）。「宿主机重启后是否可用」属未验证面，不得声称。
6. **宿主桥 Chrome 依赖宿主侧就位**：桥接的 Chrome 由宿主提供并经 appshare 接入
   （`manager/hostapps.py:583-620` 固定 argv（`--url` 只收 http/https 绝对 URL，§6.4）+ 私有 profile + 版本期望 `153.0.8010.12`）。
   没有宿主 Chrome 时，`Chrome` 图标点了会失败（退出码 3/4/5，§6.2）；此时桌面仍有
   **容器内 Chromium 112** 可用（`Chrome-Local` 图标，§6.5）——纯色底 + 任务栏 + 可起的浏览器。
   容器内通道自身的限制（112 版本较旧、`--no-sandbox`、profile 随桌共享）见 §6.5 末段。
7. **native 变体镜像按旧 attestation 契约不可签发**：`manager/attest.py` 的 gate B 要求
   Xvnc argv 出现 `-AcceptSetDesktopSize <声明值>` 并与声明一致，gate D 要求镜像内两份件
   字节 == canonical 源树字节 ⇒ 本镜像 argv 无该旗标即拒（**无绕过面**：未改 attest、
   未加跳过开关）。可用形态 = **无显式几何声明的 legacy 桌**（该分支从不调用认证链）；
   带显式几何的桌请用 canonical 规范镜像（`docker/healthcheck.sh:42-50`）。

8. **`WTK_ENABLE_ADAPTIVE_PREVIEW=1` 的每桌画面 WS 名额是 per-process 计数**（预留 + 已连接
   合并计数只在单 dispatcher 进程内成立，跨进程不共享）⇒ 只适用隔离测试环境（§9.3 同限）。
   registry mtime 新鲜度证据的可观察有效期**最长约 180s**（90s 刷新周期 ×3 门 + 90s 健康证据
   年龄上界，`dispatcher/lib/registry.js:26-31`），不得叙述成「90s 内确认存活」。

9. **运行时字体判据仍是弱判**：容器 healthcheck 第 9 门只断言
   `fc-match sans-serif:lang=zh-cn` 的 family[0] **非空且不含 DejaVu**
   （`docker/healthcheck.sh:208-211`），**不逐字比对** `Noto Sans CJK SC`。逐字硬断言只发生在
   构建期门禁（§4 第 9 项）⇒ 容器起来之后字体策略被后续层 / 手工放进的 conf 破坏
   （例如落回 JP 族）healthcheck 不会告警。复核手段 = §11 第 5b 条那条命令。

**非全功能验收**（以上九条之外，本文未验，不得当已通过引用）：公开域名 + 登录态下的端到端
桌面会话（网关登录链未测）；`auto` / `fixed` 几何桌的实机 GUI；tint2 在帧缓冲尺寸变化下的
reflow（本镜像全程以注入尺寸运行，变尺寸路径未验收）；音频按钮在非 1600 宽度下的布局
（校准按 `scaleX = w/1600`）；音频「人耳听感」（本文件的量化口径是页面内 FFT，不等于试听）。
`verify` 12/12 与容器 healthy 只等于 3 级。

## 14. 许可与商标

- 本仓库代码：`Apache-2.0`。
- `jsmpeg`（`docker/audio/web/jsmpeg.min.js`，vendored minified bundle）：**MIT**，
  Copyright (c) 2017 Dominic Szablewski；许可证文本随件在
  `docker/audio/web/LICENSE-jsmpeg.txt`。
- dispatcher 包清单自述 `license: MIT`（`dispatcher/package.json:7`）。
- 基座镜像 `ghcr.io/linuxserver/baseimage-kasmvnc`（按 digest 钉死）及其内含组件
  （KasmVNC、Openbox、tint2、pcmanfm、PulseAudio、nginx、s6-overlay）各遵其上游许可证
  （KasmVNC 本体由 Kasm Technologies 以 GPL 家族发布）；本仓库不改变其条款。
- 完整第三方声明（含图标取源与逐件 SHA256）见仓库根 `NOTICE`；Apache-2.0 全文见 `LICENSE`。
- **Chromium 与 Google Chrome 的名称与商标属各自权利人**（Chromium 属 Chromium project /
  Google LLC，Chrome 属 Google LLC）。桌面图标用的是 Chromium 项目的**开源** product logo
  （`chrome/app/theme/chromium/product_logo_256.png`；`NOTICE` 记录钉死 revision 与产物
  SHA256），仅用于标注该启动器图标：**无任何商标主张，也不隐含赞助、隶属或背书**。
