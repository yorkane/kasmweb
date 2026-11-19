#!/usr/bin/env bash
# install-manager.sh — 安装 wt-kasm 管理面（部署骨架 + daemon + systemd --user unit）
#
# 默认 = 用户级安装（uid1000 aigc）：写 ~/.config/systemd/user/wt-kasm-manager.service，
#   用显式 XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS 调 systemctl --user。
# WT_KASM_INSTALL_MODE=root：装 /etc/systemd/system/ 同名 unit（需免密 sudo，
#   User/Group = 运行本脚本的账号，即 id -un / id -gn；不写死任何机器专属用户名）。
# 两种模式都绝不触碰 wdev.service / codex-desktop-gateway / 3737 网关 / 他人容器。
set -euo pipefail

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
MODE="${WT_KASM_INSTALL_MODE:-user}"
APP_ROOT="${WT_KASM_APP_ROOT:-/data/app/webtop-kasmvnc}"
PUSH="${WT_KASM_PUID:-$(id -u)}"
PGRP="${WT_KASM_PGID:-$(id -g)}"
PY="${WT_KASM_PYTHON:-$(command -v python3)}"
XDG_RUNTIME_DIR="/run/user/$PUSH"
DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$PUSH/bus"
export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺依赖: $1" >&2; exit 2; }
}
for c in docker flock socat xdotool xprop xwininfo ss dbus-run-session; do need "$c"; done
[ -x "$PY" ] || { echo "python3 不可执行: $PY" >&2; exit 2; }
# PyYAML 预检：daemon 的 compose 渲染（manager/compose.py import yaml）在启动期才
# 暴露 ModuleNotFoundError ⇒ unit 起来又崩，日志里才看得见。安装前一次性验明，
# 缺失直接给出可执行的修复指令。
"$PY" -c 'import yaml' >/dev/null 2>&1 || {
  echo "缺依赖: python3 yaml 模块（PyYAML）⇒ 安装它（apt/pip install pyyaml）后重装" >&2
  exit 2
}
IMAGE=$(cd "$ROOT" && "$PY" -c "import manager.config as c; print(c.IMAGE)")
[ -n "$IMAGE" ] || { echo "读取 manager.config.IMAGE 失败" >&2; exit 2; }
PSUF=$(cd "$ROOT" && "$PY" -c "import manager.config as c; print(c.PROJECT_SUFFIX)")
SUF_LINE="Environment=WT_KASM_PROJECT_SUFFIX=$PSUF"
if [ -n "$PSUF" ]; then
  echo "  project 后缀 = $PSUF（unit 持久化，无需每命令 export）"
fi

echo "[1/6] 部署骨架 $APP_ROOT"
mkdir -p "$APP_ROOT/desktops" "$APP_ROOT/state" "$APP_ROOT/logs" "$APP_ROOT/sock"
mkdir -p /data/tmp/webtop-channel-port-locks
chmod 770 "$APP_ROOT" /data/tmp/webtop-channel-port-locks || { echo "chmod 770 失败" >&2; exit 3; }
for pth in "$APP_ROOT" /data/tmp/webtop-channel-port-locks; do
  mode=$(stat -c %a "$pth")
  [ "$mode" = 770 ] || { echo "权限位不是 770: $pth = $mode" >&2; exit 3; }
done

echo "[2/6] init 延后：init 走 daemon 控制 socket，必须等 unit 起来后在 [4/6] 执行"

echo "[3/6] systemd unit（mode=$MODE）"
UNIT_BODY="[Unit]
Description=wt-kasm K-route KasmVNC desktop manager (vcmi/chrome-1/chrome-2)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
# KillMode=process：daemon 会作为父进程 spawn relay/chrome/vcmi，
# 它们与 daemon 同 cgroup。默认 control-group 让 restart 连带杀掉
# 全部活性桌面应用（台账仍在 ⇒ 重启后由台账/端口复核接管）。
KillMode=process
WorkingDirectory=$ROOT
Environment=PYTHONPATH=$ROOT
Environment=WT_KASM_APP_ROOT=$APP_ROOT
Environment=WT_KASM_PUID=$PUSH
Environment=WT_KASM_PGID=$PGRP
Environment=WT_KASM_IMAGE=$IMAGE
$SUF_LINE
ExecStart=$PY -m manager.cli daemon --foreground
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0027

[Install]
WantedBy=default.target"

if [ "$MODE" = root ]; then
  sudo -n true || { echo "免密 sudo 不可用 ⇒ 请用默认 user 模式" >&2; exit 2; }
  TMPUNIT=$(mktemp -p /data/tmp)
  printf '%s\nUser=%s\nGroup=%s\n' "$UNIT_BODY" "$(id -un)" "$(id -gn)" > "$TMPUNIT"
  sudo -n cp "$TMPUNIT" /etc/systemd/system/wt-kasm-manager.service
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now wt-kasm-manager.service
  mv "$TMPUNIT" "/data/.trash/wt-kasm-installer-tmp-$(date -u +%Y%m%dT%H%M%SZ)"
  echo 'unit = /etc/systemd/system/wt-kasm-manager.service'
else
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  if [ ! -S "/run/user/$PUSH/bus" ]; then echo "user bus socket 不存在: /run/user/$PUSH/bus ⇒ systemctl --user 不可用" >&2; exit 2; fi
  printf '%s\n' "$UNIT_BODY" > "$UNIT_DIR/wt-kasm-manager.service"
  systemctl --user daemon-reload
  systemctl --user enable --now wt-kasm-manager.service
  echo "unit = $UNIT_DIR/wt-kasm-manager.service"
fi

echo "[4/6] 健康检查（daemon pidfile + 控制 socket）+ init（写 compose/registry，不启动容器）"
i=0
while [ "$i" -lt 30 ]; do
  if "$HERE/wt-kasm" daemon status | grep -q '"running": true'; then break; fi
  i=$((i + 1)); sleep 1
done
if ! "$HERE/wt-kasm" daemon status | grep -q '"running": true'; then
  echo 'daemon 未登记 pidfile ⇒ 看 logs/daemon.log 与 journalctl --user -u wt-kasm-manager' >&2
  exit 3
fi
WT_KASM_APP_ROOT="$APP_ROOT" WT_KASM_PUID="$PUSH" WT_KASM_PGID="$PGRP" \
  "$HERE/wt-kasm" init >/dev/null
test -f "$APP_ROOT/desktops/chrome-1/compose.yaml"
test -f "$APP_ROOT/registry.json"
"$HERE/wt-kasm" --json registry | "$PY" -c 'import json,sys; d=json.load(sys.stdin)["data"]; assert d["schemaVersion"]==1 and len(d["desktops"])==3; print("  registry OK: 3 desktops")'

echo "[5/6] 镜像门禁 $IMAGE（本脚本绝不 build / pull）"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  IID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
  echo "  $IMAGE 已就位 imageID=$IID ⇒ 可 wt-kasm start vcmi|chrome-1|chrome-2（记账按 imageID，不按 tag）"
else
  echo "  $IMAGE 未出现（image worker 负责）⇒ start 按 failclosed 拒绝，属预期"
  echo "  0.1.0 按 root 裁决冻结保留不覆盖；回退 = WT_KASM_IMAGE=webtop-kasmvnc:0.1.0 重装"
fi

echo "[6/6] 完成"
echo "控制 socket: $APP_ROOT/sock/control.sock"
echo "消费契约  : $APP_ROOT/registry.json"
echo "日志      : $APP_ROOT/logs/ 下的 daemon.log / relay-*.log / app-*.log"
echo "消费地址  : http://127.0.0.1:25320/desktop/<id>/（25320 dispatcher 由 dispatcher 路线持有）"
echo "state=running 只代表 backend HTTP 200；GUI 实证由 root/tester 截图验收"
