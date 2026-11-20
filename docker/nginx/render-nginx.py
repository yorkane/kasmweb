#!/usr/bin/env python3
"""Render the live nginx vhost + the injected page bootstrap, atomically.

Keys come from the container environment (compose / with-contenv chain). The
renderer never edits a file in place: it renders into a temp file in the target
directory and os.replace()s it onto the target, so a crash mid-write can never
leave a truncated vhost (crash-loop lesson from the previous webtop image).

Template placeholders (all validated, no free-form substitution):
  __WTK_PORT__  __WTK_BASE_PATH__  __WTK_XVNC_ORIGIN__  __WTK_RELAY_ORIGIN__

Side product: /opt/wtk/web/wtk-boot.js, the EXTERNAL bootstrap that defines
window.__WTK_BASE for the injected audio front-end. External on purpose (root
ruling 2026-11-13): an inline <script> in the sub_filter would depend on the
Kasm page never shipping a CSP that forbids it. a317 ships no CSP at all
(verified by grep over index.html/vnc.html), but that is not a contract, and a
relative external script also keeps the page's own cache semantics intact.
The vhost injects it with a RELATIVE url, so the browser resolves it under the
dispatcher prefix and it arrives here as /wtk-boot.js, prefix already stripped.
"""
import json
import os
import re
import sys

SRC = os.environ.get("WTK_NGINX_TEMPLATE", "/opt/wtk/nginx/wtk.conf.template")
DST = os.environ.get("WTK_NGINX_CONF", "/etc/nginx/http.d/default.conf")
BOOT = os.environ.get("WTK_BOOT_JS", "/opt/wtk/web/wtk-boot.js")


def env(name, default, pattern, kind):
    v = (os.environ.get(name) or default).strip()
    if not re.fullmatch(pattern, v):
        sys.stderr.write("render-nginx: %s=%r is not a valid %s\n" % (name, v, kind))
        sys.exit(2)
    return v


def atomic_write(path, text, mode=0o644):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".%s.tmp.%d" % (os.path.basename(path), os.getpid()))
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


PORT = env("WTK_NGINX_PORT", "3000", r"[0-9]{1,5}", "tcp port")
# Base path = the single-entry prefix this desktop is served under. Two shapes
# are legal: "/desktop/<id>/" (dispatcher-mounted, multi-desktop) and the bare
# "/" (single-container root deployment, compose quick start). Grammar: a
# leading "/" followed by zero or more non-empty segments of [A-Za-z0-9._-],
# each ending in "/". No spaces, no empty segments, no backslash, no query.
# Path traversal is a separate explicit rejection (fail closed, exit 2): the
# character class admits dots, so "no '..' segment" is checked structurally.
BASE = env("WTK_BASE_PATH", "/desktop/probe/", r"/(?:[A-Za-z0-9._-]+/)*", "base path")
if ".." in BASE.split("/"):
    sys.stderr.write("render-nginx: WTK_BASE_PATH=%r contains a '..' segment (traversal refused)\n" % BASE)
    sys.exit(2)
XVNC = env("WTK_XVNC_ORIGIN", "http://127.0.0.1:6901", r"http://[A-Za-z0-9.:-]+", "xvnc origin")
RELAY = env("WTK_RELAY_ORIGIN", "http://127.0.0.1:4901", r"http://[A-Za-z0-9.:-]+", "relay origin")

with open(SRC, "r", encoding="utf-8") as fh:
    text = fh.read()

for key, value in (("__WTK_PORT__", PORT), ("__WTK_BASE_PATH__", BASE),
                   ("__WTK_XVNC_ORIGIN__", XVNC), ("__WTK_RELAY_ORIGIN__", RELAY)):
    text = text.replace(key, value)

left = sorted(set(re.findall(r"__[A-Z0-9_]+__", text)))
if left:
    sys.stderr.write("render-nginx: unresolved placeholders %s in %s\n" % (left, SRC))
    sys.exit(3)

# The bootstrap file is written FIRST: if it fails the vhost is untouched and
# the page degrades to "no audio button" rather than referencing a dead script.
# 2026-11-20: the bootstrap also carries the KasmVNC page defaults (IME Input
# Mode on, control bar docked right). It is injected NON-defer in <head>, i.e.
# it runs before the client bundles read their settings, which are plain
# localStorage keys (raw names, read via readSetting()/getSetting()).
BOOT_JS = "window.__WTK_BASE=%s;\n" % json.dumps(BASE)
BOOT_JS += """
// --- KasmVNC page defaults (2026-11-20): seed-once client settings ----------
//   enable_ime     -> "true"  : IME Input Mode (UI.getSetting treats any stored
//                     value except 0/no/false as checked).
//   controlbar_pos -> "right" : UI startup runs
//                     if (readSetting('controlbar_pos') === 'right')
//                       UI.toggleControlbarSide();
//                     so the collapsible menu handle starts on the RIGHT edge.
// Both keys are written only when absent: a user toggle in Settings (or a drag
// of the handle) rewrites the key and always wins on the next load. Storage
// errors are swallowed - the page then behaves exactly as the stock client.
(function () { try {
  if (localStorage.getItem("enable_ime") === null) { localStorage.setItem("enable_ime", "true"); }
  if (localStorage.getItem("controlbar_pos") === null) { localStorage.setItem("controlbar_pos", "right"); }
} catch (e) { /* localStorage unavailable: stock behavior */ } })();
"""
atomic_write(BOOT, BOOT_JS)
atomic_write(DST, text)

sys.stdout.write("render-nginx: wrote %s (port=%s base=%s xvnc=%s relay=%s)\n"
                 % (DST, PORT, BASE, XVNC, RELAY))
sys.stdout.write("render-nginx: wrote %s\n" % BOOT)

