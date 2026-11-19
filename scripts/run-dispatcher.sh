#!/usr/bin/env bash
# run-dispatcher.sh — K 线 KasmVNC dispatcher 启停 / 状态 / 预检（不安装 unit、不动容器、不动他人服务）
#
# 用法: run-dispatcher.sh precheck | start | stop | status | install-hint | test
#
# 边界（root 2026-11-13 审查要求，逐条落实）：
#   1) 端口锁与 S 线共用同一把 flock = /data/tmp/webtop-channel-port-locks/port-<P>.lock
#   2) 占用判定含 stopped-but-published 容器（docker inspect PortBindings = 逻辑预留）
#   3) bind 自证：真 bind 一次再释放，锁 fd 覆盖整个「预检 + bind」过程
#   4) unit 归属检查：同名 unit 必须含本包 ExecStart 指纹，否则拒绝视为本服务（不覆盖他人）
#   5) 本脚本绝不安装 / enable / copy unit 到 systemd 目录；只打印安装命令给人执行
#   6) node 钉死绝对路径；二进制绝对路径优先
#  运维安全（root 2026-11-13 11:0x 审查 P1 四条，逐条落实）：
#   a) start 先跑**全状态** precheck（TCP 全状态 + docker published 含 stopped），再 bind 自证
#   b) 端口锁 fd9 持续到「监听 + /healthz + 登记台账」全部通过才释放；子进程 9>&- 不继承锁
#   c) stop 用五元组台账（pid + comm + exe + starttime + argv）逐项复核，SIGKILL 前再核一次；
#      台账归档进 /data/.trash/，不在部署目录留 .dead
#   d) systemctl --user 显式写死 bus 地址，不继承可能被置为 disabled 的环境变量
set -euo pipefail

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
DISP_DIR="$ROOT/dispatcher"
# node 解析：WTK_NODE 显式覆盖 > PATH 上的 node；必须可执行且主版本 >= 18
# （dispatcher 线用 node:test 等现代 API，18 是实测下界）。找不到就明确报错
# 退出，绝不回退到任何机器专属的私有路径。
NODE_BIN="${WTK_NODE:-}"
if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node || true)"; fi
if [ -z "$NODE_BIN" ]; then
  echo "[dispatcher] FATAL: 未找到 node：装 node>=18 进 PATH，或用 WTK_NODE=<绝对路径> 指定" >&2
  exit 2
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "[dispatcher] FATAL: node 不可执行: $NODE_BIN" >&2
  exit 2
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in (*[!0-9]*|'') NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[dispatcher] FATAL: node 版本 $("$NODE_BIN" --version 2>/dev/null) 低于 18（WTK_NODE=$NODE_BIN）" >&2
  exit 2
fi
APP_ROOT="${WTK_APP_ROOT:-/data/app/webtop-kasmvnc}"
LOCK_DIR="${WTK_PORT_LOCK_DIR:-/data/tmp/webtop-channel-port-locks}"
PORT="${WTK_PORT:-25320}"
HOST="${WTK_LISTEN_HOST:-127.0.0.1}"
REGISTRY="${WTK_REGISTRY:-$APP_ROOT/registry.json}"
UNIT_NAME="wt-kasm-dispatcher"
UNIT_SRC="$DISP_DIR/systemd/$UNIT_NAME.service"
COPY_DIR="$APP_ROOT/dispatcher"
LEDGER="$COPY_DIR/dispatcher.state"
TRASH_ROOT="${WTK_TRASH:-/data/.trash}"
STD_LOG="$APP_ROOT/logs/dispatcher.stderr.log"
# 归属指纹 = 模板静态内容（server.js 路径 + WTK_PORT 行本体）。
# WTK_PORT 取 UNIT_SRC 模板里的**键行全文**（当前 25320），不取运行时 $PORT：
# 运维用 WTK_PORT 覆盖端口跑 status/precheck 时，unit 文件内容不会变，指纹也不该变，
# 否则会把"已安装且归属正确"的 unit 误判成"归属未证实"。
UNIT_PORT_LINE=$(grep -E '^Environment=WTK_PORT=[0-9]+$' "$UNIT_SRC" | head -n1)
[ -n "$UNIT_PORT_LINE" ] || die "unit 模板 $UNIT_SRC 缺 Environment=WTK_PORT=<n> 行（指纹来源丢失）"
MARKERS=("server.js" "$UNIT_PORT_LINE")

die() { echo "[dispatcher] $*" >&2; exit 2; }
info() { echo "[dispatcher] $*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺依赖: $1"; }
for c in flock ss docker curl; do need "$c"; done
[ -x "$NODE_BIN" ] || die "node 不可执行: $NODE_BIN"
[ -f "$DISP_DIR/server.js" ] || die "缺 server.js: $DISP_DIR/server.js"
case "$HOST" in 127.0.0.1|localhost) ;; *) die "只允许 loopback 监听，收到: $HOST" ;; esac

# 显式写死：继承来的 DBUS_SESSION_BUS_ADDRESS 可能是 systemd 注入的 disabled 形态（`unix:`），
# 那会让 systemctl --user 报 Connection refused 并被误读成「服务没起」。
systemctl_user() {
  env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR="/run/user/$(id -u)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
    systemctl --user "$@"
}

# 只判**本端 LISTEN**：全状态 `ss -tanH` 会把自家 curl 留下的 TIME-WAIT **客户端**连接
# （对端端口 = $PORT）当成占用 ⇒ 自锁。逻辑预留由下面的 docker 检查单独承担。
tcp_listeners() {
  ss -ltnH 2>/dev/null | awk -v p=":$PORT" '{ if ($4 ~ p"$") print }' || true
}

docker_publisher_names() {
  local cid js
  for cid in $(docker ps -a --no-trunc -q 2>/dev/null); do
    js=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$cid" 2>/dev/null) || continue
    case "$js" in *"\"$PORT\""*) printf '%s %s\n' "$(docker inspect -f '{{.Name}}' "$cid" | tr -d '/')" "$cid" ;; esac
  done
  return 0
}

precheck() {
  local fail=0 l dn
  info "1) 监听地址 = $HOST:$PORT（loopback-only 硬校验）"
  info "2) TCP 占用（全状态）"
  l=$(tcp_listeners)
  if [ -n "$l" ]; then info "FAIL 已有监听:"; printf '%s\n' "$l" | sed 's/^/    /'; fail=1; else info "  无监听"; fi
  info "3) docker published 预留（含 stopped 容器 = 逻辑预留）"
  dn=$(docker_publisher_names)
  if [ -n "$dn" ]; then info "FAIL 容器预留:"; printf '%s\n' "$l$dn" | sed 's/^/    /'; fail=1; else info "  无预留"; fi
  info "4) registry 可读性"
  if [ -f "$REGISTRY" ]; then
    "$NODE_BIN" -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(d.desktops))process.exit(3);console.log("    desktops="+d.desktops.length+" schemaVersion="+d.schemaVersion)' "$REGISTRY" \
      || info "FAIL registry 解析失败（dispatcher 侧会降级为未登记页，不崩）"
  else
    info "  registry 不存在 ⇒ 启动后显示未登记页（200，不崩）"
  fi
  info "5) 依赖树 require 自检"
  ( cd "$DISP_DIR" && "$NODE_BIN" -e 'require("./server")' ) && info "  require OK" || { info "FAIL require"; fail=1; }
  [ "$fail" = 0 ] || die "预检未通过"
  info "预检通过"
}

bind_selftest() {
  mkdir -p "$LOCK_DIR"
  local lock="$LOCK_DIR/port-$PORT.lock"
  exec 9>"$lock"
  # 必须带 -n：无 -n 的 flock 会排队阻塞，把「禁止抢占」变成「排队抢占」
  flock -n 9 || die "端口锁未获得: $lock（S/K 共用，禁止抢占、禁止排队）"
  "$NODE_BIN" -e "const s=require('http').createServer((q,r)=>{r.end('x')});s.on('error',e=>{console.error('bind fail: '+(e.code||e.message));process.exit(4)});s.listen($PORT,'127.0.0.1',()=>{console.log('bind ok port='+s.address().port);s.close(()=>process.exit(0))})" \
    || die "bind 自证失败"
}

unit_ownership_check() {
  local out m
  if ! out=$(systemctl_user cat "$UNIT_NAME" 2>/dev/null); then
    info "unit 未安装（正常：本脚本不安装 unit）"
    return 0
  fi
  for m in "${MARKERS[@]}"; do
    case "$out" in *"$m"*) ;; *) die "已存在 $UNIT_NAME 但不含指纹 [$m] ⇒ 归属未证实，拒绝当本服务（请人工核对）" ;; esac
  done
  info "unit 归属证实（指纹全命中）"
}

install_hint() {
  mkdir -p "$COPY_DIR"
  install -m 644 "$UNIT_SRC" "$COPY_DIR/$UNIT_NAME.service"
  local rendered="$COPY_DIR/$UNIT_NAME.service.rendered"
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__DISPATCHER_DIR__|$DISP_DIR|g" "$UNIT_SRC" >"$rendered"
  sha256sum "$rendered" | sed 's/^/[dispatcher] rendered sha256 /'
  cat <<HINT
[dispatcher] unit 模板 + 渲染件已放 $COPY_DIR
[dispatcher] 安装命令（由人执行；本脚本绝不安装）：
  install -Dm644 $rendered ~/.config/systemd/user/$UNIT_NAME.service
  env XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus systemctl --user daemon-reload
  env XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus systemctl --user enable --now $UNIT_NAME
HINT
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# ---- 五元组身份台账（PID 复用保护）----
# comm 白名单：node v24 把主线程 comm 改成 MainThread，故登记现场观测值并允许两者
ALLOWED_COMMS="node MainThread"
start_time() { # /proc/<pid>/stat 字段 22；comm 可含空格与括号 ⇒ 以最后一个 ')' 为界
  local p=$1 rest
  rest=$(sed -e 's/^.*) //' "/proc/$p/stat" 2>/dev/null) || return 1
  set -- $rest
  eval "echo \${20:-}"
}
proc_argv() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | sed -e 's/ *$//'; }

# 现场身份 → 规范五元组文本（与登记台账逐字段比对）
proc_identity() {
  local p=$1 comm exe st argv
  comm=$(cat "/proc/$p/comm" 2>/dev/null) || return 1
  exe=$(readlink "/proc/$p/exe" 2>/dev/null) || return 1
  st=$(start_time "$p") || return 1
  argv=$(proc_argv "$p") || return 1
  printf 'pid=%s\ncomm=%s\nexe=%s\nstarttime=%s\nargv=%s\n' "$p" "$comm" "$exe" "$st" "$argv"
}

# ledger 格式：key=value 五行（pid/comm/exe/starttime/argv），argv 原样含空格
# pipefail 下 sed 读不到台账（rc2）会穿透到调用侧赋值语句触发 set -e 静默退出
# ⇒ 末尾 || true 把"无台账"归一成空串
ledger_get() { { sed -n "s/^$1=//p" "$LEDGER" 2>/dev/null || true; } | tail -1; }
ledger_pid() { ledger_get pid; }

identity_matches() { # $1=pid；五元组逐项比对台账
  local p=$1 field want got
  pid_alive "$p" || return 1
  local id
  id=$(proc_identity "$p") || return 1
  for field in pid comm exe starttime argv; do
    want=$(ledger_get "$field")
    got=$(printf '%s\n' "$id" | sed -n "s/^$field=//p")
    [ -n "$want" ] || { info "台账缺字段 $field ⇒ 判不匹配"; return 1; }
    if [ "$field" = comm ]; then
      case " $ALLOWED_COMMS " in *" $got "*) ;; *) info "comm=[$got] 不在白名单 ⇒ 判不匹配"; return 1 ;; esac
      [ "$got" = "$want" ] || { info "comm 变档 $want→$got（node 线程名可变，放行）"; }
      continue
    fi
    [ "$got" = "$want" ] || { info "$field 不一致：台账[$want] 现场[$got] ⇒ 判不匹配"; return 1; }
  done
  return 0
}

write_ledger() { # $1=pid；启动验收通过后原子登记
  local tmp="$LEDGER.tmp-$$"
  proc_identity "$1" >"$tmp" || { rm_ok "$tmp"; die "台账读取现场身份失败 pid=$1"; }
  mv -T "$tmp" "$LEDGER"
}

rm_ok() { # 零 rm：台账临时件移进 trash
  [ -f "$1" ] || return 0
  mkdir -p "$TRASH_ROOT/webtop-kasm-dispatcher-ledger"
  mv "$1" "$TRASH_ROOT/webtop-kasm-dispatcher-ledger/$(basename "$1").$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
}

cmd_status() {
  unit_ownership_check
  local pid; pid=$(ledger_pid)
  if pid_alive "$pid" && identity_matches "$pid"; then
    info "manual 实例 pid=$pid 身份相符；/healthz = $(curl -fsS --max-time 3 "http://$HOST:$PORT/healthz" 2>/dev/null || echo '未应答')"
  elif pid_alive "$pid"; then
    info "台账 pid=$pid 存活但身份五元组不符 ⇒ 判 PID 复用，台账作废（不杀）"
  else
    info "无 manual 实例（台账缺失或进程不在）"
  fi
  info "unit active = $(systemctl_user is-active "$UNIT_NAME" 2>/dev/null || echo unknown)"
}

cmd_start() {
  mkdir -p "$COPY_DIR" "$APP_ROOT/logs"
  local pid; pid=$(ledger_pid)
  # set -e 下裸 AND 列表会把「无台账」判为整体失败 ⇒ 一律用 if 块（静默 rc2 是陷阱）
  if pid_alive "$pid" && identity_matches "$pid"; then die "已在运行 pid=$pid（不重复启动）"; fi
  if pid_alive "$pid"; then info "台账 pid=$pid 身份不符 ⇒ 判 PID 复用，台账归档后继续"; archive_ledger "stale"; fi
  # 同端口 unit 在跑 ⇒ 拒绝 manual 抢锁（非本端口不影响）
  if systemctl_user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    local up
    up=$(systemctl_user show -p Environment "$UNIT_NAME" 2>/dev/null \
      | tr ' ' '\n' | sed -n 's/^WTK_PORT=//p' | head -1)
    [ "${up:-}" = "$PORT" ] \
      && die "unit 正跑在 $PORT ⇒ 拒绝 manual 抢端口（改请用 systemctl --user restart $UNIT_NAME）"
    info "unit active 但端口=$up ≠ $PORT ⇒ 继续"
  fi
  # P1-2：全状态预检（TCP 全状态 + docker published 含 stopped）先于 bind
  precheck
  bind_selftest
  info "锁 + bind 自证通过 ⇒ 启动"
  local tmppid="$APP_ROOT/logs/.starting-pid-$$"
  # P1-3：子进程 9>&- 关掉继承的锁 fd ⇒ 锁只由本 shell 持有，直到监听 + healthz + 登记全部通过
  WTK_LISTEN_HOST="$HOST" WTK_PORT="$PORT" WTK_REGISTRY="$REGISTRY" \
  WTK_PUBLIC_ORIGIN="${WTK_PUBLIC_ORIGIN:-http://$HOST:$PORT}" \
    setsid --fork sh -c 'echo $$ > "$1"; exec "$2" "$3" >>"$4" 2>&1 9>&-' \
      sh "$tmppid" "$NODE_BIN" "$DISP_DIR/server.js" "$STD_LOG"
  local i=0 hp="" newpid=""
  while [ $i -lt 40 ]; do
    sleep 0.25; i=$((i+1))
    [ -s "$tmppid" ] && newpid=$(tr -dc '0-9' < "$tmppid")
    [ -n "$newpid" ] && ! pid_alive "$newpid" && break
    hp=$(curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" 2>/dev/null) && break
    hp=""
  done
  rm_ok "$tmppid"
  [ -n "$newpid" ] || die "未写入 pid（启动即退出？见 $STD_LOG）"
  pid_alive "$newpid" || die "启动即退出，见 $STD_LOG"
  # P1-3：监听 + /healthz 双验通过后才登记台账
  [ -n "$hp" ] || die "启动后 /healthz 无应答，见 $STD_LOG"
  write_ledger "$newpid"
  flock -u 9 2>/dev/null || true   # 登记完成后才释放端口锁
  info "OK pid=$newpid [$hp] 台账 $LEDGER 日志 $STD_LOG"
}

archive_ledger() {
  [ -f "$LEDGER" ] || return 0
  local dst="$TRASH_ROOT/webtop-kasm-dispatcher-ledger"
  mkdir -p "$dst"
  mv "$LEDGER" "$dst/dispatcher.state.$1-$(date -u +%Y%m%dT%H%M%SZ)"
  info "台账归档（零 rm，不入部署目录）: $dst/dispatcher.state.$1-*"
}

cmd_stop() {
  local pid; pid=$(ledger_pid)
  pid_alive "$pid" || { info "无 manual 实例"; archive_ledger "no-proc"; return 0; }
  identity_matches "$pid" || die "pid=$pid 五元组与台账不符 ⇒ 判 PID 复用，拒杀（请人工核对台账）"
  info "stop pid=$pid comm=$(ledger_get comm) exe=$(ledger_get exe) starttime=$(ledger_get starttime)"
  kill -TERM "$pid"
  local i=0
  while pid_alive "$pid" && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
  if pid_alive "$pid"; then
    # SIGKILL 前再核一次五元组：进程若已换人，绝不补刀
    identity_matches "$pid" || die "KILL 前复核不通过（pid 已被复用）⇒ 停手，台账留存"
    kill -KILL "$pid"; info "SIGKILL 兜底"
  fi
  archive_ledger "stopped"
  info "已停止"
}

cmd_test() {
  cd "$DISP_DIR"
  local L="${WTK_TEST_LOG:-/data/tmp/webtop-kasmvnc-dispatcher-selftest/t.log}"
  mkdir -p "$(dirname "$L")"
  info "node --test（全随机端口，不占 $PORT）→ $L"
  if [ ! -d test ]; then
    die "测试线未随包发布（无 $DISP_DIR/test/）：node --test 不可用；请从上游取 dispatcher/test/ 后重试"
  fi
  local rc=0
  timeout "${WTK_TEST_TIMEOUT:-240}" "$NODE_BIN" --test test/ >"$L" 2>&1 || rc=$?
  grep -E '^# (tests|pass|fail|cancelled|skipped)|^ℹ (tests|pass|fail)' "$L" || tail -20 "$L"
  return $rc
}

case "${1:-}" in
  precheck) precheck ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  install-hint) install_hint ;;
  test) cmd_test ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
