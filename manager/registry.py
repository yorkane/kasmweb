"""dispatcher 只读消费契约 /data/app/webtop-kasmvnc/registry.json（原子写）。

root 固定字段（schemaVersion=1）：
  {schemaVersion, publicOrigin, desktops:[{id,name,port,state,container,containerId,generation,appId}]}
dispatcher 只读 id / name / port / state，不用 backendURL，避免任意 proxy。
state=running 只代表 backend ready（HTTP **200**），**不代表 GUI 已验**。

v2（root 抢先审）：改用 compose.ownership / find_by_name / inspect_full +
net.http_ready（200 only）；发布面严格 8 字段，诊断写 sidecar。

v1 可选几何（root 契约 2026-11-14，schemaVersion 仍 = 1）：
  desktops[].geometry = {"mode": "auto"|"fixed", "width": int 320..4096, "height": int 240..4096}
  - 仅 3 个键；只由显式几何的 DesktopSpec（config.normalize_geometry 同区间）生成并逐键追加；
  - 旧配置（resize_mode=None）的桌面 **不加该键** ⇒ 旧 registry 文件字节不变；
  - sanitize 对 geometry 显式逐键复制 + 严格校验（类型/区间/未知键/重复 id），
    任何损坏抛 ValueError fail-closed：**不降级为 legacy、不写盘**（write 先 sanitize，
    异常发生在建 tmp 文件之前 ⇒ 已存在 registry.json 原样保留）。
  - 消费侧（dispatcher/lib/registry.js）同规则：字段缺席 = legacy；出现且非法 = 该桌
    **state 强制 'error'** + geometryError=true（不 fallback legacy，也不丢其它桌）。
    state=error 是承重设计：现网 consumer 只放行 state==='running'，未升级的一侧同样 503。
  区间常量单一来源 = config.FRAME_WIDTH_MIN/MAX、FRAME_HEIGHT_MIN/MAX、RESIZE_MODES。
"""
from __future__ import annotations

import json
import os
import time

from . import appshare, attest, compose, config

FIELDS = ("id", "name", "port", "state", "container", "containerId", "generation", "appId")
STATES = ("running", "starting", "stopped", "error")

# geometry 允许键（显式白名单；__proto__ / constructor 等一律按未知键拒绝）
GEOMETRY_KEYS = ("mode", "width", "height")
GEOMETRY_MODES = tuple(config.RESIZE_MODES)
GEOMETRY_W_MIN, GEOMETRY_W_MAX = config.FRAME_WIDTH_MIN, config.FRAME_WIDTH_MAX
GEOMETRY_H_MIN, GEOMETRY_H_MAX = config.FRAME_HEIGHT_MIN, config.FRAME_HEIGHT_MAX


def _empty() -> dict:
    return {"schemaVersion": config.SCHEMA_VERSION, "publicOrigin": config.PUBLIC_ORIGIN,
            "desktops": []}


def _http(spec: config.DesktopSpec) -> bool:
    from . import net
    return net.http_ready(spec.backend_url + "/", timeout=2.0)


def _geometry_int(value, label, lo, hi):
    """严格 int：bool 先拒（bool 是 int 子类），只认 int 本体；区间闭区间。"""
    if isinstance(value, bool) or type(value) is not int:
        raise ValueError("geometry.%s must be int, got %s: %r"
                         % (label, type(value).__name__, value))
    if value < lo or value > hi:
        raise ValueError("geometry.%s=%d out of range %d..%d" % (label, value, lo, hi))
    return value


def validate_geometry(g, desktop_id=""):
    """校验并显式逐键复制 geometry -> {"mode","width","height"}（仅此 3 键）。

    非法（非 dict / 未知键 / 缺键 / 类型错 / 超界 / bool / mode 非 auto|fixed）一律
    ValueError：不补默认值、不降级 legacy、不静默丢弃。
    """
    where = " desktop=%s" % (desktop_id,) if desktop_id else ""
    if g is None:
        raise ValueError("geometry 为 null（缺席才是 legacy）" + where)
    if not isinstance(g, dict):
        raise ValueError("geometry 必须是对象，实为 %s%s"
                         % (type(g).__name__, where))
    for k in g:
        if k not in GEOMETRY_KEYS:
            raise ValueError("geometry 含未知键 %r%s" % (k, where))
    for k in GEOMETRY_KEYS:
        if k not in g:
            raise ValueError("geometry 缺键 %r%s" % (k, where))
    mode = g["mode"]
    if not isinstance(mode, str) or mode not in GEOMETRY_MODES:
        raise ValueError("geometry.mode 必须是 %s，实为 %r%s"
                         % ("/".join(GEOMETRY_MODES), mode, where))
    out = {"mode": mode,
           "width": _geometry_int(g["width"], "width", GEOMETRY_W_MIN, GEOMETRY_W_MAX),
           "height": _geometry_int(g["height"], "height", GEOMETRY_H_MIN, GEOMETRY_H_MAX)}
    return out


def geometry_from_spec(spec: config.DesktopSpec) -> "dict | None":
    """显式几何的 spec -> 发布用 geometry；旧配置 spec -> None（不写该键）。

    只从 config.normalize_geometry 已校验过的字段生成，键顺序固定 mode/width/height。
    """
    if getattr(spec, "resize_mode", None) is None:
        return None
    return {"mode": spec.resize_mode,
            "width": spec.frame_width,
            "height": spec.frame_height}


def probe_state(spec: config.DesktopSpec, ready: bool | None = None,
                probe: "dict | None" = None) -> dict:
    """容器实况 + 后端应答 ⇒ state。不猜；读不到即 stopped/error。

    显式几何桌面（spec.has_explicit_geometry）在 backend 200 之后**再过一道几何实况认证**
    （manager/attest.py：A 能力锚 digest / B Xvnc 进程实值 / C dockerd 记账的 health 自证 /
    D 声明-实值一致性 + 时间因果）。认证不通过 ⇒ state="error"（不是 starting/stopped：
    容器确实在跑、后端确实在应答，缺的是"运行态与声明几何等价"这一证明）。
    认证结论只进 out["attest"]（→ sidecar 的 detail 文本），**不进发布面**。
    legacy 桌面（resize_mode=None）：本函数逐字走旧路径，零新增调用。
    probe 仅供单测注入探针结果（None = 现场只读 docker exec）。
    """
    out = {"state": "stopped", "containerId": "", "generation": "", "detail": "no-container"}
    own = compose.ownership(spec)
    cid = own.get("cid") or ""
    info = own.get("info") or {}
    if cid:
        out["containerId"] = cid
    if own.get("foreign"):
        out["state"] = "error"
        out["detail"] = "foreign: " + str(own.get("reason"))
        return out
    if not cid:
        return out
    status = info.get("status")
    if not info.get("running"):
        out["state"] = "error" if status in ("restarting", "dead", "created") else "stopped"
        out["detail"] = "status=" + str(status) + " owned=" + str(own.get("owned"))
        return out
    if not own.get("owned"):
        out["state"] = "error"
        out["detail"] = "归属未证实: " + str(own.get("reason"))
        return out
    gen = appshare.read_generation(spec.id)
    out["generation"] = gen or ""
    ok = _http(spec) if ready is None else bool(ready)
    out["detail"] = "backend 200" if ok else "backend 未返回 200（GUI 状态不在此断言）"
    out["state"] = "running" if ok else "starting"
    if spec.has_explicit_geometry and out["state"] == "running":
        att = attest.attest_geometry(spec, info, probe=probe)
        out["attest"] = att
        out["detail"] = attest.summary(att)
        if not att["ok"]:
            out["state"] = "error"
    return out


def build() -> dict:
    doc = _empty()
    detail = {}
    for spec in config.DESKTOPS:
        p = probe_state(spec)
        detail[spec.id] = p["detail"]
        entry = {
            "id": spec.id,
            "name": spec.name,
            "port": spec.port,
            "state": p["state"],
            "container": spec.container,
            "containerId": p["containerId"],
            "generation": p["generation"],
            "appId": spec.app_id,
        }
        geometry = geometry_from_spec(spec)
        if geometry is not None:
            entry["geometry"] = geometry
        doc["desktops"].append(entry)
    doc["_detail"] = detail
    doc["_updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return doc


def sanitize(doc: dict) -> dict:
    """发布面 = 固定 8 字段 + 可选 geometry；_detail/_updatedAt 属本地诊断，只进 sidecar。

    geometry 只能显式逐键复制（见 validate_geometry）；损坏 / 重复 id 一律抛 ValueError
    fail-closed，绝不静默降级为 legacy，也绝不落到已存在的 registry 文件。
    """
    out = {"schemaVersion": doc.get("schemaVersion", config.SCHEMA_VERSION),
           "publicOrigin": doc.get("publicOrigin", config.PUBLIC_ORIGIN),
           "desktops": []}
    seen = set()
    for d in doc.get("desktops", []):
        entry = {k: d.get(k, "") for k in FIELDS}
        did = entry["id"]
        if isinstance(did, str) and did:
            if did in seen:
                raise ValueError("registry 重复 desktop id（fail-closed，不落盘）: %r" % (did,))
            seen.add(did)
        if isinstance(d, dict) and "geometry" in d:
            entry["geometry"] = validate_geometry(d["geometry"], did)
        out["desktops"].append(entry)
    return out


def write(doc: dict, path: str | None = None) -> str:
    p = path or config.REGISTRY_PATH
    # 先 sanitize（geometry 损坏 / 重复 id 会抛 ValueError）再动文件系统
    # ⇒ fail-closed 时已存在的 registry.json 与 sidecar 均原样保留。
    payload = json.dumps(sanitize(doc), indent=2, sort_keys=False) + "\n"
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = "%s.tmp-%d" % (p, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)
    side = p + ".detail.json"
    with open(side, "w", encoding="utf-8") as f:
        json.dump({"detail": doc.get("_detail", {}),
                   "updatedAt": doc.get("_updatedAt")}, f, indent=2, sort_keys=True)
    return p


def refresh(path: str | None = None) -> dict:
    doc = build()
    write(doc, path)
    return doc


def read(path: str | None = None) -> dict:
    p = path or config.REGISTRY_PATH
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return _empty()
    return data if isinstance(data, dict) else _empty()


def get(desktop_id: str, path: str | None = None) -> dict | None:
    for d in read(path).get("desktops", []):
        if d.get("id") == desktop_id:
            return d
    return None

