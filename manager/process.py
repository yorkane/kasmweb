"""精确进程归属与 kill（零 pkill / 零模式匹配）。

台账 = pidfile JSON（pid + comm + exe + starttime + pgid + role + desktop + label + 时间）。
杀进程前必须 pid+comm+exe+starttime 四元组全部命中，且 pid 由本模块的 pidfile 登记，
否则拒绝（failclosed）。

v2 修正（root 抢先审 2026-11-13）：
- archive_ledger 的 trash 根走 config.TRASH_ROOT（原版 NameError）。
- killpg 只在台账声明 setsid 组长（setsid=True 且 pgid==pid）且现场 os.getpgid(pid)==pid
  时下发，否则退回单 pid kill；不给别人的进程组发信号。
- 台账 exe 为空时 **不得跳过四元组**：要求 comm+starttime 命中 **且** label 出现在
  /proc/pid/cmdline，否则 failclosed。
"""
from __future__ import annotations

import errno
import json
import os
import time

from . import config

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
MARK_ENV = "WT_KASM_MARK"


def proc_exists(pid: int) -> bool:
    """/proc 目录存在不等于进程存活：僵尸态（已退出未被父进程收割）仍是目录，
    但 exe 不可读 ⇒ 视为已死，否则 SIGKILL 后的复检会误报 identity-mismatch。"""
    p = "/proc/%d" % int(pid)
    if not os.path.isdir(p):
        return False
    try:
        with open(p + "/stat", "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return False
    close = raw.rfind(")")
    if close < 0:
        return False
    fields = raw[close + 2:].split()
    state = fields[0] if fields else ""
    return state not in ("Z", "X", "x")


def read_comm(pid: int) -> str | None:
    try:
        with open("/proc/%d/comm" % int(pid), "rb") as f:
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return None


def read_exe(pid: int) -> str | None:
    try:
        return os.readlink("/proc/%d/exe" % int(pid))
    except OSError:
        return None


def read_starttime(pid: int) -> int | None:
    """field 22 of /proc/<pid>/stat。comm 含空格 ⇒ 用最后一个 ')' 定位。"""
    try:
        with open("/proc/%d/stat" % int(pid), "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2:].split()
    try:
        return int(fields[19])
    except (IndexError, ValueError):
        return None


def read_cmdline(pid: int) -> list[str]:
    try:
        with open("/proc/%d/cmdline" % int(pid), "rb") as f:
            raw = f.read()
    except OSError:
        return []
    return [p.decode("utf-8", "replace") for p in raw.split(b"\0") if p]


def get_pgid(pid: int) -> int | None:
    try:
        return os.getpgid(int(pid))
    except OSError:
        return None


def comm_matches(pid: int, want_comm: str) -> bool:
    """comm 被内核截断到 15 字符 ⇒ 前缀比对。"""
    got = read_comm(pid)
    if got is None:
        return False
    return got == want_comm[:15]


def identity(pid: int) -> dict:
    return {"pid": int(pid), "comm": read_comm(pid), "exe": read_exe(pid),
            "starttime": read_starttime(pid), "pgid": get_pgid(pid)}


def label_in_cmdline(pid: int, label: str) -> bool:
    if not label:
        return False
    argv = read_cmdline(pid)
    if not argv:
        return False
    return label in " ".join(argv)


def mark_in_environ(pid: int, mark: str) -> bool:
    """私有 env 标记核验：/proc/pid/environ 里存在整项 WT_KASM_MARK=<mark>。

    env 在 exec 时定型 ⇒ 比 cmdline 更强（wrapper 二次 exec 也带得过去），
    用于 killpg 的归属证明；读不到（权限/竞态）即 False。
    """
    if not mark:
        return False
    try:
        with open("/proc/%d/environ" % int(pid), "rb") as f:
            raw = f.read()
    except OSError:
        return False
    want = ("%s=%s" % (MARK_ENV, mark)).encode("utf-8")
    return any(item == want for item in raw.split(b"\0"))


def _comm_candidates(rec: dict) -> list[str]:
    cands = rec.get("comm_accept")
    if isinstance(cands, (list, tuple)) and cands:
        return [str(c)[:15] for c in cands if c]
    return [(rec.get("comm") or "")[:15]]


def _exe_candidates(rec: dict) -> list[str]:
    cands = rec.get("exe_accept")
    if isinstance(cands, (list, tuple)) and cands:
        return [str(c) for c in cands if c]
    return [str(rec["exe"])] if rec.get("exe") else []


def identity_check(rec: dict) -> tuple[bool, str, str]:
    """四元组核验（comm/exe 支持白名单链）。返回 (命中, 归类, 详情)。

    归类用于判定是否允许走 label/env 兜底路径：只有"exe 台账为空"才兜底，
    comm / starttime / exe 任一项现场不符 = 直接否，绝不放宽。
    """
    pid = rec.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return (False, "bad-pid", "pid 非法")
    if not proc_exists(pid):
        return (False, "gone", "进程不存在")
    got_comm = read_comm(pid)
    if got_comm is None:
        return (False, "comm", "comm 不可读")
    cands = _comm_candidates(rec)
    if got_comm not in cands:
        return (False, "comm", "comm=%r 不在白名单 %s" % (got_comm, cands))
    want_st = rec.get("starttime")
    got_st = read_starttime(pid)
    if want_st is None or got_st is None or int(want_st) != int(got_st):
        return (False, "starttime", "starttime=%s 台账=%s" % (got_st, want_st))
    exes = _exe_candidates(rec)
    if not exes:
        return (False, "no-exe", "台账无 exe（需 label / env 标记兜底）")
    got_exe = read_exe(pid)
    if got_exe is None:
        return (False, "exe", "exe 不可读")
    real = os.path.realpath(got_exe)
    if real not in {os.path.realpath(e) for e in exes}:
        return (False, "exe", "exe=%r 不在白名单 %s" % (real, exes))
    return (True, "exact", "exact")


def group_signal_allowed(rec: dict) -> bool:
    """killpg 前置守卫：setsid 组长 + 现场 pgid 自证 + 可核验归属标记。

    归属标记 = /proc/pid/environ 的 WT_KASM_MARK 整项命中，**或** label 出现在
    cmdline。任一条件不成立 ⇒ 只允许单 pid kill，绝不向别人的进程组发信号。
    """
    pid = rec.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    if not rec.get("setsid") or rec.get("pgid") != pid:
        return False
    if get_pgid(pid) != pid:
        return False
    mark = rec.get("label") or ""
    if not mark:
        return False
    return mark_in_environ(pid, mark) or label_in_cmdline(pid, mark)


def matches_record(rec: dict, require_exe: bool = True) -> bool:
    """四元组核验；只有"台账无 exe"一种情况允许 label / env 标记兜底。

    comm / starttime / exe 任一项现场不符 ⇒ 直接否（不放宽、不兜底），
    kill_exact 会打印现场 vs 台账双侧指纹供审计。
    """
    pid = rec.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    ok, kind, _detail = identity_check(rec)
    if ok:
        return True
    if kind != "no-exe":
        return False
    if not require_exe:
        return True
    label = rec.get("label") or ""
    return label_in_cmdline(pid, label) or mark_in_environ(pid, label)


def write_ledger(path: str, **fields) -> dict:
    rec = {"updated": int(time.time())}
    rec.update(fields)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp-%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return rec


def read_ledger(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def register_process(pid: int, role: str, desktop: str, pidfile: str,
                     label: str = "", extra: dict | None = None) -> dict:
    idm = identity(pid)
    rec = {"pid": idm["pid"], "comm": idm["comm"] or "", "exe": idm["exe"] or "",
           "starttime": idm["starttime"], "pgid": idm["pgid"], "role": role,
           "desktop": desktop, "label": label}
    if extra:
        rec.update(extra)
    write_ledger(pidfile, **rec)
    return rec


def _send_signal(rec: dict, sig: int) -> str:
    """按守卫发信号；返回 killpg / kill。PermissionError / ProcessLookupError 上抛。"""
    pid = int(rec["pid"])
    if group_signal_allowed(rec):
        os.killpg(pid, sig)
        return "killpg"
    os.kill(pid, sig)
    return "kill"


def kill_exact(rec: dict, sig: int = 15, timeout: float = 12.0,
               require_exe: bool = True) -> tuple[bool, str]:
    """只对四元组命中的进程发信号；不命中即拒绝。返回 (成功, 原因)。"""
    pid = rec.get("pid")
    if not isinstance(pid, int) or pid <= 1:
        return (False, "台账 pid 非法")
    if not proc_exists(pid):
        return (True, "already-dead")
    if not matches_record(rec, require_exe=require_exe):
        return (False, "identity-mismatch: 现况 %s vs 台账 %s"
                % (json.dumps(identity(pid), sort_keys=True, default=str),
                   json.dumps({k: rec.get(k) for k in ("comm", "exe", "starttime", "label")},
                              sort_keys=True, default=str)))
    try:
        mode = _send_signal(rec, sig)
    except ProcessLookupError:
        return (True, "already-dead")
    except PermissionError:
        return (False, "EPERM pid=%d" % pid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not proc_exists(pid):
            return (True, "killed-" + mode)
        time.sleep(0.12)
    if sig == 15:
        ok, why = kill_exact(dict(rec, _forced=True), sig=9, timeout=timeout,
                             require_exe=require_exe)
        if ok:
            return (True, "killed-sig9")
        return (False, "残留且 SIGKILL 被拒: " + why)
    return (False, "残留 pid=%d" % pid)


def stop_ledger(pidfile: str, sig: int = 15, timeout: float = 12.0,
                remove: bool = True) -> tuple[bool, str]:
    rec = read_ledger(pidfile)
    if rec is None:
        return (True, "no-ledger")
    ok, why = kill_exact(rec, sig=sig, timeout=timeout)
    if ok and remove:
        archive_ledger(pidfile)
    return (ok, why)


def archive_ledger(pidfile: str, trash_root: str | None = None) -> str | None:
    """台账文件不 rm，移入 trash 根下的时间戳目录。"""
    if not os.path.exists(pidfile):
        return None
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest_root = trash_root or config.TRASH_ROOT
    dest = os.path.join(dest_root, "wt-kasm-ledger-" + stamp)
    try:
        os.makedirs(dest, exist_ok=True)
        os.replace(pidfile, os.path.join(dest, os.path.basename(pidfile)))
    except OSError as exc:
        if exc.errno != errno.ENOENT:
            raise
        return None
    return dest


def live_ledger(pidfile: str, require_exe: bool = True) -> dict | None:
    rec = read_ledger(pidfile)
    if rec is None:
        return None
    return rec if matches_record(rec, require_exe=require_exe) else None


def spawn_detached(argv: list[str], cwd: str | None = None, env: dict | None = None,
                   log_path: str | None = None, new_pgid: bool = True,
                   mark: str | None = None) -> int:
    """setsid 独立会话/进程组 + 输出重定向 + **exec 确认**后返回 pid。

    O_CLOEXEC 状态管道：子进程 exec 成功 ⇒ 内核关掉写端 ⇒ 父侧 read 返回空字节；
    exec 失败 ⇒ 子进程在关掉管道前先写回 errno，父侧抛 RuntimeError 且不登记台账。
    父进程**只在收到确认之后**才读 /proc 写台账 ⇒ 台账 comm/exe 必为 exec 后真值，
    不存在 fork→exec 窗口把台账记成父解释器（P1-1 根因）。禁止用固定 sleep 猜窗口。

    mark 非空 ⇒ 注入私有 env WT_KASM_MARK=<mark>，作为 killpg 归属核验的现场证据。
    """
    if not argv:
        raise ValueError("argv 为空")
    if cwd:
        os.makedirs(cwd, exist_ok=True)
    log_fd = None
    if log_path:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    env = dict(env if env is not None else os.environ.copy())
    if mark:
        env[MARK_ENV] = mark
    rd, wr = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        status = b""
        code = 127
        try:
            os.close(rd)
            if new_pgid:
                os.setsid()
            if log_fd is not None:
                os.dup2(log_fd, 1)
                os.dup2(log_fd, 2)
            devnull = os.open(os.devnull, os.O_RDONLY)
            os.dup2(devnull, 0)
            os.chdir(cwd or "/")
            os.execvpe(argv[0], argv, env)
        except BaseException as exc:
            code = int(getattr(exc, "errno", 0) or 127)
            status = ("exec-failed errno=%d argv0=%s" % (code, argv[0])).encode()
        try:
            # 成功路径**不写任何东西** ⇒ 父侧 read 得空字节（exec 时 CLOEXEC 写端被内核关闭）。
            # 只在 exec 失败时显式写回详情；写 b"x" 会被父侧判成失败。
            if status:
                os.write(wr, status)
        except OSError:
            pass
        os._exit(code)
    os.close(wr)
    if log_fd is not None:
        os.close(log_fd)
    try:
        ack = os.read(rd, 4096)
    finally:
        os.close(rd)
    # O_CLOEXEC 写端随 exec 成功被内核关闭 ⇒ **空 ack = exec 成功**；非空 = 子进程在
    # exec 前显式写回的失败详情。exec 失败的子进程已自行退出 ⇒ 这里 _reap 收僵尸是安全的；
    # 对长期运行的健康子进程**绝不调用 _reap**（会阻塞到它退出）。
    if ack:
        _reap(pid)
        raise RuntimeError("子进程 exec 失败: " + ack.decode("utf-8", "replace"))
    if not proc_exists(pid):
        _reap(pid)
        raise RuntimeError("子进程 exec 后立即退出: argv0=%s" % argv[0])
    return pid


def _reap(pid: int) -> None:
    try:
        os.waitpid(int(pid), 0)
    except (ChildProcessError, OSError):
        pass


def spawn_registered(argv: list[str], role: str, desktop: str, pidfile: str,
                     label: str = "", cwd: str | None = None, env: dict | None = None,
                     log_path: str | None = None, extra: dict | None = None) -> dict:
    """setsid + exec 确认起进程 + 登记台账（comm/exe = 真值，setsid=True）。

    label 同时注入为私有 env 标记 ⇒ killpg 守卫可在现场核验归属。
    """
    pid = spawn_detached(argv, cwd=cwd, env=env, log_path=log_path, mark=label or None)
    fields = {"setsid": True}
    if extra:
        fields.update(extra)
    return register_process(pid, role, desktop, pidfile, label=label, extra=fields)


def spawn_launcher(argv: list[str], role: str, desktop: str, pidfile: str,
                   label: str, comm_accept: list[str], exe_accept: list[str],
                   cwd: str | None = None, env: dict | None = None,
                   log_path: str | None = None, extra: dict | None = None) -> dict:
    """启动器链（如 dbus-run-session → env → chrome）的登记：exec 确认 + 身份白名单。

    最外层 comm/exe 由启动器占用、chrome 以 fork 子进程方式起主进程 ⇒ 现场身份是
    启动器，因此台账记 comm_accept / exe_accept 白名单（含最终目标），
    killpg 归属证明 = 私有 env 标记（贯穿整条 exec 链）。仍逐字段核验，不放行任意进程。
    """
    pid = spawn_detached(argv, cwd=cwd, env=env, log_path=log_path, mark=label)
    idm = identity(pid)
    rec = {"pid": pid, "comm": idm["comm"] or "", "exe": idm["exe"] or "",
           "starttime": idm["starttime"], "pgid": idm["pgid"], "role": role,
           "desktop": desktop, "label": label, "setsid": True,
           "comm_accept": comm_accept, "exe_accept": exe_accept}
    if extra:
        rec.update(extra)
    write_ledger(pidfile, **rec)
    return rec


def walk_pids() -> list[int]:
    out = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            out.append(int(name))
    return out


def pgrp_members(pgid: int, self_pid: int | None = None) -> set[int]:
    """进程组成员（现场扫 /proc 的 getpgid，零模式匹配）。用于窗口 PID 归属回读。

    原实现读 /proc/pid/stat  ")" 后的 fields[1]，那是 **PPID（field 4）** 而非
    PGRP（field 5）⇒ 找的是"以该组为父的进程"= children，语义完全错误（root 复核指出）。
    改用现成的 os.getpgid（read_pgid 已删除，不留第二个易错实现）。
    """
    out: set[int] = set()
    target = int(pgid)
    for pid in walk_pids():
        if get_pgid(pid) == target:
            out.add(pid)
    if self_pid:
        out.add(int(self_pid))
    return out

