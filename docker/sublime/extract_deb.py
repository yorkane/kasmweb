#!/usr/bin/env python3
"""extract_deb.py - extract the members of a Debian .deb (ar archive) without dpkg/ar.

Origin: selkde handbook "Sublime Text 4 安装与注册" route, adapted for this Alpine
image (no ar, no dpkg); the pure-python ar reader was measured end-to-end on the
25880 probe container (root, 2026-11-20): it emits debian-binary / control.tar.xz /
data.tar.xz for sublime-text_build-4200_amd64.deb, after which
`tar -xf data.tar.xz -C /` performs the deb-standard install tree
(/opt/sublime_text, /usr/bin/subl, /usr/share/applications/sublime_text.desktop,
/usr/share/icons/hicolor/...).

Usage: extract_deb.py <deb> <dest>
Writes debian-binary / control.tar.* / data.tar.* into <dest> (dest created).
Fail-closed on bad magic or truncated headers; prints the member list.
"""
import os
import sys


def main():
    deb, dest = sys.argv[1], sys.argv[2]
    data = open(deb, "rb").read()
    if data[:8] != b"!<arch>\n":
        print("FAIL: not an ar archive (bad magic)")
        return 1
    os.makedirs(dest, exist_ok=True)
    off = 8
    members = []
    while off < len(data):
        header = data[off:off + 60]
        if len(header) < 60 or header[58:60] != bytes((0x60, 0x0A)):
            print("FAIL: bad ar member header at offset %d" % off)
            return 1
        name = header[0:16].decode("ascii", "replace").strip()
        size = int(header[48:58].decode("ascii").strip())
        body = data[off + 60:off + 60 + size]
        if len(body) != size:
            print("FAIL: truncated member %r (want %d, got %d)" % (name, size, len(body)))
            return 1
        with open(os.path.join(dest, name), "wb") as fh:
            fh.write(body)
        members.append("%s=%d" % (name, size))
        off += 60 + size + (size % 2)
    print("ok: extracted " + ", ".join(members))
    return 0


if __name__ == "__main__":
    sys.exit(main())
