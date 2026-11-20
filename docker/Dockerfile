# kasmweb - self-contained KasmVNC desktop image (Alpine 3.17 / lsio baseimage-kasmvnc).
#
# Build contract (MUST match .github/workflows/publish.yml):
#   context = docker/  (the directory that contains this file)
#   CI (online, base pulled by digest):
#     docker build -f docker/Dockerfile docker
#   Offline dev box (base pre-seeded locally as the alias tag):
#     docker build --pull=false \\
#       --build-arg WTK_BASE=webtop-kasmvnc-base:alpine317-527bb89e \\
#       -t kasmweb:local-verify -f docker/Dockerfile docker
#
# WTK_BASE default = the immutable ghcr digest of baseimage-kasmvnc:alpine317
# (RepoDigest sha256:e67ff31d...; matching local image ID sha256:527bb89e...). CI
# resolves the digest online; an offline build overrides WTK_BASE with the local
# alias tag and passes --pull=false so the registry is never contacted.
#
# Two stages in ONE file: deps (apk layer on the exact base) -> release (content
# layers + gates). release is FROM deps, so the lineage base -> deps -> release is
# structural, not asserted by an outside script.
#
# Product deltas vs the webtop-kasmvnc K line this image descends from:
#   * the NATIVE resize variant IS the product: svc-kasmvnc/run passes NO
#     -AcceptSetDesktopSize flag (KasmVNC 1.1.0 native default = accept) and
#     healthcheck gate 5 validates the reading only (resize=native). The canonical
#     resize-switch variant is NOT shipped by this image.
#   * the desktop ships exactly TWO icons, both wearing the official Chromium
#     product logo (see NOTICE): Chrome (host bridge via launch.sock) and
#     Chrome-Local (the in-container Chromium from the apk `chromium` package).
#     The two channels are independent processes on the same X display and can
#     run at the same time; the local channel needs no manager and no host
#     Chrome (docker/bin/wtk-chrome-local).
#   * the taskbar is the minimal TC layout (tasklist + clock): no launcher, no
#     system tray.
#   * the audio chain is unchanged: pulse app-share -> node relay (MP2) -> jsmpeg
#     in the browser (jsmpeg MIT license kept in-package).
#
# Zero rm in OUR RUN layers: gate residue goes to /opt/wtk-build-residue and is
# KEPT. s6-apply.sh is the runtime agent's file and uses mv-to-residue internally.

ARG WTK_BASE=ghcr.io/linuxserver/baseimage-kasmvnc@sha256:e67ff31da12e6908fc6acbeaba499f9339794b1b622bcb2d945286a7257b755d

FROM ${WTK_BASE} AS deps
ARG WTK_VERSION=0.1.0
LABEL org.opencontainers.image.title="kasmweb-deps" \
      org.opencontainers.image.version="${WTK_VERSION}" \
      org.opencontainers.image.description="Alpine 3.17 package layer on baseimage-kasmvnc:alpine317"

COPY apk/packages.txt /opt/wtk-apk-packages.txt

# Repository layer. Alpine v3.17 is EOL: content is served as archive content
# from the same CDN. Proven 2026-11-13: both https indexes answer 200;
# mirrors.alpinelinux.org returns 404 for v3.17. Pinning the FILE means mirror
# drift cannot bite; an unreachable pinned index FAILS the build with exit 3 -
# no silent fallback to an unverified mirror.
RUN set -eu; \
    cp /etc/apk/repositories /opt/wtk-build-repositories.base; \
    main="https://dl-cdn.alpinelinux.org/alpine/v3.17/main"; \
    commu="https://dl-cdn.alpinelinux.org/alpine/v3.17/community"; \
    printf '%s\n%s\n' "$main" "$commu" > /etc/apk/repositories; \
    wget -q --timeout=20 --spider "$main/x86_64/APKINDEX.tar.gz" \
      || { echo "wtk-deps: FATAL: $main/x86_64/APKINDEX.tar.gz unreachable" >&2; exit 3; }; \
    wget -q --timeout=20 --spider "$commu/x86_64/APKINDEX.tar.gz" \
      || { echo "wtk-deps: FATAL: $commu/x86_64/APKINDEX.tar.gz unreachable" >&2; exit 3; }; \
    echo "--- repositories (https v3.17 main+community; same release as base) ---"; \
    cat /etc/apk/repositories; \
    apk update; \
    pkgs=$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' /opt/wtk-apk-packages.txt | grep -v '^$' | tr '\n' ' '); \
    echo "--- packages: $pkgs"; \
    apk add $pkgs; \
    echo "--- installed versions (audit trail) ---"; \
    for p in $pkgs; do apk info -v "$p" 2>/dev/null || echo "MISSING $p"; done | sort; \
    echo "--- apk cache kept (size):"; du -sh /var/cache/apk 2>/dev/null || true; \
    install -d -m 0755 -o root -g root /etc/pulse/default.pa.d; \
    install -d -m 0755 -o root -g root /opt/wtk /opt/wtk/web /opt/wtk/bin \
        /opt/wtk/audio /opt/wtk/audio/web /opt/wtk/nginx /opt/wtk/windowing \
        /opt/wtk/windowing/tint2 /opt/wtk-build-residue

# /etc/pulse/default.pa.d: Alpine ships no such dir, and the shipped
# /etc/pulse/default.pa ends with ".include /etc/pulse/default.pa.d" -
# without the directory the app-share drop-in is a silently-missing include.
# /opt/wtk/web: render-nginx.py writes wtk-boot.js there at container start
# (runtime-generated; never COPYed).

FROM deps AS release
ARG WTK_VERSION=0.1.0
ARG WTK_BUILD_DATE=unknown
# Lineage note: the 9e0c6fba... value was the upstream native-default/run byte
# state. This repository ships the same functional payload with comment-path
# corrections only (Xvnc argv, geometry block, generation order untouched);
# ARG default = this repo's byte state, re-freeze on any payload change.
ARG WTK_NATIVE_SVC_SHA256=a57dec43a6d60f9fab6e2ff4cff5f9fd77fe960c5a6d30e623019ac5f071bfb7
ARG WTK_NATIVE_HC_SHA256=fb47078e008e2a1c7ef2f39af7ef843db11929c0f2d6302518175c7f360bdcd0
LABEL org.opencontainers.image.title="kasmweb" \
      org.opencontainers.image.version="${WTK_VERSION}" \
      org.opencontainers.image.created="${WTK_BUILD_DATE}" \
      org.opencontainers.image.description="Single-entry KasmVNC desktop channel: Xvnc+Openbox+tint2(TC), KasmVNC native resize default, one MP2 audio chain, two browser channels (host-bridge Chrome + in-container Chromium 112), app-share credential contract on /run/wt-kasm-app" \
      org.opencontainers.image.base.name="ghcr.io/linuxserver/baseimage-kasmvnc:alpine317" \
      org.opencontainers.image.base.digest="sha256:e67ff31da12e6908fc6acbeaba499f9339794b1b622bcb2d945286a7257b755d" \
      com.kasmweb.lineage="release FROM deps (deps FROM the pinned base): two stages, one file"

# --- content layers ----------------------------------------------------------
COPY audio/relay.js /opt/wtk/audio/relay.js
COPY audio/web/ /opt/wtk/audio/web/
COPY audio/README.md /opt/wtk/audio/README.md
COPY nginx/render-nginx.py /opt/wtk/nginx/render-nginx.py
COPY nginx/wtk.conf.template /opt/wtk/nginx/wtk.conf.template
COPY bin/wtk-launch /opt/wtk/bin/wtk-launch
COPY bin/wtk-chrome-local /opt/wtk/bin/wtk-chrome-local
COPY bin/wtk-xauth-seed /opt/wtk/bin/wtk-xauth-seed
COPY healthcheck.sh /opt/wtk/bin/healthcheck.sh
COPY pulse/20-wtk-app-share.pa /etc/pulse/default.pa.d/20-wtk-app-share.pa
COPY fonts/99-kasmweb-cjk.conf /etc/fonts/conf.d/99-kasmweb-cjk.conf
COPY windowing/openbox/rc.xml /etc/xdg/openbox/rc.xml
COPY windowing/openbox/menu.xml /defaults/menu.xml
COPY windowing/openbox/autostart /defaults/autostart
COPY windowing/startwm.sh /defaults/startwm.sh
COPY windowing/tint2/tint2rc /opt/wtk/windowing/tint2/tint2rc
COPY windowing/desktop/Chrome.desktop /defaults/desktop/
COPY windowing/desktop/Chrome-Local.desktop /defaults/desktop/
COPY windowing/desktop/ /opt/wtk/windowing/desktop/
COPY s6/svc-kasmvnc/ /etc/s6-overlay/s6-rc.d/svc-kasmvnc/
COPY s6/svc-nginx/ /etc/s6-overlay/s6-rc.d/svc-nginx/
COPY s6/svc-pulseaudio/ /etc/s6-overlay/s6-rc.d/svc-pulseaudio/
COPY s6/svc-wtk-audio/ /etc/s6-overlay/s6-rc.d/svc-wtk-audio/
COPY s6/init-nginx/ /etc/s6-overlay/s6-rc.d/init-nginx/
COPY s6/init-wtk-appshare/ /etc/s6-overlay/s6-rc.d/init-wtk-appshare/
COPY s6/s6-apply.sh /opt/wtk/bin/s6-apply.sh
COPY s6/svc-de/run /etc/s6-overlay/s6-rc.d/svc-de/run

# Modes per manifest (COPY keeps context bits; we enforce, never trust):
RUN set -eu; \
    chmod 0755 /opt/wtk/bin/wtk-launch /opt/wtk/bin/wtk-xauth-seed \
               /opt/wtk/bin/wtk-chrome-local \
               /opt/wtk/bin/healthcheck.sh /opt/wtk/bin/s6-apply.sh \
               /opt/wtk/nginx/render-nginx.py /defaults/autostart /defaults/startwm.sh \
               /defaults/desktop/Chrome.desktop /defaults/desktop/Chrome-Local.desktop; \
    chmod 0644 /opt/wtk/audio/relay.js /opt/wtk/audio/README.md /opt/wtk/audio/web/* \
               /opt/wtk/nginx/wtk.conf.template /etc/xdg/openbox/rc.xml \
               /defaults/menu.xml /opt/wtk/windowing/tint2/tint2rc \
               /etc/pulse/default.pa.d/20-wtk-app-share.pa \
               /etc/fonts/conf.d/99-kasmweb-cjk.conf \
               /opt/wtk/windowing/desktop/libfm.conf \
               /opt/wtk/windowing/desktop/icons/*.png; \
    for d in svc-kasmvnc svc-de svc-nginx svc-pulseaudio svc-wtk-audio init-nginx init-wtk-appshare; do \
      chmod 0755 "/etc/s6-overlay/s6-rc.d/$d/run"; \
      test -e "/etc/s6-overlay/s6-rc.d/$d/type" || echo longrun > "/etc/s6-overlay/s6-rc.d/$d/type"; \
    done; \
    echo "modes: enforced per manifest"

# --- native resize contract gate ---------------------------------------------
# This image IS the native variant. The two payload files are byte-frozen (sha256
# passed via ARG; changing them is a deliberate act), the Xvnc argv must carry NO
# -AcceptSetDesktopSize flag, and healthcheck gate 5 must be the validity-only
# form (sentinel pair present). Every anchor below is measured, not assumed.
RUN set -eu; \
    SVC=/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run; \
    HC=/opt/wtk/bin/healthcheck.sh; \
    test -x "$SVC" || { echo 'gate native: svc run not executable' >&2; exit 1; }; \
    test -x "$HC" || { echo 'gate native: healthcheck not executable' >&2; exit 1; }; \
    want_svc="${WTK_NATIVE_SVC_SHA256}"; want_hc="${WTK_NATIVE_HC_SHA256}"; \
    got_svc=$(sha256sum "$SVC" | awk '{print $1}'); \
    got_hc=$(sha256sum "$HC" | awk '{print $1}'); \
    [ "$got_svc" = "$want_svc" ] || { echo "gate native: svc sha256 $got_svc != frozen $want_svc" >&2; exit 1; }; \
    [ "$got_hc" = "$want_hc" ] || { echo "gate native: healthcheck sha256 $got_hc != frozen $want_hc" >&2; exit 1; }; \
    n=$(grep -c '^[[:space:]]*-AcceptSetDesktopSize' "$SVC" || true); \
    case "$n" in 0) : ;; *) echo "gate native: native image must pass NO -AcceptSetDesktopSize flag, found $n argv line(s)" >&2; exit 1 ;; esac; \
    grep -qF -- '-geometry "${WTK_WIDTH}x${WTK_HEIGHT}"' "$SVC"; \
    grep -qF ': "${WTK_WIDTH:=1024}"' "$SVC"; \
    grep -qF ': "${WTK_HEIGHT:=768}"' "$SVC"; \
    grep -qF 'RESIZE_MODE="native"' "$SVC"; \
    grep -qF 'geom=$geom resize=$RESIZE_MODE' "$HC"; \
    grep -qE '^echo "healthcheck: OK' "$HC"; \
    grep -qF 'mode=native' "$HC"; \
    m=$(grep -c 'WTK_GATE5' "$HC" || true); \
    [ "$m" = 2 ] || { echo "gate native: gate5 sentinel pair missing (got $m)" >&2; exit 1; }; \
    grep -qF -- '-interface 127.0.0.1 -websocketPort 6901 -rfbport 0 -nolisten tcp' "$SVC"; \
    grep -qF 'pgrep -x tint2' "$HC"; \
    grep -qF 'auto_null.monitor' "$HC"; \
    grep -qF '_WT_KASM_GENERATION' "$HC"; \
    grep -qF 'wtk-boot.js' "$HC"; \
    bash -n "$SVC"; bash -n "$HC"; \
    echo 'gate native: OK (svc+hc sha locked, -AcceptSetDesktopSize absent, gate5 validity-only, bash -n clean)'

# --- desktop icon manifest gate: exactly TWO managed icons (Chrome + Local) --
# 2026-11-20: the managed set grew from 1 to 2. Chrome stays the HOST BRIDGE
# (Exec must keep the wtk-launch chrome prefix); Chrome-Local is the
# IN-CONTAINER channel and its Exec must be exactly the local launcher, never a
# host-bridge path. The set is asserted exactly: count = 2 AND the sorted names,
# so a missing entry fails and a third stray file fails too.
RUN set -eu; \
    gate_icon() { \
      f="$1"; want_exec="$2"; \
      test -s "$f" || { echo "gate desktop: MISSING $f" >&2; exit 1; }; \
      grep -q "^Exec=$want_exec" "$f" || { echo "gate desktop: $f Exec != $want_exec" >&2; exit 1; }; \
      m=$(stat -c "%a" "$f"); test "$m" = 755 || { echo "gate desktop: $f mode=$m not 0755" >&2; exit 1; }; \
      ic=$(sed -n 's/^Icon=//p' "$f" | head -n1); \
      test -n "$ic" || { echo "gate desktop: $f has no Icon=" >&2; exit 1; }; \
      test -f "$ic" || { echo "gate desktop: $f Icon=$ic missing" >&2; exit 1; }; \
      head -c 8 "$ic" | od -An -tx1 | grep -q '89 50 4e 47' || { echo "gate desktop: $f Icon=$ic not PNG" >&2; exit 1; }; \
      echo "gate desktop: $(basename "$f") Exec=$want_exec mode=755 Icon=$ic (PNG magic ok)"; \
    }; \
    gate_icon /defaults/desktop/Chrome.desktop "/opt/wtk/bin/wtk-launch chrome"; \
    gate_icon /defaults/desktop/Chrome-Local.desktop "/opt/wtk/bin/wtk-chrome-local"; \
    test -s /etc/s6-overlay/s6-rc.d/init-wtk-appshare/up || { echo "gate s6: init-wtk-appshare/up empty -> oneshot no-op" >&2; exit 1; }; \
    test "$(head -c 2 /etc/s6-overlay/s6-rc.d/svc-wtk-audio/run)" = "#!" || { echo "gate s6: svc-wtk-audio/run shebang not at byte 0 (ENOEXEC)" >&2; exit 1; }; \
    test -x /opt/wtk/bin/wtk-chrome-local || { echo "gate desktop: /opt/wtk/bin/wtk-chrome-local missing or not executable" >&2; exit 1; }; \
    n=$(find /defaults/desktop -mindepth 1 -maxdepth 1 | wc -l); \
    names=$(cd /defaults/desktop && ls -1 | LC_ALL=C sort | tr '\n' ' '); \
    test "$n" = 2 || { echo "gate desktop: FATAL /defaults/desktop has $n entries [$names], not exactly 2" >&2; exit 1; }; \
    test "$names" = "Chrome-Local.desktop Chrome.desktop " || { echo "gate desktop: FATAL /defaults/desktop set = [$names], want exactly [Chrome-Local.desktop Chrome.desktop ]" >&2; exit 1; }; \
    echo "gate desktop: exact set {Chrome.desktop, Chrome-Local.desktop} (n=2) + both Exec lines verbatim + 0755 + Icon PNG exists + local launcher executable; up non-empty; shebang byte0 - OK"

# --- libfm quick_exec merge + desktop autostart contract ----------------------
# The pcmanfm apk ships /etc/xdg/libfm/libfm.conf; we merge ONLY the injected key
# into the base [config] (no whole-file overwrite) and archive the base version by
# mv (zero rm). quick_exec=1 removes the "this file is an executable script,
# execute it?" dialog on double-click. The autostart gate proves the managed
# 2-file 0755 force-seed (Chrome + Chrome-Local) landed, with no cp -n and no
# VCMI seeding residue. The force copy of BOTH names on every start is the
# mechanism by which an OLD /config volume (already carrying a Desktop dir with
# only Chrome.desktop) picks up the new icon after an image swap: the seed is
# unconditional, so Chrome-Local.desktop lands on the first boot of the new
# image; no deployment-side manual step is needed for that.
RUN set -eu; \
    SRC=/opt/wtk/windowing/desktop/libfm.conf; \
    DST=/etc/xdg/libfm/libfm.conf; \
    RES=/opt/wtk-build-residue; \
    test -s "$SRC" || { echo "gate libfm: missing shipped $SRC" >&2; exit 1; }; \
    test -s "$DST" || { echo "gate libfm: base config missing (pcmanfm apk?)" >&2; exit 1; }; \
    mv "$DST" "$RES/libfm.conf.base"; \
    keys=$(sed -n '/^\[config\]/,/^\[/p' "$SRC" | grep -E '^[a-z_]+=' | tr '\n' ' '); \
    test -n "$keys" || { echo "gate libfm: no keys under [config] in $SRC" >&2; exit 1; }; \
    cp "$RES/libfm.conf.base" "$RES/libfm.conf.merged"; \
    for kv in $keys; do \
      k=${kv%%=*}; \
      awk -v kv="$kv" 'BEGIN{d=0;n=split(kv,a,"=");k=a[1]} { if (index($0,k"=")==1) next; print; if ($0=="[config]" && !d){print kv;d=1} } END{if(!d) print kv}' \
        "$RES/libfm.conf.merged" > "$RES/libfm.conf.merged.new"; \
      mv "$RES/libfm.conf.merged.new" "$RES/libfm.conf.merged"; \
    done; \
    cp "$RES/libfm.conf.merged" "$DST"; \
    chmod 0644 "$DST"; \
    test -s "$DST"; \
    grep -q '^quick_exec=1$' "$DST" || { echo "gate libfm: quick_exec=1 not merged" >&2; exit 1; }; \
    for k in '^single_click=' '^use_trash=' '^confirm_del=' '^thumbnail_local=' '^thumbnail_max=' '^\[ui\]$' '^big_icon_size=' '^show_thumbnail='; do \
      grep -q "$k" "$DST" || { echo "gate libfm: base key $k lost" >&2; exit 1; }; \
    done; \
    test "$(grep -c '^\[' "$DST")" = "$(grep -c '^\[' "$RES/libfm.conf.base")" || { echo "gate libfm: section header count changed" >&2; exit 1; }; \
    echo "gate libfm: quick_exec=1 merged into base [config]; base keys + sections intact; base archived at $RES/libfm.conf.base"; \
    AUT=/defaults/autostart; \
    grep -q 'for f in Chrome Chrome-Local; do' "$AUT" || { echo "gate autostart: FATAL managed seed list is not [Chrome Chrome-Local]" >&2; exit 1; }; \
    grep -q 'chmod 0755 "$HOME/Desktop/Chrome.desktop" "$HOME/Desktop/Chrome-Local.desktop"' "$AUT" || { echo "gate autostart: FATAL managed 2-file force-copy + chmod 0755 not landed" >&2; exit 1; }; \
    if grep -q 'cp -n /defaults/desktop/' "$AUT"; then echo "gate autostart: FATAL cp -n seed present (stale icons would never upgrade)" >&2; exit 1; fi; \
    if grep -q 'VCMI' "$AUT"; then echo "gate autostart: FATAL VCMI seed residue present (managed set = Chrome + Chrome-Local)" >&2; exit 1; fi; \
    grep -q 'command>/opt/wtk/bin/wtk-chrome-local' /defaults/menu.xml || { echo "gate autostart: /defaults/menu.xml has no in-container Chromium entry" >&2; exit 1; }; \
    echo "gate autostart: managed 2-icon (Chrome + Chrome-Local) 0755 force-seed present, no cp -n, no VCMI; root menu carries both browser entries"

# --- taskbar gate: minimal TC layout + openbox alignment anchors -------------
RUN set -eu; \
    T=/opt/wtk/windowing/tint2/tint2rc; \
    grep -Eq '^panel_items[[:space:]]*=[[:space:]]*TC$' "$T" || { echo "gate taskbar: panel_items is not exactly TC" >&2; exit 1; }; \
    grep -Eq '^clock_padding[[:space:]]*=[[:space:]]*44[[:space:]]+0$' "$T" || { echo "gate taskbar: clock_padding = 44 0 missing (browser audio button landing band)" >&2; exit 1; }; \
    grep -Eq '^panel_size[[:space:]]*=[[:space:]]*100%[[:space:]]+30$' "$T" || { echo "gate taskbar: 30px panel geometry lost" >&2; exit 1; }; \
    grep -Eq '^panel_window_name[[:space:]]*=[[:space:]]*wtk-taskbar$' "$T" || { echo "gate taskbar: panel_window_name != wtk-taskbar" >&2; exit 1; }; \
    if grep -qi '^systray_' "$T"; then echo "gate taskbar: systray keys present (product ships no tray icons)" >&2; exit 1; fi; \
    if grep -qi '^launcher_' "$T"; then echo "gate taskbar: launcher keys present (product ships no launcher items)" >&2; exit 1; fi; \
    grep -q 'wtk-taskbar' /etc/xdg/openbox/rc.xml || { echo "gate taskbar: openbox rc.xml lost the wtk-taskbar application match" >&2; exit 1; }; \
    echo "gate taskbar: panel_items=TC, 30px panel, clock_padding 44 0, wtk-taskbar + openbox overlay match, no systray/launcher - OK"

# --- syntax gate by interpreter line, not by extension ------------------------
RUN set -eu; \
    gate() { \
      f="$1"; \
      head1=$(sed -n '/^#!/{p;q;}' "$f" | head -n1); \
      case "$head1" in \
        *python*) python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$f"; echo "gate py: ok $f" ;; \
        *node*)   node --check "$f"; echo "gate node: ok $f" ;; \
        *bash*|*/bin/sh*|*with-contenv*|*env*sh*) bash -n "$f"; echo "gate sh: ok $f" ;; \
        *) echo "gate: $f: unrecognized interpreter [$head1]; refusing to guess" >&2; exit 1 ;; \
      esac; \
    }; \
    gate /opt/wtk/audio/relay.js; \
    gate /opt/wtk/bin/wtk-launch; \
    gate /opt/wtk/bin/wtk-xauth-seed; \
    gate /opt/wtk/bin/healthcheck.sh; \
    gate /opt/wtk/bin/s6-apply.sh; \
    gate /opt/wtk/nginx/render-nginx.py; \
    gate /defaults/autostart; \
    gate /defaults/startwm.sh; \
    gate /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run; \
    gate /etc/s6-overlay/s6-rc.d/svc-nginx/run; \
    gate /etc/s6-overlay/s6-rc.d/svc-de/run; \
    gate /etc/s6-overlay/s6-rc.d/svc-pulseaudio/run; \
    gate /etc/s6-overlay/s6-rc.d/svc-wtk-audio/run; \
    gate /etc/s6-overlay/s6-rc.d/init-nginx/run; \
    gate /etc/s6-overlay/s6-rc.d/init-wtk-appshare/run; \
    for f in /opt/wtk/audio/web/audio.js /opt/wtk/audio/web/layout.js; do node --check "$f"; echo "gate node: ok $f"; done; \
    for f in /etc/xdg/openbox/rc.xml /defaults/menu.xml; do \
      python3 -c "import xml.etree.ElementTree as E,sys; E.parse(sys.argv[1])" "$f"; echo "gate xml: ok $f"; \
    done; \
    test -s /opt/wtk/audio/web/jsmpeg.min.js; \
    test -s /opt/wtk/audio/web/LICENSE-jsmpeg.txt; \
    grep -q 'module-native-protocol-unix' /etc/pulse/default.pa.d/20-wtk-app-share.pa; \
    echo "gate: syntax/manifest checks all green"

# --- vhost gate: render BOTH deployment shapes, then nginx -t -----------------
# (the base ships nginx; init-nginx renders the real vhost at every container
# start anyway, so setting the stock file aside here is a build-time check only)
# Two shapes MUST both render and pass nginx -t, or the build fails:
#   /desktop/demo/  = dispatcher-mounted multi-desktop (manager injects this)
#   /               = single-container root deploy (compose quick start)
# The bare "/" shape is exactly what regressed once (the old base-path grammar
# demanded two slashes => init-nginx exit 2 => :3000 unreachable), so it is
# gated here, not documented. Residue per shape, kept (zero rm).
RUN set -eu; \
    for shape in /desktop/demo/ /; do \
      echo "--- vhost gate: WTK_BASE_PATH=$shape ---"; \
      tag=$(printf '%s' "$shape" | tr / _); \
      WTK_NGINX_TEMPLATE=/opt/wtk/nginx/wtk.conf.template \
      WTK_NGINX_CONF=/opt/wtk-build-residue/wtk-rendered-default.conf \
      WTK_BOOT_JS=/opt/wtk-build-residue/wtk-boot.js \
      WTK_DESKTOP_ID=demo WTK_BASE_PATH="$shape" \
      WTK_PUBLIC_ORIGIN=http://127.0.0.1:25320 WTK_NGINX_PORT=3000 \
      python3 /opt/wtk/nginx/render-nginx.py; \
      test -s /opt/wtk-build-residue/wtk-rendered-default.conf; \
      test -s /opt/wtk-build-residue/wtk-boot.js; \
      grep -qF "window.__WTK_BASE=\"$shape\";" /opt/wtk-build-residue/wtk-boot.js \
        || { echo "gate: wtk-boot.js base mismatch for $shape" >&2; exit 1; }; \
      mkdir -p /opt/wtk-build-residue/nginx; \
      if [ -f /etc/nginx/http.d/default.conf ]; then \
        mv /etc/nginx/http.d/default.conf /opt/wtk-build-residue/nginx/base-default.conf.keep; \
      fi; \
      cp /opt/wtk-build-residue/wtk-rendered-default.conf /etc/nginx/http.d/default.conf; \
      nginx -t 2>&1 | tee "/opt/wtk-build-residue/nginx-test$tag.out"; \
      nginx -t >/dev/null 2>&1 || { echo "gate: nginx -t REJECTED the rendered vhost for base=$shape" >&2; exit 1; }; \
      mv /etc/nginx/http.d/default.conf "/opt/wtk-build-residue/nginx/wtk-rendered$tag.conf.used-for-test"; \
      cp /opt/wtk-build-residue/wtk-boot.js "/opt/wtk-build-residue/wtk-boot$tag.js"; \
      if [ -f /opt/wtk-build-residue/nginx/base-default.conf.keep ]; then \
        cp /opt/wtk-build-residue/nginx/base-default.conf.keep /etc/nginx/http.d/default.conf; \
      fi; \
      echo "gate: base=$shape render + nginx -t PASSED"; \
    done; \
    echo "gate: nginx -t PASSED on BOTH rendered shapes (residue kept)"

# --- s6 graph rewrite + compile gate ------------------------------------------
# s6-apply.sh (runtime-owned): removes svc-kclient / svc-docker /
# init-mods-package-install (units + inbound edges + contents entries), rewrites
# svc-nginx / svc-de / svc-pulseaudio edges, registers init-wtk-appshare +
# svc-wtk-audio, audits dangling edges, asserts the content manifest, and prints
# APPLY OK as its last line.
RUN set -eu; \
    /opt/wtk/bin/s6-apply.sh; \
    echo "--- graph assertions ---"; \
    R=/etc/s6-overlay/s6-rc.d; \
    for u in svc-kclient svc-docker init-mods-package-install; do \
      test ! -e "$R/$u" || { echo "graph: unit $u still present" >&2; exit 1; }; \
      test ! -e "$R/user/contents.d/$u" || { echo "graph: $u still registered" >&2; exit 1; }; \
      hit=$(grep -rlx "$u" "$R"/*/dependencies.d/ 2>/dev/null | head -1 || true); \
      test -z "$hit" || { echo "graph: dangling edge to $u in $hit" >&2; exit 1; }; \
    done; \
    test -e "$R/user/contents.d/svc-wtk-audio"; \
    test -e "$R/user/contents.d/init-wtk-appshare"; \
    test ! -e "$R/svc-nginx/dependencies.d/svc-kclient"; \
    test -e "$R/svc-nginx/dependencies.d/init-services"; \
    test -e "$R/svc-de/dependencies.d/svc-kasmvnc"; \
    test -e "$R/svc-pulseaudio/dependencies.d/init-wtk-appshare"; \
    test -d /kclient/node_modules/ws || { echo "graph: /kclient/node_modules/ws must stay (relay ws fallback)" >&2; exit 1; }; \
    echo "graph: removals + edges + kasmweb units verified; /kclient tree kept intact"; \
    /command/s6-rc-compile /opt/wtk-build-residue/s6-compiled \
      /package/admin/s6-overlay-3.1.2.1/etc/s6-rc/sources "$R"; \
    echo "graph: s6-rc-compile (boot sources form) RC=0"; \
    svc=$(/command/s6-rc-db -c /opt/wtk-build-residue/s6-compiled list services | sort); \
    test -n "$svc" || { echo "graph: FAIL - compiled graph lists nothing, gate vacuous" >&2; exit 1; }; \
    n=$(printf '%s\n' "$svc" | wc -l); \
    test "$n" -ge 20 || { echo "graph: FAIL - only $n services in compiled graph" >&2; exit 1; }; \
    printf '%s\n' "$svc" | tr '\n' ' '; echo; \
    if printf '%s\n' "$svc" | grep -Ex 'svc-kclient|svc-docker|init-mods-package-install'; then \
      echo "graph: FAIL - compiled graph still contains a removed service" >&2; exit 1; \
    fi; \
    echo "graph: compiled graph free of removed services - OK ($n services)"

# --- CJK font gate (hard assertions; any miss = build FAIL) --------------------
# Policy = docker/fonts/99-kasmweb-cjk.conf (installs to
# /etc/fonts/conf.d/99-kasmweb-cjk.conf, 0644). The gate below is the
# contract-check for that file: every assertion is an exact literal family
# compare, so a JP/KR/TC/DEJAVU fallthrough fails the build, not the desktop.
# Gate order: fc-cache -> file present/perm -> list CJK SC families -> four
# fc-match assertions (zh-cn / default sans / serif / monospace) -> DejaVu
# negative. All four use fc-match -f %{family[0]} (the same probe the runtime
# healthcheck gate #9 uses).
RUN set -eu; \
    test -f /etc/fonts/conf.d/99-kasmweb-cjk.conf \
      || { echo "gate cjk: FAIL - /etc/fonts/conf.d/99-kasmweb-cjk.conf absent" >&2; exit 1; }; \
    perm=$(stat -c '%a' /etc/fonts/conf.d/99-kasmweb-cjk.conf); \
    test "$perm" = "644" \
      || { echo "gate cjk: FAIL - conf.d mode is $perm, want 644" >&2; exit 1; }; \
    fc-cache -f >/dev/null 2>&1 || true; \
    echo "--- fc-list CJK SC family names (must contain the three below) ---"; \
    fc-list : family | awk -F, '{for(i=1;i<=NF;i++) print $i}' | sed 's/^ *//;s/ *$//' | grep -E '^Noto (Sans|Serif|Sans Mono) CJK SC$' | sort -u; \
    fc-list : family | grep -q 'Noto Sans CJK SC' \
      || { echo "gate cjk: FAIL - font-noto-cjk exposes no 'Noto Sans CJK SC' family" >&2; exit 1; }; \
    fam=$(fc-match -f '%{family[0]}' 'sans-serif:lang=zh-cn'); \
    echo "gate cjk: fc-match sans-serif:lang=zh-cn -> [$fam]"; \
    test "$fam" = "Noto Sans CJK SC" \
      || { echo "gate cjk: FAIL - zh-cn resolves to [$fam], want exactly [Noto Sans CJK SC]" >&2; exit 1; }; \
    fam=$(fc-match -f '%{family[0]}' 'sans-serif'); \
    echo "gate cjk: fc-match sans-serif            -> [$fam]"; \
    test "$fam" = "Noto Sans CJK SC" \
      || { echo "gate cjk: FAIL - default sans resolves to [$fam], want exactly [Noto Sans CJK SC]" >&2; exit 1; }; \
    fam=$(fc-match -f '%{family[0]}' 'serif'); \
    echo "gate cjk: fc-match serif                 -> [$fam]"; \
    test "$fam" = "Noto Serif CJK SC" \
      || { echo "gate cjk: FAIL - serif resolves to [$fam], want exactly [Noto Serif CJK SC]" >&2; exit 1; }; \
    fam=$(fc-match -f '%{family[0]}' 'monospace'); \
    echo "gate cjk: fc-match monospace             -> [$fam]"; \
    test "$fam" = "Noto Sans Mono CJK SC" \
      || { echo "gate cjk: FAIL - monospace resolves to [$fam], want exactly [Noto Sans Mono CJK SC]" >&2; exit 1; }; \
    case "$(fc-match -f '%{family[0]}' 'sans-serif:lang=zh-cn')" in \
      *DejaVu*) echo "gate cjk: FAIL - zh-cn resolves to a DejaVu family" >&2; exit 1 ;; \
    esac; \
    echo "gate cjk: all hard assertions PASS (zh-cn / default sans / serif / mono = * CJK SC; DejaVu negative ok)"

# --- in-container browser gate (Chrome-Local channel) -------------------------
# The second browser channel is the apk `chromium` (Alpine 3.17 community,
# 112.0.5615.165-r0 pinned by the archive index). Hard assertions, any miss =
# build FAIL: entry point on PATH, --version matches ^Chromium 112., and a REAL
# headless smoke render (a version string alone would not catch a broken
# sandbox / missing libs / font-config hole).
# Entry point name (measured 2026-11-20 via apk info -L chromium): Alpine ships
# NO /usr/bin/chromium. The provided entry is /usr/bin/chromium-browser ->
# /usr/lib/chromium/chromium-launcher.sh, which adds no flags of its own, so
# this gate and docker/bin/wtk-chrome-local both invoke chromium-browser.
# The smoke uses --headless=new (Chromium 112 supports it), --no-sandbox (same
# trade-off as the runtime launcher: this container grants no unprivileged user
# namespaces, so the setuid chrome-sandbox helper cannot complete its namespace
# pivot - measured as abc: rc 133 "Failed to move to new namespace ... Operation
# not permitted"; with --no-sandbox the same invocation renders),
# --disable-dev-shm-usage (the build container /dev/shm is 64MB) and
# --disable-gpu (no GPU in the build environment), plus a private throwaway
# --user-data-dir under the residue dir so the gate never writes to the build
# HOME. Measured 2026-11-20: smoke rc=0, stdout = the about:blank DOM
# "<html><head></head><body></body></html>" (40 B on disk; the PASS echo
# reports 39 B because command substitution strips the trailing newline).
# Negative controls (measured 2026-11-20 on context copies under
# /data/tmp/kasmweb-chrome/negA-* / negB-*, repo tree untouched, builds ran
# offline against the same base tag, both rc=1):
#   negA: a third .desktop COPYed into /defaults/desktop -> the DESKTOP gate
#         fails verbatim: "gate desktop: FATAL /defaults/desktop has 3 entries
#         [Chrome-Local.desktop Chrome.desktop Stray.desktop ], not exactly 2".
#         (Deleting the shipped file outright cannot reach this gate: the
#         COPY line hard-fails the context checksum first - also exit 1.)
#   negB: packages.txt without `chromium` -> THIS gate fails verbatim:
#         "gate chromium: FAIL - chromium-browser not on PATH (apk package
#         missing?)" (the apk audit trail then lists no chromium).
RUN set -eu; \
    command -v chromium-browser >/dev/null || { echo "gate chromium: FAIL - chromium-browser not on PATH (apk package missing?)" >&2; exit 1; }; \
    ver=$(chromium-browser --version 2>&1 | head -n1); \
    echo "gate chromium: chromium-browser --version -> [$ver]"; \
    printf '%s' "$ver" | grep -qE '^Chromium 112\.' || { echo "gate chromium: FAIL - version [$ver] does not match ^Chromium 112." >&2; exit 1; }; \
    UDD=/opt/wtk-build-residue/chromium-smoke-profile; \
    install -d -m 700 "$UDD"; \
    SMOKE_ERR=/opt/wtk-build-residue/chromium-smoke.err; \
    html=$(HOME="$UDD" timeout 120 chromium-browser --headless=new --no-sandbox --disable-gpu \
      --disable-dev-shm-usage --disable-software-rasterizer --no-first-run \
      --no-default-browser-check --user-data-dir="$UDD" --dump-dom about:blank 2>"$SMOKE_ERR") || { \
        echo "gate chromium: FAIL - headless smoke exited non-zero; stderr tail:" >&2; \
        tail -n 25 "$SMOKE_ERR" >&2 || true; exit 1; }; \
    test -n "$html" || { echo "gate chromium: FAIL - headless smoke produced no DOM" >&2; exit 1; }; \
    printf '%s' "$html" | grep -qi '<html' || { echo "gate chromium: FAIL - smoke output has no <html: [$html]" >&2; exit 1; }; \
    echo "gate chromium: $(du -sh /usr/lib/chromium 2>/dev/null | awk '{print $1}') install, version pinned, headless smoke DOM ok ($(printf '%s' "$html" | wc -c) B) - PASS"

# --- container contract -------------------------------------------------------
# Contract env defaults = probe contract; compose repeats geometry per desktop.
# START_DOCKER=false: svc-docker is gone. Base keeps USER=root / ENTRYPOINT /init
# (lsio runs stage2 as root by design).
ENV START_DOCKER=false \
    PUID=1000 \
    PGID=1000 \
    DISPLAY=:1 \
    WTK_DESKTOP_ID=probe \
    WTK_BASE_PATH=/desktop/probe/ \
    WTK_WIDTH=1600 \
    WTK_HEIGHT=900 \
    WTK_FRAMERATE=30 \
    WTK_PUBLIC_ORIGIN=http://127.0.0.1:25320 \
    WTK_APPSHARE=/run/wt-kasm-app \
    WTK_NGINX_PORT=3000

# Only 3000 is published by compose. 6901 (Xvnc httpd) and 4901 (audio relay)
# bind container loopback and are reachable only through this nginx entry.
EXPOSE 3000

# Twelve-gate readiness script (runtime-owned): listeners, injection anchor,
# loopback-only 6901, framebuffer reading validity (native), generation
# handshake, tint2, relay + monitor, CJK, app.json, nginx worker pin, pulse
# topology. Green = level 3 plumbing, NOT GUI.
HEALTHCHECK --interval=20s --timeout=30s --start-period=60s --retries=6 \
  CMD ["/opt/wtk/bin/healthcheck.sh"]
