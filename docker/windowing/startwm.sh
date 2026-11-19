#!/bin/bash
# startwm.sh - the session entry that svc-de runs as abc (webtop-kasmvnc image).
#
# Runs AFTER svc-kasmvnc has published $SHARE/generation and the X socket is up,
# BEFORE the WM. Its job is narrow and fail-closed:
#   1. normalise DISPLAY (with-contenv injects the base image's trailing newline;
#      Xlib parses display number "1\n" and refuses the display);
#   2. wait for the X server to accept connections;
#   3. publish the X-ownership properties on the root window:
#        _WT_KASM_DESKTOP_ID   (8s, from WTK_DESKTOP_ID; "probe" when unset)
#        _WT_KASM_GENERATION   (8s, from $SHARE/generation, 32-hex token)
#      manager/appshare.py verify_routing() reads both back over the host relay
#      and refuses to serve a display whose tokens do not match the appshare
#      files -> an Xvnc that restarted with an empty root is never mistaken for
#      the live session. Rewritten on EVERY session start, because every Xvnc
#      restart mints a new generation (svc-kasmvnc/run) and wipes the old root
#      window with it.
#   4. exec openbox-session (replaces this shell; s6 tracks the session).
#
# No root actions here: chown/env-file publishing lives in init-wtk-appshare.
set -u

SHARE="${WTK_APPSHARE:-/run/wt-kasm-app}"

# ---- 1. DISPLAY sanitation -------------------------------------------------
DISPLAY_N=$(printf '%s' "${DISPLAY:-}" | tr -d '\r\n')
if [ -z "$DISPLAY_N" ]; then
  echo "startwm: FATAL: DISPLAY empty" >&2
  exit 1
fi
DISPLAY="$DISPLAY_N"
export DISPLAY

# XAUTHORITY: the s6 env (written by init-wtk-appshare) is the primary source;
# fall back to the contract file so a manual `svc-de`-style run still authes.
if [ -z "${XAUTHORITY:-}" ] && [ -r "$SHARE/xauth" ]; then
  XAUTHORITY="$SHARE/xauth"
  export XAUTHORITY
fi

# ---- 2. wait for X (bounded, fail-closed) ----------------------------------
# 240 x 0.5s = 120s ceiling. xprop is in the base image (openbox layer).
i=0
while ! xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 240 ]; then
    echo "startwm: FATAL: X display $DISPLAY not reachable after 120s" >&2
    exit 1
  fi
  sleep 0.5
done

# ---- 3. root-window ownership tokens ---------------------------------------
GEN=""
if [ -r "$SHARE/generation" ]; then
  GEN=$(tr -d '\r\n' < "$SHARE/generation")
fi
case "$GEN" in
  *[!0-9a-fA-F]*|'')
    echo "startwm: FATAL: no hex generation in $SHARE/generation" >&2
    exit 1
    ;;
esac
if [ "${#GEN}" -lt 16 ]; then
  echo "startwm: FATAL: generation too short (${#GEN} chars, want >=16)" >&2
  exit 1
fi

ID="${WTK_DESKTOP_ID:-probe}"
ID=$(printf '%s' "$ID" | tr -cd 'A-Za-z0-9._-')
if [ -z "$ID" ]; then ID=probe; fi

if ! xprop -root -f _WT_KASM_DESKTOP_ID 8s -set _WT_KASM_DESKTOP_ID "$ID"; then
  echo "startwm: FATAL: cannot set _WT_KASM_DESKTOP_ID" >&2
  exit 1
fi
if ! xprop -root -f _WT_KASM_GENERATION 8s -set _WT_KASM_GENERATION "$GEN"; then
  echo "startwm: FATAL: cannot set _WT_KASM_GENERATION" >&2
  exit 1
fi

# Read back: a silent partial write (property deleted between set and session
# takeover) must not reach the manager as a healthy desktop.
RB=$(xprop -root _WT_KASM_GENERATION 2>/dev/null | sed -n 's/^[^=]*= "\(.*\)"$/\1/p')
if [ "$RB" != "$GEN" ]; then
  echo "startwm: FATAL: _WT_KASM_GENERATION read-back mismatch (want $GEN got '$RB')" >&2
  exit 1
fi
RBI=$(xprop -root _WT_KASM_DESKTOP_ID 2>/dev/null | sed -n 's/^[^=]*= "\(.*\)"$/\1/p')
if [ "$RBI" != "$ID" ]; then
  echo "startwm: FATAL: _WT_KASM_DESKTOP_ID read-back mismatch (want $ID got '$RBI')" >&2
  exit 1
fi
echo "startwm: ownership tokens set (desktop=$ID generation=${GEN:0:8}...)"

# ---- 4. window manager -----------------------------------------------------
exec openbox-session
