"""逐桌面声明的安全本机清单（纯解析：不部署、不建桌、不写盘、不起进程与容器）。

契约（root 任务卡 2026-11-14）：调用方显式给出一个本机清单文件路径，本模块只把它解析成
**新增** DesktopSpec 元组返回。现势 config.DESKTOPS 与既有桌面只作**只读身份比对**；
本模块不修改任何既有 spec，也不读写现役部署目录。是否集成由调用方（root）另行裁决。

文件形状（schemaVersion = 1，字段精确、禁未知额外键）：
  {"schemaVersion":1,"desktops":[{"id","name","port","relayPort","defaultApp",
                                "width","height","mode"}]}

fail-closed：文件门禁 / JSON 形状 / 任一条目 / 任一次标识冲突 => 整批抛 CatalogError，
没有半表，也没有任何副作用（不落盘、不改 config、不启动任何东西）。

安全边界：
- 路径由调用方提供：必须绝对路径；lstat + O_NOFOLLOW + fstat 双证为**普通文件**
  （软链一律拒，含指向合法内容的软链），大小 <= MAX_FILE_BYTES（64KB，等号允许）；
- port 只在调用方授权区间内（默认 25321..25329）；relayPort 只在 RELAY_PORT_MIN..MAX
  （6001..6999，保证 client_display_index = relayPort - 6000 是正整数 X 显示号）；
- 四种标识 id / port / relayPort / display 在既有桌面 + 本批新桌面内全局唯一
  => 新增不得覆盖既有 id / 目录 / port / relay / display / profile；
- 数值严格 int：bool、float、字符串、NaN、Infinity 一律拒；重复 JSON 键拒；
- name = 非空普通文本（<= 64 字符、无控制符，允许中文）；id 走 config.valid_id；
- width / height / mode 复用 config.normalize_geometry（成对 + 区间 + auto|fixed 枚举），
  清单条目必须给显式几何（mode = auto 未指定分辨率 / fixed 指定分辨率）。

本模块不 import 任何进程 / 容器 / 网络相关依赖，也不含任何写盘调用。

导入方向（root 2026-11-14 修订）：**模块体不 import config**。config 只在真正需要
config 对象的函数内部按需 from . import config（_validate_entry /
_existing_fingerprints / parse_desktop_catalog 三处）。这样 `from manager import catalog` 单独导入 catalog 时 **不会拉起 manager.config**，
config 末尾的 opt-in 加载（configure_catalog_from_environment）因此不存在导入期
双向环：两条导入顺序都拿到**已完成初始化**的 catalog，config 侧无需 exec_module /
reload 之类的补救。函数内 import 走 sys.modules 缓存，首次调用后零额外开销；
三处函数被调用时 config 必然已在 sys.modules 且所需名字（normalize_geometry /
DesktopSpec / DESKTOPS / valid_id）全部就绪：opt-in 加载的调用点在 config 文件末尾
（晚于上述全部定义与 `from . import catalog`），因此不会读到残缺属性。
行号随 config 演进变化，故此处不写行号（以符号名为准）。
"""
from __future__ import annotations

import json
import os
import stat

# 注意：这里**故意不在模块体 import config**（避免与 config 末尾的 opt-in 加载成环）。
# 需要 config 的函数各自在函数体内 from . import config。

__all__ = ("CatalogError", "read_catalog_source", "parse_desktop_catalog",
           "load_desktop_catalog")


class CatalogError(ValueError):
    """清单非法（文件门禁 / JSON 形状 / 条目字段 / 标识冲突）=> 整批拒绝。

    继承 ValueError，与发布面 validate_geometry / config.normalize_geometry 同族，
    调用方按 ValueError 捕获即可。本模块只抛这一族：不降级、不补齐、不部分成功。
    """


# ---- 形状常量（本模块单一来源；只读 config.*，不改写任何既有常量） --------------
SCHEMA_VERSION = 1
DOC_KEYS = ("schemaVersion", "desktops")
ENTRY_KEYS = ("id", "name", "port", "relayPort", "defaultApp",
              "width", "height", "mode")
DEFAULT_APPS = ("chrome", "vcmi")

MAX_FILE_BYTES = 64 * 1024            # 65536；等号允许，超出拒
NAME_MAX_LEN = 64

DISPLAY_INDEX_BASE = 6000             # client_display_index = relayPort - 6000
RELAY_PORT_MIN = DISPLAY_INDEX_BASE + 1
RELAY_PORT_MAX = DISPLAY_INDEX_BASE + 999

DEFAULT_ALLOWED_PORT_MIN = 25321
DEFAULT_ALLOWED_PORT_MAX = 25329
DEFAULT_MAX_EXTRA = 5
MAX_EXTRA_HARD_CAP = 64               # 调用方给的 max_extra 也设上限，防放大
PORT_FLOOR = 1
PORT_CEIL = 65535


# ------------------------------------------------------------------ 严格标量
def _want_int(value, label: str) -> int:
    """严格 int：bool 先拒（bool 是 int 子类），只认 int 本体；float/str/None 拒。"""
    if isinstance(value, bool) or type(value) is not int:
        raise CatalogError("%s must be int, got %s: %r"
                           % (label, type(value).__name__, value))
    return value


def _want_str(value, label: str) -> str:
    if type(value) is not str:
        raise CatalogError("%s must be str, got %s: %r"
                           % (label, type(value).__name__, value))
    return value


def _reject_constant(name: str):
    raise CatalogError("JSON 含非法常量 %r（只认有限数；NaN / Infinity 一律拒）" % (name,))


def _no_duplicate_keys(pairs):
    """重复键在 json.loads 默认语义下被后值静默覆盖 => 显式拒绝，不留歧义。"""
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise CatalogError("JSON 对象含重复键 %r" % (key,))
        seen.add(key)
    return dict(pairs)


def _parse_name(value, label: str) -> str:
    s = _want_str(value, label)
    if not s.strip():
        raise CatalogError("%s 不能为空文本: %r" % (label, value))
    if len(s) > NAME_MAX_LEN:
        raise CatalogError("%s 长度 %d 超上限 %d" % (label, len(s), NAME_MAX_LEN))
    if not s.isprintable():
        # isprintable 覆盖 Cc / Cf / Cs 等类别 => NUL、CR、LF、TAB、ESC 与孤立代理对全拒
        raise CatalogError("%s 含控制符或非可打印字符: %r" % (label, s))
    return s


def _read_all(fd: int, cap: int, p: str) -> bytes:
    """循环读满到 EOF，最多 cap 字节；短读（os.read 合法返回 < 请求量）不是缺陷。

    只累加不解释；超 cap 立即停（调用方按 len(raw) > 上限 判拒），不无限吞磁盘。
    """
    chunks = []
    total = 0
    while total < cap:
        try:
            part = os.read(fd, cap - total)
        except OSError as exc:
            raise CatalogError("清单读取失败: %s (%s)" % (p, exc.strerror or exc))
        if not part:
            break
        chunks.append(part)
        total += len(part)
    return b"".join(chunks)


# ------------------------------------------------------------------ 文件门禁
def read_catalog_source(path) -> str:
    """门禁 + 只读取字节 -> utf-8 文本。零写入、零目录创建、不追随软链。"""
    if isinstance(path, (bytes, bytearray)):
        raise CatalogError("path 必须是 str，实为 bytes（不猜编码）")
    if not isinstance(path, (str, os.PathLike)):
        raise CatalogError("path 必须是 str，实为 %s" % type(path).__name__)
    p = os.fspath(path)
    if type(p) is not str:
        raise CatalogError("path 必须是 str 路径，实为 %s" % type(p).__name__)
    if not p:
        raise CatalogError("path 不能为空")
    if not os.path.isabs(p):
        raise CatalogError("清单路径必须绝对: %r" % (p,))
    try:
        st = os.lstat(p)
    except OSError as exc:
        raise CatalogError("清单文件不可读: %s (%s)" % (p, exc.strerror or exc))
    if stat.S_ISLNK(st.st_mode):
        raise CatalogError("拒绝软链清单: %s" % (p,))
    if not stat.S_ISREG(st.st_mode):
        raise CatalogError("清单必须是普通文件: %s（类型 0o%o）"
                           % (p, stat.S_IFMT(st.st_mode)))
    if st.st_size > MAX_FILE_BYTES:
        raise CatalogError("清单超过 %d 字节上限: %s（实为 %d）"
                           % (MAX_FILE_BYTES, p, st.st_size))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(p, flags)
    except OSError as exc:
        raise CatalogError("打开清单失败: %s (%s)" % (p, exc.strerror or exc))
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise CatalogError("清单在打开瞬间已不是普通文件: %s" % (p,))
        if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            raise CatalogError("清单在门禁与打开之间被替换: %s" % (p,))
        if fst.st_size > MAX_FILE_BYTES:
            raise CatalogError("清单超过 %d 字节上限: %s（实为 %d）"
                               % (MAX_FILE_BYTES, p, fst.st_size))
        raw = _read_all(fd, MAX_FILE_BYTES + 1, p)
        # 读完后复核同一个 fd：并发写入 / 截断 / 换文件 => 内容不可信，整批拒绝
        after = os.fstat(fd)
        if (after.st_dev, after.st_ino) != (fst.st_dev, fst.st_ino):
            raise CatalogError("清单在读取期间被替换: %s" % (p,))
        if (after.st_size != fst.st_size
                or after.st_mtime_ns != fst.st_mtime_ns
                or after.st_ctime_ns != fst.st_ctime_ns):
            raise CatalogError("清单在读取期间被改写: %s（size %d -> %d）"
                               % (p, fst.st_size, after.st_size))
        if after.st_size != len(raw):
            raise CatalogError("清单读取长度与 size 不符: %s（读 %d，声明 %d）"
                               % (p, len(raw), after.st_size))
    finally:
        os.close(fd)
    if len(raw) > MAX_FILE_BYTES:
        raise CatalogError("清单读取超过 %d 字节上限: %s" % (MAX_FILE_BYTES, p))
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CatalogError("清单不是合法 utf-8: %s (%s)" % (p, exc.reason))


# ------------------------------------------------------------------ 条目校验
def _validate_entry(raw, where: str, port_min: int, port_max: int) -> dict:
    from . import config                       # 按需导入：见模块 docstring 导入方向
    if not isinstance(raw, dict):
        raise CatalogError("%s 必须是对象，实为 %s" % (where, type(raw).__name__))
    unknown = sorted(k for k in raw if k not in ENTRY_KEYS)
    if unknown:
        raise CatalogError("%s 含未知键 %s（允许键 = %s）"
                           % (where, ",".join(repr(k) for k in unknown),
                              ",".join(ENTRY_KEYS)))
    missing = [k for k in ENTRY_KEYS if k not in raw]
    if missing:
        raise CatalogError("%s 缺键 %s" % (where, ",".join(missing)))

    did = _want_str(raw["id"], where + ".id")
    if not config.valid_id(did):
        raise CatalogError("%s.id 非法: %r（规则 = config.valid_id：小写字母数字与连字符、"
                           "禁穿越与超长）" % (where, did))
    name = _parse_name(raw["name"], where + ".name")

    port = _want_int(raw["port"], where + ".port")
    if port < port_min or port > port_max:
        raise CatalogError("%s.port=%d 不在授权区间 %d..%d"
                           % (where, port, port_min, port_max))

    relay = _want_int(raw["relayPort"], where + ".relayPort")
    if relay < RELAY_PORT_MIN or relay > RELAY_PORT_MAX:
        raise CatalogError("%s.relayPort=%d 不在 %d..%d"
                           % (where, relay, RELAY_PORT_MIN, RELAY_PORT_MAX))
    display = relay - DISPLAY_INDEX_BASE
    if display < 1:
        raise CatalogError("%s.relayPort=%d 无法生成正整数显示号" % (where, relay))

    app = _want_str(raw["defaultApp"], where + ".defaultApp")
    if app not in DEFAULT_APPS:
        raise CatalogError("%s.defaultApp 必须是 %s，实为 %r"
                           % (where, "/".join(DEFAULT_APPS), app))

    try:
        w, h, mode = config.normalize_geometry(raw["width"], raw["height"], raw["mode"])
    except ValueError as exc:
        raise CatalogError("%s 几何非法: %s" % (where, exc))
    if w is None or h is None or mode is None:
        # 字段精确校验下不可达；留着做纵深防御，绝不静默回退 1600x900
        raise CatalogError("%s 几何不完整: %r %r %r"
                           % (where, raw["width"], raw["height"], raw["mode"]))
    return {"id": did, "name": name, "port": port, "relay": relay, "display": display,
            "app": app, "width": w, "height": h, "mode": mode}


def _existing_fingerprints(existing_specs) -> list:
    """既有桌面 -> [(id, port, relay, display)]。只读，不触碰入参对象。"""
    from . import config                       # 按需导入：见模块 docstring 导入方向
    if existing_specs is None or isinstance(existing_specs, (str, bytes)):
        raise CatalogError("existing_specs 必须是 DesktopSpec 序列")
    try:
        items = list(existing_specs)
    except TypeError:
        raise CatalogError("existing_specs 必须是 DesktopSpec 序列，实为 %s"
                           % type(existing_specs).__name__)
    out = []
    for i, s in enumerate(items):
        if not isinstance(s, config.DesktopSpec):
            raise CatalogError("existing_specs[%d] 不是 DesktopSpec，实为 %s"
                               % (i, type(s).__name__))
        port = _want_int(s.port, "existing_specs[%d].port" % i)
        relay = _want_int(s.relay_port, "existing_specs[%d].relay_port" % i)
        display = s.client_display_index
        if display is None:
            display = relay - DISPLAY_INDEX_BASE
        out.append((s.id, port, relay,
                    _want_int(display, "existing_specs[%d].display" % i)))
    return out


def _claim(used: dict, kind: str, value, owner: str, where: str) -> None:
    prev = used[kind].get(value)
    if prev is not None:
        raise CatalogError("%s.%s=%r 与 %s 冲突（id/port/relay/display 全局唯一，"
                           "新增不得覆盖既有桌面）" % (where, kind, value, prev))
    used[kind][value] = "%s %s" % (kind, owner)


# ------------------------------------------------------------------ 公开入口
def parse_desktop_catalog(text: str, existing_specs, *,
                          allowed_port_min: int = DEFAULT_ALLOWED_PORT_MIN,
                          allowed_port_max: int = DEFAULT_ALLOWED_PORT_MAX,
                          max_extra: int = DEFAULT_MAX_EXTRA,
                          source: str = "<inline>") -> tuple:
    """清单文本 -> 新增 DesktopSpec 元组（保持文件顺序）。见模块 docstring 契约。"""
    from . import config                       # 按需导入：见模块 docstring 导入方向
    port_min = _want_int(allowed_port_min, "allowed_port_min")
    port_max = _want_int(allowed_port_max, "allowed_port_max")
    extra_cap = _want_int(max_extra, "max_extra")
    if not (PORT_FLOOR <= port_min <= port_max <= PORT_CEIL):
        raise CatalogError("授权区间非法: %d..%d（需 1 <= min <= max <= 65535）"
                           % (port_min, port_max))
    if not (0 <= extra_cap <= MAX_EXTRA_HARD_CAP):
        raise CatalogError("max_extra=%d 需 0..%d" % (extra_cap, MAX_EXTRA_HARD_CAP))
    existing = _existing_fingerprints(existing_specs)

    _want_str(text, "清单文本")
    try:
        doc = json.loads(text, object_pairs_hook=_no_duplicate_keys,
                         parse_constant=_reject_constant)
    except CatalogError:
        raise
    except ValueError as exc:
        raise CatalogError("清单不是合法 JSON: %s (%s)" % (source, exc))

    if not isinstance(doc, dict):
        raise CatalogError("清单顶层必须是对象，实为 %s" % type(doc).__name__)
    unknown = sorted(k for k in doc if k not in DOC_KEYS)
    if unknown:
        raise CatalogError("清单顶层含未知键 %s（允许键 = %s）"
                           % (",".join(repr(k) for k in unknown), ",".join(DOC_KEYS)))
    for k in DOC_KEYS:
        if k not in doc:
            raise CatalogError("清单顶层缺键 %r" % (k,))
    schema = _want_int(doc["schemaVersion"], "schemaVersion")
    if schema != SCHEMA_VERSION:
        raise CatalogError("schemaVersion=%r 只认 %d"
                           % (doc["schemaVersion"], SCHEMA_VERSION))
    entries = doc["desktops"]
    if type(entries) is not list:
        raise CatalogError("desktops 必须是数组，实为 %s" % type(entries).__name__)
    if len(entries) > extra_cap:
        raise CatalogError("额外桌面条目数 %d 超 max_extra=%d"
                           % (len(entries), extra_cap))

    parsed = [_validate_entry(raw, "desktops[%d]" % i, port_min, port_max)
              for i, raw in enumerate(entries)]

    used = {"id": {}, "port": {}, "relay": {}, "display": {}}
    for did, port, relay, display in existing:
        _claim(used, "id", did, did, "existing")
        _claim(used, "port", port, did, "existing")
        _claim(used, "relay", relay, did, "existing")
        _claim(used, "display", display, did, "existing")
    for e in parsed:
        where = "desktops[%s]" % e["id"]
        _claim(used, "id", e["id"], e["id"], where)
        _claim(used, "port", e["port"], e["id"], where)
        _claim(used, "relay", e["relay"], e["id"], where)
        _claim(used, "display", e["display"], e["id"], where)

    # 全部校验通过后才构造；project_suffix 传 None => DesktopSpec 读 config.PROJECT_SUFFIX
    return tuple(config.DesktopSpec(e["id"], e["name"], e["port"], e["relay"], e["display"],
                                    e["app"], None,
                                    frame_width=e["width"], frame_height=e["height"],
                                    resize_mode=e["mode"])
                 for e in parsed)


def load_desktop_catalog(path, existing_specs, *,
                         allowed_port_min: int = DEFAULT_ALLOWED_PORT_MIN,
                         allowed_port_max: int = DEFAULT_ALLOWED_PORT_MAX,
                         max_extra: int = DEFAULT_MAX_EXTRA) -> tuple:
    """读本机清单文件并解析成新增 DesktopSpec 元组（纯只读；契约见模块 docstring）。

    返回**只含新增桌面**的 tuple；existing_specs 原样不动，合并策略由调用方裁决。
    """
    return parse_desktop_catalog(read_catalog_source(path), existing_specs,
                                 allowed_port_min=allowed_port_min,
                                 allowed_port_max=allowed_port_max,
                                 max_extra=max_extra, source=str(path))

