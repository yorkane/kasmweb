"""管理 daemon：stdlib Unix socket + selectors 单线程 JSON-lines 服务。

- 控制面 = /data/app/webtop-kasmvnc/sock/control.sock（CLI ↔ daemon；**不挂进容器**）
- 图标面 = 每 desk 的 <appshare>/launch.sock（**协议 = 一行 JSON**：
  {"action":"launch|focus","appId":"<固定 id>"}，键集合必须恰好等于 {action, appId} ⇒
  无 argv / url / exec / env；旧文本协议仅兼容执行并标 protocol=legacy-text，非主路径）
- 事件后（init/start/stop/app）与周期（默认 30s）刷新 registry.json
- 不做容器 keepalive 循环：容器由 restart: unless-stopped 与 docker 守护负责
- 台账 = state/daemon.pid（role=daemon），shutdown 用 SIGTERM 精确杀
"""
from __future__ import annotations

import errno
import json
import os
import selectors
import signal
import socket
import sys
import time

from . import actions, appshare, config, process, registry

DAEMON_PIDFILE = os.path.join(config.STATE_DIR, "daemon.pid")
REFRESH_INTERVAL = float(os.environ.get("WT_KASM_REFRESH_INTERVAL", "30"))
MAX_LINE = 4096
LISTEN = "listen"          # selector data 首元素：监听 socket（本体一律取 key.fileobj）
CONN = "conn"              # selector data 首元素：已连接 socket


def _is_socket_file(p: str) -> bool:
    import stat
    try:
        return stat.S_ISSOCK(os.lstat(p).st_mode)
    except OSError:
        return False


def _listen(path: str, backlog: int = 8) -> socket.socket:
    parent = os.path.dirname(path)
    if os.path.islink(parent) or os.path.islink(path):
        raise RuntimeError("socket 路径父目录/本体不允许软链: " + path)
    if not os.path.isdir(parent):
        raise RuntimeError("socket 父目录不存在（setup 未建齐 => failclosed 不代建）: " + parent)
    if _alive_daemon() and path == config.CONTROL_SOCKET:
        raise RuntimeError("已有 daemon 在跑（pidfile=%s）⇒ 拒绝二次监听" % DAEMON_PIDFILE)
    if os.path.exists(path):
        if not _is_socket_file(path):
            # 别人放的普通文件/目录 ⇒ 不覆盖、不删除，直接拒绝
            raise RuntimeError("socket 路径被非 socket 文件占用 ⇒ failclosed 不覆盖: " + path)
        # 陈旧 socket（无活 daemon）⇒ 移入 trash，不 rm
        process.archive_ledger(path, trash_root=config.TRASH_ROOT)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chmod(path, 0o660)
    s.listen(backlog)
    s.setblocking(False)
    return s


def _alive_daemon() -> dict | None:
    return process.live_ledger(DAEMON_PIDFILE)


def status_daemon() -> dict:
    rec = _alive_daemon()
    return {"running": bool(rec), "pid": rec.get("pid") if rec else None,
            "socket": config.CONTROL_SOCKET}


def send_request(req: dict, timeout: float = 120.0, path: str | None = None) -> dict:
    """CLI 侧：连控制 socket 发一行 JSON，读一行 JSON。daemon 不在 ⇒ 明确报错。"""
    p = path or config.CONTROL_SOCKET
    if not os.path.exists(p):
        raise RuntimeError("控制 socket 不存在: %s（daemon 未运行 ⇒ 先 install-manager.sh 或 wt-kasm daemon）" % p)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(p)
        s.sendall((json.dumps(req) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 1 << 20:
                raise RuntimeError("响应超长")
    finally:
        s.close()
    line = buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
    if not line:
        raise RuntimeError("daemon 无响应（空回复）")
    try:
        return json.loads(line)
    except ValueError:
        raise RuntimeError("daemon 响应非 JSON: " + line[:200])


class Daemon:
    """events: control.sock / launch.sock×N；周期刷新 registry；SIGTERM 干净退出。"""

    def __init__(self, refresh_interval: float = REFRESH_INTERVAL):
        self.refresh_interval = refresh_interval
        self.sel = selectors.DefaultSelector()
        self.listeners: dict[int, tuple[socket.socket, str, str]] = {}
        self.buffers: dict[int, bytes] = {}
        self.stop = False
        self.created: list[str] = []

    def _add(self, path: str, kind: str, desktop_id: str = "") -> None:
        s = _listen(path)
        self.created.append(path)
        self.listeners[s.fileno()] = (s, kind, desktop_id)
        # data 只放元数据（首元素区分 listener/conn）；socket 本体一律走 key.fileobj
        self.sel.register(s, selectors.EVENT_READ, data=(LISTEN, kind, desktop_id))

    def setup(self) -> None:
        os.makedirs(config.STATE_DIR, exist_ok=True)
        os.makedirs(config.SOCK_DIR, exist_ok=True)
        self._add(config.CONTROL_SOCKET, "control")
        from . import compose
        for spec in config.DESKTOPS:
            compose.write_compose(spec)  # 保证 desk/runtime/appshare 目录在位
            self._add(appshare.launch_socket_path(spec.id), "launch", spec.id)
        process.register_process(os.getpid(), "daemon", "-", DAEMON_PIDFILE,
                                 label="wt-kasm-manager",
                                 extra={"socket": config.CONTROL_SOCKET,
                                        "argv": " ".join(sys.argv[:4])})
        registry.refresh()

    def _accept(self, key) -> None:
        sock = key.fileobj
        meta = self.listeners.get(sock.fileno())
        if meta is None:
            return
        _l, kind, desktop_id = meta
        try:
            conn, _ = sock.accept()
        except OSError:
            return
        conn.setblocking(False)
        self.sel.register(conn, selectors.EVENT_READ, data=(CONN, kind, desktop_id))

    def _read(self, key, mask) -> None:
        conn = key.fileobj
        _tag, kind, desktop_id = key.data
        fd = conn.fileno()
        try:
            chunk = conn.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            self._close(conn)
            return
        if not chunk:
            # 对端关闭（EOF）⇒ 无请求可解析，直接回收连接
            self._close(conn)
            return
        buf = self.buffers.get(fd, b"") + chunk
        if len(buf) > MAX_LINE:
            self.buffers[fd] = b""
            self._write(conn, b'{"ok": false, "reason": "line too long"}\n')
            self._close(conn)
            return
        self.buffers[fd] = buf
        if b"\n" in buf:
            self._handle_line(conn, kind, desktop_id, buf)

    def _handle_line(self, conn, kind: str, desktop_id: str, buf: bytes) -> None:
        line = buf.split(b"\n", 1)[0].decode("utf-8", "replace")
        self.buffers[conn.fileno()] = b""
        if kind == "launch":
            res = actions.handle_launch_line(line, desktop_id)
            res = {"ok": bool(res.get("ok")), "appId": res.get("appId"),
                   "action": res.get("action"), "reason": res.get("reason"),
                   "protocol": res.get("protocol")}
        else:
            try:
                req = json.loads(line) if line.strip() else {}
            except ValueError:
                req = {}
            if not isinstance(req, dict) or "cmd" not in req:
                req = {"cmd": "__bad__"}
            if req.get("cmd") == "shutdown":
                self.stop = True
                self._write(conn, json.dumps({"ok": True, "cmd": "shutdown",
                                             "shuttingDown": True}).encode("utf-8") + b"\n")
                self._close(conn)
                return
            res = actions.handle_request(req)
            cmd = req.get("cmd")
            if cmd in ("init", "start", "stop", "app", "registry") and res.get("ok"):
                registry.refresh()
        self._write(conn, (json.dumps(res, default=str) + "\n").encode("utf-8"))
        self._close(conn)

    @staticmethod
    def _write(conn, payload: bytes) -> None:
        try:
            conn.sendall(payload)
        except OSError:
            pass

    def _close(self, conn) -> None:
        try:
            self.sel.unregister(conn)
        except Exception:
            pass
        self.buffers.pop(conn.fileno(), None)
        try:
            conn.close()
        except OSError:
            pass

    def _cleanup(self) -> None:
        for p in self.created:
            try:
                process.archive_ledger(p, trash_root=config.TRASH_ROOT)
            except OSError as exc:
                print("归档 socket 失败:", p, exc, file=sys.stderr, flush=True)
        for fd, (sock, _k, _d) in list(self.listeners.items()):
            try:
                sock.close()
            except OSError:
                pass
        try:
            self.sel.close()
        except Exception:
            pass
        # 只归档自己的 pidfile。**绝不** stop_ledger(DAEMON_PIDFILE)：那等于给自己发
        # SIGTERM 再等自己退出（12s 后递归 SIGKILL 自己）。
        try:
            process.archive_ledger(DAEMON_PIDFILE, trash_root=config.TRASH_ROOT)
        except OSError as exc:
            print("归档 daemon pidfile 失败:", exc, file=sys.stderr, flush=True)

    def run(self) -> int:
        self.setup()

        def _term(signum, frame):
            self.stop = True

        signal.signal(signal.SIGTERM, _term)
        signal.signal(signal.SIGINT, _term)
        last_refresh = time.time()
        while not self.stop:
            events = self.sel.select(timeout=min(2.0, max(0.1, self.refresh_interval / 3)))
            for key, mask in events:
                if key.data[0] == LISTEN:
                    self._accept(key)
                else:
                    self._read(key, mask)
            if self.stop:
                break
            if time.time() - last_refresh >= self.refresh_interval:
                try:
                    registry.refresh()
                except Exception as exc:
                    print("registry 刷新失败:", exc, file=sys.stderr, flush=True)
                last_refresh = time.time()
        self._cleanup()
        return 0


def run_foreground(refresh_interval: float = REFRESH_INTERVAL) -> int:
    return Daemon(refresh_interval=refresh_interval).run()

