#!/usr/bin/env bash
# verify-image-layout.sh <image-ref | path-to-save-tar>
#
# Offline layout self-check for a kasmweb image. The image is inspected with
# 'docker save' + tar unpack only: no 'docker run', no 'docker create', so it is
# safe on a box that runs production containers.
#
# Checks (all must pass; exit non-zero otherwise):
#   1 /defaults/desktop has exactly 1 entry
#   2 /opt/wtk/windowing/tint2/tint2rc: panel_items = TC and clock_padding = 44 0
#   3 /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run exists and has NO -AcceptSetDesktopSize
#   4 /opt/wtk/bin/healthcheck.sh contains the pulse native gate
#   4b /opt/wtk/bin/healthcheck.sh carries the native resize verdict
#     (RESIZE_MODE="native" feeds the OK line => a native image reports
#     resize=native) and the gate-5 sentinel pair (validity-only geometry
#     gate; equality with the startup size must never be asserted)
#   5 /opt/wtk/audio/web/jsmpeg.min.js and LICENSE-jsmpeg.txt are in the package
#   6 /opt/wtk/windowing/desktop/icons/chrome.png is a real PNG
#
# Layouts handled: OCI 'docker save' (docker 23+: blobs/sha256/<digest>,
# index.json -> manifest -> layers) and legacy (<digest>.tar + manifest.json).
# Overlay semantics applied during unpack: layers merged low -> high, .wh.*
# whiteouts removed, .wh..wh..opq opaque markers clear their directory.
#
# TMPDIR controls the scratch dir (CI default /tmp; dev box: export TMPDIR=/data/tmp).
# WTK_KEEP=1 keeps the scratch dir (unpacked rootfs) and prints its path.
# WTK_TRASH=<dir> moves the scratch dir there at exit instead of deleting it.
set -euo pipefail
set -o pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image-ref|save-tar>" >&2
  exit 2
fi
target="$1"

WORK="$(mktemp -d)"
ROOT="$WORK/rootfs"
mkdir -p "$ROOT"

cleanup() {
  if [ "${WTK_KEEP:-}" = "1" ]; then
    echo "kept: $WORK"
    return 0
  fi
  if [ -n "${WTK_TRASH:-}" ]; then
    mkdir -p "${WTK_TRASH}"
    mv "$WORK" "${WTK_TRASH}/$(basename "$WORK")" 2>/dev/null || true
    return 0
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

SAVE="$WORK/image.tar"
case "$target" in
  *.tar)
    [ -f "$target" ] || { echo "FATAL: no such tar: $target" >&2; exit 2; }
    SAVE="$target"
    ;;
  *)
    echo "docker save $target"
    docker save "$target" -o "$SAVE"
    ;;
esac

# Resolve the ordered layer member paths inside the save archive.
# The index.json probe is OPTIONAL: under set -e an unguarded extract aborts the
# script on a legacy (non-OCI) save archive before the layout resolver below can
# even look at it - exactly the layout that branch exists to support. Tolerate
# the miss here; the python resolver detects the layout from the archive listing.
tar -xf "$SAVE" -C "$WORK" index.json 2>/dev/null || true
python3 - "$SAVE" "$WORK/layers.txt" <<'PYEOF'
import json, sys, tarfile

save_path, out_list = sys.argv[1], sys.argv[2]
with tarfile.open(save_path, "r:") as t:
    members = set(m.name.lstrip("./") for m in t.getmembers())
    if "index.json" in members:
        # OCI layout (docker save >= 23): index.json -> manifest -> layers
        index = json.load(t.extractfile("index.json"))
        subject = index["manifests"][0]["digest"].replace(":", "/")
        man = json.load(t.extractfile("blobs/" + subject))
        want = ["blobs/" + l["digest"].replace(":", "/") for l in man["layers"]]
    else:
        # legacy layout: manifest.json at root, layers as <digest>.tar
        manifest = json.load(t.extractfile("manifest.json"))
        want = []
        for l in manifest[0]["Layers"]:
            p = l.lstrip("./")
            want.append(p if p in members else p + ".tar")
    for p in want:
        if p not in members:
            raise SystemExit("layer member missing from save archive: " + p)
    with open(out_list, "w") as fh:
        fh.write("\n".join(want) + "\n")
    print("layers: %d" % len(want))
PYEOF

while IFS= read -r layer; do
  [ -n "$layer" ] || continue
  blob="$WORK/$layer"
  mkdir -p "$(dirname "$blob")"
  tar -C "$WORK" -xf "$SAVE" "$layer"
  chmod -R u+w "$ROOT" 2>/dev/null || true
  # system tar: resolves busybox-style absolute hardlink targets inside the
  # tree, and --unlink-first (implies overwrite; GNU tar rejects it combined
  # with --overwrite) lets later layers replace 0444/0555 entries.
  # "Cannot unlink: Directory not empty" is overlay-safe noise (the directory
  # is already in place with content from lower layers): tolerated. Any other
  # tar error is fatal.
  terr="$WORK/tar.err"
  if ! tar -xpf "$blob" -C "$ROOT" --unlink-first 2>"$terr"; then
    if grep -vqE '^tar: (.*: Cannot unlink: Directory not empty|Exiting with failure status due to previous errors)$' "$terr"; then
      echo "FATAL: layer extract failed: $layer" >&2
      cat "$terr" >&2
      exit 1
    fi
  fi
  # opaque-dir markers: hide directory content coming from lower layers
  find "$ROOT" -depth -type f -name '.wh..wh..opq' | while read -r f; do
    d=$(dirname "$f")
    find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    rm -f "$f"
  done
  # whiteout files: remove the target entry, then the marker
  find "$ROOT" -depth -type f -name '.wh.*' ! -name '.wh..wh..opq' | while read -r f; do
    b=$(basename "$f")
    t="${f%/.wh.*}/${b#.wh.}"
    if { [ -e "$t" ] || [ -L "$t" ]; }; then
      rm -rf "${t:?}"
    fi
    rm -f "$f"
  done
  rm -f "$blob"
done < "$WORK/layers.txt"
echo "unpacked rootfs"

pass_n=0
fail_n=0
ok() { echo "PASS  $1  -  $2"; pass_n=$((pass_n + 1)); }
ko() { echo "FAIL  $1  -  $2"; fail_n=$((fail_n + 1)); }

# --- 1: /defaults/desktop has exactly 1 entry -------------------------------
D="$ROOT/defaults/desktop"
if [ -d "$D" ]; then
  n=$(find "$D" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  if [ "$n" = 1 ]; then
    ok desktop_entries "/defaults/desktop has exactly 1 entry: $(ls "$D" | tr '\n' ' ')"
  else
    ko desktop_entries "/defaults/desktop has $n entries, expected exactly 1"
  fi
else
  ko desktop_entries "/defaults/desktop missing"
fi

# --- 2: tint2rc panel_items = TC and clock_padding = 44 0 -------------------
T="$ROOT/opt/wtk/windowing/tint2/tint2rc"
if [ -f "$T" ] && grep -Eq '^panel_items[[:space:]]*=[[:space:]]*TC[[:space:]]*$' "$T"; then
  ok tint2_panel_items "panel_items = TC"
else
  ko tint2_panel_items "no '^panel_items = TC' in /opt/wtk/windowing/tint2/tint2rc"
fi
if [ -f "$T" ] && grep -Eq '^clock_padding[[:space:]]*=[[:space:]]*44[[:space:]]+0[[:space:]]*$' "$T"; then
  ok tint2_clock_padding "clock_padding = 44 0"
else
  ko tint2_clock_padding "no '^clock_padding = 44 0' in /opt/wtk/windowing/tint2/tint2rc"
fi

# --- 3: svc-kasmvnc/run does not PASS -AcceptSetDesktopSize ------------------
# The native variant documents the flag name in comments on purpose; the gate
# is about the effective command line, so comment lines are stripped first.
S="$ROOT/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run"
if [ ! -f "$S" ]; then
  ko svc_kasmvnc_run "/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run missing"
elif grep -v '^[[:space:]]*#' "$S" | grep -q -- '-AcceptSetDesktopSize'; then
  ko svc_kasmvnc_run "-AcceptSetDesktopSize passed on a non-comment line (must not be passed)"
else
  ok svc_kasmvnc_run "run script present, -AcceptSetDesktopSize not passed (comments only)"
fi

# --- 4: healthcheck has the native gate --------------------------------------
H="$ROOT/opt/wtk/bin/healthcheck.sh"
if [ -f "$H" ] && grep -q 'module-native-protocol-unix' "$H"; then
  ok healthcheck_native "native pulse gate present (module-native-protocol-unix)"
else
  ko healthcheck_native "/opt/wtk/bin/healthcheck.sh missing native gate"
fi

# --- 4b: native resize verdict (this image ships the native variant) -------
if [ -f "$H" ] && grep -q 'RESIZE_MODE="native"' "$H" && grep -qF 'geom=$geom resize=$RESIZE_MODE' "$H"; then
  ok healthcheck_native_resize "native verdict wired (RESIZE_MODE=native -> OK line resize=native)"
else
  ko healthcheck_native_resize "healthcheck lacks the native resize verdict (image is not the native variant)"
fi
if [ -f "$H" ] && [ "$(grep -c 'WTK_GATE5' "$H" || true)" = "2" ]; then
  ok healthcheck_gate5 "gate5 sentinel pair present (validity-only geometry gate)"
else
  ko healthcheck_gate5 "gate5 sentinel pair missing or duplicated"
fi

# --- 5: jsmpeg vendored with license -----------------------------------------
J="$ROOT/opt/wtk/audio/web/jsmpeg.min.js"
L="$ROOT/opt/wtk/audio/web/LICENSE-jsmpeg.txt"
if [ -s "$J" ] && [ -s "$L" ]; then
  ok jsmpeg_vendor "jsmpeg.min.js ($(wc -c < "$J" | tr -d ' ') B) + LICENSE-jsmpeg.txt ($(wc -c < "$L" | tr -d ' ') B)"
else
  ko jsmpeg_vendor "missing/empty /opt/wtk/audio/web/jsmpeg.min.js or LICENSE-jsmpeg.txt"
fi

# --- 6: chrome icon is a real PNG --------------------------------------------
C="$ROOT/opt/wtk/windowing/desktop/icons/chrome.png"
if [ -f "$C" ] && [ "$(od -An -tx1 -N8 "$C" | tr -d ' \n')" = "89504e470d0a1a0a" ]; then
  ok chrome_png "/opt/wtk/windowing/desktop/icons/chrome.png has PNG magic"
else
  ko chrome_png "/opt/wtk/windowing/desktop/icons/chrome.png missing or not PNG"
fi

if [ "$fail_n" -gt 0 ]; then
  echo "LAYOUT FAIL - $fail_n failed, $pass_n passed"
  exit 1
fi
echo "LAYOUT OK - $pass_n checks passed"
