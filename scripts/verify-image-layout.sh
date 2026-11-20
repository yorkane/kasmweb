#!/usr/bin/env bash
# verify-image-layout.sh <image-ref | path-to-save-tar>
#
# Offline layout self-check for a kasmweb image. The image is inspected with
# 'docker save' + tar unpack only: no 'docker run', no 'docker create', so it is
# safe on a box that runs production containers.
#
# Checks (all must pass; exit non-zero otherwise):
#   1 /defaults/desktop has exactly 2 entries: Chrome.desktop + Chrome-Local.desktop
#     (asserted as an exact set), each with its verbatim Exec line:
#     Chrome -> /opt/wtk/bin/wtk-launch chrome (host bridge),
#     Chrome-Local -> /opt/wtk/bin/wtk-chrome-local (in-container Chromium)
#   1b /opt/wtk/bin/wtk-chrome-local is present and executable
#   1c /usr/bin/chromium-browser is present and its ABSOLUTE symlink target
#      /usr/lib/chromium/chromium-launcher.sh + the chrome binary resolve INSIDE
#      the unpacked rootfs (Alpine's package provides no /usr/bin/chromium -
#      apk info -L measured 2026-11-20)
#   2 /opt/wtk/windowing/tint2/tint2rc: panel_items = TC and clock_padding = 44 0
#   3 /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run exists and has NO -AcceptSetDesktopSize
#   4 /opt/wtk/bin/healthcheck.sh contains the pulse native gate
#   4b /opt/wtk/bin/healthcheck.sh carries the native resize verdict
#     (RESIZE_MODE="native" feeds the OK line => a native image reports
#     resize=native) and the gate-5 sentinel pair (validity-only geometry
#     gate; equality with the startup size must never be asserted)
#   5 /opt/wtk/audio/web/jsmpeg.min.js and LICENSE-jsmpeg.txt are in the package
#   6 /opt/wtk/windowing/desktop/icons/chrome.png is a real PNG
#   7 Sublime Text 4 product state: /usr/bin/subl + /opt/sublime_text/sublime_text
#     present and the binary sha256 == the frozen POST-registration-patch hash
#     (a deb-extracted raw, half-patched, or other-build binary FAILS),
#     /etc/xdg/mimeapps.list maps exactly the 13 pinned types to
#     sublime_text.desktop, and /usr/share/applications/sublime_text.desktop
#     carries the verbatim Exec line + the verbatim 13-type MimeType line.
#
# Layouts handled: (A) OCI 'docker save' (docker 23+: index.json ->
# blobs/sha256/*), (B) the buildx --load artifact the GitHub runner stores
# (index.json additionally lists a provenance/attestation manifest - no layers[]
# key, platform arch/os=unknown - reordered to the front: the resolver picks the
# first entry that has a non-empty layers[] and is not an attestation, and
# descends into nested indexes), (C) legacy manifest.json + <digest>.tar.
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
# Layer resolver for three docker-save shapes (all produced by real pipelines):
#   A. OCI archive (docker save >= 23): index.json -> blobs/sha256/*
#   B. buildx --load artifact on the CI runner: index.json whose manifests[] ALSO
#      contains a provenance/attestation manifest - NO "layers" key, annotations
#      vnd.docker.reference.type=attestation-manifest, platform arch/os=unknown -
#      and the docker store reorders it to the FRONT. Taking manifests[0] blindly
#      dies with KeyError: layers (this is the CI failure of run #1).
#   C. legacy archive: manifest.json[0]["Layers"] (uppercase), <hex>/layer.tar.
# The image manifest is selected as: prefer platform linux/amd64, never an
# attestation entry, never an entry whose blob lacks a non-empty layers[].
# Nested indexes (multi-platform manifest lists) are descended into.
# Every failure path prints an explicit diagnosis, never a bare KeyError.
import json, sys, tarfile

save_path, out_list = sys.argv[1], sys.argv[2]

def die(msg):
    raise SystemExit("verify-image-layout: " + msg)

with tarfile.open(save_path, "r:") as t:
    members = set(m.name.lstrip("./") for m in t.getmembers())

    def blob(digest):
        p = digest.replace(":", "/")
        for cand in ("blobs/" + p, p, "blobs/" + p + ".tar", p + ".tar"):
            if cand in members:
                return json.load(t.extractfile(cand))
        return None

    def pick(entries, depth):
        # -> (digest, manifest, skipped_notes)
        if depth >= 4:
            die("index nesting too deep")
        picked = []
        skipped = []
        for e in entries:
            d = e.get("digest")
            if not d:
                skipped.append("entry without digest")
                continue
            ann = e.get("annotations") or {}
            plat = e.get("platform") or {}
            man = blob(d)
            if man is None:
                skipped.append("blob missing: " + d)
                continue
            if isinstance(man.get("manifests"), list):
                return pick(man["manifests"], depth + 1)   # nested index
            layers = man.get("layers")
            has_layers = isinstance(layers, list) and len(layers) > 0
            if ann.get("vnd.docker.reference.type") == "attestation-manifest" \
               or (plat.get("architecture") == "unknown" and plat.get("os") == "unknown") \
               or (not has_layers and "subject" in man):
                skipped.append("attestation/provenance: " + d)
                continue
            if not has_layers:
                skipped.append("no layers[]: %s keys=%s" % (d, sorted(man.keys())))
                continue
            rank = 0 if (plat.get("os", "linux") == "linux"
                         and plat.get("architecture", "amd64") == "amd64") else 1
            picked.append((rank, d, man))
        if not picked:
            die("no image manifest (non-empty layers[]) among %d index entries; "
                "skipped: %s" % (len(entries), "; ".join(skipped) or "none"))
        picked.sort(key=lambda x: x[0])
        item = picked[0]
        return item[1], item[2], skipped

    want = []
    if "index.json" in members:
        index = json.load(t.extractfile("index.json"))
        entries = index.get("manifests")
        if not isinstance(entries, list) or not entries:
            die("index.json has no manifests[] (keys=%s)" % sorted(index.keys()))
        digest, man, skipped = pick(entries, 0)
        print("selected image manifest: %s" % digest)
        for s in skipped:
            print("skipped %s" % s)
        for l in man["layers"]:
            d = l["digest"]
            p = d.replace(":", "/")
            for cand in ("blobs/" + p, p, "blobs/" + p + ".tar", p + ".tar"):
                if cand in members:
                    want.append(cand)
                    break
            else:
                die("layer blob missing from archive: " + d)
    elif "manifest.json" in members:
        manifest = json.load(t.extractfile("manifest.json"))
        first = manifest[0] if isinstance(manifest, list) and manifest else {}
        layers = first.get("Layers") if isinstance(first, dict) else None
        if not isinstance(layers, list) or not layers:
            die("manifest.json[0] has no Layers[] (keys=%s)" % sorted(first.keys()))
        for l in layers:
            p = l.lstrip("./")
            want.append(p if p in members else p + ".tar")
    else:
        top = sorted(set("/".join(m.split("/")[:2]) for m in members))[:20]
        die("unrecognized save archive: no index.json / manifest.json; "
            "top members: %s" % top)

    for p in want:
        if p not in members:
            die("layer member missing from save archive: " + p)
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

# --- 1: /defaults/desktop = exactly {Chrome, Chrome-Local} -------------------
D="$ROOT/defaults/desktop"
if [ -d "$D" ]; then
  n=$(find "$D" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  names=$(cd "$D" && ls -1 | LC_ALL=C sort | tr '\n' ' ')
  if [ "$n" = 2 ] && [ "$names" = "Chrome-Local.desktop Chrome.desktop " ]; then
    ok desktop_entries "/defaults/desktop has exactly 2 entries: $names"
  else
    ko desktop_entries "/defaults/desktop has $n entries [$names], expected exactly {Chrome.desktop, Chrome-Local.desktop}"
  fi
  if [ -f "$D/Chrome.desktop" ] && grep -q '^Exec=/opt/wtk/bin/wtk-launch chrome$' "$D/Chrome.desktop"; then
    ok desktop_chrome_exec "Chrome.desktop Exec = /opt/wtk/bin/wtk-launch chrome (host bridge)"
  else
    ko desktop_chrome_exec "Chrome.desktop missing or Exec != /opt/wtk/bin/wtk-launch chrome"
  fi
  if [ -f "$D/Chrome-Local.desktop" ] && grep -q '^Exec=/opt/wtk/bin/wtk-chrome-local$' "$D/Chrome-Local.desktop"; then
    ok desktop_local_exec "Chrome-Local.desktop Exec = /opt/wtk/bin/wtk-chrome-local (in-container)"
  else
    ko desktop_local_exec "Chrome-Local.desktop missing or Exec != /opt/wtk/bin/wtk-chrome-local"
  fi
else
  ko desktop_entries "/defaults/desktop missing"
  ko desktop_chrome_exec "/defaults/desktop missing"
  ko desktop_local_exec "/defaults/desktop missing"
fi

# --- 1b: in-container launcher present + executable --------------------------
CL="$ROOT/opt/wtk/bin/wtk-chrome-local"
if [ -f "$CL" ] && [ -x "$CL" ]; then
  ok chrome_local_launcher "/opt/wtk/bin/wtk-chrome-local present, mode $(stat -c '%a' "$CL")"
else
  ko chrome_local_launcher "/opt/wtk/bin/wtk-chrome-local missing or not executable"
fi

# --- 1c: in-container chromium entry point present ----------------------------
# Alpine's chromium package provides /usr/bin/chromium-browser as an ABSOLUTE
# symlink to /usr/lib/chromium/chromium-launcher.sh. A bare [ -x ] on the link
# follows it into the HOST filesystem (where it does not exist) and would
# report a false negative, so the link is read here and its target resolved
# inside the unpacked rootfs. The package provides no /usr/bin/chromium
# (apk info -L chromium, measured 2026-11-20).
CB="$ROOT/usr/bin/chromium-browser"
if [ ! -L "$CB" ] && [ ! -e "$CB" ]; then
  ko chromium_bin "/usr/bin/chromium-browser missing: the image ships no in-container browser"
else
  CB_LINK=$(readlink "$CB" 2>/dev/null || true)
  case "$CB_LINK" in
    /*) CB_RES="$ROOT$CB_LINK" ;;
    *)  CB_RES="$(dirname "$CB")/$CB_LINK" ;;
  esac
  if [ ! -s "$CB_RES" ]; then
    ko chromium_bin "entry link $CB -> ${CB_LINK:-<regular file>}; resolved target $CB_RES missing/empty in rootfs"
  elif [ ! -s "$ROOT/usr/lib/chromium/chrome" ]; then
    ko chromium_bin "/usr/lib/chromium/chrome (the browser binary) missing in rootfs"
  else
    ok chromium_bin "/usr/bin/chromium-browser -> ${CB_LINK} resolves in rootfs; /usr/lib/chromium/chrome $(wc -c < "$ROOT/usr/lib/chromium/chrome" | tr -d ' ') B"
  fi
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

# --- 7: Sublime Text 4 (build 4200) product state -----------------------------
# The registration patch is byte-locked: the shipped binary must hash to the
# POST-patch constant, i.e. the image carries the registered build and nothing
# in between (deb-extracted raw / half-patched / other build) can pass. The
# desktop file is asserted with BOTH the verbatim Exec line and the verbatim
# 13-type MimeType line (the release gate rewrites it from the deb-original
# "text/plain;"); /etc/xdg/mimeapps.list must map exactly the same 13 types.
SB="$ROOT/opt/sublime_text/sublime_text"
SUB="$ROOT/usr/bin/subl"
if [ -f "$SUB" ] && [ -f "$SB" ]; then
  ok sublime_binaries "/usr/bin/subl + /opt/sublime_text/sublime_text present in rootfs"
  WANT_POST="f145efb381d4cb8b5129cbfa1f180274cc0b9d39d7b05c88b9095d43a2ff9c36"
  got_post=$(sha256sum "$SB" | awk '{print $1}')
  if [ "$got_post" = "$WANT_POST" ]; then
    ok sublime_registered "sublime_text sha256 = post-registration-patch state (registered build 4200)"
  else
    ko sublime_registered "sublime_text sha256 $got_post != frozen post-patch $WANT_POST (unpatched / not build 4200)"
  fi
else
  ko sublime_binaries "/usr/bin/subl or /opt/sublime_text/sublime_text missing (Sublime not installed)"
  ko sublime_registered "sublime binary absent; registration state unverifiable"
fi
MIMEA="$ROOT/etc/xdg/mimeapps.list"
need_types="application/javascript application/json application/xml text/css text/html text/javascript text/markdown text/plain text/x-c text/x-python text/x-shellscript text/xml text/yaml"
if [ -f "$MIMEA" ]; then
  miss=""
  for t in $need_types; do grep -q "^$t=sublime_text.desktop$" "$MIMEA" || miss="$miss $t"; done
  mapped=$(grep -c "=sublime_text.desktop$" "$MIMEA")
  if [ -z "$miss" ] && [ "$mapped" = "13" ]; then
    ok sublime_mimeapps "/etc/xdg/mimeapps.list maps exactly the 13 pinned types to sublime_text.desktop"
  else
    ko sublime_mimeapps "mimeapps.list mapped=$mapped (want 13); missing:${miss:-none}"
  fi
else
  ko sublime_mimeapps "/etc/xdg/mimeapps.list missing (no system default-open policy)"
fi
SD="$ROOT/usr/share/applications/sublime_text.desktop"
WANT_MIME="MimeType=application/javascript;application/json;application/xml;text/css;text/html;text/javascript;text/markdown;text/plain;text/x-c;text/x-python;text/x-shellscript;text/xml;text/yaml;"
if [ -f "$SD" ] && grep -qxF "Exec=/opt/sublime_text/sublime_text %F" "$SD" && grep -qxF "$WANT_MIME" "$SD"; then
  ok sublime_desktop "sublime_text.desktop: Exec verbatim + MimeType = 13-type set (libfm Open With)"
else
  ko sublime_desktop "sublime_text.desktop missing, Exec changed, or MimeType not the 13-type set"
fi

if [ "$fail_n" -gt 0 ]; then
  echo "LAYOUT FAIL - $fail_n failed, $pass_n passed"
  exit 1
fi
echo "LAYOUT OK - $pass_n checks passed"
