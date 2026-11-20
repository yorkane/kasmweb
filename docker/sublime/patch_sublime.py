#!/usr/bin/env python3
"""patch_sublime.py - Sublime Text Build 4200 registration patch, fail-closed.

Origin: selkde handbook "Sublime Text 4 安装与注册"; pattern pair re-measured by
root on the 25880 probe (2026-11-20) against the 4200 amd64 binary:
  pre  0f b6 51 05 83 f2 01  ->  post  c6 41 05 01 31 d2 90
  unique hit @ 0x5b6283 (5988995) in the pre-patch binary (sha256 c312e4bd...).
The legacy 0x51 0C variant pattern hits ZERO times in this build - do not use it.
Post-patch binary sha256 = f145efb381d4cb8b5129cbfa1f180274cc0b9d39d7b05c88b9095d43a2ff9c36.
GUI evidence (probe 25881, abc uid=1000): the window title loses " (UNREGISTERED)".

Usage: patch_sublime.py <binary> [--expect-offset 0x5b6283]

Pre-patch it asserts the upstream pattern hits EXACTLY once (and at the pinned
offset when given), applies the 7-byte replacement in place, then re-reads the
file and verifies old=0 / new=1 / new-offset==old-offset. Any miss = rc 1.
"""
import sys

OLD = bytes.fromhex("0f b6 51 05 83 f2 01")
NEW = bytes.fromhex("c6 41 05 01 31 d2 90")


def main():
    args = sys.argv[1:]
    expect = None
    if "--expect-offset" in args:
        i = args.index("--expect-offset")
        expect = int(args[i + 1], 16)
        del args[i:i + 2]
    if len(args) != 1:
        print("usage: patch_sublime.py <binary> [--expect-offset 0x5b6283]")
        return 2
    path = args[0]
    data = open(path, "rb").read()
    n = data.count(OLD)
    if n != 1:
        print("FAIL: upstream pattern hits=%d, want exactly 1" % n)
        return 1
    off = data.find(OLD)
    if expect is not None and off != expect:
        print("FAIL: offset=%#x, want %#x" % (off, expect))
        return 1
    new_data = data[:off] + NEW + data[off + len(OLD):]
    open(path, "wb").write(new_data)
    chk = open(path, "rb").read()
    if chk.count(OLD) != 0 or chk.count(NEW) != 1 or chk.find(NEW) != off:
        print("FAIL: post-patch verification (old/new/offset mismatch)")
        return 1
    print("PASS: patched at %#x (%d) - 7 bytes" % (off, off))
    return 0


if __name__ == "__main__":
    sys.exit(main())
