"""appshare 契约（消费镜像 worker 产出）+ X 归属核对（防误路由）。

镜像侧在容器 /run/wt-kasm-app（bind 自 <desk>/runtime/appshare）产出：
  native(pulse native socket) / pulse-cookie / xauth / generation(每次 Xsession 更新)
  / app.json(纯数据)
本模块只读 + 校验，不写镜像契约文件。launch.sock 由本模块每 desk 创建并落在
appshare 目录（供桌面图标点击），协议只接受 launch / focus，固定 appIds，无 argv/url/exec。

root 抢先审修正（2026-11-13）：
- 容器内 Xvnc 用 DISPLAY=:1 => 宿主 bind 目录里的 socket 文件是 X1（不是 X310）。
- 宿主侧 X 客户端（xprop/xdotool）访问方式 = relay 起来之后用 spec.relay_display
  （127.0.0.1:310/311/312，AF_INET）。交接文档 §6 已证 unix 绝对路径写法在宿主接图
  场景解析失败 => 不再提供 unix:/abs 形式，也不与 relay 显示号混用。
- generation 正反向核对：xprop 的 _WT_KASM_GENERATION 必须等于 appshare/generation 现值。
- P1-2 / 冷启竞态（root 2026-11-13 追加）：want_generation 为 None ⇒ **failclosed**
  （与注释口径一致，appshare/generation 缺失同样拒绝，绝不通过缺 generation 放行）。
  镜像侧 generation 写在 Xvnc 之前、WM 写 root 属性稍晚 ⇒ 单次 verify_routing 只作
  **瞬时判定（不先验首帧）**；start 链路用 wait_routing() 有界等待"root 属性出现且
  等于当前 generation"。root 上残留前次 Xsession 的旧 generation 同样按未收敛处理。
"""
from __future__ import annotations

import json
import os
import subprocess
import time

from . import config

NATIVE_REL = "native"
PULSE_COOKIE_REL = "pulse-cookie"
XAUTH_REL = "xauth"
GENERATION_REL = "generation"
APP_JSON_REL = "app.json"
LAUNCH_SOCK_REL = "launch.sock"
CONTRACT_FILES = (NATIVE_REL, PULSE_COOKIE_REL, XAUTH_REL, GENERATION_REL, APP_JSON_REL)

X11_SOCKET_BASENAME = "X1"  # 容器 DISPLAY=:1


def path(desktop_id: str, name: str) -> str:
    return os.path.join(config.appshare_dir(desktop_id), name)


def launch_socket_path(desktop_id: str) -> str:
    return path(desktop_id, LAUNCH_SOCK_REL)


def x11_socket_path(desktop_id: str) -> str:
    return os.path.join(config.x11_dir(desktop_id), X11_SOCKET_BASENAME)


def read_generation(desktop_id: str) -> str | None:
    try:
        with open(path(desktop_id, GENERATION_REL), "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def read_app_json(desktop_id: str) -> dict | None:
    try:
        with open(path(desktop_id, APP_JSON_REL), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _is_socket(p: str) -> bool:
    import stat
    try:
        return stat.S_ISSOCK(os.stat(p).st_mode)
    except OSError:
        return False


def contract_status(desktop_id: str) -> dict:
    """appshare 契约逐项存在性/可读性（plumbing 可用性，不代表 GUI 已验）。"""
    out = {"desktop": desktop_id, "dir": config.appshare_dir(desktop_id),
           "files": {}, "missing": []}
    for name in CONTRACT_FILES:
        p = path(desktop_id, name)
        st: dict = {}
        if os.path.islink(p):
            st["kind"] = "symlink-rejected"
            st["readable"] = False
        elif os.path.isdir(p):
            st["kind"] = "dir"
            st["readable"] = True
        elif os.path.exists(p):
            st["kind"] = "socket" if _is_socket(p) else "file"
            try:
                st["size"] = os.path.getsize(p)
                st["readable"] = os.access(p, os.R_OK)
            except OSError:
                st["readable"] = False
        else:
            st["kind"] = "absent"
            st["readable"] = False
        out["files"][name] = st
        if st["kind"] in ("absent", "symlink-rejected") or not st["readable"]:
            out["missing"].append(name)
    out["generation"] = read_generation(desktop_id)
    out["x11_socket"] = x11_socket_path(desktop_id)
    out["x11_socket_present"] = _is_socket(x11_socket_path(desktop_id))
    return out


def xcli_env(desktop_id: str) -> dict:
    """宿主 X 客户端环境：DISPLAY 用 relay 显示号，XAUTHORITY 用 appshare。"""
    spec = config.spec(desktop_id)
    env = {"PATH": "/usr/bin:/bin", "DISPLAY": spec.relay_display, "LC_ALL": "C.UTF-8",
           "HOME": config.APP_ROOT}
    xa = path(desktop_id, XAUTH_REL)
    if os.path.exists(xa):
        env["XAUTHORITY"] = xa
    return env


def read_x_root_props(desktop_id: str, timeout: float = 6.0) -> dict:
    """xprop 读 root window 归属属性（要求 relay 已起）。读不到即 unknown，不猜。"""
    env = xcli_env(desktop_id)
    out = {"desktop_id": None, "generation": None, "raw": "", "error": None}
    try:
        r = subprocess.run(["xprop", "-root", "_WT_KASM_DESKTOP_ID", "_WT_KASM_GENERATION"],
                           capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        out["error"] = repr(exc)
        return out
    text = ((r.stdout or "") + (r.stderr or "")).strip()
    out["raw"] = text
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("_WT_KASM_DESKTOP_ID"):
            out["desktop_id"] = _prop_value(line)
        elif line.startswith("_WT_KASM_GENERATION"):
            out["generation"] = _prop_value(line)
    return out


def _prop_value(line: str) -> str | None:
    if "=" not in line:
        return None
    val = line.split("=", 1)[1].strip()
    if val.startswith('"') and val.endswith('"'):
        return val[1:-1]
    if "not found" in val.lower():
        return None
    return val


def verify_routing(desktop_id: str, expected_generation: str | None = None) -> dict:
    """X 归属核对：root 属性 desktop == 期望 id 且 generation 与 appshare 现值一致。

    root window ID 相等不当 identity（交接 §8）。generation 缺失 => failclosed。

    **瞬时判定**：冷启时 WM 尚未写 root 属性属预期，本函数返回 not ok；
    启动链路请调 wait_routing() 做有界收敛，不要把单次失败当最终结论。
    """
    props = read_x_root_props(desktop_id)
    want_gen = expected_generation or read_generation(desktop_id)
    res = {"ok": False, "desktop_id": props.get("desktop_id"), "generation": props.get("generation"),
           "want_desktop_id": desktop_id, "want_generation": want_gen,
           "display": config.spec(desktop_id).relay_display,
           "reason": None, "raw": props.get("raw"), "error": props.get("error")}
    if props.get("error"):
        res["reason"] = "xprop 失败（relay 未起? X 未就绪?）: %s" % props["error"]
        return res
    if not want_gen:
        res["reason"] = ("appshare/generation 缺失且未传 expected_generation"
                         " ⇒ 无法核对换代，failclosed（绝不通过缺 generation 放行）")
        return res
    if props.get("desktop_id") is None:
        res["reason"] = "root 无 _WT_KASM_DESKTOP_ID（镜像侧未写 => X 未就绪或契约缺失）"
        return res
    if props["desktop_id"] != desktop_id:
        res["reason"] = "误路由: root desktop=%r != %r" % (props["desktop_id"], desktop_id)
        return res
    if props.get("generation") and props["generation"] != want_gen:
        res["reason"] = "generation 不一致: xprop=%r appshare=%r（Xsession 换代中）" % (props["generation"], want_gen)
        return res
    if not props.get("generation"):
        res["reason"] = "root 无 _WT_KASM_GENERATION => 无法核对换代，failclosed"
        return res
    res["ok"] = True
    return res


def wait_routing(desktop_id: str, timeout: float = 45.0, interval: float = 1.0,
                 expected_generation: str | None = None) -> dict:
    """有界等待 X 归属收敛：root 属性存在 + desktop 命中 + generation == 现值。

    镜像侧顺序 = generation 文件先写、Xvnc 后起、WM 写 root 属性最晚 ⇒ 冷启窗口内
    单次 verify_routing 必然可能 not ok。本函数在 timeout 内轮询直到一致（含"root 上
    仍是前次 Xsession 旧 generation"这种未收敛状态），超时才返回最后一轮的 FAIL 结果。
    generation 现值在整个等待期内重新读取 ⇒ Xsession 中途换代也会等到新值。
    """
    deadline = time.time() + timeout
    res = verify_routing(desktop_id, expected_generation=expected_generation)
    while not res["ok"] and time.time() < deadline:
        time.sleep(interval)
        res = verify_routing(desktop_id, expected_generation=expected_generation)
    return res


def wait_contract(desktop_id: str, timeout: float = 90.0, interval: float = 1.0) -> dict:
    """等 appshare 契约 + X socket 齐备（镜像 init 产出）。只等 plumbing，不等 GUI。"""
    deadline = time.time() + timeout
    st = contract_status(desktop_id)
    while ((st["missing"] or not st["x11_socket_present"]) and time.time() < deadline):
        time.sleep(interval)
        st = contract_status(desktop_id)
    return st

