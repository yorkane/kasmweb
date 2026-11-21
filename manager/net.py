"""端口锁 + 占用检查 + socat X11 relay + CDP relay（宿主 DevTools 外发）+ backend readiness。

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
import sys
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


# ============================================================ CDP relay（宿主 Chrome DevTools 外发）
#
# 现状：宿主 Chrome 的 CDP 只绑 127.0.0.1:<随机端口>（--remote-debugging-port=0），
# 外部不可达。启用条件 = config.WT_KASM_CDP_RELAY_PORT != 0（导入期 fail-closed：
# 非 loopback 绑定必须配 token，见 config.py CDP_RELAY_* 块）。
# 形态与 socat X relay 同款：setsid 独立进程 + pidfile + 端口锁目录，
# 生命周期挂 app 启动链（--test-cdp 成功回读端口之后）与停 app / 停桌。

def cdp_relay_pidfile(desktop_id: str) -> str:
    return config.pidfile(desktop_id, "cdp-relay")


def cdp_relay_running(desktop_id: str) -> dict | None:
    return process.live_ledger(cdp_relay_pidfile(desktop_id))


def cdp_relay_public_url(bind: str, port: int, token: str) -> str:
    """url 形态 = http://<bind>:<port>/<token>（token 为空则不带路径；0.0.0.0 展示成 <host-ip> 占位）。"""
    host = "<host-ip>" if bind == "0.0.0.0" else bind
    base = "http://%s:%d" % (host, int(port))
    return base + ("/" + token if token else "/")


def cdp_relay_info(desktop_id: str, ok: bool, reason: str | None = None) -> dict:
    """回复用摘要（进 data.cdp.relay）。enabled/bind/port/token_required 取配置生效值。"""
    info = {"enabled": bool(config.cdp_relay_enabled()),
            "bind": config.CDP_RELAY_BIND,
            "port": int(config.CDP_RELAY_PORT),
            "url": (cdp_relay_public_url(config.CDP_RELAY_BIND, config.CDP_RELAY_PORT,
                                         config.CDP_RELAY_TOKEN)
                    if config.cdp_relay_enabled() else ""),
            "token_required": bool(config.CDP_RELAY_TOKEN),
            "ok": bool(ok)}
    if reason:
        info["reason"] = str(reason)
    return info


def _cdp_relay_port_free(port: int) -> tuple[bool, str]:
    """CDP relay 专用端口预检 = 只看**监听态**（LISTEN / SYN-RECV）。

    通用 port_free 数全状态（含 TIME-WAIT）：relay 被 kill 后，上一轮客户端连接在
    监听口上留 TIME-WAIT 记录 ⇒ 快速「stop app → start app」会被自己刚死的连接挡住。
    重启绑定带 SO_REUSEADDR（cdprelay.serve），TIME-WAIT 不影响 bind ⇒ 监听态判定
    即足够；docker host port 预留与本口无关（relay 不是容器），不查。
    """
    hits = [h for h in listening_sockets(port)
            if h["state"] in ("LISTEN", "SYN-RECV")]
    if hits:
        return (False, "本机监听命中: " + ", ".join("%s %s" % (h["state"], h["local"])
                                                    for h in hits[:4]))
    return (True, "free")


def ensure_cdp_relay(desktop_id: str, cdp_port: int, force: bool = False) -> dict:
    """起 CDP relay（python3 -m manager.cdprelay → 127.0.0.1:<cdp_port>）。

    未启用（WT_KASM_CDP_RELAY_PORT=0）⇒ {enabled:false, ok:true}（现网行为逐字节不变）。
    端口占用 / 起不来 ⇒ ok=false + reason（**不影响 app 本身**，调用方只透传）。
    已活 + upstream 端口一致 ⇒ kept（幂等）；端口变了 ⇒ 先停旧再起新（Chrome 重启换
    随机端口是常态）。
    """
    if not config.cdp_relay_enabled():
        return cdp_relay_info(desktop_id, True)
    pidfile = cdp_relay_pidfile(desktop_id)
    port = int(config.CDP_RELAY_PORT)
    live = cdp_relay_running(desktop_id)
    if live and not force:
        if int(live.get("upstream_port") or -1) == int(cdp_port):
            info = cdp_relay_info(desktop_id, True)
            info["action"] = "kept"
            info["pid"] = live["pid"]
            return info
        process.stop_ledger(pidfile)
        live = None
    if live and force:
        process.stop_ledger(pidfile)
    with port_lock(port):
        ok, why = _cdp_relay_port_free(port)
        if not ok:
            return cdp_relay_info(desktop_id, False, "relay 端口 %d 被占: %s" % (port, why))
        # 不做 selfcheck_bind（socat 线口径）：该探针用**无 SO_REUSEADDR 的 127.0.0.1**
        # 试 bind，会被上一轮 relay 的客户端 TIME-WAIT 挡住（假占用，实测
        # "bind 自证失败 [Errno 98]"）；真 relay 以 SO_REUSEADDR + 配置 bind 起，
        # bind 自证 = 进程存活 + 下方 tcp_ready，失败照样回收台账。
        argv = [sys.executable, "-m", "manager.cdprelay",
                "--bind", config.CDP_RELAY_BIND,
                "--port", str(port),
                "--upstream", "127.0.0.1:%d" % int(cdp_port)]
        if config.CDP_RELAY_TOKEN:
            argv += ["--token", config.CDP_RELAY_TOKEN]
        label = "wt-kasm-cdp-relay-%s" % desktop_id
        try:
            rec = process.spawn_registered(
                argv, "cdp-relay", desktop_id, pidfile, label=label,
                log_path=os.path.join(config.LOG_DIR, "cdp-relay-%s.log" % desktop_id),
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                     "HOME": config.APP_ROOT,
                     "PYTHONPATH": os.path.dirname(os.path.dirname(
                         os.path.abspath(__file__)))},
                extra={"port": port, "bind": config.CDP_RELAY_BIND,
                       "upstream_port": int(cdp_port)})
        except (OSError, RuntimeError, ValueError) as exc:
            return cdp_relay_info(desktop_id, False, "relay 拉起失败: %r" % (exc,))
        time.sleep(0.6)
        if not process.proc_exists(rec["pid"]):
            process.stop_ledger(pidfile)
            return cdp_relay_info(desktop_id, False,
                                  "relay 启动即退出，见 logs/cdp-relay-%s.log" % desktop_id)
        if not tcp_ready(port, timeout=2.0):
            process.stop_ledger(pidfile)
            return cdp_relay_info(desktop_id, False,
                                  "relay bind 自证失败 port=%d（台账已回收）" % port)
        info = cdp_relay_info(desktop_id, True)
        info["action"] = "started"
        info["pid"] = rec["pid"]
        return info


def stop_cdp_relay(desktop_id: str) -> tuple[bool, str]:
    """按 pidfile 四元组精确 kill（禁 pkill）；无台账 = 成功。"""
    return process.stop_ledger(cdp_relay_pidfile(desktop_id))

