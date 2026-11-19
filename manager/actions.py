"""编排动作：daemon 与 CLI 共用的唯一实现面（CLI 不自带第二套逻辑）。

start 流程 = compose 落盘 → 端口锁+precheck → compose start（幂等）→ appshare 契约 →
relay → X 归属核对 → backend 200 → registry 刷新 → 默认 app 拉起（best-effort）。
stop 流程 = 收 app → 收 relay → compose stop（不 rm）→ registry 刷新。
**state=running 只等于 backend 200，不等于 GUI 已验。**

显式几何桌面（frame_width/frame_height/resize_mode 三者齐备）在 registry 刷新之后、
拉起默认 app 之前**再过一道几何活体门禁**：**直接复用 registry.refresh() 返回文档里
该桌的 state**（= 本次写盘的同一次取值，不再二次 probe ⇒ 不存在"门禁态与盘上态不是
同一次"的窗口；refresh 抛异常 ⇒ 盘上仍是上一次内容，按门禁关闭处理且明写未写入）。
state != running ⇒ 整次 start 判 ok=False（step=geometry-attestation），
**不拉起 app、不 stop、不 rebuild**（容器保持现况）。
旧配置桌面（无显式几何）此段零新增调用、零语义变化。

对外 URL 由 _public_url() 单点生成：fixed 桌面补 ?resolution=WxH（dispatcher 几何门
先于 state 判定，固定几何缺参必 409）；auto / legacy 逐字原样。
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import os
import time

from . import appshare, compose, config, hostapps, net, process, registry


def _require_id(desktop_id: str) -> config.DesktopSpec:
    if desktop_id not in config.DESKTOP_BY_ID:
        raise KeyError("未登记的 desktop id: %r（只认 %s，不开放查询建号）"
                       % (desktop_id, ",".join(config.REGISTERED_IDS)))
    return config.spec(desktop_id)


@contextlib.contextmanager
def desk_lock(desktop_id: str, timeout: float = 150.0):
    """每 desk 一把 flock：CLI start/stop/app 与图标点击 launch 全串行。

    没有它，daemon 收到图标点击 + 用户同时敲 wt-kasm start 会对同一 desk 并发
    compose up / 重复 launch 同一 app（单线程 daemon 里操作是同步阻塞的，两路请求
    排队后仍会各自跑完整链 ⇒ 必须在操作层互斥）。锁文件落 state 目录，不 rm。
    """
    _require_id(desktop_id)
    path = os.path.join(config.state_dir(desktop_id), "op.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
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
                    raise net.PortBusy("desk %s 操作锁超时未获得（并发操作进行中）: %s"
                                       % (desktop_id, path))
                time.sleep(0.3)
        yield path
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def init_all(force: bool = False) -> dict:
    """建部署骨架 + 写 compose + 预置端口锁目录；不启动容器，不拉镜像。

    镜像诊断按**逐桌选定镜像**如实呈现（root 契约 2026-11-15）：自适应镜像启用后，
    auto 桌与 legacy/fixed 桌用的是不同 tag ⇒ 必须逐个核在位性并逐条列出，
    不得只报一个全局 tag（多图场景报单图 = 掩盖未就位的新镜像）。
    向后兼容：`image` 仍是**单图标量形态**（{present, ref, image}，逐字同旧契约，
    取第一组 = 渲染顺序首桌的镜像），新增 `images` 数组承载逐图实况 +
    `imageMode`（single = 全桌同镜像（现势）/ mixed = 逐桌多镜像）。
    out["ok"] 的语义**逐字不变**（原实现镜像缺失不改 ok ⇒ 本函数也不改，避免默认路径行为
    漂移）；缺失情况如实进 images[].present=false + out["imageAllPresent"]=False +
    out["imageMissing"]，消费侧自行判读。真正的阻断发生在 compose.start（逐桌 image_present
    失败 ⇒ action=blocked），init 只做诊断不建容器。
    """
    out = {"ok": True, "dirs": [], "compose": [], "image": {}}
    for d in (config.APP_ROOT, config.DESKTOPS_DIR, config.STATE_DIR, config.LOG_DIR,
              config.SOCK_DIR, config.PORT_LOCK_DIR):
        os.makedirs(d, exist_ok=True)
        out["dirs"].append(d)
    for spec in config.DESKTOPS:
        out["compose"].append(compose.write_compose(spec, force=force))
    plan = config.image_plan()
    images = []
    for item in plan:
        # 镜像 == config.IMAGE 时走**零参**旧调用形（stub/注入点逐字不变）；
        # 仅自适应镜像（与 IMAGE 不同）显式传引用。
        img = item["image"]
        ok, ref = (compose.image_present() if img == config.IMAGE
                   else compose.image_present(img))
        images.append({"image": item["image"], "desktops": list(item["desktops"]),
                       "present": ok, "ref": ref})
    out["images"] = images
    out["imageMode"] = "single" if len(images) == 1 else "mixed"
    if images:
        first = images[0]
        out["image"] = {"present": first["present"], "ref": first["ref"],
                        "image": first["image"]}
    # images 为空 = 本进程未登记任何桌面（仅 catalog 空清单等极端形态）：
    # out["image"] 保留初值 {}（旧契约的"未核"形态），不猜、不 IndexError。
    out["imageAllPresent"] = all(i["present"] for i in images)
    if not out["imageAllPresent"]:
        out["imageMissing"] = [i["image"] for i in images if not i["present"]]
    out["registry"] = registry.refresh()
    return out


def _precheck_port(spec: config.DesktopSpec, allow_cids: list[str]) -> dict | None:
    """预检 + bind 自证。返回 None = 通过；dict = 失败响应。

    **调用方必须已持有 net.port_lock(spec.port)**（root 抢先审 G 项）：旧实现在本函数
    内部取锁、return 前释放，而 compose.start 在锁外 ⇒ 预检与真实 bind 之间存在窗口，
    并行的 S 线可在窗口里抢走同一端口。锁范围现由 start_desk 覆盖到 ready/登记完成。

    allow_cids = 本路线自己的容器 ID：自己已停止容器的 hostPort 逻辑预留不算冲突
    （否则复启自己被自己挡住 ⇒ start 非幂等）。
    """
    ok, why = net.port_free(spec.port, allow_cids=allow_cids)
    if not ok:
        return {"ok": False, "step": "port-precheck",
                "reason": "端口 %d 不可用: %s（不抢占）" % (spec.port, why)}
    try:
        net.selfcheck_bind(spec.port)
    except net.PortBusy as exc:
        return {"ok": False, "step": "port-bind", "reason": str(exc)}
    return None


def _after_bind(spec: config.DesktopSpec, steps: dict, launch_app: bool) -> dict:
    """已 bind（或已 running 幂等复核）之后的公共段：契约 → relay → 归属 → backend → registry → app。

    非幂等分支在**端口锁内**调用本函数 ⇒ "precheck → bind → compose start → ready/登记"
    全程持锁，锁的持有区间覆盖到 registry 落盘（G 项）。
    """
    steps["contract"] = appshare.wait_contract(spec.id, timeout=90.0)
    if steps["contract"]["missing"] or not steps["contract"]["x11_socket_present"]:
        registry.refresh()
        return {"ok": False, "desktop": spec.id, "step": "appshare-contract",
                "reason": "镜像契约未齐: missing=%s x11=%s（plumbing 未就绪，不做 GUI 声明）"
                          % (steps["contract"]["missing"],
                             steps["contract"]["x11_socket_present"]),
                "detail": steps["compose"], "steps": steps}
    steps["relay"] = net.ensure_relay(spec)
    if not steps["relay"]["ok"]:
        registry.refresh()
        return {"ok": False, "desktop": spec.id, "step": "relay",
                "reason": str(steps["relay"].get("reason")), "detail": steps["relay"],
                "steps": steps}
    steps["routing"] = appshare.wait_routing(spec.id, timeout=45.0)
    if not steps["routing"]["ok"]:
        registry.refresh()
        return {"ok": False, "desktop": spec.id, "step": "routing",
                "reason": steps["routing"].get("reason"), "detail": steps["routing"],
                "steps": steps}
    ready, why = net.wait_backend_ready(spec, timeout=90.0)
    steps["backend"] = {"ready": ready, "reason": why}
    if not ready:
        registry.refresh()
        return {"ok": False, "desktop": spec.id, "step": "backend",
                "reason": why, "backendRunning": False, "steps": steps}
    # 几何活体门禁（只对显式几何桌面）：判据**直接取 registry.refresh() 返回文档里该桌的
    # state**（build() 逐桌 probe_state 的产物，与本次写盘内容同源同一次）⇒ 门禁结论与
    # registry.json 落盘状态**必然一致**，不存在"先 refresh 再二次 probe、两者不是同一次
    # 取值"的错位。refresh 本身抛异常（含 probe_state 的 fail-closed 抛）⇒ 写盘发生在
    # build 之后 ⇒ registry.json 未被本次更新 ⇒ 同样门禁关闭，并明写 registryWritten=False。
    # **registryWritten=False 只是"本次判据来自未落盘的异常"这一诊断标记，不是生产阻断**：
    # 盘上 registry 可能仍是上一轮的 running，dispatcher 侧据此放行 ⇒ 生产阻断须由独立的
    # 活性门禁/降级写盘承担（root 2026-11-14 已登记为后续独立项，不在本门禁职责内）。
    # 不通过 ⇒ fail-closed：不 launch app、不 stop、不 rebuild（容器保持现况）。
    registry_written = True
    if spec.has_explicit_geometry:
        try:
            steps["registry"] = registry.refresh()
        except Exception as exc:
            registry_written = False
            steps["registry"] = {"error": "%s: %s" % (type(exc).__name__, exc)}
        state, gdetail = _registry_state_of(steps["registry"], spec.id,
                                            written=registry_written)
        steps["geometry_attestation"] = {"state": state, "detail": gdetail,
                                         "registryWritten": registry_written,
                                         "source": "registry.refresh"}
        if state != "running":
            return {"ok": False,
                    "desktop": spec.id,
                    "step": "geometry-attestation",
                    "state": state,
                    "reason": ("显式几何 %dx%d(%s) 未通过几何活体门禁: %s"
                               "（registryWritten=%s）"
                               % (spec.frame_width, spec.frame_height, spec.resize_mode,
                                  gdetail, registry_written)),
                    "detail": steps["geometry_attestation"],
                    "backendRunning": True,
                    "registryWritten": registry_written,
                    "steps": steps}
    else:
        steps["registry"] = registry.refresh()
    app = None
    app_failed = False
    if launch_app:
        app = hostapps.launch(spec.id, spec.default_app)
        app_failed = not bool(app.get("ok"))
        steps["app"] = app
    return {"ok": (not app_failed),
            "desktop": spec.id,
            "state": "running",
            "backendRunning": True,
            "appLaunched": (None if app is None else bool(not app_failed)),
            "appFailed": app_failed,
            "reason": (("默认应用拉起失败: " + str((app or {}).get("reason")))
                       if app_failed else steps["compose"].get("reason", "ok")),
            "gui_verified": False,
            "url": _public_url(spec),
            "containerId": steps["compose"].get("containerId"),
            "relay": steps["relay"], "app": app, "steps": steps}


def _registry_state_of(doc: dict, desktop_id: str, written: bool = True) -> "tuple[str, str]":
    """从 registry.refresh() 返回文档取该桌 state + 诊断（门禁判据，逐字不猜）。

    取不到该桌条目 / state 不在 STATES ⇒ ("error", …)：门禁关闭。
    written=False 时诊断明写"本次未写入"，不把盘上旧内容当实况。
    """
    if not written:
        return "error", "registry.refresh 抛异常 ⇒ registry.json 未写入本次实况（fail-closed）"
    entry = None
    for d in (doc or {}).get("desktops", []):
        if d.get("id") == desktop_id:
            entry = d
            break
    if entry is None:
        return "error", "refresh 返回文档缺该桌条目（无法据以放行）"
    state = entry.get("state")
    if state not in registry.STATES:
        return "error", "registry state 非法: %r" % (state,)
    return state, str((doc.get("_detail") or {}).get(desktop_id, ""))


def _public_url(spec: config.DesktopSpec) -> str:
    """对外入口 URL（start / status / list 三处唯一发射点）。

    **fixed 桌面必须带 ?resolution=WxH**：dispatcher 的几何门**先于** state 判定，固定
    几何缺该参数直接 409「必须带 resolution=WxH」（dispatcher/lib/selector.js
    decideGeometry）⇒ manager 发裸路径等于发一个自己打不开的入口。形态取 dispatcher
    规范态 = 小写 x + 无前导 0（dispatcher/lib/config.js parseResolution），且 W/H 已由
    config.normalize_geometry 卡在 320..4096 / 240..4096（与 dispatcher 区间常量同口径）。
    **auto 与 legacy（resize_mode=None）逐字原样返回**：auto 带 resolution 判 409 模式
    冲突，legacy 带 resolution 判 409 未登记几何 ⇒ 该参数是 fixed 专属，不是通用参数。
    """
    base = config.PUBLIC_ORIGIN + "/desktop/" + spec.id + "/"
    if spec.resize_mode == "fixed":
        return base + "?resolution=%dx%d" % (spec.frame_width, spec.frame_height)
    return base


def start_desk(desktop_id: str, launch_app: bool = True) -> dict:
    """幂等启动：已 owned+running 的 desk 不重跑端口预检，只做复核 + 补 app。

    返回契约：
      ok=True 且 backendRunning=True ⇒ backend 200 达成；
      appFailed=True ⇒ backend 已起但默认应用未达成 ⇒ **ok=False**（未达默认应用须 FAIL），
        同时保留 backendRunning / steps 全量 detail，调用方与运维各自判读。
    """
    spec = _require_id(desktop_id)
    steps: dict = {"desktop": desktop_id}
    with desk_lock(desktop_id):
        compose.write_compose(spec)
        own = compose.ownership(spec)
        already = bool(own.get("owned") and own.get("info", {}).get("running"))
        steps["ownership"] = {"owned": bool(own.get("owned")), "foreign": bool(own.get("foreign")),
                              "running": already, "cid": own.get("cid"), "reason": own.get("reason")}
        if own.get("foreign"):
            return {"ok": False, "desktop": desktop_id, "step": "ownership",
                    "reason": own["reason"], "steps": steps}
        if already:
            # 幂等路径：端口被自己的 running 容器占是**预期**，不预检；复核 relay/契约/backend
            steps["port"] = {"skipped": "already-running-owned"}
            steps["compose"] = {"ok": True, "action": "kept", "containerId": own.get("cid"),
                                "reason": "已运行，不 recreate"}
            return _after_bind(spec, steps, launch_app)
        else:
            # 单一锁区间覆盖 precheck → bind 自证 → compose start → ready/registry 登记，
            # 全程持锁（与 S 线并发安全）；锁文件不删（flock 释放即可，无 unlink 语义）。
            with net.port_lock(spec.port):
                blocked = _precheck_port(spec, allow_cids=compose.owned_container_ids(spec))
                if blocked:
                    blocked["desktop"] = desktop_id
                    blocked["steps"] = steps
                    return blocked
                steps["compose"] = compose.start(spec)
                steps["port"] = {"locked": True, "port": spec.port}
                if not steps["compose"]["ok"]:
                    return {"ok": False, "desktop": desktop_id, "step": "compose",
                            "reason": steps["compose"].get("reason"), "detail": steps["compose"],
                            "steps": steps}
                return _after_bind(spec, steps, launch_app)


def stop_desk(desktop_id: str) -> dict:
    """可靠停止：app / relay / compose 三段全部要求成功，任一段失败 ⇒ ok=False
    且保留该段完整 detail（调用方必须看到"没停干净"，不得假成功）。"""
    spec = _require_id(desktop_id)
    out = {"desktop": desktop_id, "apps": [], "relay": None, "compose": None}
    with desk_lock(desktop_id):
        for app_id in config.APP_IDS_BY_DESKTOP.get(desktop_id, ()):
            r = dict(hostapps.stop_app(desktop_id, app_id))
            r.setdefault("step", "app:" + app_id)
            # 无台账 = 未拉起 = 成功（stop_app 已按 no-ledger 返回 ok）
            out["apps"].append(r)
        if process.read_ledger(net.relay_pidfile(desktop_id)):
            ok, why = net.stop_relay(desktop_id)
            out["relay"] = {"ok": ok, "reason": why, "step": "relay"}
        else:
            out["relay"] = {"ok": True, "reason": "no-ledger", "step": "relay"}
        out["compose"] = compose.stop(spec)
        out["compose"].setdefault("step", "compose")
        out["registry"] = registry.refresh()
        failed = ([a for a in out["apps"] if not a.get("ok")]
                  + ([] if out["relay"]["ok"] else [out["relay"]])
                  + ([] if out["compose"]["ok"] else [out["compose"]]))
        out["ok"] = not failed
        out["failedSteps"] = [{"step": f.get("step", "?"), "reason": f.get("reason")}
                              for f in failed]
        out["detail"] = failed
        return out


def app_op(desktop_id: str, action: str, app_id: str | None = None,
           cdp: bool = False, url: str | None = None) -> dict:
    spec = _require_id(desktop_id)
    apps = config.APP_IDS_BY_DESKTOP.get(desktop_id, ())
    target = app_id or spec.default_app
    if target not in apps:
        return {"ok": False, "reason": "app %r 不在 desktop %s 白名单 %s"
                % (target, desktop_id, list(apps))}
    if action == "start":
        with desk_lock(desktop_id):            # 与 start/stop/图标点击互斥
            return hostapps.launch(desktop_id, target, cdp=cdp, url=url)
    if action == "focus":
        with desk_lock(desktop_id):
            if not hostapps.live_app(desktop_id, target):
                return {"ok": False, "reason": "app 未运行 ⇒ focus 拒绝（不隐式拉起）",
                        "hint": "用 app start 或点桌面图标"}
            return hostapps.focus(desktop_id, target)
    if action == "stop":
        with desk_lock(desktop_id):
            return hostapps.stop_app(desktop_id, target)
    if action == "status":
        return {"ok": True, "apps": hostapps.apps_status(desktop_id)}
    return {"ok": False, "reason": "未知 app 动作: " + str(action)}


def status_desk(desktop_id: str, deep: bool = True) -> dict:
    spec = _require_id(desktop_id)
    p = registry.probe_state(spec) if deep else {
        "state": "unknown", "containerId": "", "generation": "", "detail": "skip"}
    relay_live = process.live_ledger(net.relay_pidfile(spec.id))
    return {"id": spec.id, "name": spec.name, "port": spec.port, "state": p["state"],
            "relayPort": spec.relay_port, "display": spec.client_display,
            "container": spec.container, "containerId": p["containerId"],
            "generation": p["generation"], "detail": p["detail"],
            "url": _public_url(spec),
            "apps": hostapps.apps_status(spec.id),
            "contract": appshare.contract_status(spec.id),
            "relayLive": bool(relay_live),
            "guiVerified": False}


def status_all(deep: bool = True) -> list[dict]:
    return [status_desk(d.id, deep=deep) for d in config.DESKTOPS]


def list_brief() -> list[dict]:
    doc = registry.read()
    by_id = {d.get("id"): d for d in doc.get("desktops", [])}
    out = []
    for spec in config.DESKTOPS:
        r = by_id.get(spec.id, {})
        out.append({"id": spec.id, "name": spec.name, "port": spec.port,
                    "state": r.get("state", "unknown"),
                    "appId": r.get("appId", spec.app_id),
                    "generation": r.get("generation", ""),
                    "url": _public_url(spec)})
    return out


def verify_desk(desktop_id: str) -> dict:
    """只读体检：**自动 gate = 12 项 plumbing**，逐检查项 PASS/FAIL（不猜；未达即 FAIL，
    不降级为 SKIP）。

    GUI 实证**不进 checks**（root 2026-11-13 裁决）：它不是本工具可自动判定的检查项，
    列成 FAIL 会让健康桌面在门禁面上显示失败。它由返回值的**中性字段**承担：
      guiVerified = False            永远由本工具置假（本工具不产截图，不给自己放行）
      guiLevel    = "not-auto-checkable"  非 SKIP、非 FAIL —— 语义 = 不属可自动检查项
      guiNote     = 4 级由截图验收单列核销
    ⇒ `ok` / `pass` / `fail` 只由 12 项 plumbing 决定；CLI 对 verify 的退出码按 data.ok，
    所以三桌健康 = 12/12 = ok=true = exit 0，真坏 = exit 1。
    """
    spec = _require_id(desktop_id)
    checks: list[dict] = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})

    own = compose.ownership(spec)
    add("容器归属", own.get("owned"), own.get("reason"))
    add("compose 在位且与渲染一致", _compose_matches(spec), config.compose_file(spec.id))
    st = appshare.contract_status(spec.id)
    add("appshare 契约齐备", not st["missing"], "missing=" + (",".join(st["missing"]) or "无"))
    add("X1 socket 存在", st["x11_socket_present"], st["x11_socket"])
    add("relay 存活", process.live_ledger(net.relay_pidfile(spec.id)) is not None,
        "port=%d display=%s" % (spec.relay_port, spec.client_display))
    route = appshare.verify_routing(spec.id)
    add("X 归属核对(desktop+generation)", route["ok"], route.get("reason") or route.get("raw"))
    ready = net.http_ready(spec.backend_url + "/", timeout=3.0)
    add("backend HTTP 200", ready, spec.backend_url + "/")
    p = registry.probe_state(spec, ready=ready)
    reg = registry.get(spec.id)
    add("registry 与实况一致", bool(reg) and reg.get("state") == p["state"],
        "registry=%s probe=%s" % (reg.get("state") if reg else None, p["state"]))
    add("registry 发布面字段合规", _registry_shape(reg), json.dumps(reg, sort_keys=True)[:200])
    for app_id in config.APP_IDS_BY_DESKTOP.get(spec.id, ()):
        rec = process.read_ledger(hostapps.app_pidfile(spec.id, app_id))
        add("app %s 台账身份匹配" % app_id,
            (rec is None) or process.matches_record(rec),
            "无台账（未拉起）" if rec is None
            else json.dumps(process.identity(int(rec["pid"])), default=str))
    # 逐桌镜像（root 契约 2026-11-15）：判据取本桌 image_for(spec)，与 render / ownership /
    # start 同源；自适应镜像未启用时逐字等于旧行（config.IMAGE）。
    add("镜像 tag 存在", compose.image_present_for(spec)[0], config.image_for(spec))
    passed = sum(1 for c in checks if c["ok"])
    return {"ok": all(c["ok"] for c in checks), "desktop": desktop_id, "pass": passed,
            "fail": len(checks) - passed, "checks": checks,
            "checksTotal": len(checks),
            "guiVerified": False,
            "guiLevel": "not-auto-checkable",
            "guiNote": "本工具只证明到 3 级 plumbing；GUI(4 级) 由 root/tester 截图验收单列核销"}


def _compose_matches(spec: config.DesktopSpec) -> bool:
    p = config.compose_file(spec.id)
    if not os.path.exists(p):
        return False
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read() == compose.render(spec)
    except OSError:
        return False


def _registry_shape(entry: dict | None) -> bool:
    if not entry:
        return False
    if set(entry.keys()) != set(registry.FIELDS):
        return False
    if entry.get("state") not in registry.STATES:
        return False
    cid = entry.get("containerId") or ""
    return bool(cid == "" or config.CID_RE.match(cid))


DISPATCH = {
    "init": lambda a: init_all(force=bool(a.get("force"))),
    "start": lambda a: start_desk(a["id"], launch_app=a.get("app", True) is not False),
    "stop": lambda a: stop_desk(a["id"]),
    "status": lambda a: (status_desk(a["id"]) if a.get("id") else status_all()),
    "list": lambda a: list_brief(),
    "app": lambda a: app_op(a["id"], a["action"], a.get("appId"),
                            cdp=bool(a.get("cdp")), url=a.get("url")),
    "verify": lambda a: verify_desk(a["id"]),
    "registry": lambda a: (registry.refresh() if a.get("refresh") else registry.read()),
    "ping": lambda a: {"ok": True, "pong": int(time.time()), "pid": os.getpid()},
}


def handle_request(req: dict) -> dict:
    cmd = req.get("cmd")
    if cmd not in DISPATCH:
        return {"ok": False, "reason": "未知命令 %r（允许 %s）"
                % (cmd, ",".join(sorted(DISPATCH)))}
    try:
        if "id" in req:
            _require_id(req["id"])
        args = req.get("args") or req
        return {"ok": True, "cmd": cmd, "data": DISPATCH[cmd](args)}
    except KeyError as exc:
        return {"ok": False, "cmd": cmd, "reason": str(exc)}
    except Exception as exc:  # 单次请求异常不外溢
        return {"ok": False, "cmd": cmd,
                "reason": "%s: %s" % (type(exc).__name__, exc)}


# root 2026-11-13 冻结的跨组件协议 = **JSON 一行**（不是空格分隔文本）：
#   {"action": "launch", "appId": "chrome"}   /   {"action": "focus", "appId": "chrome"}
# 键集合必须**恰好** = {action, appId} ⇒ argv / url / exec / env / timeout 等一切
# 追加键一律拒绝（协议面没有"调用方给参数"这回事，参数只来自注册表）。
LAUNCH_KEYS = frozenset(("action", "appId"))
LAUNCH_ACTIONS = {"launch": "start", "focus": "focus"}
# appId 只认注册表里的固定应用名（协议层就拒绝路径片段/注入面，不依赖下游白名单兜底）
LAUNCH_APP_IDS = frozenset(apps for apps in config.APP_IDS_BY_DESKTOP.values()
                           for apps in (tuple(apps)))


def handle_launch_line(line: str, desktop_id: str) -> dict:
    """图标点击协议：主路径 = JSON dict（exactly action+appId）；legacy 文本兼容但非主路径。

    收到非 JSON 的一行时**先**按旧文本协议（launch <appId> / focus <appId>）解析，
    成功即执行并在返回里标 protocol="legacy-text"；两条都不合规才 FAIL。
    兼容窗口的存在只为让旧镜像滚动升级，不代表文本协议合法 ⇒ 新组件禁止再发文本。
    """
    stripped = (line or "").strip()
    if not stripped:
        return {"ok": False, "reason": "协议 = JSON {\"action\":\"launch|focus\",\"appId\":\"<id>\"}"}
    action: str | None = None
    app_id: str | None = None
    protocol = "json"
    reject: str | None = None
    try:
        doc = json.loads(stripped)
    except ValueError:
        doc = None
    if doc is not None:
        if not isinstance(doc, dict):
            reject = "协议必须是 JSON object"
        else:
            keys = frozenset(doc)
            if not keys <= LAUNCH_KEYS:
                reject = ("拒绝额外键: %s（只允许 action/appId ⇒ 无 argv/url/exec/env）"
                        % ",".join(sorted(keys - LAUNCH_KEYS)))
            elif keys != LAUNCH_KEYS:
                reject = ("缺少键: %s（必须同时给 action 与 appId）"
                        % ",".join(sorted(LAUNCH_KEYS - keys)))
            elif doc["action"] not in LAUNCH_ACTIONS:
                reject = "action 只允许 launch/focus"
            elif not isinstance(doc["appId"], str) or doc["appId"] not in LAUNCH_APP_IDS:
                reject = ("appId 必须是注册表固定应用名之一: %s"
                          % ",".join(sorted(LAUNCH_APP_IDS)))
            else:
                action = LAUNCH_ACTIONS[doc["action"]]
                app_id = doc["appId"]
        if reject:
            return {"ok": False, "reason": reject}
    else:
        parts = stripped.split()
        if len(parts) != 2:
            return {"ok": False, "reason": "协议 = JSON {\"action\":\"launch|focus\",\"appId\":\"<id>\"}"
                    "（旧文本协议需恰好 2 段：launch|focus <appId>）"}
        verb, app_id = parts
        if verb not in LAUNCH_ACTIONS:
            return {"ok": False, "reason": "动词只允许 launch/focus"}
        if app_id not in LAUNCH_APP_IDS:
            return {"ok": False, "reason": "appId 必须是注册表固定应用名之一: %s"
                    % ",".join(sorted(LAUNCH_APP_IDS))}
        action = LAUNCH_ACTIONS[verb]
        protocol = "legacy-text"
    res = app_op(desktop_id, action, app_id)
    res.setdefault("appId", app_id)
    res.setdefault("action", action)
    res["protocol"] = protocol
    return res

