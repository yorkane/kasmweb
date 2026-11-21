#!/usr/bin/env python3
"""https-basic-proxy.py - 上游门面：TLS 终结 + HTTP Basic Auth + 透明字节泵。

用途（发布自检 scripts/release-acceptance.sh 的 password-login / https-cert-mount 用例）：
模拟生产里「authz 网关 / APISIX 终结 TLS + 校验口令，再打到 dispatcher」这一层。
断言口径：
  * 无凭据 / 错凭据 -> 401 + WWW-Authenticate
  * 正确凭据        -> 透传到上游（302 / 200 / 101 升级都原样转发）
  * 证书             -> 由 --cert/--key 指定的挂载文件提供（握手成功即证）

只用标准库（ssl / socket / hashlib / base64 / threading / json）。
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import sys
import threading

LOG_LOCK = threading.Lock()


def log(msg):
    with LOG_LOCK:
        sys.stderr.write("[proxy] %s\n" % msg)
        sys.stderr.flush()


def parse_htpasswd(path):
    """支持两种行格式：user:明文   或   user:<sha256hex>。"""
    entries = {}
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            user, value = line.split(":", 1)
            entries[user.strip()] = value.strip()
    return entries


def check_auth(header, entries):
    if not header:
        return False
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return False
    try:
        raw = base64.b64decode(parts[1].strip()).decode("utf-8")
    except Exception:
        return False
    if ":" not in raw:
        return False
    user, password = raw.split(":", 1)
    stored = entries.get(user)
    if stored is None:
        return False
    if len(stored) == 64 and all(c in "0123456789abcdef" for c in stored.lower()):
        digest = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return digest.lower() == stored.lower()
    return password == stored


def recv_head(sock, limit=65536):
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < limit:
        try:
            chunk = sock.recv(4096)
        except (socket.timeout, OSError):
            break
        if not chunk:
            break
        buf += chunk
    return buf


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(conn, addr, ctx):
    upstream = ctx["upstream"]
    entries = ctx["entries"]
    realm = ctx["realm"]
    try:
        tls = ctx["sslctx"].wrap_socket(conn, server_side=True)
    except (ssl.SSLError, OSError) as exc:
        log("tls handshake failed from %s: %s" % (addr, exc))
        return
    try:
        head = recv_head(tls)
        if not head:
            return
        first = head.split(b"\r\n", 1)[0].decode("latin-1")
        auth = None
        for line in head.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                if k.strip().lower() == b"authorization":
                    auth = v.strip().decode("latin-1")
                    break
        if not check_auth(auth, entries):
            body_bytes = b"unauthorized\n"
            tls.sendall(
                b"HTTP/1.1 401 Unauthorized\r\n"
                b"WWW-Authenticate: Basic realm=\"" + realm.encode() + b"\"\r\n"
                b"Content-Type: text/plain\r\n"
                b"Content-Length: " + str(len(body_bytes)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + body_bytes)
            log("401 %s %s" % (addr, first))
            return
        up = socket.create_connection(upstream, timeout=30)
        up.sendall(head)
        log("authed %s %s" % (addr, first))
        t = threading.Thread(target=pump, args=(up, tls), daemon=True)
        t.start()
        pump(tls, up)
        t.join(timeout=5)
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--htpasswd", required=True)
    ap.add_argument("--listen", required=True, help="127.0.0.1:PORT")
    ap.add_argument("--upstream", required=True, help="127.0.0.1:PORT")
    ap.add_argument("--realm", default="kasmweb")
    args = ap.parse_args()

    lhost, lport = args.listen.rsplit(":", 1)
    uhost, uport = args.upstream.rsplit(":", 1)
    ctx = {
        "upstream": (uhost, int(uport)),
        "entries": parse_htpasswd(args.htpasswd),
        "realm": args.realm,
        "sslctx": ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER),
    }
    ctx["sslctx"].load_cert_chain(certfile=args.cert, keyfile=args.key)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((lhost, int(lport)))
    srv.listen(64)
    sys.stdout.write(json.dumps({
        "listen": args.listen,
        "upstream": args.upstream,
        "pid": os.getpid(),
        "realm": args.realm,
        "users": sorted(ctx["entries"].keys()),
    }) + "\n")
    sys.stdout.flush()
    while True:
        try:
            conn, addr = srv.accept()
        except OSError:
            break
        threading.Thread(target=handle, args=(conn, addr, ctx), daemon=True).start()


if __name__ == "__main__":
    main()

