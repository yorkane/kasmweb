"""几何实况认证（root 契约 2026-11-14）：显式几何桌面的 state=running 第四道判据。

判定 running 建立在四类**互不等价**的实况之上，任一类缺证即不放行（fail-closed）：

  A 能力锚（部署侧签发，锁 immutable digest）
    容器实际引用的 digest（docker inspect 的 obj.Image，不是 Config.Image 的 tag）必须
    出现在部署侧签发的 image-attest.json 里，且该条目**显式声明**本能力：
    capability + argvProbe:true + healthResizeToken:true + healthcheckSha256 + svcRunSha256。
    文件缺失 / digest 不在册 / 能力未声明 ⇒ 不认可该镜像具备被认证的几何行为。
    只认 digest：tag 可被追新或重打，digest 锁定逐字节内容。

  B 运行态实证（内核里的实值）
    以 **abc 身份**只读 docker exec 进容器（root 读不到 Xvnc 的 exe/environ，会把活进程
    判成假 nopid，见 PROBE_USER），遍历 /proc 按 comm==Xvnc 找进程，多候选即拒绝（不猜
    PID），随后直读 /proc/<pid>/cmdline 的 -geometry / -AcceptSetDesktopSize 实值 +
    /proc/<pid>/environ 的 WTK_* 实值。
    exe / environ **不可读**单列判据（探针权限不足 = 缺证），绝不伪装成进程不合法。

  C 容器自证（dockerd 记账）
    State.Health=healthy + FailingStreak=0 + 末条 Log.ExitCode=0 + 末行
    \"healthcheck: OK (geom=WxH resize=N …)\" 新鲜（<= HEALTH_MAX_AGE_S）。
    fixed 要求 geom **逐字等于**声明值；auto 只验两个正整数（模式本身允许 framebuffer 跟随）。

  D 一致性 + 时间因果
    Config.Env（dockerd 记账的声明）== Xvnc 进程 env（内核里的继承实值）== spec 声明几何；
    health OK 行的 resize 令牌 == argv 的 -AcceptSetDesktopSize == 声明的 allow 值；
    Xvnc 启动时刻必须早于末次 health End（否则自证描述的是**上一个会话**）。

**为什么不伪造等价关系**：A 锁镜像内容、B 是进程实值、C 是容器自己写出的自证、
D 把声明与实值逐键对齐。四者来自四个独立通道，任何一处不吻合（例：Config.Env 写了
WTK_ALLOW_RESIZE 但进程 env 里没有该键 ⇒ env 被启动后改写；argv 的 -geometry 与声明不符
⇒ 声明未生效；Xvnc 晚于 health End ⇒ 拿旧会话的绿冒充）都会留下可判定的痕迹。

本模块**零写盘、零信号、零启停**：唯一的对外命令是只读的 docker exec（探针只跑
tr/readlink/awk/sed/cat，无写操作）。
"""
from __future__ import annotations

import calendar
import json
import os
import re
import subprocess
import time

from . import config

SCHEMA_VERSION = 1
CAPABILITY = "wtk-geometry-attest/1"
ATTEST_FILE_NAME = "image-attest.json"
ATTEST_FILE_ENV = "WT_KASM_IMAGE_ATTEST"

# health 末行新鲜度上限：compose healthcheck Interval=20s（部署契约），三次连续窗口
# = 60s + 一次 timeout 30s 的余量 ⇒ 90s。比 Docker 自己判 unhealthy 的 6 次重试
# （≈120s + timeout）更严 ⇒ 只放行 \"刚刚自证过\" 的容器。
HEALTH_MAX_AGE_S = 90.0
# End 落在未来超过该值 = 时钟异常（容器侧时钟不可信）⇒ 不放行。
CLOCK_SKEW_S = 60.0
EXEC_TIMEOUT_S = 8
# Xvnc 允许比末次 health End 晚启动的宽容（容器刚重启、health 尚未跑完一轮）。
XVNC_LIVENESS_GRACE_S = 5.0

XVNC_BIN = "Xvnc"
# 探针身份 = abc（uid 1000，Xvnc 属主；与镜像 svc-kasmvnc/run 的 s6-setuidgid abc 同源）。
# 现网实测 2026-11-14：root 进容器读 Xvnc 的 /proc/<pid>/exe 与 /proc/<pid>/environ 全部
# Permission denied（docker 默认 seccomp 屏蔽 ptrace）=> root 探针会把**活着的 Xvnc 判成
# 假 nopid**；以 abc 身份 exe/environ 全可读（environ 含 8 个 WTK_*，argv 含 -geometry 实值）。
# 因此固定 -u abc；读不到时绝不退回 root 重试：权限缺失必须显式暴露为缺证，
# 不得伪装成进程不合法。
PROBE_USER = "abc"
ENV_W = "WTK_WIDTH"
ENV_H = "WTK_HEIGHT"
ENV_ALLOW = "WTK_ALLOW_RESIZE"
ALLOW_BY_MODE = dict(config.ALLOW_RESIZE_BY_MODE)   # auto=1 / fixed=0（单一来源）

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
GEOM_RE = re.compile(r"^(\d{1,5})x(\d{1,5})$")


NOW_FN = time.time  # 测试可注入时钟（monkeypatch attest.NOW_FN；生产不注入）


class AttestError(ValueError):
    """认证文件本身不可信（结构 / schema / 能力声明不合规）⇒ 全部显式几何桌 fail-closed。"""


def attest_path(env: "dict | None" = None) -> str:
    """认证文件路径：WT_KASM_IMAGE_ATTEST 显式覆盖，否则 <APP_ROOT>/image-attest.json。

    **不做隐式发现**（不搜 /opt、不搜 cwd）：认证文件的位置必须是部署侧显式安置的，
    找不到即缺证。
    """
    mapping = os.environ if env is None else env
    raw = mapping.get(ATTEST_FILE_ENV)
    if raw is not None:
        if not isinstance(raw, str):
            raise AttestError("%s 必须是 str 路径，实为 %s" % (ATTEST_FILE_ENV, type(raw).__name__))
        raw = raw.strip()
        if raw:
            return raw
    return config.APP_ROOT + "/" + ATTEST_FILE_NAME


# ------------------------------------------------------------------ A 能力锚
def load_attestation(path: "str | None" = None) -> dict:
    """读部署侧签发的认证文件 -> {digest: entry}。任何不合规一律抛 AttestError。

    fail-closed 的具体形态：文件缺失 / 坏 JSON / 根非对象 / schemaVersion!=1 /
    images 非列表或空 / 条目非对象 / digest 形态不合法 / digest 重复 /
    capability 不等于 CAPABILITY / argvProbe 与 healthResizeToken 不是显式 true /
    两份 sha256 不是 64 位小写 hex。
    **能力未显式声明 = 不认可**，绝不按\"大概是新镜像\"放行。
    """
    p = path or attest_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as exc:
        raise AttestError("认证文件缺失或不可读: %s (%s)" % (p, type(exc).__name__))
    try:
        doc = json.loads(raw)
    except ValueError:
        raise AttestError("认证文件不是合法 JSON: %s" % p)
    if not isinstance(doc, dict):
        raise AttestError("认证文件根必须是对象，实为 %s" % type(doc).__name__)
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        raise AttestError("认证文件 schemaVersion=%r，只认 %d"
                          % (doc.get("schemaVersion"), SCHEMA_VERSION))
    images = doc.get("images")
    if not isinstance(images, list) or not images:
        raise AttestError("认证文件 images 必须是非空数组")
    out: dict = {}
    for entry in images:
        if not isinstance(entry, dict):
            raise AttestError("images 条目必须是对象，实为 %s" % type(entry).__name__)
        digest = entry.get("digest")
        if not isinstance(digest, str) or not DIGEST_RE.match(digest):
            raise AttestError("images 条目 digest 形态不合法: %r" % (digest,))
        if digest in out:
            raise AttestError("认证文件 digest 重复: %s" % digest)
        if entry.get("capability") != CAPABILITY:
            raise AttestError("%s 未声明能力 %s（capability=%r）" % (digest, CAPABILITY, entry.get("capability")))
        for flag in ("argvProbe", "healthResizeToken"):
            if entry.get(flag) is not True:
                raise AttestError("%s 的 %s 必须是显式 true，实为 %r" % (digest, flag, entry.get(flag)))
        for sha_key in ("healthcheckSha256", "svcRunSha256"):
            sha = entry.get(sha_key)
            if not isinstance(sha, str) or not HEX64_RE.match(sha):
                raise AttestError("%s 的 %s 必须是 64 位小写 hex，实为 %r" % (digest, sha_key, sha))
        out[digest] = entry
    return out


# ---------------------------------------------------------------- 时间/令牌解析
_TS_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?Z$")


def parse_ts(value) -> "float | None":
    """docker 的 RFC3339 纳秒串 -> epoch 秒；空/零值/非法 -> None（不猜）。"""
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("0001-01-01"):
        return None
    m = _TS_RE.match(value)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    frac = m.group(7)
    micro = 0
    if frac:
        micro = int(round(float(frac) * 1_000_000))
    try:
        base = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0))
    except (ValueError, OverflowError):
        return None
    return base + micro / 1_000_000.0


OK_PREFIX = "healthcheck: OK"


def parse_health_output(output) -> dict:
    """容器自证末行 -> {okLine, geom, resize, line}。

    只认**以 healthcheck: OK 开头**的行（取最后一条），令牌用 key=value 语法逐 token 取。
    令牌缺席 ⇒ 字段为 None：**绝不从 env / spec 推断补齐**（缺证就是缺证）。
    """
    out = {"okLine": False, "geom": None, "resize": None, "line": ""}
    if not isinstance(output, str) or not output:
        return out
    line = ""
    for candidate in output.splitlines():
        c = candidate.strip()
        if c.startswith(OK_PREFIX):
            line = c
    if not line:
        return out
    out["okLine"] = True
    out["line"] = line
    body = line[len(OK_PREFIX):].strip()
    if body.startswith("(") and body.endswith(")"):
        body = body[1:-1]
    for token in body.split():
        k, sep, v = token.partition("=")
        if not sep:
            continue
        if k == "geom":
            g = GEOM_RE.match(v)
            if g:
                out["geom"] = (int(g.group(1)), int(g.group(2)))
            else:
                out["geom"] = "malformed:" + v
        elif k == "resize":
            out["resize"] = v
    return out


# ---------------------------------------------------- B 运行态实证（只读探针）
# 探针**只读**（tr / readlink / awk / sed 级）且**固定以 abc 身份**跑（PROBE_USER）。
# 计数只按 comm==Xvnc：root 视角 exe 不可读，把 exe 读通设为计数前提会把活进程滤没
# （现网实证：root 探针输出假 nopid）。comm 可被改名 => 命中后在 Python 侧单独验 exe 指向。
# 多候选即放弃（不猜 PID）。exe / environ 的**可读性**显式上报（exe_ok / environ_ok）：
# 权限不足记为缺证，与「进程不合法」严格区分——缺证不放行，不把权限问题写成非法进程。
PROBE_KEYS = (ENV_W, ENV_H, ENV_ALLOW)
PROBE_SH = (
    "N=0; PIDS=''\n"
    "for d in /proc/[0-9]*; do\n"
    "  [ -r \"$d/comm\" ] || continue\n"
    "  c=$(tr -d '\\n' < \"$d/comm\" 2>/dev/null) || continue\n"
    "  [ \"$c\" = Xvnc ] || continue\n"
    "  N=$((N+1)); PIDS=\"$PIDS ${d#/proc/}\"\n"
    "done\n"
    "if [ \"$N\" = 0 ]; then echo 'WTKX nopid'; echo 'WTKX end'; exit 0; fi\n"
    "if [ \"$N\" -gt 1 ]; then echo \"WTKX multiple=$N\"; echo 'WTKX end'; exit 0; fi\n"
    "set -- $PIDS; p=$1\n"
    "echo \"WTKX pid=$p\"\n"
    "echo \"WTKX comm=$(tr -d '\\n' < /proc/$p/comm 2>/dev/null)\"\n"
    "if e=$(readlink /proc/$p/exe 2>/dev/null) && [ -n \"$e\" ]; then\n"
    "  echo 'WTKX exe_ok=1'\n"
    "  echo \"WTKX exe=$e\"\n"
    "else\n"
    "  echo 'WTKX exe_ok=0'\n"
    "  echo 'WTKX exe='\n"
    "fi\n"
    "if [ -r /proc/$p/environ ]; then echo 'WTKX environ_ok=1'; else echo 'WTKX environ_ok=0'; fi\n"
    "echo \"WTKX starttime=$(awk '{print $22}' /proc/$p/stat 2>/dev/null)\"\n"
    "echo \"WTKX btime=$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null)\"\n"
    "echo \"WTKX argv=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)\"\n"
    "for k in " + " ".join(PROBE_KEYS) + "; do\n"
    "  v=$(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n \"s|^$k=||p\" | head -1)\n"
    "  [ -n \"$v\" ] && echo \"WTKX env_$k=$v\"\n"
    "done\n"
    "echo 'WTKX end'\n"
)


SENTINEL = "WTKX end"


def parse_probe(text: str) -> dict:
    """探针输出 -> 结构化；缺哨兵即整体不可信（部分输出不能用于放行）。"""
    out = {"trustworthy": False, "nopid": False, "multiple": None, "pid": None,
           "exe": None, "comm": None, "starttime": None, "btime": None,
           "exe_ok": None, "environ_ok": None,
           "argv": [], "env": {}, "rc": None, "raw": text if isinstance(text, str) else ""}
    if not isinstance(text, str) or SENTINEL not in text:
        return out
    out["trustworthy"] = True
    for line in text.splitlines():
        if not line.startswith("WTKX "):
            continue
        body = line[5:]
        k, sep, v = body.partition("=")
        if k == "rc":
            out["rc"] = v
            continue
        if k == "nopid":
            out["nopid"] = True
        elif k == "multiple":
            out["multiple"] = v
        elif not sep:
            continue
        elif k == "pid":
            out["pid"] = v.strip()
        elif k == "exe":
            out["exe"] = v.strip()
        elif k == "comm":
            out["comm"] = v.strip()
        elif k == "exe_ok":
            out["exe_ok"] = (v.strip() == "1")
        elif k == "environ_ok":
            out["environ_ok"] = (v.strip() == "1")
        elif k == "starttime":
            out["starttime"] = v.strip()
        elif k == "btime":
            out["btime"] = v.strip()
        elif k == "argv":
            out["argv"] = v.split()
        elif k.startswith("env_"):
            out["env"][k[4:]] = v
    return out


def _docker_exec(cid: str) -> str:
    """唯一的外部命令面：以 abc 身份跑只读探针（argv 含 -u PROBE_USER）。

    rc!=0（容器无 abc 用户 / exec 被拒）返回 rc 行给解析侧 => B 实证 fail-closed；
    **绝不退回 root 重试**：root 读不到 exe/environ，只会把活进程判成假 nopid。
    """
    if not config.CID_RE.match(cid or ""):
        raise AttestError("containerId 非法，拒绝 exec: %r" % (cid,))
    try:
        r = subprocess.run(["docker", "exec", "-u", PROBE_USER, cid, "sh", "-c", PROBE_SH],
                           capture_output=True, text=True, timeout=EXEC_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return "WTKX rc=timeout %ds\n%s" % (EXEC_TIMEOUT_S, SENTINEL)
    except OSError as exc:
        return "WTKX rc=exec_failed %s\n%s" % (type(exc).__name__, SENTINEL)
    if r.returncode != 0:
        return "WTKX rc=%d %s\n%s" % (r.returncode, (r.stderr or "").strip()[:200], SENTINEL)
    return r.stdout


# ------------------------------------------------------------------ 主判据
def _clk_tck() -> int:
    try:
        n = os.sysconf("SC_CLK_TCK")
        return int(n) if n and n > 0 else 100
    except (ValueError, OSError, KeyError):
        return 100


def _flag_value(argv, flag) -> "str | None":
    """取 flag 后一个 token；出现 0 次或 >1 次 ⇒ None（不猜最后一个）。"""
    hits = []
    for i, tok in enumerate(argv):
        if tok == flag:
            if i + 1 >= len(argv):
                return None
            hits.append(argv[i + 1])
        elif tok.startswith(flag + "="):
            hits.append(tok[len(flag) + 1:])
    if len(hits) != 1:
        return None
    return hits[0]


def _epoch_of(probe: dict) -> "float | None":
    """Xvnc 启动 epoch = btime + starttime/CLK_TCK（内核口径，不可得 ⇒ None）。"""
    try:
        btime = int(probe.get("btime"))
        st = int(probe.get("starttime"))
    except (TypeError, ValueError):
        return None
    return btime + st / float(_clk_tck())


def attest_geometry(spec: config.DesktopSpec, info: dict, path: "str | None" = None,
                    now: "float | None" = None, probe: "dict | None" = None) -> dict:
    """显式几何桌面的实况认证 -> {"ok": bool, "reasons": [...], "evidence": {...}}。

    spec   : 声明侧（frame_width / frame_height / resize_mode / allow_resize）
    info   : compose.inspect_full(cid) 的返回（含 imageDigest / env / health* / pid）
    path   : 认证文件路径（默认 attest_path()）
    now    : 注入时钟（测试用）
    probe  : 注入探针结果（测试用）；None ⇒ 现场跑只读 docker exec

    ok = not reasons：任何一类缺证都进 reasons，调用方据此 state=error。
    """
    reasons: list = []
    ev: dict = {"capability": CAPABILITY, "declared": {
        "width": spec.frame_width, "height": spec.frame_height,
        "mode": spec.resize_mode, "allow": spec.allow_resize}}
    info = info if isinstance(info, dict) else {}
    if not spec.has_explicit_geometry:
        return {"ok": False, "reasons": ["spec 无显式几何，不应调用认证"], "evidence": ev}

    # ---- A 能力锚 -------------------------------------------------------------
    digest = info.get("imageDigest") or ""
    ev["imageDigest"] = digest
    if not isinstance(digest, str) or not DIGEST_RE.match(digest or ""):
        reasons.append("A 能力锚: 容器无 immutable digest（inspect 的 Image=%r）" % (digest,))
    else:
        try:
            table = load_attestation(path)
        except AttestError as exc:
            table = {}
            reasons.append("A 能力锚: %s" % exc)
        if table:
            entry = table.get(digest)
            if entry is None:
                reasons.append("A 能力锚: digest %s 不在认证册（在册 %s）"
                               % (digest, ",".join(sorted(table))))
            else:
                ev["attestEntry"] = {"digest": digest, "tag": entry.get("tag"),
                                     "builtAt": entry.get("builtAt"),
                                     "healthcheckSha256": entry.get("healthcheckSha256"),
                                     "svcRunSha256": entry.get("svcRunSha256")}

    # ---- C 容器自证（dockerd 记账的 health）------------------------------------
    hstat = info.get("healthStatus")
    ev["healthStatus"] = hstat
    if not hstat:
        reasons.append("C 自证: 无 State.Health（未配 healthcheck ⇒ 无自证通道）")
    elif hstat != "healthy":
        reasons.append("C 自证: health=%r 非 healthy" % (hstat,))
    streak = info.get("healthFailingStreak")
    ev["healthFailingStreak"] = streak
    if streak not in (0,):
        reasons.append("C 自证: FailingStreak=%r 非 0" % (streak,))
    hlog = info.get("healthLog") if isinstance(info.get("healthLog"), dict) else {}
    parsed = parse_health_output(hlog.get("output"))
    ev["healthLine"] = parsed["line"]
    if hlog.get("exit") != 0:
        reasons.append("C 自证: 末条 health Log ExitCode=%r 非 0" % (hlog.get("exit"),))
    if not parsed["okLine"]:
        reasons.append("C 自证: 末条 health 输出无 '%s' 行" % OK_PREFIX)
    geom = parsed["geom"]
    if parsed["okLine"] and geom is None:
        reasons.append("C 自证: OK 行无 geom=WxH 令牌（缺证不从 env 补）")
    elif isinstance(geom, str):
        reasons.append("C 自证: geom 令牌形态非法 %r" % geom)
    elif geom is not None:
        want = (spec.frame_width, spec.frame_height)
        if spec.resize_mode == "fixed":
            if geom != want:
                reasons.append("C 自证: framebuffer %dx%d != 声明 fixed %dx%d"
                               % (geom[0], geom[1], want[0], want[1]))
        else:
            if geom[0] <= 0 or geom[1] <= 0:
                reasons.append("C 自证: auto 模式 geom 非两个正整数 %r" % (geom,))
    now_ts = float(NOW_FN()) if now is None else float(now)
    end = parse_ts(hlog.get("end"))
    ev["healthEnd"] = hlog.get("end")
    if end is None:
        reasons.append("C 自证: 末条 health End 时间不可解析（%r）" % (hlog.get("end"),))
    else:
        age = now_ts - end
        ev["healthAgeS"] = round(age, 1)
        if age > HEALTH_MAX_AGE_S:
            reasons.append("C 自证: 末次 health 距今 %.0fs > %.0fs（自证已过期）"
                           % (age, HEALTH_MAX_AGE_S))
        elif age < -CLOCK_SKEW_S:
            reasons.append("C 自证: 末次 health End 在未来 %.0fs（时钟不可信）" % (-age,))

    # ---- B 运行态实证 --------------------------------------------------------
    if isinstance(probe, dict):
        pr = probe
    else:
        cid = info.get("containerId") or info.get("id") or ""
        if not config.CID_RE.match(cid):
            reasons.append("B 实证: containerId 非法/缺失，无法直读进程实值: %r" % (cid,))
            return {"ok": False, "reasons": reasons, "evidence": ev}
        try:
            pr = parse_probe(_docker_exec(cid))
        except AttestError as exc:
            reasons.append("B 实证: %s" % exc)
            return {"ok": False, "reasons": reasons, "evidence": ev}
    ev["probe"] = {k: pr.get(k) for k in ("pid", "exe", "comm", "rc", "nopid", "multiple",
                                        "exe_ok", "environ_ok")}
    ev["probeUser"] = PROBE_USER
    if not pr.get("trustworthy"):
        reasons.append("B 实证: 探针输出不完整（无 %s 哨兵），不可信" % SENTINEL)
        return {"ok": False, "reasons": reasons, "evidence": ev}
    if pr.get("rc"):
        reasons.append("B 实证: 探针 rc=%s" % pr.get("rc"))
        return {"ok": False, "reasons": reasons, "evidence": ev}
    if pr.get("nopid"):
        reasons.append("B 实证: 容器内无 Xvnc 进程（comm==Xvnc 命中 0 个）")
        return {"ok": False, "reasons": reasons, "evidence": ev}
    if pr.get("multiple"):
        reasons.append("B 实证: Xvnc 候选 %s 个，拒绝猜测 PID" % pr.get("multiple"))
        return {"ok": False, "reasons": reasons, "evidence": ev}
    argv = pr.get("argv") or []
    comm = pr.get("comm")
    exe = pr.get("exe") or ""
    if comm != XVNC_BIN:
        reasons.append("B 实证: 命中进程 comm=%r 非 %s（不认改名进程）" % (comm, XVNC_BIN))
    exe_ok = pr.get("exe_ok")
    ev["exeOk"] = exe_ok
    if exe_ok is False:
        reasons.append("B 实证: 进程 exe 不可读（探针权限不足：需以 %s 身份进容器读 /proc）" % PROBE_USER)
    elif os.path.basename(exe) != XVNC_BIN:
        reasons.append("B 实证: 命中进程 exe=%r 不指向 %s 二进制（不认标签巧合）" % (exe, XVNC_BIN))
    argv_geom = _flag_value(argv, "-geometry")
    argv_allow = _flag_value(argv, "-AcceptSetDesktopSize")
    ev["argvGeom"] = argv_geom
    ev["argvAllow"] = argv_allow
    g = GEOM_RE.match(argv_geom or "")
    argv_geom_t = (int(g.group(1)), int(g.group(2))) if g else None
    want = (spec.frame_width, spec.frame_height)
    if argv_geom_t is None:
        reasons.append("B 实证: Xvnc argv 的 -geometry 缺失/重复/形态非法（%r）" % (argv_geom,))
    elif argv_geom_t != want:
        reasons.append("B 实证: Xvnc argv -geometry %s != 声明 %dx%d"
                       % (argv_geom, want[0], want[1]))
    if argv_allow is None:
        reasons.append("B 实证: Xvnc argv 的 -AcceptSetDesktopSize 缺失或重复（不猜）")
    elif argv_allow != spec.allow_resize:
        reasons.append("B 实证: argv -AcceptSetDesktopSize=%s 与声明 %s=%s 相反"
                       % (argv_allow, spec.resize_mode, spec.allow_resize))

    # ---- D 一致性 + 时间因果 -------------------------------------------------
    declared_env = {ENV_W: str(spec.frame_width), ENV_H: str(spec.frame_height),
                    ENV_ALLOW: str(spec.allow_resize)}
    cfg_env = info.get("env") if isinstance(info.get("env"), dict) else {}
    for k, want_v in declared_env.items():
        got = cfg_env.get(k)
        if got is None:
            reasons.append("D 一致性: Config.Env 缺 %s（声明 %s）" % (k, want_v))
        elif got != want_v:
            reasons.append("D 一致性: Config.Env %s=%s != 声明 %s" % (k, got, want_v))
    proc_env = pr.get("env") or {}
    ev["procEnv"] = {k: proc_env.get(k) for k in declared_env}
    environ_ok = pr.get("environ_ok")
    ev["environOk"] = environ_ok
    if environ_ok is False:
        reasons.append("D 一致性: Xvnc 进程 environ 不可读（探针权限不足：需以 %s 身份进容器）"
                       " ⇒ 声明与进程实值的等价关系无法实证，缺证不放行" % PROBE_USER)
    else:
        for k, want_v in declared_env.items():
            got = proc_env.get(k)
            if got is None:
                reasons.append("D 一致性: Xvnc 进程 env 无 %s（Config.Env 有 ⇒ 启动后被改写，等价关系不成立）" % k)
            elif got != want_v:
                reasons.append("D 一致性: Xvnc 进程 env %s=%s != 声明 %s" % (k, got, want_v))
    if parsed["resize"] is None:
        reasons.append("D 一致性: health OK 行无 resize= 令牌（镜像未具备该能力）")
    elif argv_allow is not None and parsed["resize"] != argv_allow:
        reasons.append("D 一致性: health resize=%s != argv -AcceptSetDesktopSize=%s"
                       % (parsed["resize"], argv_allow))
    if parsed["geom"] is not None and argv_geom_t is not None and not isinstance(parsed["geom"], str):
        if spec.resize_mode == "fixed" and parsed["geom"] != argv_geom_t:
            reasons.append("D 一致性: fixed 桌 health geom=%dx%d != argv geom=%s"
                           % (parsed["geom"][0], parsed["geom"][1], argv_geom))
    xvnc_epoch = _epoch_of(pr)
    ev["xvncEpoch"] = xvnc_epoch
    if xvnc_epoch is None:
        reasons.append("D 因果: Xvnc 启动时刻不可得（btime/starttime 读不到）")
    elif end is not None and xvnc_epoch > end + XVNC_LIVENESS_GRACE_S:
        reasons.append("D 因果: Xvnc 启动(%s) 晚于末次 health End %s ⇒ 自证属上一会话"
                       % (time.strftime("%H:%M:%S", time.gmtime(xvnc_epoch)), hlog.get("end")))
    return {"ok": not reasons, "reasons": reasons, "evidence": ev}


def summary(att: dict) -> str:
    """给 registry detail 用的一行结论（不含 PII、不含命令）。"""
    if att.get("ok"):
        return "几何实况已认证（A 能力锚 + B 进程实值 + C 容器自证 + D 一致性）"
    return "几何实况未认证: " + "; ".join(att.get("reasons") or ["无判据"])
