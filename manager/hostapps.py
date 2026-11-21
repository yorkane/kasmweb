"""真宿主应用接入：Chrome / VCMI 都是本机二进制，跑在 desktop 的 X 显示上。

规约（root 2026-11-13 任务卡 + 交接 §6/§8 + root 两轮抢先审）：
- Chrome = /home/aigc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome (153.0.8010.12)
  VCMI = /usr/games/vcmiclient (1.7.5)
- 普通宿主 UID(1000) + 正常 Chrome sandbox 优先：不 unshare -U、不 uid map 成 root、
  不加 --no-sandbox（除确证必需并先报 root）。
- socat relay：127.0.0.1:P -> <desk>/runtime/x11/X1（容器 DISPLAY=:1）；
  app DISPLAY=127.0.0.1:(P-6000)=:310/:311/:312。避开宿主 abstract X1/:99/:149。
- 每 app 目录统一 = desktops/<id>/apps/<app>/{home,profile,runtime}（chrome profile =
  desktops/<id>/apps/chrome/profile，与 root 约定一致）；权限 700；绝不跨 desk 共享。
- 环境白名单：app_env() 直接作为 execvpe 的子环境（**不套 env -i wrapper**，见 launch
  注释）⇒ 不继承宿主 DBUS_*（宿主是 disabled:）/PULSE_*/DISPLAY/LD_PRELOAD/PYTHON*；
  chrome 用 dbus-run-session 私有 bus（最外层启动器，登记走 comm/exe 白名单）。
- 窗口 title/class/PID xdotool/xprop 回读 => focus；不默认最大化。
- 换代先安全确认旧 app 退出，确认不了 failclosed 阻止同 profile 多开；零 pkill。
- 每桌面可双 app（chrome + vcmi），default_app 不变；图标点对非默认 app 合法。
- VCMI 数据 = 真实授权源**内容级校验的完整实体复制**（staging → 全文件 sha256 比对 →
  原子 rename；失败 throw，不留半树）；**绝不执行** /data/app/vcmi-webtop9/init-data.sh。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time

from . import appshare, config, net, process

VCMI_TITLE = "VCMI"
VCMI_CLASS = "vcmiclient"
CHROME_CLASS = "Chrome"
DBUS_RUN_SESSION = "/usr/bin/dbus-run-session"
# EasyConnect 窗口身份（opt-in 桌面 app；WM_CLASS / WM_NAME 取注册名）。
# 241 实机未取证 ⇒ find_window 未命中即整次 launch 判 ok=False（failclosed，不登记窗口）。
EASYCONNECT_CLASS = "EasyConnect"
EASYCONNECT_TITLE = "EasyConnect"


def app_dir(desktop_id: str, app_id: str) -> str:
    return os.path.join(config.desktop_dir(desktop_id), "apps", app_id)


def app_home(desktop_id: str, app_id: str) -> str:
    return os.path.join(app_dir(desktop_id, app_id), "home")


def chrome_profile(desktop_id: str) -> str:
    """契约路径 = desktops/<id>/apps/chrome/profile（两个 Chrome 天然不同）。"""
    return os.path.join(app_dir(desktop_id, "chrome"), "profile")


def app_runtime(desktop_id: str, app_id: str) -> str:
    return os.path.join(app_dir(desktop_id, app_id), "runtime")



def ensure_chrome_frame_pref(desktop_id: str) -> dict:
    """私有 profile 的 Default/Preferences 写 browser.custom_chrome_frame=false。

    Chrome 默认 CSD 自请求 _MOTIF_WM_HINTS 关掉 WM 装饰 ⇒ 自绘标题栏，
    KasmVNC 里像“没有标题栏”（镜像 Openbox rules 实为 decor=yes，实测 frame=1,1,22,5）。
    键名 = 在 153 二进制 strings 精确命中
    browser.custom_chrome_frame（root 2026-11-13 实证），不是猜的键。

    约束：只写本桌**私有 profile 副本**，绝不碰真实 ~/.config 与真实 HOME；
    只在 app 未活时写（Chrome 运行中会把自己的 Preferences 覆写回去）；
    已有内容 JSON 深合并，不覆盖用户其它偏好；损坏文件移入 trash 后重建（零 rm）。
    """
    prof = chrome_profile(desktop_id)
    d = os.path.join(prof, "Default")
    path = os.path.join(d, "Preferences")
    prefs: dict = {}
    action = "created"
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError("Preferences 不是 JSON object")
            prefs, action = loaded, "merged"
        except (OSError, ValueError) as exc:
            _move_to_trash(path, desktop_id)   # 损坏/半写 ⇒ 留证重建
            action = "rebuilt-" + type(exc).__name__
    browser = prefs.get("browser")
    if not isinstance(browser, dict):
        browser = {}
    changed = browser.get("custom_chrome_frame") is not False
    browser["custom_chrome_frame"] = False
    prefs["browser"] = browser
    if changed or action != "merged":
        os.makedirs(d, mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prefs, f)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
        os.chmod(d, 0o700)
        os.chmod(prof, 0o700)
    return {"ok": True, "action": action, "changed": changed, "path": path}
def app_pidfile(desktop_id: str, app_id: str) -> str:
    return config.pidfile(desktop_id, "app-" + app_id)


def app_log(desktop_id: str, app_id: str) -> str:
    return os.path.join(config.LOG_DIR, "app-%s-%s.log" % (desktop_id, app_id))


def live_app(desktop_id: str, app_id: str) -> dict | None:
    return process.live_ledger(app_pidfile(desktop_id, app_id))


# ---------- 内容级指纹 ----------

def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_manifest(root: str, follow_dir_symlink: bool = False) -> dict:
    """确定性内容清单：relpath -> sha256；树内软链 = 违规直接抛。"""
    if not os.path.isdir(root):
        raise FileNotFoundError("目录不存在: " + root)
    files = {}
    total = 0
    for base, dirs, names in os.walk(root, followlinks=follow_dir_symlink):
        for name in dirs + names:
            p = os.path.join(base, name)
            if os.path.islink(p):
                raise RuntimeError("VCMI 源/副本树禁软链: %s" % p)
        for name in names:
            p = os.path.join(base, name)
            if os.path.isfile(p):
                rel = os.path.relpath(p, root)
                files[rel] = file_sha256(p)
                total += os.path.getsize(p)
    agg = hashlib.sha256()
    for rel in sorted(files):
        agg.update(("%s %s\n" % (rel, files[rel])).encode())
    return {"root": root, "files": files, "count": len(files), "bytes": total,
            "aggregate": agg.hexdigest()}


def baseline_hashes() -> dict:
    """真实 VCMI 源内容指纹（只读，430MB 全量 sha256）。root 要求 content hash。"""
    # 不带时间戳字段 ⇒ payload 幂等（P3-1：旧 generated 使 manifest 逐次启动都被重写）。
    out = {"sources": {}}
    for label, src in (("data", config.VCMI_SRC_DATA), ("config", config.VCMI_SRC_CONFIG)):
        try:
            m = tree_manifest(src)
            out["sources"][label] = {"path": src, "count": m["count"], "bytes": m["bytes"],
                                     "aggregate": m["aggregate"]}
        except (OSError, RuntimeError) as exc:
            out["sources"][label] = {"path": src, "error": str(exc)}
    return out


def quick_fingerprint(root: str) -> dict:
    """热路径预检指纹 = (count, bytes, 顶层 mtime_ns)：**不读文件内容**。

    P3-1：全量 sha256 只在显式 verify / force=True 做；冷启动热路径用本函数，
    命中即视为副本完整（随后由 verify 路径做权威 aggregate 核验）。
    """
    if not os.path.isdir(root):
        raise FileNotFoundError("目录不存在: " + root)
    count = 0
    total = 0
    for base, dirs, names in os.walk(root):
        for n in list(dirs) + list(names):
            p = os.path.join(base, n)
            if os.path.islink(p):
                raise RuntimeError("VCMI 源/副本树禁软链: " + p)
        for n in names:
            p = os.path.join(base, n)
            if os.path.isfile(p):
                count += 1
                total += os.path.getsize(p)
    top_mt = 0
    for n in os.listdir(root):
        try:
            top_mt = max(top_mt, os.lstat(os.path.join(root, n)).st_mtime_ns)
        except OSError:
            pass
    return {"count": count, "bytes": total, "top_mtime_ns": top_mt}


def _quick_matches(recorded: dict, now: dict) -> bool:
    """热路径键比对。

    P3-1 根因（已闭合）：播种登记记录顶层只有 count / bytes，mtime 键叫
    count_top_mtime_ns，而热路径读顶层 top_mtime_ns ⇒ 永为 -1 ⇒ 快检永不命中 ⇒
    每次热重启被迫跑 430MB 全量 sha256。修法 = 播种侧在**同一记录**补写顶层
    top_mtime_ns（见 vcmi_home_seed 的 info.update），本函数口径保持不变。
    """
    return (int(recorded.get("count", -1)) == now["count"]
            and int(recorded.get("bytes", -1)) == now["bytes"]
            and int(recorded.get("top_mtime_ns", -1)) == now["top_mtime_ns"])


def count_ttf(path: str) -> int:
    n = 0
    for base, dirs, names in os.walk(path):
        n += sum(1 for f in names if f.lower().endswith(".ttf"))
    return n


# ---------- VCMI HOME：完整校验复制 ----------

def _staging_root(desktop_id: str) -> str:
    p = os.path.join(config.desktop_dir(desktop_id), ".staging")
    os.makedirs(p, mode=0o700, exist_ok=True)
    return p


def _copy_tree_verified(src: str, dst: str, desktop_id: str) -> dict:
    """src → staging（cp -a）→ 逐文件 sha256 全量比对 → 原子 rename 到 dst。

    任何不一致 / 软链 / 数量差 = 抛错并 staging 移入 trash，dst 不留半树。
    """
    src_manifest = tree_manifest(src)
    if src_manifest["count"] == 0:
        raise RuntimeError("源目录为空，拒绝复制: " + src)
    stage = os.path.join(_staging_root(desktop_id), "seed-" + os.urandom(6).hex())
    os.makedirs(stage, mode=0o700, exist_ok=True)
    r = subprocess.run(["cp", "-a", src + "/.", stage + "/"], capture_output=True, text=True)
    if r.returncode != 0:
        _move_to_trash(stage, desktop_id)
        raise RuntimeError("cp -a 失败: " + (r.stderr or "").strip()[:200])
    dst_manifest = tree_manifest(stage)
    if (dst_manifest["count"] != src_manifest["count"]
            or dst_manifest["aggregate"] != src_manifest["aggregate"]):
        missing = sorted(set(src_manifest["files"]) - set(dst_manifest["files"]))[:8]
        extra = sorted(set(dst_manifest["files"]) - set(src_manifest["files"]))[:8]
        diff = [k for k in set(src_manifest["files"]) & set(dst_manifest["files"])
                if src_manifest["files"][k] != dst_manifest["files"][k]][:8]
        _move_to_trash(stage, desktop_id)
        raise RuntimeError("staging 内容校验失败 count=%s/%s missing=%s extra=%s diff=%s"
                           % (dst_manifest["count"], src_manifest["count"], missing, extra, diff))
    os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
    if os.path.exists(dst):
        _move_to_trash(stage, desktop_id)
        raise RuntimeError("目标已存在，禁止覆盖: " + dst)
    os.rename(stage, dst)
    os.chmod(dst, 0o700)
    return {"src": src, "dst": dst, "count": dst_manifest["count"], "bytes": dst_manifest["bytes"],
            "aggregate": dst_manifest["aggregate"], "source_aggregate": src_manifest["aggregate"]}


def _move_to_trash(path: str, desktop_id: str) -> None:
    if not os.path.exists(path):
        return
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest = os.path.join(os.environ.get("WT_KASM_TRASH", config.TRASH_ROOT),
                        "wt-kasm-staging-%s-%s" % (desktop_id, stamp))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(path, dest)


def vcmi_seed_manifest_path(desktop_id: str) -> str:
    return os.path.join(config.state_dir(desktop_id), "vcmi-seed.json")


def _empty_dir_to_trash(path: str, desktop_id: str) -> None:
    """空目标目录 ⇒ 移入 trash（AGENTS.md：删除一律 mv 进 /data/.trash，零 rm/rmdir）。"""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest = os.path.join(config.TRASH_ROOT, "wt-kasm-seed-empty-%s-%s-%s"
                        % (desktop_id, os.path.basename(path), stamp))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(path, dest)


VCMI_KEY_DIRS = ("Data",)                           # 硬门槛：只读资产根
VCMI_INFO_DIRS = ("Mods", "config", "Maps", "MP3")   # 只登记不判定（真实 data 根顶层无 config 目录）
VCMI_TRUSTED_DIRS = ("Saves", "Logs", "Cache", "Screenshots", "Maps", "States", "Video")
MAX_SYMLINK_REPORT = 8


def vcmi_seed_hot_gate(data_dst, recorded, quick):
    """已播种副本的热重启放行门（root 2026-11-13 四点裁决）。

    ① 首次启动（无 manifest / force=True）⇒ 调用方仍走全量内容复制
       （staging 逐文件 sha256 全量比对 + 原子发布），本门不参与，门槛不放宽。
    ② 本门不做全树逐文件 hash 相等：游戏运行会自写 Saves/Logs/Cache 与 config
       副本 ⇒ 用启动时 hash 拒绝再次启动 = 把正常行为判成损坏。热路径只用调用方
       传入的 quick_fingerprint（不读文件内容）。
    ③ 判定量 = (a) 树内零软链（与 tree_manifest 同一禁链口径）
       (b) 资产根 Data 在场且非空。Mods / config / Maps 等顶层目录**只登记不判定**：
           真实 data 根顶层没有 config 目录，写进硬门槛会把生产副本判成损坏
       (c) 文件数 / 总字节不小于登记值（游戏只增不减 ⇒ 删除或截断即拒）。
    ④ mutable 目录（VCMI_TRUSTED_DIRS）只作审计登记，不参与任何判定。

    返回 {ok, reason, symlinks, key, mutable}，永不抛错。
    """
    out = {"ok": False, "reason": "", "symlinks": [], "key": {}, "mutable": []}
    links = []
    key_present = {d: False for d in VCMI_KEY_DIRS}
    info_present = {d: False for d in VCMI_INFO_DIRS}
    data_files = 0
    config_json = 0
    mutable_seen = set()
    for base, dirs, names in os.walk(data_dst):
        for n in list(dirs) + list(names):
            q = os.path.join(base, n)
            if os.path.islink(q):
                links.append(os.path.relpath(q, data_dst))
        rel = os.path.relpath(base, data_dst)
        top = rel.split(os.sep)[0] if rel != "." else ""
        if top in VCMI_TRUSTED_DIRS:
            mutable_seen.add(top)
        if top == "Data":
            data_files += len(names)
        if top == "config":
            config_json += sum(1 for n in names if n.lower().endswith(".json"))
        if rel == ".":
            for d in dirs:
                if d in key_present:
                    key_present[d] = True
                if d in info_present:
                    info_present[d] = True
    out["symlinks"] = links[:MAX_SYMLINK_REPORT]
    out["key"] = dict(key_present, data_files=data_files, config_json=config_json)
    out["mutable"] = sorted(mutable_seen)
    if links:
        out["reason"] = "symlink-in-copy"
        return out
    missing = [d for d, v in key_present.items() if not v]
    if missing:
        out["reason"] = "missing-key-dir:" + ",".join(missing)
        return out
    if data_files == 0:
        out["reason"] = "empty-Data-dir"
        return out
    out["info_dirs"] = {k: v for k, v in sorted(info_present.items())}
    out["config_json"] = config_json
    if quick is None:
        out["reason"] = "no-quick-fingerprint"
        return out
    if quick["count"] < int(recorded.get("count", -1)):
        out["reason"] = "count-drop:%s<%s" % (quick["count"], recorded.get("count"))
        return out
    if quick["bytes"] < int(recorded.get("bytes", -1)):
        out["reason"] = "bytes-drop:%s<%s" % (quick["bytes"], recorded.get("bytes"))
        return out
    out["ok"] = True
    out["reason"] = "gate-pass"
    return out


def vcmi_home_seed(desktop_id: str, force: bool = False, verify: bool = False) -> dict:
    """首次 VCMI app 启动时调用；已完整副本 = 预检后跳过。失败抛错（不半树启动）。

    口径（root 2026-11-13）：
    口径（root 2026-11-13 四点裁决，判定逻辑见 vcmi_seed_hot_gate）：
    - **首次启动（无 manifest / force=True）= 全量内容复制**：staging 逐文件 sha256
      全量比对后才原子发布，门槛不放宽。
    - **热重启门**（manifest 在场）= 树内零软链 + 关键 Data 资产在场 + 文件数/字节数
      不降；**全树逐文件 hash 相等不再作为放行门槛**（游戏自写 Saves/Logs/Cache/config
      ⇒ hash 必然漂移，漂移本身不判损坏、不清副本）。
    - **热路径不跑全量 sha256**：用 quick_fingerprint(count/bytes/顶层 mtime) 预检；
      全量 aggregate 只在 verify=True 做审计并写回新 hash。
    - **基线核验只针对 data 树**：游戏运行会写自己的 config 副本 ⇒ 不得用启动时的
      config hash 拒绝正常再次启动（config 只记 hash 供审计，不作放行门槛）。
    - 空目标目录移入 trash，不 rmdir。
    """
    home = app_home(desktop_id, "vcmi")
    pairs = ((config.VCMI_SRC_DATA, os.path.join(home, ".local", "share", "vcmi")),
             (config.VCMI_SRC_CONFIG, os.path.join(home, ".config", "vcmi")))
    data_dst = os.path.join(home, ".local", "share", "vcmi")
    mpath = vcmi_seed_manifest_path(desktop_id)
    recorded = {}
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            recorded = json.load(f)
    except (OSError, ValueError):
        recorded = {}
    report = {"desktop": desktop_id, "home": home, "copied": [], "kept": [], "ttf": 0}
    by_dst = {i.get("dst"): i for i in (recorded.get("pairs") or [])}
    rec_data = by_dst.get(data_dst)
    if not force and rec_data:
        try:
            quick = quick_fingerprint(data_dst)
        except (OSError, RuntimeError):
            quick = None
        hot_ok = bool(quick) and _quick_matches(rec_data, quick)
        if hot_ok and not verify:
            # 最快路径：三键全等 ⇒ 零 IO 放行，不重写 manifest
            report["action"] = "quick-existing"
            report["kept"].append(dict(rec_data, quick=quick))
            report["ttf"] = count_ttf(os.path.join(data_dst, "Data"))
            return report
        gate = vcmi_seed_hot_gate(data_dst, rec_data, quick)
        report["gate"] = gate
        if not gate["ok"]:
            # 门不过（软链 / 关键资产缺失 / 数量下降）⇒ 走全量重播种，必要时抛错
            report["stale"] = {"recorded": rec_data.get("aggregate"),
                               "gate_reason": gate["reason"]}
        elif not verify:
            # 门通过 + 热路径：放行，**不跑全量 sha256**；hash 漂移只记账，副本不清
            rec_data["quick"] = quick
            rec_data["top_mtime_ns"] = quick["top_mtime_ns"]
            report["action"] = "gate-existing"
            report["drift"] = True
            report["kept"].append(rec_data)
            report["ttf"] = count_ttf(os.path.join(data_dst, "Data"))
            _write_seed_manifest(mpath, desktop_id, recorded.get("pairs") or [],
                                 baseline=False)
            return report
        else:
            # verify=True ⇒ 显式审计：全量 aggregate，漂移则重记新 hash 后放行
            agg = tree_manifest(data_dst)
            same = agg["aggregate"] == rec_data.get("aggregate")
            rec_data["aggregate"] = agg["aggregate"]
            rec_data["count"] = agg["count"]
            rec_data["bytes"] = agg["bytes"]
            rec_data["quick"] = quick
            rec_data["top_mtime_ns"] = (quick or {}).get("top_mtime_ns", 0)
            report["action"] = "verified" if same else "verified-drift-reauthored"
            if not same:
                report["stale"] = {"recorded": (recorded.get("pairs") or [{}])[0]
                                   .get("aggregate"), "now": agg["aggregate"],
                                   "reauthored": True}
            report["kept"].append(rec_data)
            report["ttf"] = count_ttf(os.path.join(data_dst, "Data"))
            _write_seed_manifest(mpath, desktop_id, recorded.get("pairs") or [],
                                 baseline=False)
            return report
    for src, dst in pairs:
        if not os.path.isdir(src):
            raise RuntimeError("VCMI 授权源不存在: %s（不静默跳过）" % src)
        if os.path.isdir(dst) and os.listdir(dst):
            m = tree_manifest(dst)
            raise RuntimeError("目标副本已存在且非空但无校验记录/记录不符（count=%s aggregate=%s）"
                               "⇒ 拒绝猜测，请人工确认: %s" % (m["count"], m["aggregate"][:16], dst))
        if os.path.isdir(dst):
            _empty_dir_to_trash(dst, desktop_id)
        info = _copy_tree_verified(src, dst, desktop_id)
        q = quick_fingerprint(dst)
        info.update({"count_top_mtime_ns": q["top_mtime_ns"],
                     "top_mtime_ns": q["top_mtime_ns"], "quick": q})
        report["copied"].append(info)
    os.chmod(home, 0o700)
    os.chmod(os.path.join(home, ".local"), 0o700)
    os.chmod(os.path.join(home, ".local", "share"), 0o700)
    os.chmod(os.path.join(home, ".config"), 0o700)
    report["action"] = "seeded"
    report["ttf"] = count_ttf(os.path.join(home, ".local", "share", "vcmi", "Data"))
    pairs_out = report["copied"]
    _write_seed_manifest(mpath, desktop_id, pairs_out, baseline=True)
    return report


def ensure_vcmi_windowed_settings(desktop_id: str) -> dict:
    """本桌私有 VCMI HOME 的 settings.json 写 video.fullscreen=false（窗口模式）。

    成因：源 settings.json 里没有 video.fullscreen 键 ⇒ 引擎按 schema 默认 true 进
    全屏（实测：主窗 _NET_FRAME_EXTENTS=0,0,0,0 且铺满整桌，本次远端桌面为 1600x900，
    正证 = xprop -root _NET_DESKTOP_GEOMETRY = 1600, 900）。键名与默认值
    实证 = /usr/share/vcmi/config/schemas/settings.json:251-257（video.fullscreen
    boolean default true），不是虚构键。K 路线 = 浏览器里一块桌面 ⇒ 必须 windowed
    带标题栏，用户才能拖动 / 看到 WM 标题。

    约束：只写**本桌私有副本**（desktops/<id>/apps/vcmi/home/.config/vcmi），绝不碰
    真实 ~/.config/vcmi；launch 路径调用（单例守卫已确认 app 未活 ⇒ 不会被运行时覆写）；
    JSON 深合并只动 video.fullscreen，其余键（language/lastMap/font 等）逐字保留。
    """
    path = os.path.join(app_home(desktop_id, "vcmi"), ".config", "vcmi", "settings.json")
    cfg: dict = {}
    action = "created"
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError("settings.json 不是 JSON object")
            cfg, action = loaded, "merged"
        except (OSError, ValueError) as exc:
            _move_to_trash(path, desktop_id)
            action = "rebuilt-" + type(exc).__name__
    video = cfg.get("video")
    if not isinstance(video, dict):
        video = {}
    changed = video.get("fullscreen") is not False
    video["fullscreen"] = False
    cfg["video"] = video
    if changed or action != "merged":
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    return {"ok": True, "action": action, "changed": changed, "path": path}

def _write_seed_manifest(mpath: str, desktop_id: str, pairs: list, baseline: bool) -> None:
    """写 seed manifest。baseline=False ⇒ 复用已有 source_baseline（幂等，不重算 430MB）。"""
    os.makedirs(os.path.dirname(mpath), exist_ok=True)
    old: dict = {}
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}
    payload = {"desktop": desktop_id, "pairs": pairs,
               "seeded_at": old.get("seeded_at")
                            or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "source_baseline": old.get("source_baseline")
                                  if not baseline else baseline_hashes()}
    tmp = mpath + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    os.replace(tmp, mpath)


# ---------- 环境 / argv ----------

def app_env(desktop_id: str, app_id: str) -> dict:
    spec = config.spec(desktop_id)
    home = app_home(desktop_id, app_id)
    runtime = app_runtime(desktop_id, app_id)
    os.makedirs(runtime, mode=0o700, exist_ok=True)
    os.makedirs(os.path.join(home, ".config"), mode=0o700, exist_ok=True)
    os.makedirs(os.path.join(home, ".local", "share"), mode=0o700, exist_ok=True)
    os.chmod(home, 0o700)
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": home,
        "USER": "aigc",
        "LOGNAME": "aigc",
        "SHELL": "/bin/bash",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "TZ": "Etc/UTC",
        "DISPLAY": spec.client_display,
        "XDG_RUNTIME_DIR": runtime,
        "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
        "XDG_CACHE_HOME": os.path.join(home, ".cache"),
    }
    xa = appshare.path(desktop_id, appshare.XAUTH_REL)
    if os.path.exists(xa):
        env["XAUTHORITY"] = xa
    native = appshare.path(desktop_id, appshare.NATIVE_REL)
    if os.path.exists(native):
        env["PULSE_SERVER"] = "unix:" + native
    cookie = appshare.path(desktop_id, appshare.PULSE_COOKIE_REL)
    if os.path.exists(cookie):
        env["PULSE_COOKIE"] = cookie
    return env


def cdp_dir(desktop_id: str, app_id: str) -> str:
    return os.path.join(config.state_dir(desktop_id), "cdp-" + app_id)


def cdp_portfile(desktop_id: str) -> str:
    return os.path.join(chrome_profile(desktop_id), "DevToolsActivePort")


def clear_stale_cdp_portfile(desktop_id: str, app_id: str) -> str | None:
    """launch 前把 profile 下遗留的 DevToolsActivePort 移入 trash（P2-2）。

    该文件跨 session 持久（chrome 崩溃/SIGKILL 时不清理）⇒ 不清就轮询到上一轮端口，
    写进 endpoint.txt 判 ok=true。profile 归本桌面私有，移入 trash 不 rm。
    """
    f = cdp_portfile(desktop_id)
    if not os.path.exists(f):
        return None
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest = os.path.join(config.TRASH_ROOT, "wt-kasm-cdpport-%s-%s-%s"
                        % (desktop_id, app_id, stamp))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(f, dest)
    return dest


def _validate_home_url(url):
    """--url entry validation (review A7, fail closed): http:// or https:// only.

    url reaches chrome as ONE argv element (no shell => no command injection);
    the real surface is FLAG injection: a value starting with "-" parses as a
    chrome flag (--remote-debugging-port / --load-extension / ...). The http(s)
    scheme whitelist excludes "-" leads and every non-http scheme
    (data:/file:/javascript:) => one prefix test closes it. The check lives at
    the app_argv consumer, the point where BOTH the CLI and the daemon
    control-socket channel converge; a refusal raises ValueError and the
    caller maps it to an error reply. None = no url passed: passes through.
    """
    if url is None:
        return None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ValueError("--url 只允许 http:// 或 https:// 绝对 URL（拒绝 '-' 旗标注入与"
                        " data:/file:/javascript: 等旁路方案）: %r" % (url,))
    return url


def app_argv(desktop_id: str, app_id: str, cdp: bool = False,
             home_url: str | None = None) -> list[str]:
    """固定 argv 白名单。CDP 仅 --test-cdp（registered chrome 桌面 + chrome app）。"""
    apps = config.APP_IDS_BY_DESKTOP.get(desktop_id, ())
    if app_id not in apps:
        raise KeyError("desktop %s 不接受 app %r（白名单 %s）" % (desktop_id, app_id, apps))
    _validate_home_url(home_url)
    if app_id == "chrome":
        prof = chrome_profile(desktop_id)
        os.makedirs(prof, mode=0o700, exist_ok=True)
        argv = [config.CHROME_BIN,
                "--user-data-dir=" + prof,
                "--class=" + CHROME_CLASS,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                "--disable-features=Translate",
                "--window-position=40,40",
                "--window-size=1280,780"]
        if cdp:
            if not desktop_id.startswith("chrome-"):
                raise ValueError("--test-cdp 只允许 registered chrome-* 桌面")
            argv = ([config.CHROME_BIN,
                     "--user-data-dir=" + prof,
                     "--class=" + CHROME_CLASS,
                     "--no-first-run", "--no-default-browser-check",
                     "--remote-debugging-address=127.0.0.1",
                     "--remote-debugging-port=0",
                     # CDP 分支同样带几何旗标（root 2026-11-13）：--test-cdp 重启
                     # 不得把窗口退回最小默认尺寸，与常规分支逐字一致
                     "--window-position=40,40",
                     "--window-size=1280,780",
                     home_url or "about:blank"])
        else:
            argv += [home_url or "about:blank"]
        return argv
    if app_id == config.APP_EASYCONNECT:
        # 固定 argv：只有"白名单二进制 + 两个固定旗标"，无 url / env / 追加参数通道。
        if desktop_id != config.EASYCONNECT_DESKTOP_ID:
            raise KeyError("app %r 只注册在桌面 %s，桌面 %s 拒绝"
                           % (app_id, config.EASYCONNECT_DESKTOP_ID, desktop_id))
        return [config.EASYCONNECT_BIN] + list(config.EASYCONNECT_ARGS)
    return [config.VCMI_BIN]


def app_window_matchers(app_id: str) -> dict:
    if app_id == "chrome":
        return {"class": CHROME_CLASS, "name": "Google Chrome"}
    if app_id == config.APP_EASYCONNECT:
        return {"class": EASYCONNECT_CLASS, "name": EASYCONNECT_TITLE}
    return {"class": VCMI_CLASS, "name": VCMI_TITLE}


def xcli_env(desktop_id: str) -> dict:
    return appshare.xcli_env(desktop_id)


def window_pid(desktop_id: str, window_id: str) -> int | None:
    env = xcli_env(desktop_id)
    rp = subprocess.run(["xdotool", "getwindowpid", str(window_id)], capture_output=True,
                        text=True, env=env, timeout=10)
    if rp.returncode == 0 and rp.stdout.strip().isdigit():
        return int(rp.stdout.strip())
    return None


def pid_owned_by(pid: int | None, rec: dict) -> bool:
    """窗口 PID 归属回读（F）：必须 == 台账 pid，或 ∈ 台账进程组成员。

    只看 class/name 命中会捡到**同桌面别人的**同名窗口（Chrome 多实例 / 前次 Xsession
    残留 ⇒ 同 class 同 title），登记后 focus/stop 就会打到别人 ⇒ 未命中当作未出现。
    chrome 主进程是 dbus-run-session 的 fork 子进程（不 setsid）⇒ 同一进程组。
    """
    if not pid:
        return False
    own = rec.get("pid")
    if not isinstance(own, int) or own <= 0:
        return False
    if int(pid) == own:
        return True
    pgid = rec.get("pgid")
    if not isinstance(pgid, int) or pgid <= 0:
        return False
    return int(pid) in process.pgrp_members(pgid)


def find_window(desktop_id: str, app_id: str, timeout: float = 25.0,
                owner_rec: dict | None = None) -> dict:
    """按 class/name 找窗口，**并回读 WM_PID 校验归属**。

    owner_rec 给出时：PID 不属台账进程/进程组 ⇒ 视为未命中，继续轮询，最终 FAIL。
    """
    m = app_window_matchers(app_id)
    env = xcli_env(desktop_id)
    deadline = time.time() + timeout
    last = "无"
    while time.time() < deadline:
        # root 2026-11-13 实机证实：xdotool search 的两个 matcharg 穿插
        # (--class X --name Y) ⇒ rc1 "Unknown command: --name"（--name 被当成
        # 搜索根正则）⇒ 旧写法永远搜不到窗。只按 class 搜 + --onlyvisible
        # （排除 Chrome 未映射辅助窗），标题只做逐窗回读不参与过滤。
        args = ["xdotool", "search", "--onlyvisible", "--class", m["class"]]
        try:
            r = subprocess.run(args, capture_output=True, text=True, env=env, timeout=15)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "reason": "xdotool 失败: %r" % (exc,)}
        ids = [x for x in r.stdout.split() if x]
        for wid in ids:
            info = {"ok": True, "window_id": wid, "pid": None, "title": None, "class": None}
            info["pid"] = window_pid(desktop_id, wid)
            if owner_rec is not None and not pid_owned_by(info["pid"], owner_rec):
                last = ("窗口 %s PID=%s 不属台账 pid=%s/pgid=%s ⇒ 判为他人同名窗口"
                        % (wid, info["pid"], owner_rec.get("pid"), owner_rec.get("pgid")))
                info["ok"] = False
                continue
            rt = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True,
                                text=True, env=env, timeout=10)
            if rt.returncode == 0:
                info["title"] = rt.stdout.strip()
            rc = subprocess.run(["xprop", "-id", wid, "WM_CLASS"], capture_output=True,
                                text=True, env=env, timeout=10)
            if rc.returncode == 0:
                info["class"] = rc.stdout.strip().split("=")[-1].strip()
            return info
        if not ids:
            last = (r.stderr or "未命中").strip()[:120] or "未命中"
        time.sleep(0.5)
    return {"ok": False, "reason": "窗口未出现（或归属未确认）: " + last}


def _cdp_alive(port: int, timeout: float = 2.0) -> bool:
    """CDP 探活 = GET /json/version 返回 JSON（证明端口上真有本轮 DevTools 服务）。"""
    import urllib.request
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/json/version" % int(port),
                                     headers={"User-Agent": "wt-kasm-manager"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if int(resp.status) != 200:
                return False
            body = resp.read(4096).decode("utf-8", "replace")
    except Exception:
        return False
    return "webSocketDebuggerUrl" in body or "Browser" in body


def read_cdp_endpoint(desktop_id: str, app_id: str, timeout: float = 25.0,
                      spawn_time: float | None = None) -> dict:
    """--remote-debugging-port=0 ⇒ 从 profile/DevToolsActivePort 回取实际端口。

    P2-2 双保险：(1) 要求文件 mtime >= spawn_time（本轮写入）；
    (2) 对端口做 GET /json/version 探活，确认属本轮进程。二者不满足 ⇒ 超时 FAIL，
    绝不把上一轮残留端口当 ok=true 交回调用方。
    """
    f = cdp_portfile(desktop_id)
    deadline = time.time() + timeout
    last = "文件未出现"
    while time.time() < deadline:
        if os.path.exists(f):
            try:
                st = os.stat(f)
                if spawn_time is not None and st.st_mtime + 1e-6 < spawn_time:
                    last = "文件陈旧（mtime 早于 spawn 时刻）"
                else:
                    with open(f, "r", encoding="utf-8") as fh:
                        lines = [l.strip() for l in fh if l.strip()]
                    if lines and lines[0].isdigit():
                        port = int(lines[0])
                        if _cdp_alive(port):
                            ws_path = lines[1] if len(lines) > 1 else ""
                            url = "http://127.0.0.1:%d" % port
                            d = cdp_dir(desktop_id, app_id)
                            os.makedirs(d, mode=0o700, exist_ok=True)
                            with open(os.path.join(d, "endpoint.txt"), "w",
                                      encoding="utf-8") as fh:
                                fh.write(url + "\n" + ws_path + "\n")
                            return {"ok": True, "port": port, "ws_path": ws_path,
                                    "url": url, "fresh": True}
                        last = "端口 %d 探活失败（/json/version 无响应）" % port
            except OSError:
                pass
        time.sleep(0.4)
    return {"ok": False, "reason": "DevToolsActivePort 读取失败: %s（%s）" % (f, last)}


# ---------- focus：台账 window_id 直核（KasmVNC 最小化恢复；root 2026-11-13 裁决） ----------
#
# 旧实现的缺陷（root 实测 doc/reports/kasmvnc-root012-20261113/clean-minimized.json
# + double-focus.json）：find_window 走 `xdotool search --onlyvisible`，只看**已映射**
# 窗口；最小化 = WM_STATE Iconic + Map State IsUnMapped ⇒ 永远搜不到 ⇒ 桌面图标双击
# （launch→focus）与 CLI focus 对已最小化的 app 一律「未命中」。
# 新规约（只改 focus；launch 用的 find_window 默认可见语义逐字不动）：
#   1. 只认**台账登记的 window_id**（launch 时已做 class + PID 归属核验并登记），
#      focus 现场再核四件事：台账身份匹配、_NET_WM_PID 归属台账 pid/pgid、
#      WM_STATE 合法存在、WM_CLASS 与 app 相符；任一不成立 ⇒ 拒绝且**不发任何输入命令**。
#   2. Iconic / 未映射 ⇒ 先 `xdotool windowmap`，再 windowactivate --sync + windowraise，
#      每步查 rc。
#   3. 回读三件套 = root _NET_ACTIVE_WINDOW == wid、WM_STATE Normal、xwininfo
#      Map State IsViewable 全部成立才 ok=True（并写 focused_at/window_id，
#      pid/starttime 逐字不动）；否则 ok=False 带实测值。
#   4. **不回退通用搜索**（同桌面同名多实例 / Chrome 10x10 辅助窗会把焦点打到别人窗口）。


def _wid_norm(value) -> int | None:
    """窗口号归一：'25165827' / '0x1800003' / 25165827 ⇒ int。

    不可解析 / 0 / 负数 ⇒ None。0 是 X11 Window 常量 None（无激活窗时 xprop 输出
    "window id # 0x0"），绝不能当合法窗口号参与比较。
    """
    try:
        n = int(str(value).strip(), 0)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _xprop(desktop_id: str, args: list[str]) -> str:
    """xprop 读属性；rc!=0 / 超时 / "not found" ⇒ 空串（读不到就是读不到，不猜）。"""
    env = xcli_env(desktop_id)
    try:
        r = subprocess.run(["xprop"] + list(args), capture_output=True, text=True,
                           env=env, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if r.returncode != 0:
        return ""
    out = (r.stdout or "").strip()
    return "" if "not found" in out.lower() else out


def wm_state(desktop_id: str, window_id: str) -> str | None:
    """WM_STATE 窗口态 = Normal / Iconic / Withdrawn；无该属性（辅助窗/已销毁）⇒ None。"""
    out = _xprop(desktop_id, ["-id", str(window_id), "WM_STATE"]).lower()
    for kind in ("normal", "iconic", "withdrawn"):
        if "window state: " + kind in out:
            return kind.capitalize()
    return None


def map_state(desktop_id: str, window_id: str) -> str | None:
    """xwininfo Map State = IsViewable / IsUnMapped；读不到 ⇒ None。"""
    env = xcli_env(desktop_id)
    try:
        r = subprocess.run(["xwininfo", "-id", str(window_id)], capture_output=True,
                           text=True, env=env, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    low = (r.stdout or "").lower()
    if "map state: isviewable" in low:
        return "IsViewable"
    if "map state: isunmapped" in low:
        return "IsUnMapped"
    return None


def active_window(desktop_id: str) -> int | None:
    """root 的 _NET_ACTIVE_WINDOW（EWMH 激活窗）；读不到 / 无激活窗（0x0）⇒ None。

    xprop 真实行格式是 "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1400010"
    （**不是** "= 0x…"）⇒ 先按 "window id #" 解析，再兼容 "= / :" 写法；
    值为 0x0（X11 None）⇒ None。
    """
    out = _xprop(desktop_id, ["-root", "_NET_ACTIVE_WINDOW"])
    for pat in (r"window id\s*#\s*(0[xX][0-9a-fA-F]+|\d+)",
                r"[=:]\s*(0[xX][0-9a-fA-F]+|\d+)"):
        m = re.search(pat, out)
        if m:
            return _wid_norm(m.group(1))
    return None


def validate_ledger_window(desktop_id: str, app_id: str, rec: dict | None) -> dict:
    """台账 window_id 现场核验 = focus 的唯一窗口来源（不做通用搜索）。"""
    if not rec:
        return {"ok": False, "reason": "无台账（app 未运行）⇒ focus 拒绝"}
    if not process.proc_exists(int(rec.get("pid") or 0)) or not process.matches_record(rec):
        return {"ok": False, "reason": "台账进程身份不匹配（已退出或 PID 复用）⇒ focus 拒绝"}
    wn = _wid_norm(rec.get("window_id"))
    if wn is None:
        return {"ok": False, "reason": "台账无 window_id（launch 未确认窗口）⇒ focus 拒绝"}
    wid = str(wn)
    pid = window_pid(desktop_id, wid)
    if not pid_owned_by(pid, rec):
        return {"ok": False, "reason": "窗口 %s PID=%s 不属台账 pid=%s/pgid=%s ⇒ focus 拒绝"
                           % (wid, pid, rec.get("pid"), rec.get("pgid"))}
    state = wm_state(desktop_id, wid)
    if state is None:
        return {"ok": False, "reason": "窗口 %s 无合法 WM_STATE（已销毁或非管理窗）⇒ focus 拒绝" % wid}
    m = app_window_matchers(app_id)
    cls = _xprop(desktop_id, ["-id", wid, "WM_CLASS"])
    if m["class"].lower() not in cls.lower():
        return {"ok": False, "reason": "窗口 %s WM_CLASS=%s 与 app %s 不符 ⇒ focus 拒绝"
                           % (wid, cls[:120] or "空", app_id)}
    return {"ok": True, "window_id": wid, "wm_state": state, "pid": pid, "class": cls}


def focus(desktop_id: str, app_id: str, timeout: float = 4.0) -> dict:
    pf = app_pidfile(desktop_id, app_id)
    rec = process.read_ledger(pf)
    v = validate_ledger_window(desktop_id, app_id, rec)
    if not v["ok"]:
        return {"ok": False, "reason": v["reason"]}
    wid = v["window_id"]
    wn = int(wid)
    env = xcli_env(desktop_id)
    steps: list[list] = []

    def run_input(argv: list[str]) -> int:
        try:
            r = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=15)
        except (OSError, subprocess.TimeoutExpired) as exc:
            steps.append([argv[1], "exc", repr(exc)[:120]])
            return 255
        steps.append([argv[1], r.returncode, (r.stderr or "").strip()[:120]])
        return r.returncode

    ms = map_state(desktop_id, wid)
    if v["wm_state"] != "Normal" or ms != "IsViewable":
        if run_input(["xdotool", "windowmap", wid]) != 0:
            return {"ok": False, "reason": "windowmap 失败 ⇒ 最小化未恢复", "window_id": wid,
                    "wm_state": v["wm_state"], "map_state": ms, "steps": steps}
    if run_input(["xdotool", "windowactivate", "--sync", wid]) != 0:
        return {"ok": False, "reason": "windowactivate 失败", "window_id": wid, "steps": steps}
    if run_input(["xdotool", "windowraise", wid]) != 0:
        return {"ok": False, "reason": "windowraise 失败", "window_id": wid, "steps": steps}
    deadline = time.time() + max(0.5, float(timeout))
    state = ms = None
    act = None
    while True:
        state = wm_state(desktop_id, wid)
        ms = map_state(desktop_id, wid)
        act = active_window(desktop_id)
        if state == "Normal" and ms == "IsViewable" and act == wn:
            break
        if time.time() >= deadline:
            return {"ok": False,
                    "reason": "激活回读未确认（wm_state=%s map_state=%s active=%s）"
                              % (state, ms, act),
                    "window_id": wid, "steps": steps,
                    "readback": {"wm_state": state, "map_state": ms, "active_window": act}}
        time.sleep(0.2)
    fresh = process.read_ledger(pf) or rec
    fresh["focused_at"] = int(time.time())
    fresh["window_id"] = wid
    process.write_ledger(pf, **fresh)
    return {"ok": True, "window_id": wid, "pid": v["pid"], "title": fresh.get("title"),
            "class": v["class"], "wm_state": state, "map_state": ms,
            "active_window": act, "steps": steps}


def _generation_guard(desktop_id: str, app_id: str) -> dict:
    pf = app_pidfile(desktop_id, app_id)
    rec = process.read_ledger(pf)
    if not rec:
        return {"ok": True, "action": "none"}
    gen_now = appshare.read_generation(desktop_id)
    gen_rec = rec.get("generation")
    if gen_now is None:
        # P1-2 failclosed：镜像侧 generation 未产出 = Xsession 状态未知，
        # 放行会挂到换代前的旧 session（与注释口径一致）。
        return {"ok": False, "action": "failclosed",
                "reason": "generation 未就绪（appshare/generation 缺失）⇒ 拒绝 launch"}
    if not gen_rec:
        # 台账没记 generation（旧版本登记）⇒ 无法判定换代，同样拒绝复用旧台账。
        return {"ok": False, "action": "failclosed",
                "reason": "台账无 generation 字段 ⇒ 无法核对换代，failclosed（先 stop 该 app）"}
    if gen_now == gen_rec:
        return {"ok": True, "action": "none", "generation": gen_now}
    if process.proc_exists(int(rec.get("pid") or 0)):
        if not process.matches_record(rec):
            return {"ok": False, "action": "failclosed",
                    "reason": "换代且旧 app PID 身份不匹配（PID 复用?），拒绝多开"}
        ok, why = process.stop_ledger(pf, sig=15, timeout=12)
        if not ok:
            return {"ok": False, "action": "failclosed",
                    "reason": "换代后旧 app 无法确认退出（%s）⇒ 拒绝同 profile 再开" % why}
        return {"ok": True, "action": "reaped", "generation": gen_now}
    return {"ok": True, "action": "gone", "generation": gen_now}


def _single_guard(desktop_id: str, app_id: str) -> dict:
    pf = app_pidfile(desktop_id, app_id)
    live = live_app(desktop_id, app_id)
    if live:
        return {"ok": True, "action": "focus", "pid": live["pid"]}
    stale = process.read_ledger(pf)
    if stale and process.proc_exists(int(stale.get("pid") or 0)) and not process.matches_record(stale):
        return {"ok": False, "action": "failclosed",
                "reason": "台账 PID 存在但身份不匹配（PID 复用保护）: %s"
                          % json.dumps(process.identity(int(stale["pid"])), default=str)}
    lock = os.path.join(chrome_profile(desktop_id), "SingletonLock") if app_id == "chrome" else None
    if lock and os.path.islink(lock):
        moved = clear_stale_singleton_lock(desktop_id)
        if not moved:
            return {"ok": False, "action": "failclosed",
                    "reason": "Chrome profile 锁存在且锁主未确认死亡 ⇒ 不自动删锁，需人工确认: %s -> %s"
                            % (lock, os.readlink(lock) if os.path.islink(lock) else "?")}
        return {"ok": True, "action": "launch", "stale_singleton_lock": moved}
    return {"ok": True, "action": "launch"}


def clear_stale_singleton_lock(desktop_id: str) -> dict | None:
    """回收**已确认死亡**的 Chrome profile 单例锁（移入 trash，零 rm）。

    为什么需要：app stop 走 killpg（SIGTERM）⇒ Chrome 来不及自清理 SingletonLock，
    于是下一次 app start 会被单例守卫 failclosed 挡住 ⇒ stop/start 循环断裂。
    判据全部成立才回收，任一不成立 ⇒ 原样返回 None，交给守卫 failclosed：
      1) 台账无活进程（调用方已保证：守卫只在 live_app 为空时进入 launch 分支）；
      2) 锁必须是 symlink（Chrome 写 hostname-pid 软链），非软链 = 形态异常 ⇒ 不碰；
      3) 软链目标必须解析出数字 PID，且该 PID **不存在**（kill -0 ESRCH）⇒ 死锁。
    PID 活着 ⇒ 返回 None（绝不删别人的锁），守卫随后 failclosed 报人工确认。
    """
    lock = os.path.join(chrome_profile(desktop_id), "SingletonLock")
    if not os.path.islink(lock):
        return None
    try:
        target = os.readlink(lock)
    except OSError:
        return None
    pid_s = target.rsplit("-", 1)[-1]
    if not pid_s.isdigit():
        return None
    pid = int(pid_s)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass                      # ESRCH ⇒ 锁主已死，可回收
    except PermissionError:
        return None               # 进程存在（他人所有）⇒ 不碰
    else:
        return None               # 锁主活着 ⇒ 不碰，守卫 failclosed
    moved = {"lock": lock, "target": target, "pid": pid}
    _move_to_trash(lock, desktop_id)
    return moved


def recover_window_into_ledger(desktop_id: str, app_id: str, timeout: float = 6.0) -> dict:
    """台账进程已活但**没有 window_id**（首次 spawn 后窗口超时的遗留态）⇒ 现场补登记。

    P1（二次点击假成功）的收口点：这类台账走 focus 必然被
    `validate_ledger_window` 拒（"台账无 window_id"），旧代码顶层仍回 ok=true
    ⇒ 桌面图标第二次点击看起来成功、实际什么都没发生。

    判据与 launch 首次登记**同源**：`find_window(owner_rec=台账)` ⇒ class 命中 +
    `_NET_WM_PID` ∈ 台账 pid/pgid，因此不会把同桌面他人同名窗登记成自己的。
    只补写 window 相关字段（pid/comm/exe/starttime/pgid/label/generation 逐字不动），
    不 spawn、不发任何信号 ⇒ 补登记失败也不 kill 用户进程，交顶层判 ok=false。
    """
    pf = app_pidfile(desktop_id, app_id)
    live = process.live_ledger(pf)          # 权威复核：进程在且身份匹配才登记
    if live is None:
        return {"ok": False,
                "reason": "台账进程已退出/身份不匹配 ⇒ 不补登记 window_id（不 kill）"}
    win = find_window(desktop_id, app_id, timeout=timeout, owner_rec=live)
    if not win.get("ok"):
        return {"ok": False,
                "reason": "窗口归属未确认 ⇒ 不补登记 window_id: " + str(win.get("reason"))}
    fresh = process.read_ledger(pf) or dict(live)
    fresh.update({"window_id": win["window_id"], "window_pid": win["pid"],
                  "title": win["title"], "cls": win["class"],
                  "window_recovered_at": int(time.time())})
    process.write_ledger(pf, **fresh)
    return {"ok": True, "window_id": win["window_id"], "pid": win["pid"],
            "title": win["title"], "class": win["class"]}


def _ledger_lacks_window_id(desktop_id: str, app_id: str) -> bool:
    """台账可读但 window_id 缺失/非法（None、\"0\"、垃圾串）⇒ True。

    只用来区分两类 focus 失败：
      - 「无 window_id ⇒ 必然被拒」= 值得按 launch 同源判据补登记一次；
      - 其它失败（PID 归属 / WM_CLASS / 激活回读）⇒ 不补登记、不重试、不 kill。
    台账不存在 ⇒ False（`_single_guard` 已判过活体，属竞态，交调用方下次点击）。
    """
    rec = process.read_ledger(app_pidfile(desktop_id, app_id))
    if rec is None:
        return False
    return _wid_norm(rec.get("window_id")) is None


def launcher_identity(app_id: str, argv: list[str]) -> tuple[list[str], list[str]]:
    """启动器链的 comm / exe 白名单（现场身份 = 最外层启动器）。

    comm 被内核截断到 15 字符 ⇒ "dbus-run-session" 记为 "dbus-run-sessio"。
    白名单同时含最终目标（chrome / vcmiclient），因为 chrome 主进程是 fork 子进程，
    台账 pid 现场读到的就是最外层启动器；归属证明另由私有 env WT_KASM_MARK 承担。
    """
    if app_id == "chrome":
        return (["dbus-run-sessio", "chrome"], [DBUS_RUN_SESSION, config.CHROME_BIN])
    return ([os.path.basename(argv[0])[:15]], [argv[0]])


def launch(desktop_id: str, app_id: str, cdp: bool = False, url: str | None = None,
           focus_after: bool = True) -> dict:
    apps = config.APP_IDS_BY_DESKTOP.get(desktop_id, ())
    if app_id not in apps:
        return {"ok": False, "reason": "desktop %s 白名单 %s 不含 app %r（无任意 argv）"
                                       % (desktop_id, list(apps), app_id)}
    if cdp and not desktop_id.startswith("chrome-"):
        return {"ok": False, "reason": "--test-cdp 只允许 registered chrome-* 桌面"}
    if app_id == config.APP_EASYCONNECT and not os.path.isfile(config.EASYCONNECT_BIN):
        # 宿主没装 EasyConnect ⇒ failclosed 直说，不进 relay / spawn 链路（不产生脏台账）。
        return {"ok": False, "failclosed": True,
                "reason": "EasyConnect 二进制不存在: %s（宿主未安装 ⇒ 拒绝 launch）"
                          % config.EASYCONNECT_BIN}
    guard = _generation_guard(desktop_id, app_id)
    if not guard["ok"]:
        return {"ok": False, "reason": guard["reason"], "failclosed": True}
    single = _single_guard(desktop_id, app_id)
    if not single["ok"]:
        return {"ok": False, "reason": single["reason"], "failclosed": True}
    if single["action"] == "focus":
        if not focus_after:
            # 调用方明确不要焦点（内部预热/自检路径）⇒ 维持既有 ok=true 语义。
            return {"ok": True, "action": "focus", "pid": single["pid"],
                    "focus": {"ok": True, "skipped": True},
                    "reason": "app 已活 ⇒ 未请求焦点（不多开）"}
        f = focus(desktop_id, app_id)
        if f.get("ok") is False and _ledger_lacks_window_id(desktop_id, app_id):
            # P1 收口：台账无 window_id（首次 spawn 后窗口超时的遗留态）⇒ focus 必拒。
            # 按 launch 首次登记的**同源**判据现场补登记一次，登记成功才重试 focus。
            recovered = recover_window_into_ledger(desktop_id, app_id)
            f = focus(desktop_id, app_id) if recovered["ok"] else {
                "ok": False,
                "reason": "窗口补登记失败: " + str(recovered.get("reason"))}
        if f.get("ok") is False:
            # 顶层判据与焦点一致：焦点未确认 ⇒ ok=false（不再假成功）。
            # 既不 kill 用户进程也不多开；调用方（图标 / CLI / status）自行决定下一步。
            return {"ok": False, "action": "focus", "pid": single["pid"], "focus": f,
                    "reason": "app 已活但焦点未恢复（不多开、不 kill 用户进程）: "
                              + str(f.get("reason"))}
        return {"ok": True, "action": "focus", "pid": single["pid"], "focus": f,
                "reason": "app 已活 ⇒ 只恢复焦点，不多开"}
    relay = net.ensure_relay(config.spec(desktop_id))
    if not relay["ok"]:
        return {"ok": False, "reason": "X relay 不可用: " + str(relay.get("reason"))}
    route = appshare.verify_routing(desktop_id)
    if not route["ok"]:
        return {"ok": False, "reason": "X 归属核对未通过: " + str(route.get("reason")), "route": route}
    if app_id == "vcmi":
        vcmi_home_seed(desktop_id)
    env = app_env(desktop_id, app_id)
    argv = app_argv(desktop_id, app_id, cdp=cdp, home_url=url)
    # 不再套 "env -i k=v ..." wrapper：env 白名单直接作为子环境传给 execvpe（一次 exec）。
    # wrapper 的害处：CLOEXEC 状态管道只确认**首层** exec（env 本身），chrome 起没起来
    # 完全没确认 ⇒ 台账 comm/exe 记成 /usr/bin/env，四元组核验对不上真实目标，
    # 且 killpg 归属证明失效（root 抢先审 B 项）。
    label = "wt-kasm-app-%s-%s" % (desktop_id, app_id)
    if app_id == "chrome":
        argv = [DBUS_RUN_SESSION, "--"] + argv
    comm_accept, exe_accept = launcher_identity(app_id, argv)
    generation = appshare.read_generation(desktop_id)
    if not generation:
        return {"ok": False, "failclosed": True,
                "reason": "generation 未就绪 ⇒ 台账无法记代际，拒绝 launch"}
    spawn_time = time.time()
    moved = clear_stale_cdp_portfile(desktop_id, app_id) if (app_id == "chrome" and cdp) else None
    pf = app_pidfile(desktop_id, app_id)
    common = {"argv0": app_argv(desktop_id, app_id, cdp=cdp, home_url=url)[0],
              "profile": chrome_profile(desktop_id) if app_id == "chrome" else None,
              "generation": generation,
              "relay_port": config.spec(desktop_id).relay_port,
              "display": env["DISPLAY"],
              "log": app_log(desktop_id, app_id), "cdp": bool(cdp)}
    # 每桌私有 HOME/profile 的显示模式契约（launch 路径 ⇒ 单例守卫已确认 app 未活，
    # 写运行时配置文件安全；Chrome 运行中会覆写自己的 Preferences）。
    if app_id == "vcmi":
        common["windowed"] = ensure_vcmi_windowed_settings(desktop_id)
    elif app_id == "chrome":
        common["frame_pref"] = ensure_chrome_frame_pref(desktop_id)
    if moved:
        common["cdp_portfile_moved"] = moved
    if app_id == "chrome":
        rec = process.spawn_launcher(
            argv, "app-" + app_id, desktop_id, pf, label=label,
            comm_accept=comm_accept, exe_accept=exe_accept,
            cwd=app_home(desktop_id, app_id), env=env,
            log_path=app_log(desktop_id, app_id), extra=common)
    else:
        rec = process.spawn_registered(
            argv, "app-" + app_id, desktop_id, pf, label=label,
            cwd=app_home(desktop_id, app_id), env=env,
            log_path=app_log(desktop_id, app_id), extra=common)
    pid = rec["pid"]
    out = {"ok": True, "action": "launched", "pid": pid, "display": env["DISPLAY"],
           "log": app_log(desktop_id, app_id)}
    win = find_window(desktop_id, app_id, timeout=30.0, owner_rec=rec)
    out["window"] = win
    if win.get("ok"):
        rec.update({"window_id": win["window_id"], "window_pid": win["pid"],
                    "title": win["title"], "cls": win["class"]})
        process.write_ledger(pf, **rec)
    else:
        out["ok"] = False
        out["reason"] = "窗口归属未确认（不登记 window 字段、不 focus）: " + str(win.get("reason"))
    if cdp:
        out["cdp"] = read_cdp_endpoint(desktop_id, app_id, spawn_time=spawn_time)
        # CDP 外发 relay（config.WT_KASM_CDP_RELAY_PORT != 0 才启用）：在端口回读成功
        # **之后**起，转发目标 = 本轮读到的 loopback 随机端口。relay 起不来只降级
        # data.cdp.relay.ok=false + reason ⇒ app 本身仍算拉起成功（root 契约）。
        if out["cdp"].get("ok"):
            out["cdp"]["relay"] = net.ensure_cdp_relay(desktop_id, int(out["cdp"]["port"]))
        else:
            out["cdp"]["relay"] = net.cdp_relay_info(
                desktop_id, False, "CDP 端口未回读 ⇒ relay 未起")
    return out


def stop_app(desktop_id: str, app_id: str) -> dict:
    """停 app：先停该桌 CDP relay（Chrome 端口随进程消失，relay 留着就是死转发 +
    占着对外端口），再按台账精确 kill app 本体。"""
    if process.read_ledger(net.cdp_relay_pidfile(desktop_id)):
        cr_ok, cr_why = net.stop_cdp_relay(desktop_id)
        if not cr_ok:
            return {"ok": False, "desktop": desktop_id, "appId": app_id,
                    "reason": "CDP relay 未停干净（app 未动，先人工处理 relay）: " + str(cr_why),
                    "step": "cdp-relay"}
    ok, why = process.stop_ledger(app_pidfile(desktop_id, app_id))
    return {"ok": ok, "desktop": desktop_id, "appId": app_id, "reason": why}


def apps_status(desktop_id: str) -> list[dict]:
    out = []
    for app_id in config.APP_IDS_BY_DESKTOP.get(desktop_id, ()):
        rec = process.read_ledger(app_pidfile(desktop_id, app_id))
        out.append({"appId": app_id,
                    "pid": rec.get("pid") if rec else None,
                    "live": bool(rec) and process.matches_record(rec),
                    "window": rec.get("window_id") if rec else None,
                    "title": rec.get("title") if rec else None,
                    "profile": rec.get("profile") if rec else None,
                    "cdp": bool(rec.get("cdp")) if rec else False,
                    "generation": rec.get("generation") if rec else None})
    return out


def chrome_version() -> tuple[bool, str]:
    if not os.path.exists(config.CHROME_BIN):
        return (False, "chrome 二进制不存在: " + config.CHROME_BIN)
    r = subprocess.run([config.CHROME_BIN, "--version"], capture_output=True, text=True, timeout=25)
    got = (r.stdout or r.stderr).strip()
    expected = config.CHROME_EXPECTED_VERSION
    # 期望串自身形态不合法（空串 / 非点分数字）⇒ fail-closed 判 False，绝不恒真。
    # （空串在 `in` 判定下恒真 = 门禁被空值绕过；这里不依赖 config 侧的解析保证。）
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", expected) is None:
        return (False, got)
    # 精确 token 比对：期望版本左右邻字符不得是数字或点，否则
    # "157.0.8103.7" 会前缀匹配 "157.0.8103.78"、"157.0.8103.78" 会匹配
    # "157.0.8103.789" / "157.0.8103.78.1" / "1157.0.8103.78" = 假门禁。
    probe = re.compile(r"(?<![0-9.])" + re.escape(expected) + r"(?![0-9.])")
    # 退出码判定逐字保留原行为（原版不查 returncode，此处不新增约束）。
    return (probe.search(got) is not None, got)


def vcmi_version() -> tuple[bool, str]:
    if not os.path.exists(config.VCMI_BIN):
        return (False, "vcmiclient 不存在: " + config.VCMI_BIN)
    r = subprocess.run([config.VCMI_BIN, "--version"], capture_output=True, text=True, timeout=25)
    got = [l for l in (r.stdout + "\n" + r.stderr).strip().splitlines() if l.strip()]
    return (any("1.7.5" in l for l in got), " | ".join(got[:2]))

