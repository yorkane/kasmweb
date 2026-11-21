#!/usr/bin/env bash
# release-acceptance.sh — kasmweb 发布前自检套件（行为层；静态层见 verify-image-layout.sh）
#
# 覆盖的接入面（每个用例都是 4 级之前的「活体」断言，FAIL 即阻断发布）：
#   password-login   口令门面（TLS+BasicAuth）在链路前时，桌面入口仍完整可用
#   https-cert-mount  证书由挂载文件提供（握手成功 + 证书身份可核）
#   cdp-connect      宿主 Chrome 的 CDP 端点可连（--test-cdp → /json/version）
#   cdp-relay        CDP 端点在宿主 loopback、不进容器、三处端口一致
#   cdp-relay-bind   CDP relay 绑 0.0.0.0 + token 门（跨主机可达 / 404 / fail-closed 负例）
#   dir-mount        三个 bind（x11 / appshare / config）双向可见 + 缺 appshare ⇒ 容器起不来
#   two-level-path   桌面在二级目录 /desktop/<id>/ 下全通（页面 / 注入件 / websockify / 404 边界）
#   regression       deploy.md §11 的可自动化项（healthz / 规范 302 / 参数矩阵 / 后端 200 /
#                    healthcheck / 字体 / 容器内 Chromium / manager verify）
#
# 边界（写在 deploy.md §11.1，勿误读）：
#   * 口令与 TLS **不在镜像内**：Xvnc 固定 -SecurityTypes None -disableBasicAuth -sslOnly 0，
#     认证与 TLS 终结归上游网关。本套件验的是「门面在链路前时桌面入口仍完整可用」，
#     并断言镜像侧确实无口令（口径与 deploy.md 一致）。
#   * 目录挂载的契约 = manager 渲染 compose 的三个 bind；宿主数据目录挂进桌面**不在**本契约内。
#
# 用法：
#   scripts/release-acceptance.sh [--image REF] [--case NAME]... [--json-out PATH] [--keep]
# 退出码：0 = 全 PASS/SKIP；1 = 有 FAIL；2 = 用法/前置缺失。
#
# 纪律：rig 全部落在 mktemp -d 里（默认 /data/tmp），端口避让生产（25320/25321-3/6310-2），
#       结束后 rig 目录 mv 进 /data/.trash；不碰 /data/app/webtop-kasmvnc、不重启生产服务、
#       不用 rm 删文件（容器删除仅限本套件自建）、不用 pkill（按 PID 精确 kill）。

set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE="${WTK_ACCEPT_IMAGE:-ghcr.io/yorkane/kasmweb:latest}"
DESK_ID="chrome-acc"          # CDP 钩子要求 desktop id 以 chrome- 开头
PROXY_USER="kasm"
PROXY_PASS="acc-$(date -u +%H%M%S)"
KEEP=0
JSON_OUT=""
SELECTED_CASES=()

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2;;
    --case) SELECTED_CASES+=("$2"); shift 2;;
    --json-out) JSON_OUT="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    -h|--help) usage 0;;
    *) echo "未知参数: $1" >&2; usage 2;;
  esac
done

# ---------------------------------------------------------------- 基础工具
PASS_N=0; FAIL_N=0; SKIP_N=0
SUMMARY=()
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
record() {  # record <STATE> <NAME> <DETAIL>
  local st="$1" name="$2" detail="$3"
  SUMMARY+=("${st}|${name}|${detail}")
  case "${st}" in
    PASS) PASS_N=$((PASS_N+1));;
    FAIL) FAIL_N=$((FAIL_N+1));;
    SKIP) SKIP_N=$((SKIP_N+1));;
  esac
  printf '%-4s %-16s %s\n' "${st}" "${name}" "${detail}"
}
want() {  # want <name>：用例是否被选中
  [ "${#SELECTED_CASES[@]}" -eq 0 ] && return 0
  local c
  for c in "${SELECTED_CASES[@]}"; do [ "$c" = "$1" ] && return 0; done
  return 1
}
port_free() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
pick_port() {  # pick_port <lo> <hi> <preferred>
  local lo="$1" hi="$2" pref="$3" p
  for p in "${pref}" $(seq "${lo}" "${hi}"); do
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  return 1
}
http_code() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || echo 000; }
http_header() {  # http_header <name> <url> [curl args...]
  local name="$1"; shift
  curl -sk -o /dev/null -D - --max-time 10 "$@" 2>/dev/null | tr -d '\r' | awk -v n="${name}" 'BEGIN{IGNORECASE=1} tolower($1) == tolower(n)":" {print substr($0, index($0,":")+2); exit}'
}
json_field() {  # json_field <json> <python expr over d>
  printf '%s' "$1" | python3 -c "import json,sys
d=json.load(sys.stdin)
try:
    print($2)
except Exception as exc:
    print('ERR:%s' % exc)" 2>/dev/null || true
}

# ---------------------------------------------------------------- 前置检查
need() {
  command -v "$1" >/dev/null 2>&1 || { say "缺前置: $1"; return 1; }
}
for bin in docker node python3 curl ss; do
  if ! need "$bin"; then
    echo "FATAL  前置缺失: $bin（套件无法运行）" >&2
    exit 2
  fi
done
python3 -c 'import yaml' >/dev/null 2>&1 || {
  echo "FATAL  python3 缺 PyYAML（manager 依赖）" >&2; exit 2; }
# manager 的端口锁目录硬编码在 /data/tmp（config.py:27）⇒ 宿主必须有可写的 /data/tmp
if ! ( mkdir -p /data/tmp 2>/dev/null && [ -w /data/tmp ] ); then
  echo "FATAL  /data/tmp 不可写（manager 端口锁目录硬编码于 /data/tmp/webtop-channel-port-locks）" >&2
  echo "      CI 修法: sudo mkdir -p /data/tmp && sudo chmod 1777 /data/tmp" >&2
  exit 2
fi
docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
  echo "FATAL  被测镜像不存在: ${IMAGE}" >&2; exit 2; }

# rig 根：优先 WTK_ACCEPT_RIG_DIR，其次 /data/tmp（开发机），最后 $TMPDIR（CI runner 无 /data）
RIG_BASE=""
for cand in "${WTK_ACCEPT_RIG_DIR:-}" /data/tmp "${TMPDIR:-/tmp}"; do
  [ -n "${cand}" ] || continue
  if mkdir -p "${cand}" 2>/dev/null && [ -w "${cand}" ]; then RIG_BASE="${cand}"; break; fi
done
if [ -z "${RIG_BASE}" ]; then echo "FATAL 找不到可写的 rig 目录（WTK_ACCEPT_RIG_DIR / /data/tmp / $TMPDIR）" >&2; exit 2; fi
RIG=$(mktemp -d "${RIG_BASE}/kasmweb-acc-XXXXXXXX")
APP_ROOT="${RIG}/app"
DESK_DIR="${APP_ROOT}/desktops/${DESK_ID}"
CONTAINER="wt-kasm-${DESK_ID}"
MGR_PID=""; DISP_PID=""; PROXY_PID=""; NEG_CONTAINER=""
cleanup() {
  local pid
  # relay(socat) 与宿主 Chrome 是 manager 的子进程，kill manager 不带走它们 ⇒
  # 按命令行里带 rig 路径的进程逐个精确 kill（枚举 PID，不用 pkill）。
  if [ -n "${APP_ROOT}" ] && [ -d "${APP_ROOT}" ]; then
    for pid in $(pgrep -f "${APP_ROOT}" 2>/dev/null || true); do
      [ "${pid}" = "$$" ] && continue
      kill "${pid}" 2>/dev/null || true
    done
  fi
  # CDP relay 是 setsid 独立进程，命令行不含 rig 路径 ⇒ 上面扫不到；按 pidfile 精确收：
  # 台账 pid + 现场 cmdline 必须含 manager.cdprelay 才 kill（零模式匹配杀）。
  local cpf cpid
  cpf="${APP_ROOT}/state/${DESK_ID}/cdp-relay.pid"
  if [ -f "${cpf}" ]; then
    cpid=$(json_field "$(cat "${cpf}" 2>/dev/null || echo '{}')" 'd.get("pid","")' | tr -d ' ')
    if [ -n "${cpid}" ] && [ -d "/proc/${cpid}" ] && tr '\0' ' ' < "/proc/${cpid}/cmdline" 2>/dev/null | grep -q 'manager[.]cdprelay'; then
      kill "${cpid}" 2>/dev/null || true
    fi
  fi
  for pid in "${PROXY_PID}" "${DISP_PID}" "${MGR_PID}"; do
    [ -n "${pid}" ] || continue
    kill "${pid}" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PROXY_PID}" "${DISP_PID}" "${MGR_PID}"; do
    [ -n "${pid}" ] || continue
    kill -9 "${pid}" 2>/dev/null || true
  done
  [ -n "${NEG_CONTAINER}" ] && docker rm -f "${NEG_CONTAINER}" >/dev/null 2>&1 || true
  if [ "${KEEP}" != "1" ]; then
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
  if [ "${KEEP}" = "1" ]; then
    say "rig 保留: ${RIG}"
  else
    local trash_base=""
    for cand in "${WTK_ACCEPT_TRASH_DIR:-}" /data/.trash "${TMPDIR:-/tmp}"; do
      [ -n "${cand}" ] || continue
      if mkdir -p "${cand}" 2>/dev/null && [ -w "${cand}" ]; then trash_base="${cand}"; break; fi
    done
    if [ -n "${trash_base}" ]; then
      local dest="${trash_base}/kasmweb-acc-$(date -u +%Y%m%dT%H%M%SZ)"
      mkdir -p "${dest}" && mv "${RIG}" "${dest}/" 2>/dev/null && say "rig 归档: ${dest}" || true
    else
      say "无可用归档目录，rig 留在: ${RIG}"
    fi
  fi
}
trap cleanup EXIT

say "套件启动：image=${IMAGE}"
say "rig: ${RIG}"

# ---------------------------------------------------------------- 端口与目录
DESK_PORT=$(pick_port 25321 25329 25326) || { echo "FATAL 25321..25329 无空闲端口" >&2; exit 2; }
# 首选 6401：避开生产 relay 6310-6312 与 25880 验证台 rig 的 6313/6314（跨 rig 撞车会
# 让对方的 ensure_relay 失败）。6310-6399 段一律不用。
RELAY_PORT=$(pick_port 6401 6499 6401) || { echo "FATAL 6401..6499 无空闲端口" >&2; exit 2; }
DISPATCHER_PORT=$(pick_port 25400 25440 25410) || { echo "FATAL 25400..25440 无空闲端口" >&2; exit 2; }
PROXY_PORT=$(pick_port 25450 25499 25460) || { echo "FATAL 25450..25499 无空闲端口" >&2; exit 2; }
# CDP relay 外发端口（0.0.0.0 绑定）用 6501..6599：避开生产 relay 6310-6312、
# 25880 验证台 rig 的 6313/6314，也避开本套件 X relay 的 6401..6499。
CDP_RELAY_PORT=$(pick_port 6501 6599 6501) || { echo "FATAL 6501..6599 无空闲端口" >&2; exit 2; }
CDP_RELAY_TOKEN="acc$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
say "端口：desk=${DESK_PORT} relay=${RELAY_PORT} cdp-relay=${CDP_RELAY_PORT} dispatcher=${DISPATCHER_PORT} proxy=${PROXY_PORT}"

mkdir -p "${RIG}/certs" "${RIG}/trash"

# ---------------------------------------------------------------- manager（临时实例）
CHROME_BIN="${WT_KASM_CHROME_BIN:-}"
if [ -z "${CHROME_BIN}" ]; then
  for cand in /home/aigc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
              "$(command -v google-chrome-stable || true)" \
              "$(command -v google-chrome || true)" \
              "$(command -v chromium || true)"; do
    if [ -n "${cand}" ] && [ -x "${cand}" ]; then CHROME_BIN="${cand}"; break; fi
  done
fi
CHROME_VER=""
if [ -n "${CHROME_BIN}" ] && [ -x "${CHROME_BIN}" ]; then
  CHROME_VER=$("${CHROME_BIN}" --version 2>/dev/null | awk '{print $NF}')
fi

cat > "${RIG}/catalog.json" <<EOF
{"schemaVersion":1,"desktops":[{"id":"${DESK_ID}","name":"Acceptance","port":${DESK_PORT},
 "relayPort":${RELAY_PORT},"defaultApp":"chrome","width":1600,"height":900,"mode":"fixed"}]}
EOF

export PYTHONPATH="${REPO_DIR}"
export WT_KASM_APP_ROOT="${APP_ROOT}"
export WT_KASM_CATALOG_FILE="${RIG}/catalog.json"
export WT_KASM_IMAGE="${IMAGE}"
export WT_KASM_TRASH="${RIG}/trash"
# PUID/PGID 取**当前执行用户**：容器 init 会按它改 /config 与 /run/wt-kasm-app 的属主，
# 若与宿主用户不一致，宿主侧就读不到 appshare（CI runner 是 uid 1001 ≠ 1000）。
export WT_KASM_PUID="$(id -u)"
export WT_KASM_PGID="$(id -g)"
export WT_KASM_PUBLIC_ORIGIN="http://127.0.0.1:${DISPATCHER_PORT}"
export WT_KASM_PROJECT_SUFFIX=-kwtacc
# CDP relay：0.0.0.0 + 随机 token（config 导入期 fail-closed 要求非 loopback 必配 token）。
export WT_KASM_CDP_RELAY_BIND=0.0.0.0
export WT_KASM_CDP_RELAY_PORT="${CDP_RELAY_PORT}"
export WT_KASM_CDP_RELAY_TOKEN="${CDP_RELAY_TOKEN}"
if [ -n "${CHROME_VER}" ]; then
  export WT_KASM_CHROME_BIN="${CHROME_BIN}"
  export WT_KASM_CHROME_VERSION="${CHROME_VER}"
fi

cd "${REPO_DIR}"
python3 -m manager.cli daemon --foreground > "${RIG}/manager.log" 2>&1 &
MGR_PID=$!
for _ in $(seq 1 60); do
  [ -S "${APP_ROOT}/sock/control.sock" ] && break
  sleep 0.5
done
if [ ! -S "${APP_ROOT}/sock/control.sock" ]; then
  say "manager 未就绪，日志尾："; tail -20 "${RIG}/manager.log" >&2 || true
  echo "FATAL  rig 装配失败（manager 未起）" >&2
  exit 2
fi
say "manager 就绪 pid=${MGR_PID}"

# ---------------------------------------------------------------- 桌面容器（用 manager 渲染的 compose = 生产同一条路径）
COMPOSE_FILE="${DESK_DIR}/compose.yaml"
for _ in $(seq 1 60); do
  [ -f "${COMPOSE_FILE}" ] && break
  sleep 0.5
done
if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "FATAL  manager 未渲染 compose: ${COMPOSE_FILE}" >&2
  exit 2
fi
docker compose -f "${COMPOSE_FILE}" up -d > "${RIG}/compose-up.log" 2>&1 || {
  say "compose up 失败："; tail -20 "${RIG}/compose-up.log" >&2; exit 2; }
CONTAINER="wt-kasm-${DESK_ID}"
HEALTH=""
for _ in $(seq 1 120); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo missing)
  [ "${HEALTH}" = "healthy" ] && break
  sleep 1
done
say "容器 ${CONTAINER} health=${HEALTH}"
if [ "${HEALTH}" != "healthy" ]; then
  say "容器日志尾："; docker logs --tail 30 "${CONTAINER}" >&2 2>&1 || true
fi

# ---------------------------------------------------------------- dispatcher（临时实例）
python3 -m manager.cli registry --refresh >/dev/null 2>&1 || true
# native 镜像只能作 legacy 桌：catalog 桌强制声明几何，而 native 镜像没有几何活体链
# （attest B/C/D 不闭合 ⇒ 发布面门判 state=error，dispatcher 照状态放行 ⇒ 503）。
# 这里把 manager 写的条目**降级成 legacy 形态**（去 geometry 键、state=running）喂
# dispatcher —— 这正是生产上 native 镜像桌的真实形态（基线三桌即 legacy），不是伪造
# 状态：id / port / containerId / generation 全部取自 manager 写的 registry。
python3 - "${APP_ROOT}/registry.json" "${RIG}/dispatcher-registry.json" "${DESK_ID}" "${DISPATCHER_PORT}" <<'PYEOF'
import json
import sys
src, dst, desk_id, origin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = json.load(open(src, encoding="utf-8"))
out = {"schemaVersion": data.get("schemaVersion", 1),
       "publicOrigin": "http://127.0.0.1:" + origin, "desktops": []}
for entry in data.get("desktops", []):
    if entry.get("id") != desk_id:
        continue
    e = {k: v for k, v in entry.items() if k not in ("geometry", "geometryError")}
    e["state"] = "running"
    out["desktops"].append(e)
json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("legacy registry for dispatcher: " + dst)
PYEOF
WTK_LISTEN_HOST=127.0.0.1 \
WTK_PORT="${DISPATCHER_PORT}" \
WTK_REGISTRY="${RIG}/dispatcher-registry.json" \
WTK_PUBLIC_ORIGIN="http://127.0.0.1:${DISPATCHER_PORT}" \
WTK_BACKEND_PORT_MIN="${DESK_PORT}" \
WTK_BACKEND_PORT_MAX="${DESK_PORT}" \
node "${REPO_DIR}/dispatcher/server.js" > "${RIG}/dispatcher.log" 2>&1 &
DISP_PID=$!
DISP_OK=0
for _ in $(seq 1 60); do
  if [ "$(http_code "http://127.0.0.1:${DISPATCHER_PORT}/healthz")" = "200" ]; then
    DISP_OK=1; break
  fi
  sleep 0.5
done
say "dispatcher 就绪=${DISP_OK} pid=${DISP_PID}"

# ---------------------------------------------------------------- 口令+证书门面
PROXY_OK=0
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${RIG}/certs/key.pem" -out "${RIG}/certs/cert.pem" -days 2 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    > "${RIG}/certs/openssl.log" 2>&1 || true
  printf '%s:%s\n' "${PROXY_USER}" "${PROXY_PASS}" > "${RIG}/certs/htpasswd"
  if [ -s "${RIG}/certs/cert.pem" ]; then
    python3 "${REPO_DIR}/scripts/lib/https-basic-proxy.py" \
      --cert "${RIG}/certs/cert.pem" --key "${RIG}/certs/key.pem" \
      --htpasswd "${RIG}/certs/htpasswd" \
      --listen "127.0.0.1:${PROXY_PORT}" --upstream "127.0.0.1:${DISPATCHER_PORT}" \
      > "${RIG}/proxy.json" 2> "${RIG}/proxy.log" &
    PROXY_PID=$!
    for _ in $(seq 1 40); do
      if [ -s "${RIG}/proxy.json" ]; then PROXY_OK=1; break; fi
      sleep 0.25
    done
  fi
fi
say "门面代理就绪=${PROXY_OK} pid=${PROXY_PID}"

DISP="http://127.0.0.1:${DISPATCHER_PORT}"
PROXY="https://127.0.0.1:${PROXY_PORT}"
CANON_QUERY="autoconnect=1&resize=scale&path=desktop%2F${DESK_ID}%2Fwebsockify&idle_disconnect=0&clipboard_seamless=false&shared=true"

# ================================================================ 用例
if want password-login; then
  if [ "${PROXY_OK}" != "1" ] || [ "${DISP_OK}" != "1" ]; then
    record SKIP password-login "门面代理或 dispatcher 未就绪（proxy=${PROXY_OK} disp=${DISP_OK}）"
  else
    code_no=$(http_code "${PROXY}/")
    code_wrong=$(http_code "${PROXY}/" -u "${PROXY_USER}:wrong-${PROXY_PASS}")
    wa=$(http_header www-authenticate "${PROXY}/" || true)
    loc=$(http_header location "${PROXY}/?desktop=${DESK_ID}" -u "${PROXY_USER}:${PROXY_PASS}" || true)
    posture=$(docker exec "${CONTAINER}" sh -c 'p=$(pgrep -x Xvnc | head -1); [ -n "$p" ] && tr "\0" " " < /proc/$p/cmdline | grep -o "\-SecurityTypes None -disableBasicAuth"' 2>/dev/null | head -1 || true)
    pw400=$(http_code "${DISP}/?password=secret")
    ok=1; why=""
    [ "${code_no}" = "401" ] || { ok=0; why="${why}无凭据=${code_no} "; }
    [ "${code_wrong}" = "401" ] || { ok=0; why="${why}错凭据=${code_wrong} "; }
    case "${wa}" in *Basic*) ;; *) ok=0; why="${why}缺WWW-Authenticate ";; esac
    case "${loc}" in *"/desktop/${DESK_ID}/?"*) ;; *) ok=0; why="${why}Location=${loc} ";; esac
    case "${posture}" in *"-SecurityTypes None -disableBasicAuth"*) ;; *) ok=0; why="${why}镜像口令口径不符[${posture}] ";; esac
    [ "${pw400}" = "400" ] || { ok=0; why="${why}?password=未拒[${pw400}] "; }
    if [ "${ok}" = "1" ]; then
      record PASS password-login "401/401/302 逐项符合；镜像侧 -SecurityTypes None -disableBasicAuth 成立；?password= 被拒 400"
    else
      record FAIL password-login "${why}"
    fi
  fi
fi

if want https-cert-mount; then
  if [ "${PROXY_OK}" != "1" ]; then
    record SKIP https-cert-mount "证书/代理未就绪（openssl 或 proxy 缺失）"
  else
    subj=$(openssl s_client -connect "127.0.0.1:${PROXY_PORT}" -servername localhost </dev/null 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null | head -1)
    fp_local=$(openssl x509 -in "${RIG}/certs/cert.pem" -noout -fingerprint -sha256 2>/dev/null | head -1)
    fp_served=$(openssl s_client -connect "127.0.0.1:${PROXY_PORT}" -servername localhost </dev/null 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null | head -1)
    code_auth=$(http_code "${PROXY}/" -u "${PROXY_USER}:${PROXY_PASS}")
    if [ -n "${fp_local}" ] && [ "${fp_local}" = "${fp_served}" ] && [ "${code_auth}" = "401" -o "${code_auth}" = "302" -o "${code_auth}" = "200" ]; then
      record PASS https-cert-mount "握手成功，服务证书 = 挂载文件（sha256 指纹逐字一致）；受保护入口仍通"
    else
      record FAIL https-cert-mount "指纹 local=[${fp_local}] served=[${fp_served}] code=${code_auth}"
    fi
  fi
fi

CDP_PORT=""; CDP_URL=""; CDP_WS=""; CDP_RELAY_JSON=""
if want cdp-connect || want cdp-relay || want cdp-relay-bind; then
  if [ -z "${CHROME_VER}" ]; then
    record SKIP cdp-connect "本机无宿主 chromium（WTKASM_CHROME_BIN 默认路径不存在）"
    record SKIP cdp-relay "同上"
    record SKIP cdp-relay-bind "同上"
  else
    out=""
    for attempt in 1 2; do
      out=$(cd "${REPO_DIR}" && python3 -m manager.cli app start "${DESK_ID}" --app chrome --test-cdp 2>&1 || true)
      CDP_PORT=$(json_field "${out}" 'd["data"]["cdp"]["port"]' | tr -d ' ' || true)
      CDP_URL=$(json_field "${out}" 'd["data"]["cdp"]["url"]' | tr -d ' ' || true)
      CDP_RELAY_JSON=$(printf '%s' "${out}" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(json.dumps(d["data"]["cdp"].get("relay", {}), ensure_ascii=False))
except Exception:
    print("{}")' 2>/dev/null || echo "{}")
      case "${CDP_PORT}" in ""|ERR*) ;; *) break;; esac
      # 宿主 Chrome 起窗有毫秒级竞态（窗口归属未确认 ⇒ 拉起失败）：重试一次
      [ "${attempt}" = "1" ] && sleep 4
    done
    case "${CDP_PORT}" in
      ""|ERR*) 
      why=$(printf '%s' "${out}" | tr '\n' ' ' | cut -c1-200)
      if want cdp-connect; then record FAIL cdp-connect "app start --test-cdp 未回读端口（输出：${why}）"; fi
      if want cdp-relay; then record FAIL cdp-relay "同上"; fi
      if want cdp-relay-bind; then record FAIL cdp-relay-bind "同上（未回读 CDP 端口 ⇒ 无从起 relay）"; fi
      ;;
    *)
      ver_json=$(curl -s --max-time 8 "http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null || echo "")
      ws=$(printf '%s' "${ver_json}" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("webSocketDebuggerUrl",""))
except Exception:
    print("")' 2>/dev/null)
      ep_file="${APP_ROOT}/state/${DESK_ID}/cdp-chrome/endpoint.txt"
      ep=$(head -1 "${ep_file}" 2>/dev/null || echo "")
      if want cdp-connect; then
        if [ -n "${ws}" ] && [ "${ep}" = "http://127.0.0.1:${CDP_PORT}" ]; then
          record PASS cdp-connect "/json/version 回读 webSocketDebuggerUrl；endpoint.txt 与回复一致（port=${CDP_PORT}）"
        else
          record FAIL cdp-connect "ws=[${ws}] endpoint=[${ep}] 期望=http://127.0.0.1:${CDP_PORT}"
        fi
      fi
      listen=$(ss -ltnH "sport = :${CDP_PORT}" 2>/dev/null | awk '{print $4}' | head -1 | tr -d ' ' || true)
      in_container=$(docker exec "${CONTAINER}" sh -c "curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null | head -1 | tr -d ' ' || true)
      if want cdp-relay; then
        if [ "${listen}" = "127.0.0.1:${CDP_PORT}" ] && [ "${in_container}" = "000" ]; then
          record PASS cdp-relay "CDP 端口仅宿主 loopback（${listen}），容器内不可达（${in_container}）⇒ 未外泄"
        else
          record FAIL cdp-relay "listen=[${listen}] 期望 127.0.0.1:${CDP_PORT}；容器内探测=${in_container} 期望 000"
        fi
      fi
      if want cdp-relay-bind; then
        r_ok=$(json_field "${CDP_RELAY_JSON}" 'd.get("ok")')
        r_bind=$(json_field "${CDP_RELAY_JSON}" 'd.get("bind")')
        r_ena=$(json_field "${CDP_RELAY_JSON}" 'd.get("enabled")')
        r_treq=$(json_field "${CDP_RELAY_JSON}" 'd.get("token_required")')
        r_url=$(json_field "${CDP_RELAY_JSON}" 'd.get("url")')
        r_reason=$(json_field "${CDP_RELAY_JSON}" 'd.get("reason","")')
        r_listen=$(ss -ltnH "sport = :${CDP_RELAY_PORT}" 2>/dev/null | awk '{print $4}' | head -1 | tr -d ' ' || true)
        HOST_IP=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null | tr -d ' ' || true)
        cont_code=$(docker exec "${CONTAINER}" sh -c "curl -s -m 5 -o /dev/null -w '%{http_code}' http://${HOST_IP}:${CDP_RELAY_PORT}/${CDP_RELAY_TOKEN}/json/version" 2>/dev/null | head -1 | tr -d ' ' || true)
        cont_body=$(docker exec "${CONTAINER}" sh -c "curl -s -m 5 http://${HOST_IP}:${CDP_RELAY_PORT}/${CDP_RELAY_TOKEN}/json/version" 2>/dev/null || true)
        cont_noauth=$(docker exec "${CONTAINER}" sh -c "curl -s -m 5 -o /dev/null -w '%{http_code}' http://${HOST_IP}:${CDP_RELAY_PORT}/json/version" 2>/dev/null | head -1 | tr -d ' ' || true)
        ok=1; why=""
        [ "${r_ena}" = "True" ] || { ok=0; why="${why}enabled=${r_ena} "; }
        [ "${r_ok}" = "True" ] || { ok=0; why="${why}relay.ok=${r_ok}(reason=${r_reason}) "; }
        [ "${r_bind}" = "0.0.0.0" ] || { ok=0; why="${why}bind=${r_bind} "; }
        [ "${r_treq}" = "True" ] || { ok=0; why="${why}token_required=${r_treq} "; }
        case "${r_url}" in *":${CDP_RELAY_PORT}/${CDP_RELAY_TOKEN}"*) ;; *) ok=0; why="${why}url=[${r_url}] ";; esac
        [ "${r_listen}" = "0.0.0.0:${CDP_RELAY_PORT}" ] || { ok=0; why="${why}ss=[${r_listen}] 期望 0.0.0.0:${CDP_RELAY_PORT} "; }
        [ "${cont_code}" = "200" ] || { ok=0; why="${why}容器带 token=${cont_code} 期望 200 "; }
        case "${cont_body}" in *webSocketDebuggerUrl*) ;; *) ok=0; why="${why}容器响应缺 webSocketDebuggerUrl ";; esac
        [ "${cont_noauth}" = "404" ] || { ok=0; why="${why}容器不带 token=${cont_noauth} 期望 404 "; }
        [ "${listen}" = "127.0.0.1:${CDP_PORT}" ] || { ok=0; why="${why}原始 CDP 端口 listen=[${listen}] 期望 127.0.0.1:${CDP_PORT} "; }
        NEG_PORT=$((CDP_RELAY_PORT + 50))
        neg_rc=0
        neg_out=$(cd "${REPO_DIR}" && env -u WT_KASM_CDP_RELAY_TOKEN WT_KASM_CDP_RELAY_BIND=0.0.0.0 WT_KASM_CDP_RELAY_PORT="${NEG_PORT}" python3 -m manager.cli daemon --foreground 2>&1) || neg_rc=$?
        printf '%s\n' "${neg_out}" > "${RIG}/cdp-relay-negative.log"
        [ "${neg_rc}" != "0" ] || { ok=0; why="${why}负例退出码=${neg_rc} 期望非零 "; }
        case "${neg_out}" in *WT_KASM_CDP_RELAY_TOKEN*) ;; *) ok=0; why="${why}负例报错缺 WT_KASM_CDP_RELAY_TOKEN 字样 ";; esac
        for negpid in $(pgrep -f "manager.cli daemon" 2>/dev/null || true); do
          if tr '\0' '\n' < "/proc/${negpid}/environ" 2>/dev/null | grep -qx "WT_KASM_CDP_RELAY_PORT=${NEG_PORT}"; then
            kill "${negpid}" 2>/dev/null || true
          fi
        done
        if [ "${ok}" = "1" ]; then
          record PASS cdp-relay-bind "relay 绑 0.0.0.0:${CDP_RELAY_PORT}（回复 bind=0.0.0.0 ok=true url 带 token）；容器经 ${HOST_IP} 带 token=200 含 webSocketDebuggerUrl、无 token=404；原始 CDP 端口仍只绑 127.0.0.1:${CDP_PORT}；fail-closed 负例启动即拒 rc=${neg_rc}"
        else
          record FAIL cdp-relay-bind "${why}"
        fi
      fi
      ;;
    esac
  fi
fi

if want dir-mount; then
  x11=$(docker exec "${CONTAINER}" sh -c 'ls /tmp/.X11-unix/X1 2>/dev/null' 2>/dev/null || echo "")
  sock=$(docker exec "${CONTAINER}" sh -c 'ls /run/wt-kasm-app/launch.sock 2>/dev/null' 2>/dev/null || echo "")
  deskfiles=$(docker exec "${CONTAINER}" sh -c 'ls /config/Desktop 2>/dev/null | tr "\n" " "' 2>/dev/null || echo "")
  marker="${DESK_DIR}/config/.acc-mount-probe"
  # 标记写在 x11 目录（1777，容器 init 不改它的属主）；config 目录会被容器按 PUID 改属主，
  # 宿主未必写得进去（CI runner uid≠容器 uid）。
  marker="${DESK_DIR}/runtime/x11/.acc-mount-probe"
  echo "probe-$(date -u +%s)" > "${marker}" 2>/dev/null || true
  seen=$(docker exec "${CONTAINER}" sh -c 'cat /tmp/.X11-unix/.acc-mount-probe 2>/dev/null' 2>/dev/null || echo "")
  mountmap=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/tmp/.X11-unix"}}{{.Source}}{{end}}{{end}}' "${CONTAINER}" 2>/dev/null || echo "")
  NEG_CONTAINER="kasmweb-acc-neg-$$"
  docker run -d --name "${NEG_CONTAINER}" \
    -e WTK_DESKTOP_ID=${DESK_ID} -e DISPLAY=:1 -e PUID=1000 -e PGID=1000 \
    -e START_DOCKER=false --shm-size 1g --tmpfs /tmp "${IMAGE}" >/dev/null 2>&1 || true
  neg_health=""
  for _ in $(seq 1 30); do
    neg_health=$(docker inspect -f '{{.State.Health.Status}}' "${NEG_CONTAINER}" 2>/dev/null || echo missing)
    [ "${neg_health}" = "healthy" ] && break
    sleep 1
  done
  ok=1; why=""
  [ -n "${x11}" ] || { ok=0; why="${why}缺X1 "; }
  [ -n "${sock}" ] || { ok=0; why="${why}缺launch.sock "; }
  case "${deskfiles}" in *Chrome.desktop*) ;; *) ok=0; why="${why}桌面无Chrome.desktop ";; esac
  case "${deskfiles}" in *Chrome-Local.desktop*) ;; *) ok=0; why="${why}桌面无Chrome-Local.desktop ";; esac
  [ "${seen}" = "$(cat "${marker}" 2>/dev/null)" ] || { ok=0; why="${why}宿主->容器标记不可见[seen=${seen}] "; }
  [ "${mountmap}" = "${DESK_DIR}/runtime/x11" ] || { ok=0; why="${why}bind 映射不符[${mountmap}] "; }
  if [ "${neg_health}" = "healthy" ]; then
    ok=0; why="${why}缺 appshare 挂载的容器竟 healthy（契约破） "
  fi
  if [ "${ok}" = "1" ]; then
    record PASS dir-mount "三 bind 可见（X1/launch.sock/Desktop 双图标）；宿主->容器标记同步；缺 appshare ⇒ 容器非 healthy（${neg_health}）"
  else
    record FAIL dir-mount "${why}"
  fi
fi

if want two-level-path; then
  bare=$(http_code "${DISP}/desktop/${DESK_ID}/")
  canon=$(http_code "${DISP}/desktop/${DESK_ID}/?${CANON_QUERY}")
  asset=$(http_code "${DISP}/desktop/${DESK_ID}/wtk-boot.js")
  one_seg=$(http_code "${DISP}/desktop/")
  unknown=$(http_code "${DISP}/desktop/nope/")
  direct=$(http_code "http://127.0.0.1:${DESK_PORT}/")
  ok=1; why=""
  [ "${bare}" = "302" ] || { ok=0; why="${why}裸路径=${bare}(legacy期望302引导) "; }
  [ "${canon}" = "200" ] || { ok=0; why="${why}规范URL=${canon} "; }
  [ "${asset}" = "200" ] || { ok=0; why="${why}注入件=${asset} "; }
  [ "${one_seg}" = "400" ] || { ok=0; why="${why}一段=/desktop/=${one_seg}(空桌标识期望400) "; }
  [ "${unknown}" = "404" ] || { ok=0; why="${why}未知桌=${unknown} "; }
  [ "${direct}" = "200" ] || { ok=0; why="${why}后端直连=${direct} "; }
  bootbase=$(docker exec "${CONTAINER}" sh -c 'grep -o "window.__WTK_BASE=[^;]*" /opt/wtk/web/wtk-boot.js 2>/dev/null | head -1' 2>/dev/null | tr -d ' ' || true)
  case "${bootbase}" in *"/desktop/${DESK_ID}/"*) ;; *) ok=0; why="${why}镜像未认二级base[${bootbase}] ";; esac
  if [ "${ok}" = "1" ]; then
    record PASS two-level-path "/desktop/${DESK_ID}/ 规范URL 200、wtk-boot.js 200；裸路径 302 引导；一段 400 / 未知桌 404；后端直连 200；镜像级 base=${bootbase}"
  else
    record FAIL two-level-path "${why}"
  fi
fi

if want client-connect; then
  # 客户端真连通 = 4 级 GUI 判据（仓库纪律：4 级单列核销，不当发布门）⇒ 显式 opt-in。
  browser="${WTK_ACCEPT_BROWSER:-}"
  if [ -z "${browser}" ]; then
    record SKIP client-connect "4 级 GUI 判据默认不跑（设 WTK_ACCEPT_BROWSER=<chrome> 开启一次性抽查）"
  elif [ ! -x "${browser}" ]; then
    record SKIP client-connect "WTK_ACCEPT_BROWSER 指向的浏览器不可执行：${browser}"
  else
    dom=$(timeout 90 "${browser}" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
            --virtual-time-budget=12000 --dump-dom \
            "${DISP}/desktop/${DESK_ID}/?${CANON_QUERY}" 2>/dev/null || true)
    if printf '%s' "${dom}" | grep -q 'noVNC_status' && printf '%s' "${dom}" | grep -q 'Connected'; then
      record PASS client-connect "KasmVNC 客户端在二级路径下连上桌面（DOM 状态 Connected）；浏览器=${browser##*/}"
    else
      record FAIL client-connect "客户端未连上（DOM 摘要：$(printf '%s' "${dom}" | tr -s ' \n' ' ' | cut -c1-180)）"
    fi
  fi
fi

if want regression; then
  hz=$(curl -s --max-time 8 "${DISP}/healthz" 2>/dev/null || echo "")
  loc=$(http_header location "${DISP}/?desktop=${DESK_ID}" || true)
  q=$(printf '%s' "${loc}" | sed -n 's/.*?\(.*\)$/\1/p')
  p400a=$(http_code "${DISP}/?desktop=${DESK_ID}&autoconnect=0")
  p400b=$(http_code "${DISP}/?path=evil")
  p404=$(http_code "${DISP}/?desktop=nope")
  backend=$(http_code "http://127.0.0.1:${DESK_PORT}/")
  hc=$(docker exec "${CONTAINER}" /opt/wtk/bin/healthcheck.sh 2>&1 | tail -1 || echo "")
  fonts=$(docker exec "${CONTAINER}" sh -c 'fc-match -f "%{family[0]}\n" "sans-serif:lang=zh-cn"' 2>/dev/null | head -1 || true)
  chromev=$(docker exec "${CONTAINER}" sh -c 'chromium-browser --version 2>/dev/null' 2>/dev/null | head -1 || true)
  vjson=$(cd "${REPO_DIR}" && python3 -m manager.cli verify "${DESK_ID}" 2>/dev/null || true)
  vinfo=$(printf '%s' "${vjson}" | python3 -c "import json,sys
try:
    text = sys.stdin.read()
    doc, _rest = json.JSONDecoder().raw_decode(text.lstrip())
    d = doc['data']
    fails = [c['name'] for c in d.get('checks', []) if not c.get('ok')]
    print('%s|%s|%s' % (d.get('pass'), d.get('fail'), ';'.join(fails)))
except Exception as exc:
    print('ERR|ERR|%s' % exc)")
  vpass=$(printf '%s' "${vinfo}" | cut -d'|' -f1)
  vfail=$(printf '%s' "${vinfo}" | cut -d'|' -f2)
  vnames=$(printf '%s' "${vinfo}" | cut -d'|' -f3)
  ok=1; why=""
  case "${hz}" in ok*) ;; *) ok=0; why="${why}healthz=[${hz}] ";; esac
  for kv in 'autoconnect=1' 'resize=scale' "path=desktop%2F${DESK_ID}%2Fwebsockify" 'idle_disconnect=0' 'clipboard_seamless=false' 'shared=true'; do
    case "${q}" in *"${kv}"*) ;; *) ok=0; why="${why}规范参数缺${kv} ";; esac
  done
  [ "${p400a}" = "400" ] || { ok=0; why="${why}autoconnect=0=${p400a} "; }
  [ "${p400b}" = "400" ] || { ok=0; why="${why}?path=evil=${p400b} "; }
  [ "${p404}" = "404" ] || { ok=0; why="${why}未知桌=${p404} "; }
  [ "${backend}" = "200" ] || { ok=0; why="${why}后端=${backend} "; }
  case "${hc}" in *OK*) ;; *) ok=0; why="${why}healthcheck=[${hc}] ";; esac
  [ "${fonts}" = "Noto Sans CJK SC" ] || { ok=0; why="${why}字体=[${fonts}] "; }
  case "${chromev}" in "Chromium 112."*) ;; *) ok=0; why="${why}容器内chromium=[${chromev}] ";; esac
  # native 镜像 + 声明几何 = 发布面门不闭合（设计互斥，见 deploy.md §11.1）：
  # 允许且**仅**允许这一类失败项；其余任何 plumbing 失败都判 FAIL。
  if [ -n "${vnames}" ]; then
    IFS=';' read -ra vlist <<< "${vnames}"
    for vn in "${vlist[@]}"; do
      case "${vn}" in
        *发布面*|*几何*) ;;
        *) ok=0; why="${why}verify 失败项非互斥类[${vn}] ";;
      esac
    done
  fi
  case "${vfail}" in ERR) ok=0; why="${why}verify 输出不可解析 ";; *) ;; esac
  [ "${vpass}" != "ERR" ] || { ok=0; why="${why}verify 无通过项 "; }
  if [ "${ok}" = "1" ]; then
    record PASS regression "healthz/规范302(6 键)/参数矩阵400-404/后端200/healthcheck OK/字体 SC/Chromium 112；verify ${vpass}过${vfail}败（互斥项：${vnames:-无}）"
  else
    record FAIL regression "${why}"
  fi
fi

# ================================================================ 摘要
echo
echo "== 发布前自检摘要 =="
for line in "${SUMMARY[@]}"; do
  printf '%s\n' "${line}" | awk -F'|' '{printf "%-4s %-16s %s\n", $1, $2, $3}'
done
printf '总计：PASS=%d FAIL=%d SKIP=%d\n' "${PASS_N}" "${FAIL_N}" "${SKIP_N}"

if [ -n "${JSON_OUT}" ]; then
  {
    printf '{"image":"%s","rig":"%s","pass":%d,"fail":%d,"skip":%d,"cases":[' \
      "${IMAGE}" "${RIG}" "${PASS_N}" "${FAIL_N}" "${SKIP_N}"
    local_first=1
    for line in "${SUMMARY[@]}"; do
      st=$(printf '%s' "${line}" | cut -d'|' -f1)
      nm=$(printf '%s' "${line}" | cut -d'|' -f2)
      dt=$(printf '%s' "${line}" | cut -d'|' -f3-)
      [ "${local_first}" = "1" ] || printf ','
      local_first=0
      printf '{"state":"%s","name":"%s","detail":"%s"}' "${st}" "${nm}" "${dt}"
    done
    printf ']}\n'
  } > "${JSON_OUT}"
  say "JSON 摘要：${JSON_OUT}"
fi

[ "${FAIL_N}" -eq 0 ] || exit 1
exit 0

