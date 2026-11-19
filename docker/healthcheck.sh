#!/usr/bin/with-contenv bash
# healthcheck.sh - native-default variant: readiness for one webtop-kasmvnc desktop
# entry whose framebuffer follows a viewer-requested remote resize (and the client
# default requests none: the Kasm iframe resize control ships off).
#
# Scope of this variant: gate 5 only. Gates 1-4 and 6-12 are byte-for-byte the
# canonical image/healthcheck.sh text (that canonical file is untouched; this is a
# separate payload installed at the same image path /opt/wtk/bin/healthcheck.sh), so
# the entry, the loopback-only 6901, the generation handshake, the tint2 panel, the
# audio chain, CJK resolution, app.json, the nginx worker pin and the pulse topology
# are graded exactly as before.
#
# WHY GATE 5 CANNOT ASSERT EQUALITY HERE: the native-default svc-kasmvnc/run passes
# NO -AcceptSetDesktopSize flag, so KasmVNC's native default for that flag (1, per
# 1.1.0 -help) accepts SetDesktopSize and the framebuffer legitimately follows the
# viewer window when such a request arrives. Asserting geom == W x H in that mode
# contradicts the mode and would
# flip the container to unhealthy the moment a remote resize lands - the exact failure
# this candidate exists to remove. So the gate proves the reading is well formed (two
# positive integers from ONE xwininfo snapshot) and nothing more: explicitly NOT a
# size enforcement gate, no ceiling asserted, no app window touched.
#
# WHICH SIZE TO EXPECT (root ruling 2026-11-16, three layers - this gate measures
# neither of the two upper ones): server-side PERMISSION is open (flag absent), but a
# real Kasm 1.1 session inside an iframe, with the viewer's resize control at its own
# default (off), sends no remote-resize request and no scaling happens client-side;
# the entry layer (dispatcher/lib/selector.js) additionally rewrites resize=remote
# to resize=scale. So on that common path the reading here stays at the startup
# initial value, and it moves only if a client that requests remote size reaches
# the server. Both states are healthy by
# design: this gate asserts validity, never equality, and never infers from a size
# whether the client requested anything.
# Startup W x H is the INITIAL value and is reported for the record, never compared.
# Which number that is depends on the ENVIRONMENT, not on this file: the parent image
# k012 writes WTK_WIDTH=1600 / WTK_HEIGHT=900 into its Docker Config.Env and the
# manager's compose file overrides both per desktop, so under the current manager
# this gate reports startup 1600x900. The 1024x768 in the fallback below applies
# only when the variable is absent or empty (a bare run with no env) - it is NOT
# this product's default, and it is a separate fact from the upstream LSIO native
# line's own hardcoded -geometry 1024x768 (that one describes the base layer's run
# file, not the environment this build inherits). The two numbers must not be
# merged into one claim. This overlay adds no ENV of its own and overrides nothing.
#
# The resize-switch env key is not read by this file and its name must not appear
# here (key-name rule: see this directory's README). RESIZE_MODE is a constant, and
# that constant is what the OK line prints: resize=native.
#
# NOT GEOMETRY-ATTESTABLE: these bytes differ from the canonical source tree, so
# build-image.sh attest gate D refuses issuance for an image built from them, and
# manager/attest.py gates B/D reject its argv. Not bypassed - deploy as a legacy
# (no declared geometry) desktop, where that chain is never invoked.
#
# Gates, and the failure each one exists to catch:
#   1 entry answers over loopback                    (nginx up, vhost rendered)
#   2 same entry at the container interface address   (wtib6 false-green: a
#       127.0.0.1-only vhost is DNAT-unreachable => published port 000, gate 1 green).
#       FAILS CLOSED: compose pins a bridge network, so a missing interface address
#       means this container is not on the network the dispatcher publishes through.
#   3 served page carries the injection anchor        (sub_filter matched =>
#       Accept-Encoding cleared and the Kasm title survived)
#   4 6901 listens on loopback ONLY                   (no second public door)
#   5 framebuffer reading well formed (native): two positive integers, ONE snapshot;
#       equality with the startup initial value deliberately NOT asserted (a viewer
#       resize is the designed behaviour), no ceiling asserted (on 1.1.0
#       -MaxVideoResolution caps only the video-encoding region and did not block
#       2100x1200; real limits come from protocol/service capability, not here)
#   6 X root _WT_KASM_GENERATION == appshare/generation (fail closed on a
#       restarted Xvnc: fresh token on disk, root prop not yet rewritten)
#   7 panel process alive                             (tint2 taskbar)
#   8 relay /healthz ok AND auto_null.monitor exists   (audio chain end-to-end)
#   9 CJK resolves                                    (fc-match zh-cn)
#  10 app.json valid JSON naming this desktop          (contract file, pure data)
#  11 nginx worker count pin survived                  (base drift = idle waste)
#  12 pulse topology: 2 native sockets, 1 sink         (-n missing = double load)
#
# Green here proves plumbing, NOT GUI. It never claims a window is visible,
# clickable, or that pixels are streaming. This gate is level 3 at best.
set -u

ok=1
fail() { echo "healthcheck: FAIL: $*" >&2; ok=0; }
note() { echo "healthcheck: $*"; }

PORT="${WTK_NGINX_PORT:-3000}"
SHARE="${WTK_APPSHARE:-/run/wt-kasm-app}"
# Record-only startup geometry read: environment first (in practice k012 Config.Env
# = 1600x900, and the manager can override it per desktop), 1024x768 only as the
# bare-env fallback. Never an expected value - gate 5 compares nothing.
W="${WTK_WIDTH:-1024}"
H="${WTK_HEIGHT:-768}"

# --- BEGIN WTK_NATIVE POLICY (contract-tested block; keep both sentinels) -----
# Native variant: the Xvnc argv carries no -AcceptSetDesktopSize flag, so the
# an inbound SetDesktopSize is accepted, so the framebuffer can follow a
# viewer-requested remote resize (KasmVNC 1.1.0 native default for that flag = 1).
# The canonical three-way grammar (unset/empty -> fixed, 1 -> dynamic, anything else
# -> fail closed) lives in image/healthcheck.sh and is deliberately NOT reproduced,
# parsed, or overridden here: this file reads no policy key, so there is no illegal
# value to fail closed on and the mode string is a constant. Gate 5 is its only
# consumer, and the OK line reports this constant.
RESIZE_MODE="native"
is_pos_int() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -gt 0 ] 2>/dev/null; }
# --- END WTK_NATIVE POLICY ----------------------------------------------------
ID="${WTK_DESKTOP_ID:-probe}"
DISP=$(printf '%s' "${DISPLAY:-:1}" | tr -d '\r\n')
export XAUTHORITY="$SHARE/xauth"

# --- 1 loopback entry ---
code=$(curl -s -o /tmp/wtk-hc.html -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/")
case "$code" in
  2*) : ;;
  *) fail "entry http=$code on loopback" ;;
esac

# --- 2 published-address reachability (fail closed, never skip) ---
iface_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
if [ -z "${iface_ip:-}" ]; then
  fail "no container interface address: gate 2 cannot be skipped on a bridge-pinned compose"
else
  code2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: 127.0.0.1:${PORT}" "http://${iface_ip}:${PORT}/")
  case "$code2" in
    2*) : ;;
    *) fail "entry http=$code2 at interface address $iface_ip (published port unreachable)" ;;
  esac
fi

# --- 3 injection anchor ---
if ! grep -q 'wtk-boot.js' /tmp/wtk-hc.html 2>/dev/null; then
  fail "injected anchor wtk-boot.js absent from served page (sub_filter matched nothing?)"
fi

# --- 4 6901 loopback only ---
# `ss` is not in the base image (iproute2 ships /sbin/ip only) and adding
# iproute2 for one gate is not worth a package; netstat prints the same
# "tcp 0 0 LADDR FADDR STATE" columns, so $4 is the local socket address here too.
l6=$(netstat -ltn 2>/dev/null | awk '$4 ~ /:6901$/ {print $4}' | head -1)
if [ -z "$l6" ]; then
  fail "Xvnc websocket port 6901 is not listening"
else
  case "$l6" in
    127.0.0.1:6901|localhost:6901) : ;;
    *) fail "6901 bound to $l6 - must be loopback-only" ;;
  esac
fi

# --- 5 geometry ---
# Two facts from the a317 base (probe wtk-hc-probe-06, Xvnc 1600x900):
#   * xwininfo is 1.1.5 and has NO -noalias (rc1, usage on stderr) => do not pass it;
#   * the stat lines read "  Width: 1600", so the number is the LAST field.
#     $(NF-1) returns the literal "Width:"/"Height:" and the gate would compare
#     "Width:xHeight:" against 1600x900 - a permanent FAIL, not a pass.
# Width and Height are read as separate values, so a half-present reading ("1600")
# cannot pass the dynamic check, which needs two numbers.
# --- BEGIN WTK_GATE5 (contract-tested block; keep both sentinels) -------------
# ONE xwininfo call, ONE snapshot (same rule as the canonical gate): two calls can
# straddle a live resize and report a torn width/height pair. A failed command yields
# empty text, which the empty-reading branch below rejects, so the negative cases
# (empty / header-only / Width-only) still fail closed.
xw=$(DISPLAY="$DISP" xwininfo -root 2>/dev/null)
rw=$(printf '%s\n' "$xw" | awk '/Width:/ {print $NF; exit}')
rh=$(printf '%s\n' "$xw" | awk '/Height:/ {print $NF; exit}')
geom="${rw}x${rh}"
if [ -z "$rw" ] || [ -z "$rh" ]; then
  fail "xwininfo -root empty on DISPLAY=$DISP (X not ready / cookie unreadable)"
elif ! is_pos_int "$rw" || ! is_pos_int "$rh"; then
  fail "gate5 native: reading is not two positive integers (width='$rw' height='$rh')"
else
  note "gate5 mode=native: framebuffer $geom (startup ${W}x${H}); validity check only - equality with the startup initial value is NOT asserted by design, because this image passes no -AcceptSetDesktopSize flag and a viewer resize legitimately changes it (treating that as unhealthy is the failure this overlay removes). Explicitly NOT a size enforcement gate: no ceiling asserted (real limits come from protocol/service capability) and no app window is looked at, moved, or resized here."
fi
# --- END WTK_GATE5 -----------------------------------------------------------

# --- 6 generation handshake ---
gen=""
if [ ! -s "$SHARE/generation" ]; then
  fail "$SHARE/generation missing (svc-kasmvnc writes it before spawning Xvnc)"
else
  gen=$(tr -d '\r\n' < "$SHARE/generation")
  # xprop prints the property TYPE, not the -f format code: after
  #   xprop -f _WT_KASM_GENERATION 8s -set ...
  # the readback line is '_WT_KASM_GENERATION(STRING) = "<token>"' (probe
  # wtk-hc-probe-06), so a literal '(8s)' in the pattern can never match and the
  # gate would report the token absent forever. Split on the first '=' like
  # windowing/startwm.sh does - same grammar on both sides of the handshake.
  xg=$(DISPLAY="$DISP" xprop -root _WT_KASM_GENERATION 2>/dev/null | sed -n 's/^[^=]*=[[:space:]]*"\(.*\)"$/\1/p')
  if [ -z "$xg" ]; then
    fail "_WT_KASM_GENERATION absent on the X root (startwm has not finished)"
  elif [ "$xg" != "$gen" ]; then
    fail "generation mismatch: root=$xg appshare=$gen (X session restarted)"
  fi
fi

# --- 7 panel ---
pgrep -x tint2 >/dev/null 2>&1 || fail "tint2 panel not running"

# --- 8 audio chain ---
hz=$(curl -s --max-time 5 -H "Host: 127.0.0.1:${PORT}" "http://127.0.0.1:${PORT}/audio/healthz" 2>/dev/null)
case "$hz" in
  *'"ok":true'*) : ;;
  *) fail "audio relay /healthz not ok: ${hz:0:120}" ;;
esac
srcs=$(s6-setuidgid abc env HOME=/run/pulse PULSE_RUNTIME_PATH=/run/pulse \
        PULSE_COOKIE=/run/pulse/.config/pulse/cookie \
        PULSE_SERVER="unix:${SHARE}/native" \
        pactl list sources short 2>/dev/null)
echo "$srcs" | grep -q 'auto_null\.monitor[[:space:]]' || fail "pulse source auto_null.monitor absent"

# --- 9 CJK ---
cjkm=$(fc-match -f '%{family[0]}' 'sans-serif:lang=zh-cn' 2>/dev/null)
case "$cjkm" in
  "") fail "fc-match produced no family" ;;
  *DejaVu*) fail "CJK font missing: fc-match sans-serif:lang=zh-cn -> '$cjkm'" ;;
  *) : ;;
esac

# --- 10 app.json ---
if [ -s "$SHARE/app.json" ]; then
  jq -e --arg id "$ID" '.desktopId==$id and (.appIds|index("chrome")) and (.appIds|index("vcmi"))' \
     "$SHARE/app.json" >/dev/null 2>&1 || fail "app.json invalid or not desktop '$ID'"
else
  fail "$SHARE/app.json missing"
fi


# --- 11 nginx worker count (root ruling 2026-11-13, resource sanity) ---
# The Alpine main config ships worker_processes auto, which counts HOST cpus, not
# the container quota: on the probe host that is 144 idle workers per desktop and
# ~432 for three desktops. s6-apply.sh section 7 rewrites /etc/nginx/nginx.conf to
# 1 at build time; this gate is the runtime proof the pin survived, so a base-layer
# change shows up as a failure instead of invisible waste. Counted with pgrep -f on
# the process title (probe wtk-hc-probe/nginx_pin.sh: pgrep=1, ps=1).
wkc=$(pgrep -c -f "nginx: worker process" 2>/dev/null || echo 0)
[ "$wkc" = 1 ] || fail "nginx workers=$wkc, expected 1 (worker_processes pin lost: base auto = 1 worker per HOST cpu per desktop)"

# --- 12 pulse topology: exactly 2 native sockets and exactly 1 sink (-n fix) ---
# -F alone makes the daemon run /etc/pulse/default.pa (dump-conf: load-default-
# script-file = yes) AND the -F script, so the drop-in loads twice. Probe
# wtk-hc-probe/pulse_n.sh: with -F only => bind(): Address in use + an auto_null.2
# sink; with -n -F => 2 sockets / 1 sink. Gate 8 proves the monitor exists, so it
# cannot see the duplicate; this gate can.
pulse_q() { s6-setuidgid abc env HOME=/run/pulse PULSE_RUNTIME_PATH=/run/pulse PULSE_COOKIE=/run/pulse/.config/pulse/cookie PULSE_SERVER="unix:${SHARE}/native" pactl "$@" 2>/dev/null; }
nsock=$(pulse_q list modules short | grep -c module-native-protocol-unix) || fail "gate12: pactl list modules as abc failed rc=$?; no root pactl fallback"
nsink=$(pulse_q list sinks short | grep -c .) || fail "gate12: pactl list sinks as abc failed rc=$?; no root pactl fallback"
[ "$nsock" = 2 ] || fail "pulse native-protocol modules=$nsock, expected 2 (/run/pulse/native + /run/wt-kasm-app/native)"
[ "$nsink" = 1 ] || fail "pulse sinks=$nsink, expected 1 auto_null (2 = startup script ran twice, -n missing)"

[ "$ok" = 1 ] || exit 1
echo "healthcheck: OK (http=$code geom=$geom resize=$RESIZE_MODE gen=${gen:0:8} cjk=$cjkm)"
