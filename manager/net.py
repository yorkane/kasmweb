"""端口锁 + 占用检查 + socat X11 relay + backend readiness。

锁约定（跨路线共享）：/data/tmp/webtop-channel-port-locks/port-<P>.lock
流程 = flock 独占 → precheck（ss 全状态监听 + docker 全状态 host port 绑定）
→ bind 自证 → 登记；锁的 fd 覆盖整个 bind 与自证过程。
禁止抢占占用者；本模块只操作自己登记的 relay 进程。

v2 修正（root 抢先审 2026-11-13）：
- relay 目标 = appshare.x11_socket_path()（容器 DISPLAY=:1 ⇒ 文件是 X1，**不是 X310**）。
- http_ready 只认 **200**（401/403 = 未授权，不算 backend ready）。
- docker_port_bindings 改为 docker ps -a --no-trunc -q + docker inspect
  HostConfig.PortBindings（全状态，含 stopped 预绑 = 逻辑预留）。
- relay 台账经 process.spawn_registered 记录 pid + pgid + setsid，kill 时按守卫走。
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import os
import socket
import subprocess
import time

from . import appshare, config, process


class PortBusy(Exception):
    pass


def lock_path(port: int) -> str:
    return os.path.join(config.PORT_LOCK_DIR, "port-%d.lock" % int(port))


@contextlib.contextmanager
def port_lock(port: int, timeout: float = 20.0):
    os.makedirs(config.PORT_LOCK_DIR, exist_ok=True)
    path = lock_path(port)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o660)
    deadline = time.time() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EAGAIN, errno.EACCES):
                    raise
                if time.time() >= deadline:
                    raise PortBusy("端口锁 %s 超时未获得" % path)
                time.sleep(0.2)
        yield path
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def listening_sockets(port: int) -> list[dict]:
    """本机 TCP（全状态）中命中该端口号的条目。"""
    out: list[dict] = []
    try:
        raw = subprocess.run(["ss", "-tanH"], capture_output=True, text=True,
                             timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return out
    for line in raw.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        state, local = cols[0], cols[3]
        if local.rsplit(":", 1)[-1] != str(int(port)):
            continue
        out.append({"state": state, "local": local})
    return out


listening_pids = listening_sockets  # 兼容旧名（返回项不含 pid，ss -tanH 无 process 列）


def _container_ports(cid: str) -> list[str]:
    r = subprocess.run(["docker", "inspect", "-f", "{{json .HostConfig.PortBindings}}", cid],
                       capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return []
    raw = (r.stdout or "").strip()
    if not raw or raw in ("null", "<nil>"):
        return []
    try:
        bindings = json.loads(raw)
    except ValueError:
        return []
    out = []
    if isinstance(bindings, dict):
        for cport, arr in bindings.items():
            for b in arr or []:
                if isinstance(b, dict) and b.get("HostPort"):
                    out.append("%s->%s:%s" % (cport, b.get("HostIp") or "*", b["HostPort"]))
    return out


def docker_port_bindings(port: int, all_states: bool = True) -> list[dict]:
    """全状态容器的 published host port 绑定（含 stopped 预绑 = 逻辑预留）。

    返回 [{"name","cid","entry"}]，带 cid 才能区分"别人的占用"与"自己已停止容器的预留"
    （后者必须允许复启，见 actions.start_desk 的 owned 分支）。
    """
    args = ["docker", "ps", "-a", "--no-trunc", "-q"] if all_states else ["docker", "ps", "--no-trunc", "-q"]
    try:
        raw = subprocess.run(args, capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    needle = ":%d" % int(port)
    hits: list[dict] = []
    for cid in [x.strip() for x in raw.splitlines() if x.strip()]:
        for entry in _container_ports(cid):
            if entry.endswith(needle):
                name = subprocess.run(["docker", "inspect", "-f", "{{.Name}}", cid],
                                      capture_output=True, text=True).stdout.strip().lstrip("/")
                hits.append({"name": name or "?", "cid": cid, "entry": entry})
    return hits


def port_free(port: int, allow_cids: tuple[str, ...] | list[str] | None = None) -> tuple[bool, str]:
    """端口可用性预检。

    allow_cids：本路线**自己的**容器 64 位 ID 白名单。自己的已停止容器留下的 host port
    逻辑预留不算冲突（否则 start 非幂等：复启自己会被自己挡住）。别人的绑定、任何本机
    TCP 监听（含自己正在跑的容器 = 由调用方先判 owned+running 走 no-op 分支）一律占用。
    """
    hits = listening_sockets(port)
    if hits:
        return (False, "本机 TCP 命中: " + ", ".join("%s %s" % (h["state"], h["local"]) for h in hits[:4]))
    allow = set(allow_cids or ())
    dh = [h for h in docker_port_bindings(port) if h["cid"] not in allow]
    if dh:
        return (False, "docker host port 绑定命中(含 stopped): "
                + ", ".join("%s (%s) %s" % (h["name"], h["cid"][:12], h["entry"]) for h in dh[:4]))
    return (True, "free")


def require_port_free(port: int) -> None:
    ok, why = port_free(port)
    if not ok:
        raise PortBusy("端口 %d 不可用: %s" % (port, why))


def selfcheck_bind(port: int) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", int(port)))
    except OSError as exc:
        raise PortBusy("bind 自证失败 127.0.0.1:%d: %s" % (port, exc))
    finally:
        s.close()


def http_ready(url: str, timeout: float = 2.0, accept_status: tuple[int, ...] = (200,)) -> bool:
    """backend ready = HTTP **200 only**（401/403/3xx 一律不算）。"""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "wt-kasm-manager"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return int(resp.status) in accept_status
    except urllib.error.HTTPError as exc:
        return int(exc.code) in accept_status
    except Exception:
        return False


def tcp_ready(port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def wait_backend_ready(spec: config.DesktopSpec, timeout: float = 90.0,
                       interval: float = 1.0) -> tuple[bool, str]:
    """backend ready = 容器 nginx（loopback publish）应答 200。GUI 已验不在本断言范围。"""
    url = spec.backend_url + "/"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_ready(url):
            return (True, "backend ready(200): " + url)
        time.sleep(interval)
    return (False, "backend 未在 %.0fs 内返回 200: %s" % (timeout, url))


def relay_pidfile(desktop_id: str) -> str:
    return config.pidfile(desktop_id, "relay")


def relay_running(desktop_id: str) -> dict | None:
    return process.live_ledger(relay_pidfile(desktop_id))


def ensure_relay(spec: config.DesktopSpec, force: bool = False) -> dict:
    """socat TCP-LISTEN(127.0.0.1:P, fork) → UNIX:<desk>/runtime/x11/X1。"""
    sock = appshare.x11_socket_path(spec.id)
    pidfile = relay_pidfile(spec.id)
    live = relay_running(spec.id)
    if live and not force:
        return {"ok": True, "action": "kept", "pid": live["pid"], "port": spec.relay_port,
                "sock": live.get("sock", sock)}
    if live and force:
        process.stop_ledger(pidfile)
    if not appshare._is_socket(sock):
        return {"ok": False, "action": "skip",
                "reason": "X socket 不存在: %s（桌面未起；判据 = S_ISSOCK，普通文件不放行）" % sock}
    with port_lock(spec.relay_port):
        ok, why = port_free(spec.relay_port)
        if not ok:
            raise PortBusy("relay 端口 %d 被占: %s" % (spec.relay_port, why))
        selfcheck_bind(spec.relay_port)
        argv = ["socat", "-dd",
                "TCP-LISTEN:%d,bind=127.0.0.1,fork,reuseaddr" % spec.relay_port,
                "UNIX-CONNECT:" + sock]
        label = "wt-kasm-relay-%s" % spec.id
        rec = process.spawn_registered(
            argv, "relay", spec.id, pidfile, label=label,
            log_path=os.path.join(config.LOG_DIR, "relay-%s.log" % spec.id),
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": config.APP_ROOT},
            extra={"port": spec.relay_port, "sock": sock, "display": spec.relay_display})
        time.sleep(0.6)
        if not process.proc_exists(rec["pid"]):
            return {"ok": False, "action": "failed", "pid": rec["pid"],
                    "reason": "relay 启动即退出，见 logs/relay-%s.log" % spec.id}
        if not tcp_ready(spec.relay_port):
            process.stop_ledger(pidfile)
            return {"ok": False, "action": "failed",
                    "reason": "relay bind 自证失败 port=%d（台账已回收）" % spec.relay_port}
        return {"ok": True, "action": "started", "pid": rec["pid"],
                "port": spec.relay_port, "sock": sock, "display": spec.relay_display}


def stop_relay(desktop_id: str) -> tuple[bool, str]:
    return process.stop_ledger(relay_pidfile(desktop_id))

