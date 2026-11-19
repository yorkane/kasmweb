#!/bin/bash
# s6-apply.sh - rewrite the base image's s6-rc graph for this image layer.
#
# Called from the Dockerfile AFTER the unit directories have been copied in.
# Idempotent. Refuses to leave a dangling reference: a dependency edge naming a
# unit that is not registered is a hard error when s6-rc compiles the graph, and
# the container then dies with a log line nobody reads at 3am - so the final pass
# checks every edge of every registered unit against the set of existing units.
#
# ZERO rm, including inside the image (root ruling 2026-11-13): removals are
# `mv` into $RESIDUE = /opt/wtk-build-residue, which keeps every displaced file
# inspectable in the shipped image. Edge files and contents.d stamps are empty
# by s6-rc's own format, so their archived names are flattened (unit__dep).
#
# Why the removals (base = baseimage-kasmvnc:alpine317, 22 registered units):
#   svc-kclient               - the Kasm Workspaces client (node /kclient). It owns
#                               the 6901/4901 publish UX and requires a Kasm manager
#                               account. Its removal is what forces the edge rewrite
#                               below. ONLY THE SERVICE IS DISABLED: the /kclient tree
#                               stays in the image, because audio/relay.js resolves its
#                               `ws` module from /kclient/node_modules/ws (ws@8.17.1 in
#                               this base). Do not delete that tree in the Dockerfile.
#   svc-docker                - docker-cli sidecar; compose forbids docker.sock and
#                               START_DOCKER=false, so it can only ever fail.
#   init-mods-package-install - apt/pip at boot, then rm -rf's the mod lists. No mod
#                               repo here, and the pip path needs network at boot.
#
# Edge rewrites. Base chain was:
#   svc-kasmvnc <- svc-pulseaudio ; svc-kclient <- svc-kasmvnc ;
#   svc-nginx   <- svc-kclient    ; svc-de      <- svc-nginx
# After this script:
#   svc-nginx: dependencies.d = init-services                      (-svc-kclient)
#   svc-de:    dependencies.d = init-services svc-kasmvnc svc-pulseaudio
#              (-svc-nginx +svc-kasmvnc +svc-pulseaudio), run script overridden
#     DE must never start before the X server exists; with kclient gone the honest
#     edge is svc-kasmvnc. nginx and DE are siblings from init-services onwards.
#   svc-pulseaudio: dependencies.d = init-services init-wtk-appshare (+appshare)
#
# New units (copied by the Dockerfile, registered here):
#   init-wtk-appshare oneshot <- init-kasmvnc-config   (env is final, runs early)
#   svc-wtk-audio     longrun <- init-services, svc-pulseaudio
#   init-nginx / svc-nginx / svc-kasmvnc / svc-pulseaudio / svc-de: same unit names,
#   run scripts overridden (render vhost atomically / pure exec / WTK_* geometry+gen /
#   pinned cookie + drop-ins / explicit startwm entry).
#
# No new nginx-render unit is needed: init-nginx already sits upstream of
# init-services in the base chain (init-os-end -> init-kasmvnc -> init-nginx ->
# init-kasmvnc-config -> init-video -> init-kasmvnc-end -> init-config ->
# init-config-end -> init-mods -> init-mods-end -> init-custom-files ->
# init-services), so every svc-* sees a rendered vhost.
set -eu

R=/etc/s6-overlay/s6-rc.d
C=$R/user/contents.d
RESIDUE=${WTK_RESIDUE:-/opt/wtk-build-residue}
# s6-overlay 3.1.2.1 keeps its BUILT-IN sources beside the compiled repo, under
# /package/admin/s6-overlay-3.1.2.1/etc/s6-rc/sources (base, top, fix-attrs,
# legacy-cont-init, legacy-services). Those names are not under $R, so an audit
# that scans only $R calls a correct image broken: build 105210 died on
#   ci-service-check -> legacy-services   and   init-os-end -> base.
# Both edges are correct, and the Dockerfile hands s6-rc-compile BOTH roots
# (Dockerfile:210-211), so the audit resolves a name against both roots too.
# That is a name lookup, not a blanket pass: a name absent from both roots is
# still a hard failure, and no edge is ever deleted to make the audit quiet.
SRC=${WTK_S6_SOURCES:-/package/admin/s6-overlay-3.1.2.1/etc/s6-rc/sources}

die() { echo "s6-apply: FATAL: $*" >&2; exit 1; }
say() { echo "s6-apply: $*"; }

[ -d "$R" ] || die "$R missing (wrong base image?)"
[ -d "$C" ] || die "$C missing"
mkdir -p "$RESIDUE" || die "cannot create residue dir $RESIDUE"

# archive <src> <flattened-name>: mv, never rm. Empty files (edges, contents.d
# stamps) are preserved as zero-byte records so the graph diff is auditable.
archive() {
  [ -e "$1" ] || return 0
  mv "$1" "$RESIDUE/$2" || die "cannot archive $1 -> $RESIDUE/$2"
  say "archived: $1 -> $RESIDUE/$2"
}

# --- 1) removals: every inbound edge must go before the unit itself -----------
for u in svc-kclient svc-docker init-mods-package-install; do
  if [ -d "$R/$u" ]; then
    for d in "$R"/*/dependencies.d; do
      [ -e "$d/$u" ] || continue
      unit=$(basename "$(dirname "$d")")
      archive "$d/$u" "edge__${unit}__${u}"
    done
    archive "$C/$u" "contents__${u}"
    archive "$R/$u" "unit__${u}"
    say "unit removed: $u"
  else
    say "absent (already removed): $u"
  fi
done

# --- 2) edge rewrites --------------------------------------------------------
archive "$R/svc-nginx/dependencies.d/svc-kclient" "edge__svc-nginx__svc-kclient"
touch "$R/svc-nginx/dependencies.d/init-services"

archive "$R/svc-de/dependencies.d/svc-nginx" "edge__svc-de__svc-nginx"
touch "$R/svc-de/dependencies.d/init-services" \
      "$R/svc-de/dependencies.d/svc-kasmvnc" \
      "$R/svc-de/dependencies.d/svc-pulseaudio"

touch "$R/svc-pulseaudio/dependencies.d/init-wtk-appshare"

# --- 3) registration (touch = an empty file is the whole dependency record) ---
for u in init-wtk-appshare svc-wtk-audio; do
  [ -d "$R/$u" ] || die "unit directory $R/$u was not copied"
  [ -f "$R/$u/type" ] || die "unit $u has no type file"
  touch "$C/$u"
  say "registered: $u (type=$(cat "$R/$u/type"))"
done

# appshare must run before the daemon that binds a socket into it, and it reads
# /defaults written by the kasmvnc config oneshot, so that is its upstream edge.
touch "$R/init-wtk-appshare/dependencies.d/init-kasmvnc-config"

# --- 4) dangling-edge audit --------------------------------------------------
missing=0
# Both roots are audited: the image's own units in $R, and the s6-overlay
# built-ins in $SRC, whose edges (legacy-services -> base user, top -> ...) are
# the ones the compiler resolves at boot. A dep name must exist in one of them.
for d in "$R"/*/dependencies.d "$SRC"/*/dependencies.d; do
  unit=$(basename "$(dirname "$d")")
  for dep in "$d"/*; do
    [ -e "$dep" ] || continue
    name=$(basename "$dep")
    if [ -d "$R/$name" ] || [ -d "$SRC/$name" ]; then
      continue
    fi
    say "FATAL: $unit depends on unregistered unit $name (looked in $R and $SRC)"
    missing=1
  done
done
[ "$missing" = 0 ] || die "dangling dependency edges present (see above)"

# --- 5) executability, asserted not assumed ---------------------------------
for f in svc-kasmvnc svc-nginx svc-de svc-pulseaudio svc-wtk-audio init-nginx init-wtk-appshare; do
  [ -f "$R/$f/run" ] || die "unit $f has no run script"
  # ENOEXEC guard: s6-supervise execs the run script directly, so the shebang
  # must be byte 0. svc-wtk-audio/run shipped with a leading blank line and
  # s6-overlay's scan gate skips empty files, so the build stayed silent.
  head -c 2 "$R/$f/run" | grep -q '^#!' || die "unit $f: run script does not start with a shebang at byte 0 (s6 execs it directly -> ENOEXEC)"
  chmod 0755 "$R/$f/run"
done

# A oneshot needs an `up` file naming the script to run, and s6-rc wants the
# ABSOLUTE path. init-wtk-appshare/up shipped as a single newline = an empty
# oneshot: the contract (credentials, app.json, group ownership) would never
# run, and s6-rc-compile fails on the missing command.
u=$R/init-wtk-appshare/up
[ -s "$u" ] || die "init-wtk-appshare/up is empty - a oneshot with no up file runs nothing"
[ "$(tr -d '\r\n' < "$u")" = "$R/init-wtk-appshare/run" ] || die "init-wtk-appshare/up must contain the absolute run path ($R/init-wtk-appshare/run), got: $(tr -d '\r\n' < "$u")"
for f in $(find "$R" -path '*/dependencies.d/*' -size +0c); do
  die "edge file $f is not zero-length (s6-rc encodes an edge as an empty file)"
done

# --- 6) session-entry assertions (build-time, so a broken overlay cannot ship) -
[ -f /defaults/startwm.sh ] || die "/defaults/startwm.sh absent (svc-de execs it; a missing file = silent no-desktop)"
[ -x /defaults/startwm.sh ] || die "/defaults/startwm.sh is not executable"
grep -q 'startwm.sh' "$R/svc-de/run" || die "svc-de/run does not exec /defaults/startwm.sh"
grep -qx 'exec s6-setuidgid abc /bin/bash /defaults/startwm.sh' "$R/svc-de/run" || die "svc-de/run does not end with the explicit exec line for /defaults/startwm.sh"
# The base openbox package ALREADY ships /etc/xdg/openbox/rc.xml, so a plain
# -f test is satisfied by the untouched base and proves nothing. Match the
# generation marker that merge-rc.py writes into our rc.xml (build-rc.sh).
grep -q 'wtk-windowing:generated' /etc/xdg/openbox/rc.xml || die "/etc/xdg/openbox/rc.xml is the stock base file, not the generated wtk rc (COPY target wrong?)"
[ -f /opt/wtk/windowing/tint2/tint2rc ] || die "tint2rc absent at its contract path (autostart hardcodes it)"
[ -d /opt/wtk/web ] || die "/opt/wtk/web absent (render-nginx.py writes wtk-boot.js there)"
[ -x /opt/wtk/bin/wtk-xauth-seed ] || die "/opt/wtk/bin/wtk-xauth-seed missing/not executable (init-wtk-appshare calls it)"
[ -x /opt/wtk/bin/wtk-launch ] || die "/opt/wtk/bin/wtk-launch missing/not executable"
[ -d /etc/pulse/default.pa.d ] || die "/etc/pulse/default.pa.d absent (pulse drop-in would be silently ignored)"
[ -f /etc/pulse/default.pa.d/20-wtk-app-share.pa ] || die "pulse drop-in not installed"
[ -d /kclient/node_modules/ws ] || die "/kclient/node_modules/ws absent - relay.js ws fallback needs it (do not delete /kclient)"

say "graph: user/contents.d = $(ls "$C" | tr '\n' ' ')"
say "residue: $(ls "$RESIDUE" | tr '\n' ' ')"
# --- 7) nginx main config: pin worker_processes (image-borne, build-time) ------
# The Alpine main config ships "worker_processes auto;", which counts the HOST CPUs,
# not the container cpus= quota: probe host nproc = 144, so ONE desktop spawned ~144
# idle nginx workers and three desktops would be ~432 processes doing nothing (root
# observed 192 per desktop on its host). One worker serves this container end to end
# (single-entry vhost: ws + audio for one 1600x900 session), so the first version
# pins 1. Resource sanity, not a capacity study.
# The -g flag is not an option: "nginx -g 'daemon off; worker_processes 1;'" dies with
#   "worker_processes" directive is duplicate in /etc/nginx/nginx.conf:6
# (probe wtk-hc-probe/nginx_worker.sh, rc=1), so the main config file is rewritten.
# Root ruling 2026-11-13: generate/copy a main config, do not touch upstream services -
# /etc/nginx/nginx.conf is read only by svc-nginx inside this container.
NC=${WTK_NGINX_MAIN:-/etc/nginx/nginx.conf}
[ -f "$NC" ] || die "nginx main config $NC absent: the worker pin is impossible and svc-nginx would inherit auto"
archive "$NC" nginx.conf.base
sed 's/^[[:space:]]*worker_processes[[:space:]]*auto[[:space:]]*;/worker_processes 1; # wtk: base auto = 1 worker per HOST cpu per desktop/' "$RESIDUE/nginx.conf.base" > "$NC" || die "sed failed on $NC"
grep -q '^worker_processes 1;' "$NC" || die "worker pin left no 'worker_processes 1;' line in $NC - base file changed shape; extend the sed, do not relax this gate"
if grep -qE '^[[:space:]]*worker_processes[[:space:]]+auto' "$NC"; then die "worker_processes auto survives in $NC"; fi
nginx -t >/dev/null 2>&1 || die "nginx -t rejects $NC after the worker pin"
say "nginx: worker_processes pinned to 1 in $NC (host nproc = $(nproc)); base config archived as nginx.conf.base; nginx -t ok"
say "APPLY OK"
