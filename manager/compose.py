"""每 desktop 一份 Compose project / container（wt-kasm-<id>）。

固定契约（root 2026-11-13 任务卡）：
- compose 文件 = /data/app/webtop-kasmvnc/desktops/<id>/compose.yaml
- restart: unless-stopped，network bridge，无 GPU，shm_size 1g，tmpfs /tmp（**/run 不加 noexec**）
- 禁 docker.sock；控制 UDS 不挂容器；无 privileged
- binds：/tmp/.X11-unix ← <desk>/runtime/x11（容器内 Xvnc 以 DISPLAY=:1 建 socket ⇒
        宿主侧文件是 X1，relay 目标即此，不是 X310）
        /run/wt-kasm-app ← <desk>/runtime/appshare
        /config ← <desk>/config
- env：WTK_DESKTOP_ID / WTK_BASE_PATH=/desktop/<id>/ / WTK_WIDTH=1600 / WTK_HEIGHT=900 /
       WTK_FRAMERATE=30 / WTK_PUBLIC_ORIGIN=http://127.0.0.1:25320 / PUID / PGID（宿主 1000）
       逐桌面几何（root 契约 2026-11-14）：WTK_WIDTH / WTK_HEIGHT 取 spec 的逐桌面值
       （无显式值 = config.FRAME_WIDTH/HEIGHT，与旧行为逐字节一致）；
       WTK_ALLOW_RESIZE **只在 spec.resize_mode 显式时写**（auto=1 / fixed=0），
       旧 spec 一个键都不新增 ⇒ 已部署 desk 的 compose.yaml 不会因写回而 changed。
       + 基座 DISPLAY=:1、START_DOCKER=false
+ 镜像 = **config.image_for(spec)**（逐桌唯一入口，默认 ghcr.io/yorkane/kasmweb:latest；image worker
       构建，本模块只核 tag 存在，**绝不 build / pull**。0.1.1 / 0.1.0 冻结保留不覆盖 ⇒
       取证/记账一律按 docker inspect 的 Image ID）
       逐桌镜像（root 契约 2026-11-15）：WT_KASM_ADAPTIVE_IMAGE 显式设置时**只有
       resize_mode=auto 的桌**换用该镜像，legacy / fixed 桌继续用 config.IMAGE ⇒
       本模块的渲染、认领（ownership 的 image 双核）与 start 的镜像存在性预检**三处
       必须同源取镜像**，全部经 config.image_for(spec)，不得各自读 config.IMAGE。
       未设置该变量时 image_for 恒等于 config.IMAGE ⇒ 产物与现势逐字节相同。

project 名 = config.COMPOSE_PROJECT_PREFIX + id + config.PROJECT_SUFFIX（正式默认 -v012，
root 2026-11-13 裁决：生产 project = wt-kasm-<id>-v012）。container_name 恒为 wt-kasm-<id>
⇒ 换 project 只影响 compose 记账面，不影响路由/绑定/台账名。yaml 内 name: 与 CLI -p 同源，
两者永远一致（升级窗口的旧 project 容器由 recreate-012.py 留证，不会被本模块发现/删除）。
+       **绝不 build / pull**。0.1.0 冻结保留不覆盖 ⇒ 取证/记账一律按 docker inspect 的 Image ID）

root 抢先审修正（2026-11-13，运行前全部落实）：
1. start 不含 --remove-orphans（会删同 project 其它记录，违反零删除）。
2. 元数据读取一律 --no-trunc；containerId 必须 64 位 hex 且经 inspect 确认。
3. 同名 running 不即认领：label 归属 + image 双核，外来同名即拒绝。
4. 失败回收只对本 desk 精确 stop；零 docker rm / down -v，保留 source 目录。
"""
from __future__ import annotations

import json
import os
import subprocess

import yaml

from . import config


def render(spec: config.DesktopSpec) -> str:
    """逐桌渲染 compose.yaml。镜像**必须**取 config.image_for(spec)（逐桌唯一入口）。"""
    doc = {
        "name": spec.project,
        "services": {
            "desktop": {
                "image": config.image_for(spec),
                "container_name": spec.container,
                "hostname": spec.container,
                "restart": "unless-stopped",
                "network_mode": "bridge",
                "shm_size": config.SHM_SIZE,
                "ports": ["127.0.0.1:%d:%d" % (spec.port, config.CONTAINER_PORT)],
                "tmpfs": ["/tmp"],
                "environment": _environment(spec),
                "volumes": [
                    "%s:/tmp/.X11-unix" % _rel(spec, config.x11_dir(spec.id)),
                    "%s:/run/wt-kasm-app" % _rel(spec, config.appshare_dir(spec.id)),
                    "%s:/config" % _rel(spec, config.config_dir(spec.id)),
                ],
                "labels": {"wt-kasm.managed": "true",
                           "wt-kasm.route": config.PRODUCT,
                           "wt-kasm.desktop": spec.id},
            }
        },
    }
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)


def _rel(spec: config.DesktopSpec, abs_path: str) -> str:
    base = config.desktop_dir(spec.id)
    if not abs_path.startswith(base + "/"):
        raise ValueError("bind 源必须落在 desk 目录内: %s" % abs_path)
    return "./" + abs_path[len(base) + 1:]


def _environment(spec: config.DesktopSpec) -> dict:
    """env 单一构造点：键顺序 = 旧字面量顺序；WTK_ALLOW_RESIZE 只在显式几何时插入。

    旧 spec（frame_width/height/resize_mode 全 None）产物与改动前逐字节相同。
    """
    env = {
        "WTK_DESKTOP_ID": spec.id,
        "WTK_BASE_PATH": "/desktop/%s/" % spec.id,
        "WTK_WIDTH": str(spec.effective_frame_width),
        "WTK_HEIGHT": str(spec.effective_frame_height),
    }
    allow = spec.allow_resize
    if allow is not None:
        env["WTK_ALLOW_RESIZE"] = allow
    env["WTK_FRAMERATE"] = str(config.FRAME_RATE)
    env["WTK_PUBLIC_ORIGIN"] = config.PUBLIC_ORIGIN
    env["PUID"] = str(config.PUID)
    env["PGID"] = str(config.PGID)
    env["DISPLAY"] = config.CONTAINER_DISPLAY
    env["START_DOCKER"] = "false"
    return env


def write_compose(spec: config.DesktopSpec, force: bool = False) -> dict:
    d = config.desktop_dir(spec.id)
    os.makedirs(d, exist_ok=True)
    for sub in (config.x11_dir(spec.id), config.appshare_dir(spec.id), config.config_dir(spec.id)):
        os.makedirs(sub, mode=0o770, exist_ok=True)
    path = config.compose_file(spec.id)
    want = render(spec)
    changed = True
    if os.path.exists(path) and not force:
        with open(path, "r", encoding="utf-8") as f:
            changed = f.read() != want
    if changed:
        tmp = "%s.tmp-%d" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(want)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    return {"path": path, "changed": changed}


def image_present(image: str | None = None) -> tuple[bool, str]:
    """核镜像引用在位（只 inspect，绝不 build/pull）。**签名与默认语义逐字不变**。"""
    img = image or config.IMAGE
    r = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", img],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return (True, r.stdout.strip())
    return (False, (r.stderr or "").strip()[:200])


def image_present_for(spec: config.DesktopSpec) -> tuple[bool, str]:
    """逐桌镜像在位性（root 契约 2026-11-15）：判据 = config.image_for(spec)。

    向后兼容形态（刻意保留，不改既有调用者接口）：本桌镜像**等于** config.IMAGE 时
    按**零参**调 image_present()（与旧调用点逐字同形 ⇒ 现有 stub 与注入点不变）；
    仅当自适应镜像生效且本桌为 auto（镜像不同）时显式传该引用。
    未启用自适应镜像 ⇒ 全桌恒走零参分支 ⇒ 现势逐字节不变。
    """
    img = config.image_for(spec)
    if img == config.IMAGE:
        return image_present()
    return image_present(img)


def compose(spec: config.DesktopSpec, *args: str, timeout: int = 180) -> subprocess.CompletedProcess:
    cmd = ["docker", "compose", "-p", spec.project, "-f", config.compose_file(spec.id)] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          cwd=config.desktop_dir(spec.id))


def inspect_full(cid: str) -> dict:
    """单容器精确 inspect；cid 必须 64 位 hex。返回 {} 表示不存在/非法。

    几何实况认证（root 契约 2026-11-14）在**旧键逐字不动**的前提下加式补捕四类实况：
      imageDigest = obj.Image（**容器实际引用的 immutable digest**，不是 Config.Image 的 tag；
                    tag 可被追新/重打，digest 不可 ⇒ 认证只认它）
      env         = Config.Env 解析成 dict（**只作一致性核对，不是运行态证据**）
      health*     = State.Health 状态 / FailingStreak / 末条 Log（末行由容器自己写出，
                    被 dockerd 记账 ⇒ 零额外命令面的内部自证）
      pid         = State.Pid（容器 init 进程宿主 PID，只做存在性 sanity）
    legacy 消费侧（ownership / registry 旧路径）只读旧键，新增键不影响其行为。
    """
    if not config.CID_RE.match(cid or ""):
        return {}
    r = subprocess.run(["docker", "inspect", cid], capture_output=True, text=True)
    if r.returncode != 0:
        return {}
    try:
        arr = json.loads(r.stdout)
    except ValueError:
        return {}
    if not arr:
        return {}
    obj = arr[0]
    state = obj.get("State", {})
    cfg = obj.get("Config", {})
    health = state.get("Health") or {}
    log = health.get("Log") or []
    last = log[-1] if isinstance(log, list) and log else {}
    env = {}
    for pair in (cfg.get("Env") or []):
        if isinstance(pair, str) and "=" in pair:
            k, _, v = pair.partition("=")
            env[k] = v
    return {"id": obj.get("Id", ""), "status": state.get("Status", ""),
            "running": bool(state.get("Running")), "image": cfg.get("Image", ""),
            "labels": cfg.get("Labels", {}) or {},
            "startedAt": state.get("StartedAt", ""),
            "name": (obj.get("Name") or "").lstrip("/"),
            "restartPolicy": (obj.get("HostConfig", {}).get("RestartPolicy") or {}).get("Name", ""),
            "imageDigest": obj.get("Image", ""),
            "pid": state.get("Pid", 0),
            "env": env,
            "healthStatus": (health.get("Status") or ""),
            "healthFailingStreak": health.get("FailingStreak"),
            "healthLog": {"output": (last.get("Output") or ""),
                          "exit": last.get("ExitCode"),
                          "start": (last.get("Start") or ""),
                          "end": (last.get("End") or "")}}


def find_by_name(name: str) -> str | None:
    """按 container_name 精确查 64 位 ID（全状态，--no-trunc）。"""
    r = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--filter", "name=^%s$" % name,
                        "--format", "{{.ID}}"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        cid = line.strip()
        if config.CID_RE.match(cid):
            return cid
    return None


def owned_container_ids(spec: config.DesktopSpec) -> list[str]:
    """带本 route + 本 desktop label 的 64 位容器 ID（全状态）= 本模块唯一可操作集合。"""
    r = subprocess.run(["docker", "ps", "-a", "--no-trunc",
                        "--filter", "label=wt-kasm.route=" + config.PRODUCT,
                        "--filter", "label=wt-kasm.desktop=" + spec.id,
                        "--format", "{{.ID}}"], capture_output=True, text=True)
    return [l.strip() for l in r.stdout.splitlines() if config.CID_RE.match(l.strip())]


COMPOSE_PROJECT_LABEL = "com.docker.compose.project"


def stop_targets(spec: config.DesktopSpec, ids: list[str]) -> dict:
    """Compose project 漂移守卫（root 任务卡 2026-11-15）：决定本次 stop 真会作用到谁。

    成因（recreate-adaptive.py B1 记录）：owned_container_ids 按 route + desktop label 列 ID，
    而执行面是 docker compose -p spec.project stop —— 按 project label 选目标。两个口径一旦
    漂移（逐桌换 project / 全局换后缀 / 容器被别处迁走），compose 在目标 project 内找不到任何
    容器 => rc=0 假成功：旧 project 里那个仍在跑的容器原样活着，调用方却收到"已停"。
    因此 stop 前必须逐个核对将受操作容器的 project 标签。

    判据（fail-closed，拒绝时不发 stop）：
      - inspect 不可读（容器消失 / dockerd 报错 / JSON 损坏）=> 拒绝；
      - 运行中容器的 project 标签缺失（未知）或与 spec.project 不符 => 拒绝；
      - 已停容器（含 -prior-011 这类换 project 留证件、外来 project 的死容器）=> 不进目标集，
        也不阻断：compose stop 对已停容器无副作用，留证面必须原样存在；
      - 外来（foreign）容器由 ownership() 先行拒绝，本函数不为其放行任何路径。

    返回 ok / targets / checked / reason：targets = 经 project 核对的运行中容器；调用方只可
    把 stop 的"已停"结论建立在这份 targets 上（stopped 面积不得用 label 列表冒充）。
    """
    targets: list[str] = []
    problems: list[str] = []
    for cid in ids:
        info = inspect_full(cid)
        if not info:
            return {"ok": False, "targets": [], "checked": list(ids),
                    "reason": "project 守卫：inspect 不可读 cid=%s（容器消失/dockerd 异常）=> 拒绝 stop" % cid}
        labels = info.get("labels") or {}
        if not info.get("running"):
            continue
        proj = labels.get(COMPOSE_PROJECT_LABEL)
        if proj != spec.project:
            problems.append("cid=%s running=%s project=%r != spec.project=%r"
                            % (cid, info.get("status"), proj, spec.project))
        else:
            targets.append(cid)
    if problems:
        return {"ok": False, "targets": [], "checked": list(ids),
                "reason": "project 守卫：将受操作的运行中容器与 spec.project 不同源（漂移/标签缺失）"
                          "=> compose -p 按 project 选目标会假成功，拒绝 stop: " + "; ".join(problems)}
    return {"ok": True, "targets": targets, "checked": list(ids), "reason": None}
def ownership(spec: config.DesktopSpec) -> dict:
    """归属判定：外来同名（缺本 route label）与 image 不符都必须拒绝认领。

    目标 tag = config.image_for(spec)（**与 render / start 同源**）：逐桌启用自适应镜像时，
    本桌按本桌的镜像认领，未选桌继续按 config.IMAGE 认领 ⇒ 旧容器不会因全局换 tag 被误判。
    比对仍按 Config.Image 逐字相等（不 strip tag、不按仓库前缀放宽、不 fallback digest）⇒
    不重建原则与 fail-closed 语义逐字不变。
    """
    want = config.image_for(spec)
    out = {"owned": False, "foreign": False, "cid": None, "info": {}, "reason": None}
    cid = find_by_name(spec.container)
    if not cid:
        ids = owned_container_ids(spec)
        cid = ids[0] if ids else None
    if not cid:
        out["reason"] = "no-container"
        return out
    out["cid"] = cid
    info = inspect_full(cid)
    if not info:
        out["reason"] = "inspect 失败 cid=%s" % cid
        return out
    out["info"] = info
    labels = info["labels"]
    if labels.get("wt-kasm.route") != config.PRODUCT or labels.get("wt-kasm.desktop") != spec.id:
        out["foreign"] = True
        out["reason"] = "同名容器非本路线创建 labels=%s ⇒ 拒绝认领" % json.dumps(labels, sort_keys=True)
        return out
    if info.get("image") != want:
        out["reason"] = "容器 image=%s 与目标 %s 不符" % (info.get("image"), want)
        return out
    out["owned"] = True
    out["reason"] = "owned"
    return out


def start(spec: config.DesktopSpec) -> dict:
    """归属核验通过且已运行 = 幂等 no-op（不 recreate）；停止 = compose up -d --pull never。"""
    own = ownership(spec)
    cid = own.get("cid")
    if own.get("foreign"):
        return {"ok": False, "action": "refused", "reason": own["reason"], "containerId": cid}
    if cid and own.get("owned") and own["info"].get("running"):
        return {"ok": True, "action": "kept", "containerId": cid,
                "status": own["info"]["status"], "reason": "已运行，不 recreate"}
    if cid and not own.get("owned"):
        return {"ok": False, "action": "refused", "containerId": cid,
                "reason": own["reason"] or "归属未证实，拒绝操作"}
    ok, ref = image_present_for(spec)
    if not ok:
        return {"ok": False, "action": "blocked",
                "reason": "镜像 %s 不存在（%s）——由 image worker 构建，本模块不 build/pull"
                          % (config.image_for(spec), ref)}
    r = compose(spec, "up", "-d", "--pull", "never")
    if r.returncode != 0:
        return {"ok": False, "action": "failed", "reason": "compose up 失败",
                "out": (r.stderr or r.stdout).strip()[-800:]}
    own2 = ownership(spec)
    cid2 = own2.get("cid")
    if not (cid2 and own2.get("owned")):
        return {"ok": False, "action": "refused", "containerId": cid2,
                "reason": "启动后归属核验未通过: " + str(own2.get("reason"))}
    with open(config.cidfile(spec.id, "desktop"), "w", encoding="utf-8") as f:
        f.write(cid2 + "\n")
    return {"ok": True, "action": "started", "containerId": cid2,
            "out": (r.stdout or "").strip()[-400:]}


def stop(spec: config.DesktopSpec, timeout: int = 60) -> dict:
    """只精确停本 desk 且归属核验通过的容器；不 rm、不 down -v、无 --remove-orphans。

    两道硬门（root 任务卡 2026-11-15，防 Compose project 漂移下的 rc=0 假成功）：
      1) 发命令前：stop_targets 逐个核对将受操作（运行中）容器的
         com.docker.compose.project == spec.project；inspect 不可读 / 标签缺失 / project 不符
         => 一律拒绝且不发 stop（foreign 由 ownership 先拒，绝不代其动手）；
      2) rc=0 后：对 targets 逐个重新 inspect；仍 running 或复查 inspect 不可读
         => ok=False 且 reason 点名到 cid，不得报成功。

    留证容器（已停的旧 project / -prior-011）不阻断本桌停止，也不计入 stopped。
    返回键与旧版兼容（ok / action / stopped / reason），新增 checked 诊断键。
    """
    own = ownership(spec)
    if own.get("foreign"):
        return {"ok": False, "action": "refused", "reason": own["reason"]}
    ids = owned_container_ids(spec)
    if not ids:
        return {"ok": True, "action": "absent", "stopped": []}
    gate = stop_targets(spec, ids)
    if not gate["ok"]:
        return {"ok": False, "action": "refused", "stopped": [],
                "checked": gate["checked"], "reason": gate["reason"]}
    targets = gate["targets"]
    if not targets:
        # 本桌已标记容器全部未运行（含换 project 留证件）=> 无可停目标，幂等成功
        return {"ok": True, "action": "stopped", "stopped": [], "checked": gate["checked"],
                "reason": "本桌无运行中容器，无 stop 目标（已停/留证容器不操作）: %s" % ",".join(ids)}
    r = compose(spec, "stop", "-t", str(timeout))
    if r.returncode != 0:
        return {"ok": False, "action": "stopped", "stopped": targets, "checked": gate["checked"],
                "reason": "compose stop rc=%d：%s"
                          % (r.returncode, (r.stderr or r.stdout).strip()[:400])}
    still: list[str] = []
    unreadable: list[str] = []
    statuses: dict[str, str] = {}
    for cid in targets:
        info = inspect_full(cid)
        if not info:
            unreadable.append(cid)
            continue
        statuses[cid] = info.get("status") or ""
        if info.get("running"):
            still.append(cid)
    if unreadable:
        return {"ok": False, "action": "stopped", "stopped": targets, "checked": gate["checked"],
                "reason": "compose stop rc=0 但复核查验 inspect 不可读（无法证实已停）: %s"
                          % ",".join(unreadable)}
    if still:
        return {"ok": False, "action": "stopped", "stopped": targets, "checked": gate["checked"],
                "reason": "compose stop rc=0 但复核查验仍 running（假成功）: %s"
                          % ",".join("%s(%s)" % (c, statuses.get(c, "?")) for c in still)}
    return {"ok": True, "action": "stopped", "stopped": targets, "checked": gate["checked"],
            "reason": None}

