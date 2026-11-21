"""CDP relay：把宿主 Chrome 的 loopback DevTools 端口按需外发（纯标准库，零新依赖）。

启动（由 manager/net.ensure_cdp_relay 以 setsid 独立进程 + pidfile 拉起）：

    python3 -m manager.cdprelay --bind 0.0.0.0 --port 6501 \
        --token <token> --upstream 127.0.0.1:<chrome-cdp-port>

契约（照 wdev 线 webtop-cdp / wdev-cdp-proxy 的已验证语义）：

* token 非空：请求路径必须逐字等于 `/<token>` 或以 `/<token>/` 开头，否则 **404**
  （不是 401 —— 探测面最小；与业务 404 不可区分是已知短板）。
* 转发前剥掉 `/<token>` 前缀；上游请求**强设** `Host: 127.0.0.1:<port>`
  （Chrome 按请求 Host 生成 webSocketDebuggerUrl，不改写会得到对外无效的回环地址）。
* 响应改写只对 **`/json*`** 且 200 的响应生效：正文里的 `ws://127.0.0.1:<port>` 整串
  换成外部可见的 `ws://<原始请求 Host>/<token>…`。客户端（Playwright / CDP 库）拿到的
  WS URL 自带 token，零二次配置。
* `Upgrade: websocket` ⇒ hijack：向上游重发**已剥前缀**的请求行 + 原 headers，
  之后双向字节泵。
* 本期**不做 TLS 监听**（明文 HTTP/WS）。TLS 门面是后续项：fleet 的边缘 TLS 在
  APISIX/authz，本模块只负责「能绑 0.0.0.0 + token 门」。

安全口径（详见 deploy.md §6.6）：

* DevTools = 浏览器**完全控制权** ⇒ token 视同密钥；非 loopback 绑定必须带 token
  （manager/config.py 导入期 fail-closed，本模块启动期二次断言）。
* token 出现在 URL 路径 ⇒ 会进上游 access log；本模块日志**绝不打印 token**，
  请求行只记 token 已替换为 `/<token>` 的形态。
* 只转发 TCP 字节，除 token 门外不做任何语义解释，也不缓存任何响应。
"""
from __future__ import annotations

import argparse
import re
import select
import socket
import sys
import threading

TOKEN_MASK = "/<token>"
MAX_HEAD_BYTES = 64 * 1024
MAX_BODY_BYTES = 8 * 1024 * 1024
PUMP_CHUNK = 65536
CONNECT_TIMEOUT = 10.0
PUMP_IDLE_TIMEOUT = 300.0
TOKEN_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
BINDS = ("127.0.0.1", "localhost", "0.0.0.0")
LOOPBACK_BINDS = ("127.0.0.1", "localhost")


class ConfigError(Exception):
    pass


# ============================================================ 启动期校验

def validate(bind, port, token, upstream: str) -> dict:
    """全部启动门禁集中在这里；任何非法 ⇒ ConfigError（main 里转成非零退出）。"""
    if not isinstance(bind, str) or bind not in BINDS:
        raise ConfigError("--bind 只允许 %s，实为 %r" % (" / ".join(BINDS), bind))
    if isinstance(port, bool):
        raise ConfigError("--port 必须是整数，实为 bool")
    try:
        pi = int(str(port), 10)
    except (TypeError, ValueError):
        raise ConfigError("--port 必须是整数，实为 %r" % (port,))
    if not (1 <= pi <= 65535):
        raise ConfigError("--port=%d 越界 1..65535（0 = 不启用，由 manager 侧判）" % pi)
    if not isinstance(token, str):
        raise ConfigError("--token 必须是 str，实为 %s" % type(token).__name__)
    if token and TOKEN_RE.match(token) is None:
        raise ConfigError("--token 形态非法（要求 %s，禁 '/' / 空白 / 控制字符）: %r"
                          % (TOKEN_RE.pattern, token[:40]))
    if bind not in LOOPBACK_BINDS and not token:
        raise ConfigError("--bind=%s 是非 loopback 绑定 ⇒ 必须带 --token"
                          "（CDP = 浏览器完全控制权，无 token 的外发面拒绝启动）" % bind)
    if not isinstance(upstream, str) or upstream.count(":") != 1:
        raise ConfigError("--upstream 必须是 <host>:<port>，实为 %r" % (upstream,))
    host, _sep, pstr = upstream.partition(":")
    if not host or not pstr.isdigit() or (len(pstr) > 1 and pstr[0] == "0"):
        raise ConfigError("--upstream 形态非法（host 非空 + 无前导零十进制端口）: %r"
                          % (upstream,))
    up = int(pstr)
    if not (1 <= up <= 65535):
        raise ConfigError("--upstream 端口越界 1..65535: %r" % (upstream,))
    return {"bind": bind, "port": pi, "token": token, "upstream_host": host,
            "upstream_port": up, "upstream_authority": "%s:%d" % (host, up)}


def parse_args(argv=None) -> dict:
    p = argparse.ArgumentParser(prog="python3 -m manager.cdprelay",
                                description="CDP relay（token 门 + webSocketDebuggerUrl 改写）")
    p.add_argument("--bind", required=True)
    p.add_argument("--port", required=True)
    p.add_argument("--token", default="")
    p.add_argument("--upstream", required=True, help="形如 127.0.0.1:34567")
    a = p.parse_args(argv)
    return validate(a.bind, a.port, a.token, a.upstream)


def log_line(cfg: dict, line: str) -> None:
    """日志绝不带 token：token 在请求行里已被 mask 成 /<token>。"""
    sys.stdout.write("[cdprelay bind=%s port=%d upstream=%s] %s\n"
                     % (cfg["bind"], cfg["port"], cfg["upstream_authority"], line))
    sys.stdout.flush()


# ============================================================ 头部解析

def recv_head(conn) -> bytes:
    """读到完整 \r\n\r\n 头部（含结束标记）；超上限或不完整 ⇒ ValueError。"""
    buf = b""
    while b"\r\n\r\n" not in buf:
        if len(buf) >= MAX_HEAD_BYTES:
            raise ValueError("请求头超 %d 字节" % MAX_HEAD_BYTES)
        chunk = conn.recv(4096)
        if not chunk:
            raise EOFError("对端在发出完整请求头前关闭")
        buf += chunk
    return buf


def split_request(head: bytes):
    blob, _sep, tail = head.partition(b"\r\n\r\n")
    lines = blob.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) < 2:
        raise ValueError("请求行无法解析")
    method, path = parts[0], parts[1]
    proto = parts[2] if len(parts) > 2 else "HTTP/1.1"
    return method, path, proto, parse_headers(lines[1:]), tail


def parse_headers(lines) -> "list[tuple[str, str]]":
    out = []
    for ln in lines:
        name, sep, value = ln.partition(":")
        if sep:
            out.append((name, value.strip(" \t")))
    return out


def header_value(hdrs, name: str) -> str:
    want = name.lower()
    for k, v in hdrs:
        if k.lower() == want:
            return v
    return ""


def is_websocket_upgrade(hdrs) -> bool:
    up = header_value(hdrs, "upgrade").lower()
    conn = header_value(hdrs, "connection").lower()
    return up == "websocket" and "upgrade" in conn


# ============================================================ token 门

def authorize(path: str, token: str) -> "tuple[bool, str, str]":
    """返回 (放行, 上游 path, 外部前缀)。token 为空 = 全放行（只在本机用）。"""
    if not token:
        return (True, path, "")
    want = "/" + token
    if path == want:
        return (True, "/", want)
    if path.startswith(want + "/"):
        return (True, path[len(want):] or "/", want)
    return (False, path, want)


def mask_path(path: str, token: str) -> str:
    """日志用：token ⇒ /<token>；无 token 时原样。"""
    if not token:
        return path
    want = "/" + token
    if path == want:
        return TOKEN_MASK
    if path.startswith(want + "/"):
        return TOKEN_MASK + path[len(want):]
    return path


# ============================================================ 响应改写

def upstream_ws_prefixes(cfg: dict) -> "list[str]":
    """Chrome 自述 webSocketDebuggerUrl 时可能用的 Host 形态（全部收拢到一个改写目标）。"""
    p = cfg["upstream_port"]
    hosts = ["127.0.0.1:%d" % p, "localhost:%d" % p, "0.0.0.0:%d" % p, "[::1]:%d" % p]
    out = []
    for h in hosts:
        out.append("ws://" + h + "/")
        out.append("ws://" + h)
    return out


def public_ws_base(cfg: dict, public_host: str, token: str) -> str:
    """外部可见前缀；TLS 上下文（X-Forwarded-Proto=https）用 wss。"""
    host = public_host or ("%s:%d" % (cfg["bind"], cfg["port"]))
    scheme = "wss" if header_proto_is_tls() else "ws"
    base = "%s://%s" % (scheme, host)
    if token:
        base += "/" + token
    return base


def header_proto_is_tls() -> bool:
    """本期 relay 自身无 TLS 监听 ⇒ 恒 ws；留单点给后续 TLS 门面（见 deploy.md §6.6）。"""
    return False


def rewrite_json_body(body: bytes, cfg: dict, public_base: str):
    """/json* 的 webSocketDebuggerUrl 整串替换。返回 (body, changed)。"""
    text = body.decode("latin-1")
    orig = text
    for src in upstream_ws_prefixes(cfg):
        if src in text:
            dst = public_base + ("/" if src.endswith("/") else "")
            text = text.replace(src, dst)
    if text == orig:
        return body, False
    return text.encode("latin-1"), True


def read_body(sock, hdrs, head_tail: bytes):
    """响应体读全（chunked / content-length / 读到 EOF）。返回 (body, truncated)。"""
    chunks = [head_tail]
    te = header_value(hdrs, "transfer-encoding").lower()
    cl = header_value(hdrs, "content-length")
    total = len(head_tail)
    if "chunked" in te:
        buf = head_tail
        while True:
            if total >= MAX_BODY_BYTES:
                return b"".join(chunks), True
            part = sock.recv(4096)
            if not part:
                break
            buf += part
            chunks.append(part)
            total += len(part)
            if buf[-5:] == b"0\r\n\r\n" or buf.endswith(b"0\r\n\r\n"):
                break
        return b"".join(chunks), False
    if cl and cl.isdigit():
        want = int(cl)
        while total < want and total < MAX_BODY_BYTES:
            part = sock.recv(min(4096, want - total))
            if not part:
                break
            chunks.append(part)
            total += len(part)
        return b"".join(chunks), total < want
    while total < MAX_BODY_BYTES:
        part = sock.recv(4096)
        if not part:
            break
        chunks.append(part)
        total += len(part)
    return b"".join(chunks), False


# ============================================================ 转发

def plain404() -> bytes:
    body = b'{"ok":false,"reason":"not found"}'
    return (b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json"
            b"\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body)) + body


def build_upstream_request(method: str, path: str, proto: str, hdrs, cfg: dict,
                           body_tail: bytes = b"", websocket: bool = False) -> bytes:
    """剥前缀后的请求行 + 原 headers（减去逐跳头），强设 Host=127.0.0.1:<port>。"""
    lines = ["%s %s %s" % (method, path, proto)]
    drop = ("host", "connection", "keep-alive", "proxy-connection", "transfer-encoding")
    for k, v in hdrs:
        lk = k.lower()
        if lk in drop:
            continue
        if websocket and lk == "origin":
            # Chrome 校验 Origin；relay 自身无 TLS ⇒ 不伪造 https Origin，
            # 换成上游自述 Origin（与"本机直连 CDP"等价）。
            lines.append("Origin: http://" + cfg["upstream_authority"])
            continue
        lines.append("%s: %s" % (k, v))
    lines.append("Host: " + cfg["upstream_authority"])
    if websocket:
        # 逐跳头 connection 在上方被剥掉；WS 握手必须带回 Connection: Upgrade，
        # 否则上游（真 Chrome 与假上游同）按普通请求处理 ⇒ 握手 404。
        lines.append("Connection: Upgrade")
        lines.append("Upgrade: websocket")
    else:
        lines.append("Connection: close")
    req = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
    return req + body_tail


def send_all(sock, payload: bytes) -> bool:
    try:
        sock.sendall(payload)
        return True
    except OSError:
        return False


def forward_http(cfg: dict, client, method: str, path: str, proto: str, hdrs,
                 body_tail: bytes, public_base: str) -> None:
    ok, up_path, _prefix = authorize(path, cfg["token"])
    if not ok:
        log_line(cfg, "%s %s -> 404 (token-mismatch)" % (method, mask_path(path, cfg["token"])))
        send_all(client, plain404())
        return
    up = socket.create_connection((cfg["upstream_host"], cfg["upstream_port"]),
                                  timeout=CONNECT_TIMEOUT)
    try:
        up.sendall(build_upstream_request(method, up_path, proto, hdrs, cfg, body_tail))
        head = recv_head(up)
        stat, rhdrs, tail = split_response(head)
        rbody, truncated = read_body(up, rhdrs, tail)
        changed = False
        if "/json" in up_path and "200" in stat and not truncated:
            rbody, changed = rewrite_json_body(rbody, cfg, public_base)
        out = ("%s\r\n" % stat).encode("latin-1")
        for line in out_headers(rhdrs, rbody, changed):
            out += ("%s: %s\r\n" % (line[0], line[1])).encode("latin-1")
        out += b"\r\n" + rbody
        send_all(client, out)
        log_line(cfg, "%s %s -> %s%s" % (method, mask_path(path, cfg["token"]),
                                        stat.split(" ", 1)[-1],
                                        " (ws-url rewritten)" if changed else ""))
    finally:
        close(up)


def split_response(head: bytes):
    blob, _sep, tail = head.partition(b"\r\n\r\n")
    lines = blob.decode("latin-1").split("\r\n")
    return lines[0], parse_headers(lines[1:]), tail


def out_headers(hdrs, body: bytes, changed: bool):
    drop = ("content-length", "transfer-encoding", "connection", "keep-alive")
    out = [(k, v) for k, v in hdrs if k.lower() not in drop]
    out.append(("Content-Length", str(len(body))))
    out.append(("Connection", "close"))
    if changed:
        out.append(("X-Wtk-Cdp-Rewritten", "webSocketDebuggerUrl"))
    return out


def forward_ws(cfg: dict, client, method: str, path: str, proto: str, hdrs) -> None:
    ok, up_path, _prefix = authorize(path, cfg["token"])
    if not ok:
        log_line(cfg, "%s %s -> 404 (token-mismatch, ws)"
                 % (method, mask_path(path, cfg["token"])))
        send_all(client, plain404())
        return
    up = socket.create_connection((cfg["upstream_host"], cfg["upstream_port"]),
                                  timeout=CONNECT_TIMEOUT)
    try:
        up.sendall(build_upstream_request(method, up_path, proto, hdrs, cfg,
                                          websocket=True))
        log_line(cfg, "%s %s -> WS hijack (upstream %s)"
                 % (method, mask_path(path, cfg["token"]), cfg["upstream_authority"]))
        pump(client, up)
    finally:
        close(up)


def pump(a, b) -> None:
    """双向字节泵；任一方向 EOF / 错误 ⇒ 全停（WS 不需要半关闭语义）。"""
    socks = [a, b]
    for s in socks:
        s.setblocking(False)
    while True:
        try:
            r, _w, x = select.select(socks, [], socks, PUMP_IDLE_TIMEOUT)
        except OSError:
            return
        if x or not r:
            return
        for s in r:
            try:
                data = s.recv(PUMP_CHUNK)
            except (BlockingIOError, InterruptedError):
                continue
            except OSError:
                return
            if not data:
                return
            peer = b if s is a else a
            try:
                peer.sendall(data)
            except OSError:
                return


def close(sock) -> None:
    try:
        sock.close()
    except OSError:
        pass


# ============================================================ 监听

def handle(client, cfg: dict) -> None:
    try:
        method, path, proto, hdrs, body_tail = split_request(recv_head(client))
        public_base = public_ws_base(cfg, header_value(hdrs, "host"), cfg["token"])
        if is_websocket_upgrade(hdrs):
            forward_ws(cfg, client, method, path, proto, hdrs)
            return
        forward_http(cfg, client, method, path, proto, hdrs, body_tail, public_base)
    except (ValueError, EOFError) as exc:
        log_line(cfg, "bad request: %s" % (exc,))
        send_all(client, plain404())
    except OSError:
        pass
    finally:
        close(client)


def serve(cfg: dict) -> int:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((cfg["bind"], cfg["port"]))
    srv.listen(64)
    log_line(cfg, "listening token=%s（上游 %s）"
             % ("required" if cfg["token"] else "none", cfg["upstream_authority"]))
    while True:
        try:
            conn, _addr = srv.accept()
        except KeyboardInterrupt:
            break
        except OSError:
            continue
        threading.Thread(target=handle, args=(conn, cfg), daemon=True).start()
    return 0


def main(argv=None) -> int:
    try:
        cfg = parse_args(argv)
    except ConfigError as exc:
        sys.stderr.write("cdprelay 拒绝启动: %s\n" % (exc,))
        return 2
    return serve(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
