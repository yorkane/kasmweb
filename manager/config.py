"""常量与路径契约。所有值单一来源，其余模块只 import，不重复定义。

deploy 根 = /data/app/webtop-kasmvnc/（process/data/state/compose 唯一落点；
image-probe 子目录属镜像 worker，只读）。临时面 = /data/tmp/webtop-kasmvnc-manager-*。
"""
from __future__ import annotations

import os
import re

SCHEMA_VERSION = 1
VERSION = "0.1.2"

PRODUCT = "webtop-kasmvnc"
APP_ROOT = os.environ.get("WT_KASM_APP_ROOT", "/data/app/webtop-kasmvnc").rstrip("/") or "/data/app/webtop-kasmvnc"
DESKTOPS_DIR = APP_ROOT + "/desktops"
REGISTRY_PATH = APP_ROOT + "/registry.json"
STATE_DIR = APP_ROOT + "/state"
LOG_DIR = APP_ROOT + "/logs"
SOCK_DIR = APP_ROOT + "/sock"
CONTROL_SOCKET = SOCK_DIR + "/control.sock"

TEMP_ROOT = "/data/tmp"
TEMP_PREFIX = "webtop-kasmvnc-manager-"
# 测试/安装可用 WT_KASM_TRASH 覆盖；消费侧只读 config.TRASH_ROOT，不再各自读 env
TRASH_ROOT = os.environ.get("WT_KASM_TRASH", "/data/.trash").rstrip("/") or "/data/.trash"
PORT_LOCK_DIR = "/data/tmp/webtop-channel-port-locks"

# 正式默认 = 最新已发布 tag（root 2026-11-13 授权：0.1.1 → 0.1.2）。
# 0.1.2 = 0.1.1 的热修复：quick_exec + 755 受管 icons + 绝对 png 固化；schema 不变。
# 记账一律按 docker inspect 的 Image ID，不按 tag ⇒ tag 被追新也不误判。
# 旧 0.1.1（imageID 22ee7eb0d759…）与 0.1.0（c0335cfb86f6…）按 root 裁决**冻结保留**、
# 不覆盖 tag；部署侧可用 WT_KASM_IMAGE 显式回退。
# kasmweb 线默认 = 本仓库自产镜像的已发布 tag（CI 推 ghcr.io/yorkane/kasmweb）；
# WT_KASM_IMAGE 覆盖能力不变（离线本地 tag kasmweb:local-verify 等回退照旧）。
IMAGE = os.environ.get("WT_KASM_IMAGE", "ghcr.io/yorkane/kasmweb:latest")

# ------------------------------------------------- 自适应镜像（逐桌选择性镜像，启动期）
# root 任务卡 2026-11-15：镜像逐桌隔离启用。**未设置 = 现势逐字节不变**。
#   WT_KASM_ADAPTIVE_IMAGE=<显式镜像引用>   （默认空）
# 选中规则 = **只有 resize_mode == "auto" 的桌面**用该镜像；legacy（None）与 fixed 桌面
# 继续用 config.IMAGE。理由：自适应缩放是新镜像的增量特性，逐桌启用时未选中的旧容器仍跑
# 在旧 tag 上；若全桌统一切镜像，ownership 的 image 双核会把它们判成 error ⇒ 与逐桌启用
# 自相矛盾。所以"用哪个 tag"必须按 spec 逐桌判定，判定唯一入口 = config.image_for。
#
# fail-closed 与不猜（与上方 IMAGE 契约同纪律，不削弱任何镜像能力认证）：
#   - 值必须是显式带 tag 或 @sha256:digest 的**合法 Docker 引用**；无 tag（隐式 latest）/
#     latest / 含空白（含首尾空白）/ 含 = / 以 - 开头 / 形态非法 ⇒ 导入期抛 ValueError，
#     不 trim、不补全、不猜 registry 与 namespace ⇒ 绝不覆盖既有 tag。
#     引用形态逐段校验（root 2026-11-15 评审补强）：
#       registry[:port]（小写 host + 端口 1..65535 无前导零）/ 仓库路径组件（小写、
#       非空段、首尾字母数字、连接符只允许 . _ -）/ tag（最后一个 '/' 之后**恰好一个**
#       冒号，故 a:b:c、x/y:1:2、reg:5000/:1 一律拒；末位允许 . - _，例 'test_' 合法）/
#       digest（仅 sha256:64hex）。逐段口径详见 _split_image_ref 文档。
#   - 本变量**不改写** config.IMAGE，也不触发 build/pull（compose 只核 tag 存在）。
#   - 能力认证链不变：attest 按容器 inspect 的 immutable digest 认锚、**不按 tag**
#     ⇒ 换 tag 不获得任何旁路；image_for 只决定"起容器用哪个 tag / 认领时比对哪个 tag"。
#   - 热重载 = 无（与 CATALOG_FILE / BASE_AUTO 同纪律）。
ADAPTIVE_IMAGE_ENV = "WT_KASM_ADAPTIVE_IMAGE"
ADAPTIVE_IMAGE: str = ""            # 现势（"" = 未启用）

IMAGE_PATH_COMPONENT_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\Z")  # 仓库路径单段（小写，禁 ':'）
IMAGE_HOST_LABEL_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\Z")        # registry 主机标签（禁 '_' / 空标签）
IMAGE_TAG_RE = re.compile(r"\A[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\Z")            # 字符集/长度按 Docker 规范：首字符字母数字或 '_'，末位允许 . - _
IMAGE_DIGEST_RE = re.compile(r"\Asha256:[0-9a-f]{64}\Z")
IMAGE_PATH_MAX = 255                        # 每段长度上限（distribution 规范）


def _reject_ref(why: str, raw: str):
    raise ValueError("%s 的镜像引用非法（%s）: %r" % (ADAPTIVE_IMAGE_ENV, why, raw))


IMAGE_PORT_RE = re.compile(r"\A[1-9][0-9]{0,4}\Z")       # 无前导零的十进制端口串


def _check_registry(head: str, raw: str) -> None:
    """registry[:port] 形态：host = 点分标签（小写、非空、首尾字母数字），端口 1..65535。

    端口只认无前导零的 ASCII 十进制（"05000" / "1_0" / 全角数字一律拒），且必须在
    1..65535；host 标签禁 '_' / 空标签 / 首尾 '-'（纯 IPv4 registry 合法：四段数字标签）。
    """
    host, sep, port = head.partition(":")
    if sep:
        if not IMAGE_PORT_RE.match(port) or not (1 <= int(port) <= 65535):
            _reject_ref("registry 端口非法（要 1..65535 的十进制，无前导零）", raw)
    if not host:
        _reject_ref("registry 主机为空", raw)
    for label in host.split("."):
        if not IMAGE_HOST_LABEL_RE.match(label):
            _reject_ref("registry 主机标签非法 %r（禁 '_' / 空标签 / 首尾 - ）" % (label,), raw)


def _split_image_ref(raw: str) -> tuple:
    """拆 Docker 引用 -> (registry|None, repository, tag|None, digest|None)；非法一律抛 ValueError。

    逐段校验（root 2026-11-15 评审：旧实现放过 a:b:c、reg:5000/:1、x/y:1:2）：
      - registry 判定 = 第一个 '/' 之前的组件含 ':' 或 '.'（distribution 规范），并校验
        host[:port]；其余全算仓库路径；
      - 仓库路径每段非空、小写、首尾字母数字、连接符只允许 . _ - 、长度 <= 255 ⇒
        '//'/':1'/首尾 '/' 一律拒；
      - tag = 最后一段的**最后一个**冒号之后，且该段只允许一个冒号 ⇒ a:b:c / x/y:1:2 拒；
        冒号后为空（'x/y:'）拒；tag 字符集与长度按规范（首字符字母数字或 '_'，其后
        可含 . _ - ，**末位允许 . - _** ⇒ 'test_' / '0.2.0-' / '0.2.0-x86_64' 合法）；
      - digest 仅认 sha256:64hex，且 '@' 只允许出现一次（partition 首 '@' 后 name 内无 '@'）。
    本函数不判"必须有 tag/digest"与"禁 latest"（由调用方按本开关策略判）。

    口径 = 本开关自定的 fail-closed 子集：registry = 小写 host[:port]（端口 1..65535，
    无前导零）；仓库段非空、小写、首尾字母数字、连接符只允许 . _ -；tag =
    [A-Za-z0-9_][A-Za-z0-9._-]{0,127}（末位可为 . - _）；digest 仅 sha256:64hex。
    **不承诺覆盖完整 Docker 引用语法**（如 '+'、sha512 一律拒），也不做与规范的逐条比较；
    本函数只保证"能解析 ⇒ 无多冒号 / 无空段 / 无 host 注入面"。

    返回的 repository 已去掉 ':tag'，可直接用于逐段核对；registry 为 None 表示未带域名。
    """
    name, sep, digest_part = raw.partition("@")
    if sep and not digest_part:
        _reject_ref("'@' 之后缺 digest", raw)
    digest = digest_part if sep else None
    if digest is not None and not IMAGE_DIGEST_RE.match(digest):
        _reject_ref("@digest 形态不合法（只认 sha256:64hex）", raw)
    if not name:
        _reject_ref("缺 repository（只有 @digest）", raw)
    head, slash, rest = name.partition("/")
    registry = None
    if slash and (":" in head or "." in head):
        registry = head
        _check_registry(head, raw)
        repository = rest
    else:
        repository = name
    if not repository:
        _reject_ref("registry 之后缺 repository", raw)
    comps = repository.split("/")
    tag = None
    last = comps[-1]
    if ":" in last:
        comp, _, tag = last.partition(":")
        if ":" in tag:
            _reject_ref("repository:tag 段含多个冒号", raw)
        if not comp:
            _reject_ref("tag 之前为空路径段", raw)
        if not tag:
            _reject_ref("':' 之后缺 tag", raw)
        if not IMAGE_TAG_RE.match(tag):
            _reject_ref("tag 形态不合法", raw)
        comps[-1] = comp
        repository = "/".join(comps)        # 返回去 tag 后的干净仓库路径
    for c in comps:
        if not c:
            _reject_ref("仓库路径含空段（'//' / 首尾 '/'）", raw)
        if len(c) > IMAGE_PATH_MAX:
            _reject_ref("仓库路径段超 %d 字符" % IMAGE_PATH_MAX, raw)
        if not IMAGE_PATH_COMPONENT_RE.match(c):
            _reject_ref("仓库路径段 %r 非法（小写字母数字起头收尾，仅可含 . _ -）" % (c,), raw)
    return (registry, repository, tag, digest)


def _parse_adaptive_image(env=None) -> str:
    """解析 WT_KASM_ADAPTIVE_IMAGE -> 生效镜像引用（"" = 未启用）。非法一律抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(ADAPTIVE_IMAGE_ENV)
    if raw is None:
        return ""
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (ADAPTIVE_IMAGE_ENV, type(raw).__name__, raw))
    if not raw.strip():
        return ""                              # 未设置 / 空串 / 纯空白 = 未启用
    if raw != raw.strip():
        raise ValueError("%s 含前后空白（不 trim、不猜）: %r" % (ADAPTIVE_IMAGE_ENV, raw))
    if any(ch.isspace() for ch in raw):
        raise ValueError("%s 含空白字符（镜像引用不允许）: %r" % (ADAPTIVE_IMAGE_ENV, raw))
    if "=" in raw:
        raise ValueError("%s 含 '='（不是合法镜像引用）: %r" % (ADAPTIVE_IMAGE_ENV, raw))
    if raw.startswith("-"):
        raise ValueError("%s 以 '-' 开头（会被当作命令行参数）: %r" % (ADAPTIVE_IMAGE_ENV, raw))
    # partition 无 '@' 时右值是空串而非 None ⇒ 在 _split_image_ref 内按 sep 归一，否则
    # "无显式 tag 无 digest"的裸镜像名逃过拒绝（root 2026-11-15 评审抓出）。
    _, _, tag, digest = _split_image_ref(raw)
    if tag is None and digest is None:
        raise ValueError("%s=%r 无显式 tag 也无 digest（隐式 latest = 猜 ⇒ 拒绝）"
                         % (ADAPTIVE_IMAGE_ENV, raw))
    if tag == "latest":
        raise ValueError("%s 拒绝 tag 'latest'（必须显式钉版本）: %r" % (ADAPTIVE_IMAGE_ENV, raw))
    return raw


def configure_adaptive_image_from_environment(env=None) -> str:
    """自适应镜像 opt-in（公开 API）；返回生效值（"" = 未启用）。契约见上方块注释。

    同值重复调用 = 幂等返回；已生效的进程改清单 ⇒ 抛（热重载=无，重启 manager 生效）。
    空值调用返回 "" 且**不清除**已生效现势 ⇒ 不存在运行时关闭入口（与 BASE_AUTO 同形）。
    """
    global ADAPTIVE_IMAGE
    got = _parse_adaptive_image(env)
    if not got:
        return ""
    if ADAPTIVE_IMAGE:
        if ADAPTIVE_IMAGE == got:
            return got
        raise ValueError("%s 已生效为 %s ⇒ 同进程不得改为 %s（热重载=无，重启 manager 生效）"
                         % (ADAPTIVE_IMAGE_ENV, ADAPTIVE_IMAGE, got))
    ADAPTIVE_IMAGE = got
    return got


def image_for(spec) -> str:
    """逐桌镜像选择的**唯一入口**：auto 桌且已设自适应镜像 -> 该镜像；其余 -> config.IMAGE。

    消费侧（compose.render / compose.ownership / compose.start / actions 的 init 诊断与
    verify）一律经本函数取镜像，不得各自读 config.IMAGE，否则渲染与认领指向不同 tag
    （= 本次修的部署阻断）。
    """
    if ADAPTIVE_IMAGE and getattr(spec, "resize_mode", None) == "auto":
        return ADAPTIVE_IMAGE
    return IMAGE


def image_plan() -> list:
    """init 诊断用：按渲染顺序聚合 [{"image", "desktops"}]（多图如实逐条列出）。"""
    out: list = []
    seen: dict = {}
    for s in DESKTOPS:
        img = image_for(s)
        if img not in seen:
            seen[img] = {"image": img, "desktops": []}
            out.append(seen[img])
        seen[img]["desktops"].append(s.id)
    return out
PULL_POLICY = "never"
CONTAINER_PREFIX = "wt-kasm-"
COMPOSE_PROJECT_PREFIX = "wt-kasm-"
# 升级期 project 版本后缀（root 2026-11-13 裁决）：
#   ""     = 生产现势（compose 内 name: 与 CLI -p 同为 wt-kasm-<id>）
#   "-v012" = 0.1.1→0.1.2 换镜像窗口：旧容器 rename 后仍带 com.docker.compose.project
#             =wt-kasm-<id> 标签，在**旧 project** 里 `compose up` 会按标签发现它并自动
#             recreate + docker remove ⇒ 违反零删除。换新 project 后旧 project 只剩留证容器。
# 正常 CLI（new / start / stop）经 DesktopSpec.project 自动跟随本值，无需其它改动。
# 逐桌启用（迁移窗口）见下方 ADAPTIVE_PROJECT_SUFFIX_ENV 块：全量换本值会影响**所有
# 未迁移桌**的 project 面，逐桌迁移走该开关（调用者显式传 project_suffix 的 spec 优先级最高）。
# 正式默认 = -v012（root 2026-11-13 裁决：生产现势 project 即 wt-kasm-<id>-v012，
# 正常 CLI / daemon / 重装 unit 不得回旧 project；fixture 与测试用 env 覆盖为 ""）。
# 导入期形态校验（评审 A8）：与逐桌后缀同一字符集口径（PROJECT_SUFFIX_RE，见下方
# 逐桌开关块）。全局后缀同样进 compose project 全名与 CLI -p，非法形态必须在这里
# 抛，不留到 docker 启动期才炸；"" = 合法（生产现势的无后缀形态）。
PROJECT_SUFFIX = os.environ.get("WT_KASM_PROJECT_SUFFIX", "-v012")
if PROJECT_SUFFIX not in ("",) and not re.fullmatch(r"-?[a-z0-9][a-z0-9_-]{0,62}", PROJECT_SUFFIX):
    raise ValueError("WT_KASM_PROJECT_SUFFIX 形态非法: %r（要 ^-?[a-z0-9][a-z0-9_-]{0,62}$"
                     " 或空串：小写、禁 '.'/空白/路径/'='/注入面/大写；含前导 '-' 总长 <= 63）"
                     % (PROJECT_SUFFIX,))

# ------------------------------------------------- 逐桌 project 后缀（迁移窗口，启动期 opt-in）
# root 任务卡 2026-11-15：上方 PROJECT_SUFFIX 是**进程级全局单值** => 换它 = 同时换**全部**桌面
# 的 project 面，未迁移桌的 compose.yaml 与生命周期会被邻居桌的迁移连带改写（= 逐桌迁移的结构性
# 阻断）。本开关提供**逐桌**通道：要让现有 25320 桌面真实自适应而**采用新镜像**时，为保留旧容器
# 需要新 compose project；本后缀只作用于**显式启用**且 **resize_mode == "auto"** 的桌面，
# legacy（resize_mode=None）与 fixed 桌面继续用 config.PROJECT_SUFFIX。
#   WT_KASM_ADAPTIVE_PROJECT_SUFFIX=<逐桌新后缀>   （默认空 = 未启用）
#
# 默认零差异（未设置 = 现势逐字节不变）：未启用时 project_suffix_for 恒等于 PROJECT_SUFFIX
# => DesktopSpec.project / compose.render 的 name: / compose CLI 的 -p 实参全部与启用前逐字节
# 相同；registry 发布面字段集不变（project 不进发布面）。
#
# 优先级（唯一入口 = project_suffix_for，消费侧不得各自读 config.PROJECT_SUFFIX）：
#   1) 调用者显式传入的 project_suffix 形参（含 ""）**最高**，本开关不得遮蔽
#      => 既有测试/脚本的逐 spec 覆盖点（project_suffix="" / "-v012"）语义不变；
#   2) 本开关（仅 resize_mode == "auto" 的桌）；
#   3) config.PROJECT_SUFFIX。
#   形参传 None = "无显式覆盖"= 交本开关逐桌判定（清单桌面条目的构造走这条）。
#   显式与继承**按构造期来源标记**（DesktopSpec.project_suffix_explicit = 形参 is not None），
#   不看值相等 => 调用者显式传 "-v012"（与全局逐字相同）同样记为显式意图。
#   既有 spec 的几何翻转用**原实例**（身份字段逐字保留），其后缀形参经 _spec_project_suffix
#   按该标记分流，避免"原实例算好的旧全局值"遮蔽本开关。
#
# fail-closed 与不猜（与 ADAPTIVE_IMAGE 同纪律）：
#   - 形态 = Compose project 名的后缀片段口径：^[a-z0-9][a-z0-9_-]{0,62}$
#     见下方 PROJECT_SUFFIX_RE（小写字母数字主体，其后仅 a-z 0-9 _ - ；**长度按整个串计，
#     前导 '-' 计入，片段上限 63**）；root 评审裁决 2026-11-15：**'.' 全面移除** ——
#     Docker Compose 的 project 名校验不接受 '.'，解析期放过会在启动期才炸 ⇒ 直接拒；
#     全名首字符由 COMPOSE_PROJECT_PREFIX 的 'w' 提供，片段只含 [a-z0-9_-] ⇒ 全名必过
#     Compose 校验；project 全名（前缀 + id + 后缀）超 PROJECT_NAME_MAX 在取值时抛，
#     不截断不猜；
#   - 允许**单个前导 '-'**（现势 -v012 即此形态；Compose 校验的是**全名**，全名首字符由
#     COMPOSE_PROJECT_PREFIX 的 'w' 提供 ⇒ 前导 '-' 不使全名违规，且逐桌新后缀必须能与现势
#     同形态（-v012 -> -vauto），否则与迁移脚本 --new-project-suffix 的取值不互通；
#     CLI 侧 -p 以**独立 argv** 传值、无 shell，故无注入面）；'-' 单独成串、'--x' 双前导拒；
#   - 一律拒绝（导入期抛 ValueError，不 trim、不补全、不猜 registry/命名空间、不隐式转换）：
#     含空白（含首尾空白）/ 含 '/' 或以 '.' 起头（路径面）/ 含 '=' 与 shell 与 CLI 注入面
#     （; & | $ ( ) < > 反引号 等，均被字符集拒）/ 大写 / 空段 / 超长；
#   - 未设置 / 空串 / 纯空白 = 关闭（关闭 = 现势逐字节不变），且无运行时关闭入口；
#   - 本开关**不改写** config.PROJECT_SUFFIX，不接触 docker：真实容器迁移（rename / 换 project
#     的 compose up / 台账改写）**不在本任务范围**，迁移脚本的 apply 路径仍按 root 裁决硬禁用；
#     本模块只负责"逐桌 project 名从哪来"这一条配置通道。
#   - 同进程改清单 = 抛（热重载 = 无，与 CATALOG_FILE / BASE_AUTO / ADAPTIVE_IMAGE 同纪律）。
ADAPTIVE_PROJECT_SUFFIX_ENV = "WT_KASM_ADAPTIVE_PROJECT_SUFFIX"
ADAPTIVE_PROJECT_SUFFIX: str = ""           # 现势（"" = 未启用）
PROJECT_NAME_MAX = 64                       # Compose project 全名长度上限
PROJECT_SUFFIX_RE = re.compile(r"\A-?[a-z0-9][a-z0-9_-]{0,62}\Z")       # 片段 <=63（含前导 '-'）；禁 '.'（root 评审 2026-11-15）


def _reject_project_suffix(why: str, raw) -> None:
    raise ValueError("%s 的 project 后缀非法（%s）: %r"
                     % (ADAPTIVE_PROJECT_SUFFIX_ENV, why, raw))


def _parse_adaptive_project_suffix(env=None) -> str:
    """解析 WT_KASM_ADAPTIVE_PROJECT_SUFFIX -> 生效后缀（"" = 未启用）。非法一律抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(ADAPTIVE_PROJECT_SUFFIX_ENV)
    if raw is None:
        return ""
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (ADAPTIVE_PROJECT_SUFFIX_ENV, type(raw).__name__, raw))
    if len(raw) > 63:
        _reject_project_suffix("长度 %d 超 63（片段总长上限，前导 '-' 计入）" % len(raw), raw)
    if not raw.strip():
        return ""                              # 未设置 / 空串 / 纯空白 = 未启用
    if raw != raw.strip():
        _reject_project_suffix("含前后空白（不 trim、不猜）", raw)
    if any(ch.isspace() for ch in raw):
        _reject_project_suffix("含空白字符", raw)
    if raw.startswith("--"):
        _reject_project_suffix("以连续 '-' 开头（只允许单个前导 '-'）", raw)
    if not PROJECT_SUFFIX_RE.match(raw):
        _reject_project_suffix("形态不合法（要 ^-?[a-z0-9][a-z0-9_-]{0,62}$：小写、非空、"
                               "禁 '.'（Compose project 名不接受）/ 禁空白 / 路径 / '=' / "
                               "注入面 / 大写；总长（含前导 '-'）<= 63）",
                               raw)
    return raw


def configure_adaptive_project_suffix_from_environment(env=None) -> str:
    """逐桌 project 后缀 opt-in（公开 API）；返回生效值（"" = 未启用）。契约见上方块注释。

    同值重复调用 = 幂等返回；已生效的进程改清单 => 抛（热重载 = 无，重启 manager 生效）。
    空值调用返回 "" 且**不清除**已生效现势 => 不存在运行时关闭入口（与 ADAPTIVE_IMAGE 同形）。
    """
    global ADAPTIVE_PROJECT_SUFFIX
    got = _parse_adaptive_project_suffix(env)
    if not got:
        return ""
    if ADAPTIVE_PROJECT_SUFFIX:
        if ADAPTIVE_PROJECT_SUFFIX == got:
            return got
        raise ValueError("%s 已生效为 %s => 同进程不得改为 %s（热重载=无，重启 manager 生效）"
                         % (ADAPTIVE_PROJECT_SUFFIX_ENV, ADAPTIVE_PROJECT_SUFFIX, got))
    ADAPTIVE_PROJECT_SUFFIX = got
    return got


def project_suffix_for(spec) -> str:
    """逐桌 project 后缀的**唯一入口**：auto 桌且已设逐桌后缀 -> 该后缀；其余 -> PROJECT_SUFFIX。

    消费侧（DesktopSpec 构造期、以及复制既有 spec 的路径）一律经本函数取后缀，不得各自读
    config.PROJECT_SUFFIX，否则渲染（compose name:）与认领/停启（-p 实参）指向不同 project
    => 逐桌迁移自相矛盾。project 全名超 PROJECT_NAME_MAX 抛 ValueError（不静默截断）。
    未启用逐桌后缀时本函数恒等于 config.PROJECT_SUFFIX => 现势逐字节不变。
    """
    if ADAPTIVE_PROJECT_SUFFIX and getattr(spec, "resize_mode", None) == "auto":
        name = COMPOSE_PROJECT_PREFIX + str(spec.id) + ADAPTIVE_PROJECT_SUFFIX
        if len(name) > PROJECT_NAME_MAX:
            raise ValueError("%s 使桌面 %r 的 project 全名 %r 超 %d 字符（Compose project 名上限，"
                             "不截断不猜）" % (ADAPTIVE_PROJECT_SUFFIX_ENV, spec.id, name,
                                              PROJECT_NAME_MAX))
        return ADAPTIVE_PROJECT_SUFFIX
    return PROJECT_SUFFIX
def _assert_projects_unique(specs, where: str) -> None:
    """project 全名逐字唯一（迁移窗口硬不变量）：两张桌 = 同一个 Compose project 即抛。

    为什么必须显式校验（root 评审裁决 2026-11-15）：**id 全局唯一推不出 project 唯一**。
    逐桌后缀只对 auto 桌生效，于是存在跨桌组合让一张桌的新 project 逐字等于另一张桌的
    现势 project（例：auto 桌 "a" + 后缀 "-b-v012" => "wt-kasm-a-b-v012"，与 legacy 桌
    "a-b" + 全局后缀 "-v012" 同名；桌面 id 允许连字符，后缀只禁连续 '-' 与 '.'）。
    后果不是命名难看而是**生命周期互踩**：两张桌共用一个 project 后，一侧的 compose
    up / stop 会驱动另一侧的容器，逐桌迁移变成互相覆写。
    消费面（compose.render 的 name: / CLI 的 -p 实参）全部读 DesktopSpec.project
    ⇒ 按 project 比对即覆盖两条路径。调用位置 = 基表导入末尾 + 清单合并 +
    base-auto 翻转，全部在**一次性重绑全局之前** ⇒ fail-closed：抛穿时现役注册表逐字
    未动、无半表；未启用逐桌后缀时 project 逐字 = 前缀 + id + 全局后缀，id 唯一 ⇒ 恒通过。
    """
    seen = {}
    for s in specs:
        proj = s.project
        prev = seen.get(proj)
        if prev is not None:
            raise ValueError("%s 出现 project 全名冲突：桌面 %r 与 %r 同名 project %r"
                             "（逐桌后缀只对 auto 桌生效 ⇒ 跨桌组合可与邻居桌现势同名；"
                             "id 唯一不蕴含 project 唯一 ⇒ 拒绝登记，全局逐字未动）"
                             % (where, prev, s.id, proj))
        seen[proj] = s.id


def _validate_project_uniqueness(specs=None, where: str = "桌面注册表") -> None:
    """对合并结果（缺省 = 现势 DESKTOPS）按当前后缀现势校验 project 全名唯一。"""
    _assert_projects_unique(tuple(DESKTOPS if specs is None else specs), where)


def _spec_project_suffix(spec) -> str | None:
    """复制既有 spec（BASE_AUTO 几何翻转）时该传的 project_suffix 形参值。

    翻转必须复用**原实例**（id / 端口 / 挂载 / profile 逐字保留），但把原实例已算好的
    project_suffix 当**显式覆盖**传回去会遮蔽本开关（原实例是 legacy，翻转后才 auto，
    后缀会停在旧全局值）。因此按**来源标记**分流（root 2026-11-15 审阅裁决：值相等判据
    无法区分"调用者显式传 -v012"与"继承全局 -v012" => 不看取值，只看构造期来源）：
      - spec.project_suffix_explicit 为真 => 原样返回该值（含与 config.PROJECT_SUFFIX
        逐字相同的显式值、含 ""），新实例同样记为显式，显式优先级不变；
      - 继承（构造期未传形参）=> 返回 None，让新实例按翻转后的几何重新走 project_suffix_for。
    标记缺失的鸭子 spec（第三方同形对象）按继承处理 = 退回继承语义，不猜显式。
    """
    if getattr(spec, "project_suffix_explicit", False):
        return spec.project_suffix
    return None


# ------------------------------------------------- 公网入口 origin（241 可移植，启动期 fail-closed）
# 未设置 = 现网（235）逐字节不变：PUBLIC_ORIGIN http://127.0.0.1:25320 / DRIVER_PORT 25320。
# 241.t 上 25320 已被其它服务占用 ⇒ 只开"换端口"这一条通道：
#   WT_KASM_PUBLIC_ORIGIN=http://127.0.0.1:<1..65535>
# 形态 = 规范 origin 的严格子集，任一不符导入期抛 ValueError（不 trim、不补全、不猜）：
#   - 只认小写 http:// 且主机逐字 127.0.0.1（localhost / 其它 loopback 写法 / 任意 host 全拒）；
#   - 端口必须**显式**（禁隐式 80）、无前导零、区间 1..65535；
#   - 禁 userinfo（'@'）/ 路径 / query('?') / fragment('#') / 尾斜杠 / 空白 / 控制字符 /
#     NUL / 空串（显式设空值 = 拒绝，不是"回到默认"）；
#   - 只影响入口 origin 与 DRIVER_PORT：桌面端口 25321-25323、relay、compose 渲染、
#     app 协议、目录布局与镜像全部不受本开关影响。
# DRIVER_PORT 从**已验证的** origin 提取（不再第二次读 env）⇒ 二者不可能分叉。
# 显式设置时另有一道**端口排它**门禁（_assert_public_origin_no_port_conflict，调用点在
# 模块末尾、opt-in 清单合并**之后**）：入口端口不得与任一**已注册**桌面的
# spec.port / spec.relay_port 相同 ⇒ 241 上换端口不会把某个桌面的发布口/relay 口吃掉。
# 未设置（默认 25320）= 不校验，现网语义逐字不变。
PUBLIC_ORIGIN_ENV = "WT_KASM_PUBLIC_ORIGIN"
PUBLIC_ORIGIN_DEFAULT = "http://127.0.0.1:25320"
PUBLIC_ORIGIN_RE = re.compile(r"\Ahttp://127\.0\.0\.1:([1-9][0-9]{0,4})\Z")


def _parse_public_origin(env=None) -> str:
    """解析 WT_KASM_PUBLIC_ORIGIN -> 生效 origin（未设置 = 现网默认）。非法一律抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(PUBLIC_ORIGIN_ENV)
    if raw is None:
        return PUBLIC_ORIGIN_DEFAULT
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (PUBLIC_ORIGIN_ENV, type(raw).__name__, raw))
    if not raw.strip():
        raise ValueError("%s 显式设为空串/纯空白（要默认请**不设**该变量）: %r"
                         % (PUBLIC_ORIGIN_ENV, raw))
    if raw != raw.strip():
        raise ValueError("%s 含前后空白（不 trim、不猜）: %r" % (PUBLIC_ORIGIN_ENV, raw))
    if any(ch.isspace() for ch in raw):
        raise ValueError("%s 含空白字符: %r" % (PUBLIC_ORIGIN_ENV, raw))
    if "\x00" in raw:
        raise ValueError("%s 含 NUL: %r" % (PUBLIC_ORIGIN_ENV, raw))
    m = PUBLIC_ORIGIN_RE.match(raw)
    if m is None:
        raise ValueError("%s 必须是规范 http://127.0.0.1:<1..65535>（禁 userinfo / 路径 / "
                         "query / fragment / 尾斜杠 / 隐式端口 / 前导零端口 / 非 127.0.0.1 "
                         "主机 / 大写协议 / 非 http）: %r" % (PUBLIC_ORIGIN_ENV, raw))
    port = int(m.group(1))
    if not (1 <= port <= 65535):
        raise ValueError("%s 端口 %d 越界 1..65535: %r" % (PUBLIC_ORIGIN_ENV, port, raw))
    return "http://127.0.0.1:%d" % port


PUBLIC_ORIGIN = _parse_public_origin()
DRIVER_PORT = int(PUBLIC_ORIGIN.rsplit(":", 1)[1])  # 从验证后的 origin 提取；dispatcher/worker 持有


def _assert_public_origin_no_port_conflict(env=None) -> None:
    """显式 WT_KASM_PUBLIC_ORIGIN 的端口必须与全部已注册桌面端口互斥（导入期 fail-closed）。

    调用点 = 本模块末尾 opt-in 入口调用**之后** ⇒ 计入 base 三桌 +
    opt-in 清单新增的全部桌面（spec.port 与 spec.relay_port 两类都算）。
    未设置该开关（= 默认 25320）直接返回：现网逐字节不变，不做任何校验。
    显式设置 = 端口逐一比对，命中即抛 ValueError：不降级、不改端口、不部分生效。
    比对源 DRIVER_PORT 是已验证 origin 的单点派生值 ⇒ 判据与生效值不可能分叉。
    """
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    if mapping.get(PUBLIC_ORIGIN_ENV) is None:
        return                                   # 默认值：现网兼容，不校验
    port = DRIVER_PORT
    for s in DESKTOPS:                           # 现势注册表（含 opt-in 追加桌）
        if port == s.port:
            raise ValueError("%s 端口 %d 与已注册桌面 %r 的 port 冲突"
                             "（入口端口不得占用桌面发布口）: %r"
                             % (PUBLIC_ORIGIN_ENV, port, s.id, s.port))
        if port == s.relay_port:
            raise ValueError("%s 端口 %d 与已注册桌面 %r 的 relay_port 冲突"
                             "（入口端口不得占用 relay 口）: %r"
                             % (PUBLIC_ORIGIN_ENV, port, s.id, s.relay_port))


# ------------------------------------------------- 宿主 Chrome 路径/版本（241 可移植，启动期 fail-closed）
# 未设置 = 现网（235）逐字节不变：CHROME_BIN = playwright chromium-1243、版本 153.0.8010.12。
# 241.t 上 Chrome 在 /opt/google/chrome/chrome（157.0.8103.78）⇒ 开两条显式通道：
#   WT_KASM_CHROME_BIN=<绝对路径>        WT_KASM_CHROME_VERSION=<点分数字版本>
# 门禁（只改"值从哪来"，不改任何执行方式）：
#   - 路径：必须 str、非空、无首尾空白、无 NUL / 换行 / 控制字符、以 '/' 起头（绝对路径），
#     长度 <= 4096；消费侧仍是 hostapps.app_argv 的**固定 argv 列表**（argv[0]）⇒
#     不经 shell、不 split、不 exec，故无注入面；本开关不新增任何参数、不改 profile 目录。
#   - 版本：必须 str、非空、无空白，形态 = **严格 4 段**点分数字（每段 0 或无前导零正整数，
#     例 157.0.8103.78）。段数固定为 4 的理由：hostapps.chrome_version 用"期望串 in 实际输出"
#     判定，段数偏少的期望串（"157" / "157.0"）会匹配一整族版本 = 假门禁。
#     hostapps.chrome_version 的 **"期望版本串出现在 --version 输出里"** 门禁逐字保留，
#     且因空串在这里就被拒，门禁不可能被空值放过。
CHROME_BIN_ENV = "WT_KASM_CHROME_BIN"
CHROME_BIN_DEFAULT = "/home/aigc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
CHROME_VERSION_ENV = "WT_KASM_CHROME_VERSION"
CHROME_VERSION_DEFAULT = "153.0.8010.12"
CHROME_VERSION_RE = re.compile(r"\A(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){3}\Z")
PATH_MAX_LEN = 4096


def _parse_chrome_bin(env=None) -> str:
    """解析 WT_KASM_CHROME_BIN -> 生效路径（未设置 = 现网默认）。非法一律抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(CHROME_BIN_ENV)
    if raw is None:
        return CHROME_BIN_DEFAULT
    if type(raw) is not str:
        raise ValueError("%s 必须是 str 路径，实为 %s: %r"
                         % (CHROME_BIN_ENV, type(raw).__name__, raw))
    if not raw.strip():
        raise ValueError("%s 显式设为空串/纯空白（要默认请**不设**该变量）: %r"
                         % (CHROME_BIN_ENV, raw))
    if raw != raw.strip():
        raise ValueError("%s 含前后空白（不 trim、不猜）: %r" % (CHROME_BIN_ENV, raw))
    if "\x00" in raw:
        raise ValueError("%s 含 NUL: %r" % (CHROME_BIN_ENV, raw))
    if any(ch in "\n\r" for ch in raw):
        raise ValueError("%s 含换行: %r" % (CHROME_BIN_ENV, raw))
    if any(ord(ch) < 0x20 for ch in raw):
        raise ValueError("%s 含控制字符: %r" % (CHROME_BIN_ENV, raw))
    if len(raw) > PATH_MAX_LEN:
        raise ValueError("%s 长度 %d 超 %d: %r"
                         % (CHROME_BIN_ENV, len(raw), PATH_MAX_LEN, raw[:60]))
    if not raw.startswith("/"):
        raise ValueError("%s 必须是绝对路径（相对路径/裸命令名 = 依赖 PATH 查找 ⇒ 拒绝）: %r"
                         % (CHROME_BIN_ENV, raw))
    return raw


def _parse_chrome_version(env=None) -> str:
    """解析 WT_KASM_CHROME_VERSION -> 生效期望版本（未设置 = 现网默认）。非法一律抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(CHROME_VERSION_ENV)
    if raw is None:
        return CHROME_VERSION_DEFAULT
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (CHROME_VERSION_ENV, type(raw).__name__, raw))
    if not raw.strip():
        raise ValueError("%s 显式设为空串/纯空白（空串会让 hostapps 的 'in' 门禁恒真 ⇒ 拒绝）: %r"
                         % (CHROME_VERSION_ENV, raw))
    if raw != raw.strip():
        raise ValueError("%s 含前后空白（不 trim、不猜）: %r" % (CHROME_VERSION_ENV, raw))
    if any(ch.isspace() for ch in raw):
        raise ValueError("%s 含空白字符: %r" % (CHROME_VERSION_ENV, raw))
    if CHROME_VERSION_RE.match(raw) is None:
        raise ValueError("%s 必须是严格 4 段点分数字版本（每段为 0 或无前导零正整数，"
                         "例 157.0.8103.78）: %r" % (CHROME_VERSION_ENV, raw))
    return raw


CHROME_BIN = _parse_chrome_bin()
CHROME_EXPECTED_VERSION = _parse_chrome_version()

FRAME_WIDTH = 1600
FRAME_HEIGHT = 900
FRAME_RATE = 30

# 逐桌面几何（root 契约 2026-11-14）：DesktopSpec 可显式声明启动分辨率 + 缩放宽紧，
# 多个独立桌面互不影响。三参数全缺省 = 旧配置：compose 渲染沿用 FRAME_WIDTH /
# FRAME_HEIGHT，且不写 WTK_ALLOW_RESIZE（不写 = 已有 compose.yaml 不会因写回而 changed）。
# 显式几何必须成对 + 显式 resize_mode；类型 / 范围 / 不完整一律抛 ValueError，不静默回退。
FRAME_WIDTH_MIN = 320
FRAME_WIDTH_MAX = 4096
FRAME_HEIGHT_MIN = 240
FRAME_HEIGHT_MAX = 4096
RESIZE_MODES = ("auto", "fixed")
ALLOW_RESIZE_BY_MODE = {"auto": "1", "fixed": "0"}
SHM_SIZE = "1g"
CONTAINER_DISPLAY_NO = 1      # 容器内 Xvnc DISPLAY=:1 ⇒ bind 目录里的 socket 是 X1
CONTAINER_DISPLAY = ":%d" % CONTAINER_DISPLAY_NO  # 写进容器 env 的 DISPLAY 串
CLIENT_DISPLAY_BASE = 310     # 宿主 relay 客户端显示号 310/311/312 = 127.0.0.1:(relay_port-6000)
CONTAINER_PORT = 3000         # 镜像内 nginx


def _geometry_int(value, label: str, lo: int, hi: int) -> int:
    """严格正整数：bool 先拒（bool 是 int 子类），只认 int 本体；其余类型一律拒绝。"""
    if isinstance(value, bool) or type(value) is not int:
        raise ValueError("%s must be int, got %s: %r"
                         % (label, type(value).__name__, value))
    if value < lo or value > hi:
        raise ValueError("%s=%d out of range %d..%d" % (label, value, lo, hi))
    return value


def normalize_geometry(frame_width=None, frame_height=None, resize_mode=None):
    """归一化逐桌面几何 -> (w, h, mode)；三值全 None -> (None, None, None) = 旧配置。

    不完整（只给宽 / 只给高 / 有几何无 mode）与任何非法值都抛 ValueError：
    不回退 1600x900、不忽略 mode，新增桌面不会静默继承别人的分辨率。
    """
    if frame_width is None and frame_height is None and resize_mode is None:
        return (None, None, None)
    if frame_width is None or frame_height is None:
        raise ValueError("frame_width / frame_height must be given together: %r %r"
                         % (frame_width, frame_height))
    if resize_mode is None:
        raise ValueError("explicit geometry needs explicit resize_mode 'auto'|'fixed'")
    w = _geometry_int(frame_width, "frame_width", FRAME_WIDTH_MIN, FRAME_WIDTH_MAX)
    h = _geometry_int(frame_height, "frame_height", FRAME_HEIGHT_MIN, FRAME_HEIGHT_MAX)
    if not isinstance(resize_mode, str) or resize_mode not in RESIZE_MODES:
        raise ValueError("resize_mode must be auto/fixed, got %r" % (resize_mode,))
    return (w, h, resize_mode)


class DesktopSpec:
    __slots__ = ("id", "name", "port", "relay_port", "client_display_index",
                 "app_id", "default_app", "project_suffix", "project_suffix_explicit",
                 "frame_width", "frame_height", "resize_mode")

    def __init__(self, id, name, port, relay_port, client_display_index, default_app,
                 project_suffix: str | None = None, *,
                 frame_width: int | None = None,
                 frame_height: int | None = None,
                 resize_mode: str | None = None):
        self.id = id
        self.name = name
        self.port = port
        self.relay_port = relay_port
        self.client_display_index = client_display_index
        self.default_app = default_app
        self.app_id = default_app
        # 逐桌面几何：None = 旧配置（现有 3 个 DESKTOPS 与全部历史构造点字节兼容）。
        w, h, mode = normalize_geometry(frame_width, frame_height, resize_mode)
        self.frame_width = w
        self.frame_height = h
        self.resize_mode = mode
        # project 后缀：显式形参 > 逐桌自适应开关（仅 auto 桌）> config.PROJECT_SUFFIX。
        # 生产 = 经 project_suffix_for 逐桌判定（单一来源）；测试/脚本可逐 spec 显式覆盖。
        # 来源标记独立记账（不看值相等）：显式传与全局同字面量的 "-v012" 也记 True，
        # 复制 / 几何翻转时按显式意图原样带走（见 _spec_project_suffix）。
        self.project_suffix_explicit = project_suffix is not None
        self.project_suffix = (project_suffix if project_suffix is not None
                               else project_suffix_for(self))

    @property
    def has_explicit_geometry(self) -> bool:
        return self.resize_mode is not None

    @property
    def effective_frame_width(self) -> int:
        return FRAME_WIDTH if self.frame_width is None else self.frame_width

    @property
    def effective_frame_height(self) -> int:
        return FRAME_HEIGHT if self.frame_height is None else self.frame_height

    @property
    def allow_resize(self) -> "str | None":
        """WTK_ALLOW_RESIZE 取值：auto->"1"、fixed->"0"、旧配置->None（compose 不写该键）。"""
        return None if self.resize_mode is None else ALLOW_RESIZE_BY_MODE[self.resize_mode]

    @property
    def container(self) -> str:
        return CONTAINER_PREFIX + self.id

    @property
    def project(self) -> str:
        return COMPOSE_PROJECT_PREFIX + self.id + self.project_suffix

    @property
    def backend_url(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    @property
    def client_display(self) -> str:
        """宿主 X 客户端显示串（relay TCP 通道；与容器内 :1 解耦）。"""
        return "127.0.0.1:%d" % self.client_display_index

    @property
    def relay_display(self) -> str:
        return self.client_display


DESKTOPS = (
    DesktopSpec("vcmi", "VCMI", 25321, 6310, 310, "vcmi"),
    DesktopSpec("chrome-1", "Chrome 1", 25322, 6311, 311, "chrome"),
    DesktopSpec("chrome-2", "Chrome 2", 25323, 6312, 312, "chrome"),
)
DESKTOP_BY_ID = {d.id: d for d in DESKTOPS}
REGISTERED_IDS = tuple(d.id for d in DESKTOPS)

# 每桌面可双 app（图标点对非默认 app 合法）；default_app 不变。
APP_IDS_BY_DESKTOP = {d.id: ("chrome", "vcmi") for d in DESKTOPS}

CHROME_PROFILE_REL = ("apps", "chrome", "profile")

# CHROME_BIN / CHROME_EXPECTED_VERSION 已在上方「宿主 Chrome 路径/版本」块按 env 定义
# （默认值逐字 = 本处旧字面量）；此处不得重复赋值，否则会把 env 覆盖回默认。
VCMI_BIN = "/usr/games/vcmiclient"

# 宿主 EasyConnect（Sangfor VPN 客户端）：默认**不注册**，只在 opt-in 开关打开后作为
# chrome-1 的第三个可拉起 app 进入白名单。常量无条件定义（hostapps 的分支只在注册后可达），
# 路径与 argv 固定 ⇒ 协议面无参数通道。开关与契约见下方 opt-in 块注释。
APP_EASYCONNECT = "easyconnect"
EASYCONNECT_DESKTOP_ID = "chrome-1"
EASYCONNECT_BIN = "/usr/share/sangfor/EasyConnect/EasyConnect"
EASYCONNECT_ARGS = ("--enable-transparent-visuals", "--disable-gpu")

# VCMI 宿主种子源（数据/配置）按 CHROME 的双通道模式开 env 覆盖：
# WT_KASM_VCMI_SRC_DATA / WT_KASM_VCMI_SRC_CONFIG 显式设置时取覆盖值（非空，
# 逐字不 trim）；默认值保持现值 = 235 现网种子路径，向后兼容逐字节不变。
VCMI_SRC_DATA = os.environ.get("WT_KASM_VCMI_SRC_DATA") or "/home/aigc/.local/share/vcmi"
VCMI_SRC_CONFIG = os.environ.get("WT_KASM_VCMI_SRC_CONFIG") or "/home/aigc/.config/vcmi"

PUID = int(os.environ.get("WT_KASM_PUID", os.getuid()))
PGID = int(os.environ.get("WT_KASM_PGID", os.getgid()))

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
CID_RE = re.compile(r"^[0-9a-f]{64}$")
HEX64 = 64


def valid_id(desktop_id: str) -> bool:
    return (isinstance(desktop_id, str) and bool(ID_RE.match(desktop_id))
            and desktop_id not in (".", ".."))


def spec(desktop_id: str) -> DesktopSpec:
    s = DESKTOP_BY_ID.get(desktop_id)
    if s is None:
        raise KeyError("未登记的 desktop id: %r（registered ids = %s）"
                       % (desktop_id, ",".join(REGISTERED_IDS)))
    return s


def desktop_dir(desktop_id: str) -> str:
    return DESKTOPS_DIR + "/" + desktop_id


def compose_file(desktop_id: str) -> str:
    return desktop_dir(desktop_id) + "/compose.yaml"


def runtime_dir(desktop_id: str) -> str:
    return desktop_dir(desktop_id) + "/runtime"


def x11_dir(desktop_id: str) -> str:
    return runtime_dir(desktop_id) + "/x11"


def appshare_dir(desktop_id: str) -> str:
    return runtime_dir(desktop_id) + "/appshare"


def config_dir(desktop_id: str) -> str:
    return desktop_dir(desktop_id) + "/config"


def apps_dir(desktop_id: str) -> str:
    return desktop_dir(desktop_id) + "/apps"


def state_dir(desktop_id: str) -> str:
    return STATE_DIR + "/" + desktop_id


def pidfile(desktop_id: str, role: str) -> str:
    return state_dir(desktop_id) + "/%s.pid" % role


def cidfile(desktop_id: str, role: str) -> str:
    return state_dir(desktop_id) + "/%s.cid" % role


def relay_display_for_port(relay_port: int) -> str:
    return "127.0.0.1:%d" % (int(relay_port) - 6000)


# ========================================================= opt-in 扩展桌面清单
# root 任务卡 2026-11-14：manager 启动期可选地从**用户显式指定**的本机清单文件读取
# **新增**桌面（多个独立桌面各自解不同分辨率），追加进注册表。逐桌 geometry 基础已在盘，
# 解析与全部门禁复用 manager/catalog.py —— 本块不重复实现校验，也不改 catalog。
#
# 默认（无 env）= 100% 向后兼容：三个 DESKTOPS / REGISTERED_IDS / APP_IDS_BY_DESKTOP 与
# 各自的 profile / compose 渲染逐字不变，且**零文件读取**（不 open / os.open / lstat /
# stat 任何路径；负例 = tests/test_catalog_optin.py::test_default_import_reads_no_files）。
#
# 唯一开关 = WT_KASM_CATALOG_FILE：
#   - 未设置 => 零读取零改动；
#   - 显式空串 / 纯空白 => 与未设置同义（明确裁决：空串不是相对路径、也不触发读取，
#     opt-in 必须给真路径）。不做任何默认路径发现（config / catalog / registry 无隐式清单）。
#   - 其它值 => 整串原样交 catalog（含空白的串不是绝对路径 => catalog 拒绝）。
#
# fail-closed 与原子性：路径不存在 / 相对 / 软链 / 超 64KB / 坏 JSON / schemaVersion 不符 /
# 未知键 / 条目缺键 / 端口越界 / id-port-relay-display 冲突 / duplicate id / 超额 =>
# catalog 抛 CatalogError（ValueError 家族），本块原样抛出：不降级、不部分加载、不忽略、
# 不继续启动。合并结果先在局部算完（含 config 侧冲突复核），全过之后才一次性重绑全局
# ⇒ 异常路径上任何全局都未动过 ⇒ 不存在半表。
#
# 新增桌面属性：port / relayPort / client_display_index = relayPort-6000 / 显式
# width,height,mode 全部来自清单条目；defaultApp 只决定**默认自动启动**的那一个 app，
# APP_IDS_BY_DESKTOP 与既有桌面**同集合**（chrome + vcmi）⇒ 桌面图标两类 app 都可点，
# 不因走清单而删功能。project 名 = COMPOSE_PROJECT_PREFIX + id + 当时 PROJECT_SUFFIX
# （与三桌同一构造点，不新增命名规则）；目录 / profile 走既有 desktop_dir 家族
# ⇒ 每桌私有 apps/chrome/profile，互不共享。
#
# 热重载 = 无。清单只在本模块导入时读一次，之后文件内容变化不会被发现，也不会自动重读
# （同一路径重复调用 configure_catalog_from_environment 命中缓存，直接返回首次摘要）。
# 改清单要生效 = 重启 manager 进程（daemon 重启 = 重新导入 config）。在**已加载过桌面的
# 进程里**换路径再调用 = 必抛 id/port 冲突（现役桌不得被隐式重建），这是设计意图。

CATALOG_FILE_ENV = "WT_KASM_CATALOG_FILE"

# 基线快照：下方合并只**追加**，永不改这些条目（测试与部署侧按此复核三桌属性未变）。
CATALOG_BASE_DESKTOP_IDS = tuple(d.id for d in DESKTOPS)
CATALOG_BASELINE_DESKTOPS = DESKTOPS
CATALOG_BASELINE_REGISTERED_IDS = REGISTERED_IDS
CATALOG_BASELINE_APP_IDS = {k: tuple(v) for k, v in APP_IDS_BY_DESKTOP.items()}
# 每桌 app 白名单集合（现势三桌同一集合）：新增桌继承它，defaultApp 只控默认自启。
CATALOG_ALLOWED_APPS = CATALOG_BASELINE_APP_IDS[CATALOG_BASE_DESKTOP_IDS[0]]

# 现势（未启用 = 空元组 / None；启用成功后 = 本次新增 id 顺序与摘要）
CATALOG_LOADED: tuple = ()
CATALOG_SUMMARY: "dict | None" = None


def _catalog_path_from_env(env=None) -> "str | None":
    """解析开关：None = 未启用（零读取）；启用 = 清单路径原串（门禁全交 catalog）。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(CATALOG_FILE_ENV)
    if raw is None:
        return None
    if type(raw) is not str:
        raise ValueError("%s 必须是 str 路径，实为 %s" % (CATALOG_FILE_ENV, type(raw).__name__))
    return raw if raw.strip() else None


def _merge_catalog_specs(new_specs, base_specs):
    """base + 新增 -> (DESKTOPS 元组, APP_IDS_BY_DESKTOP, DESKTOP_BY_ID)。

    全部在局部构造后一次性返回 = 校验全过；任一条不成立直接抛，调用方看不到半状态。
    catalog 已做过门禁，这里只补 catalog 看不到的 config 侧不变量：DesktopSpec 类型、
    valid_id、id / port / relay / display 与 base 及批内互不重复、显式几何成对且合法、
    defaultApp 在允许 app 集合内。新增桌 app 白名单 = CATALOG_ALLOWED_APPS（双 app）。
    """
    base = tuple(base_specs)
    by_id = {s.id: s for s in base}
    ports = {s.port: s.id for s in base}
    relays = {s.relay_port: s.id for s in base}
    displays = {s.client_display_index: s.id for s in base}
    order = [s.id for s in base]
    app_ids = {s.id: tuple(CATALOG_BASELINE_APP_IDS.get(s.id, ())) for s in base}

    for n, s in enumerate(new_specs):
        where = "catalog[%d]" % n
        if not isinstance(s, DesktopSpec):
            raise ValueError("%s 不是 DesktopSpec，实为 %s" % (where, type(s).__name__))
        if not valid_id(s.id):
            raise ValueError("%s.id 非法: %r" % (where, s.id))
        if s.id in by_id:
            raise ValueError("%s.id=%r 与既有桌面冲突（opt-in 不得覆盖现役桌）" % (where, s.id))
        for kind, table, value in (("port", ports, s.port),
                                   ("relay_port", relays, s.relay_port),
                                   ("client_display_index", displays, s.client_display_index)):
            prev = table.get(value)
            if prev is not None:
                raise ValueError("%s.%s=%r 与桌面 %r 冲突（id/port/relay/display 全局唯一）"
                                 % (where, kind, value, prev))
            table[value] = s.id
        w, h, mode = normalize_geometry(s.frame_width, s.frame_height, s.resize_mode)
        if (w, h, mode) != (s.frame_width, s.frame_height, s.resize_mode) or mode is None:
            raise ValueError("%s 几何不完整/不合法: %r %r %r（新增桌面必须自带显式分辨率）"
                             % (where, s.frame_width, s.frame_height, s.resize_mode))
        if s.default_app not in CATALOG_ALLOWED_APPS:
            raise ValueError("%s.defaultApp=%r 不在允许 app 集合 %s"
                             % (where, s.default_app, "/".join(CATALOG_ALLOWED_APPS)))
        by_id[s.id] = s
        order.append(s.id)
        app_ids[s.id] = tuple(CATALOG_ALLOWED_APPS)
    return (tuple(by_id[i] for i in order), app_ids, by_id)


def _catalog_summary_snapshot() -> dict:
    """CATALOG_SUMMARY 的深拷贝（list / dict 都新造，不共享可变容器）。

    公开 API 返回副本 = 调用方改不动全局注册表现势；浅拷贝 dict() 会让 added / apps /
    geometries 三个容器按引用共享，外部 append 直接污染 CATALOG_SUMMARY（已实测）。
    """
    s = CATALOG_SUMMARY
    return {"path": s["path"],
            "total": s["total"],
            "added": list(s["added"]),
            "base": list(s["base"]),
            "ids": list(s["ids"]),
            "apps": {k: list(v) for k, v in s["apps"].items()},
            "geometries": {k: list(v) for k, v in s["geometries"].items()}}


def configure_catalog_from_environment(env=None) -> "dict | None":
    """opt-in 入口（公开 API）：按 env 读清单并把新增桌面**追加**进注册表。

    返回 None = 未启用（零读取、零改动）；启用且成功返回摘要 dict。启用但清单非法 =>
    抛 catalog.CatalogError（ValueError 家族）：不降级、不部分加载、不忽略，全局绑定
    逐字未动。config 导入末尾自动调用一次 = manager 启动期（CLI / daemon 都会导入
    config，无需外部显式接线）。

    重复调用**同一路径** = 命中缓存直接返回首次摘要的深拷贝：不再读盘、不再二次合并
    ⇒ 本函数不是热重载入口：清单文件内容变化不会被感知，改清单需重启 manager 进程；
    在已加载过桌面的进程里换路径调用 = 抛 id/port 冲突（现役桌不得被隐式重建）。
    """
    global DESKTOPS, DESKTOP_BY_ID, REGISTERED_IDS, APP_IDS_BY_DESKTOP
    global CATALOG_LOADED, CATALOG_SUMMARY
    path = _catalog_path_from_env(env)
    if path is None:
        return None
    if CATALOG_SUMMARY is not None and CATALOG_SUMMARY.get("path") == path:
        return _catalog_summary_snapshot()
    new_specs = catalog.load_desktop_catalog(path, DESKTOPS)
    merged, app_ids, by_id = _merge_catalog_specs(new_specs, DESKTOPS)
    _assert_projects_unique(merged, "catalog 合并后的注册表")
    # ---- 全部校验通过；一次性重绑（失败路径永不走到这里）----
    added = tuple(s.id for s in new_specs)
    DESKTOPS = merged
    DESKTOP_BY_ID = by_id
    REGISTERED_IDS = tuple(s.id for s in merged)
    APP_IDS_BY_DESKTOP = app_ids
    CATALOG_LOADED = added
    CATALOG_SUMMARY = {"path": path,
                       "total": len(merged),
                       "added": list(added),
                       "base": list(CATALOG_BASE_DESKTOP_IDS),
                       "ids": list(REGISTERED_IDS),
                       "apps": {k: list(v) for k, v in app_ids.items()},
                       "geometries": {s.id: [s.frame_width, s.frame_height, s.resize_mode]
                                      for s in merged if s.has_explicit_geometry}}
    return _catalog_summary_snapshot()


# ========================================================= 基础桌面自适应缩放 opt-in（启动期）
# root 任务卡 2026-11-15：25320 各基础桌面的远端 framebuffer 随 iframe 变化（Kasm remote
# resize）且保留任务栏 ⇒ 被选中的基础桌面以 resize_mode='auto' 启动，启动分辨率 = 既有默认
# FRAME_WIDTH x FRAME_HEIGHT。这是对三个基础条目的**几何层翻转**，不是新增桌面登记：
# WT_KASM_CATALOG_FILE 通道仍只允许追加（上方 catalog 契约不变）；桌面身份（id/name/port/
# relay/display/default_app/project/container/目录与 profile 路径）逐字节不变。
#
# 唯一开关 = WT_KASM_BASE_AUTO_DESKTOPS（逗号分隔的桌面 id 清单）：
#   - 未设置 / 显式空串 / 纯空白 => 未启用：DESKTOPS、compose 渲染与 registry 语义
#     **字节兼容现状**（三桌全 legacy：frame_width/frame_height/resize_mode 全 None，
#     compose 不写 WTK_ALLOW_RESIZE，registry 不写 geometry 键，入口 URL 逐字原样）。
#   - 每个 token 必须逐字等于 vcmi / chrome-1 / chrome-2 三个真实基础 id 之一；
#     token 含前后空白、空 token（首/尾/双逗号）、未知 id（all、*、大写、catalog 文件新增桌）、
#     重复 id => 抛 ValueError（CatalogError 同族，按 ValueError 捕获即覆盖）：
#     fail-closed = 导入期抛穿、全局绑定逐字未动、不存在半表。
#   - 被选中桌面几何 = (FRAME_WIDTH, FRAME_HEIGHT, 'auto')：compose 新增 WTK_ALLOW_RESIZE=1
#     （宽度/高度字符串与 legacy 相同），registry 发布 geometry {mode:auto,width:1600,
#     height:900}；has_explicit_geometry=True 使该桌**原样进入既有显式几何实况认证链**
#     （registry.probe_state -> attest.attest_geometry -> actions 起停门禁）——本开关
#     不为认证开任何旁路；已有显式几何的基础桌（被 catalog 之外途径改过）拒绝二次翻转。
#   - 未选中桌面保持 legacy：spec 对象同一性保留（同一实例，非重建）。
# 热重载 = 无：只在模块导入期读一次（与 CATALOG_FILE 同纪律）。进程内重复调用同一生效值
# 返回缓存快照；已翻转的进程再载不同清单 => 抛（几何翻转不在进程内静默回退/扩选）。
BASE_AUTO_ENV = "WT_KASM_BASE_AUTO_DESKTOPS"
BASE_AUTO_IDS = ("vcmi", "chrome-1", "chrome-2")   # 只认三个真实基础 id（唯一授权集）

# 现势（未启用 = 空元组 / None；启用成功后 = 生效 id 顺序与摘要）
BASE_AUTO_LOADED: tuple = ()
BASE_AUTO_SUMMARY: "dict | None" = None


def _parse_base_auto_ids(env=None) -> tuple:
    """解析开关值 -> 生效 id 元组（按串内顺序）。空/未设置 = 空元组；任何非法抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(BASE_AUTO_ENV)
    if raw is None:
        return ()
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (BASE_AUTO_ENV, type(raw).__name__, raw))
    if not raw.strip():
        return ()
    out = []
    seen = set()
    for tok in raw.split(","):
        if not tok:
            raise ValueError("%s 含空 token（首/尾/双逗号）: %r" % (BASE_AUTO_ENV, raw))
        if tok != tok.strip():
            raise ValueError("%s token %r 含前后空白（必须逐字等于基础 id）" % (BASE_AUTO_ENV, tok))
        if tok not in BASE_AUTO_IDS:
            raise ValueError("%s token %r 不在基础桌面集 %s（只允许三个真实基础 id）"
                             % (BASE_AUTO_ENV, tok, "/".join(BASE_AUTO_IDS)))
        if tok in seen:
            raise ValueError("%s 含重复 id %r（fail-closed，不合并去重）" % (BASE_AUTO_ENV, tok))
        seen.add(tok)
        out.append(tok)
    return tuple(out)


def _base_auto_snapshot() -> dict:
    """BASE_AUTO_SUMMARY 的副本（不共享可变容器，调用方改不动现势）。"""
    s = BASE_AUTO_SUMMARY
    return {"ids": list(s["ids"]),
            "geometry": list(s["geometry"]),
            "base": list(BASE_AUTO_IDS)}


def configure_base_auto_from_environment(env=None) -> "dict | None":
    """基础桌面 auto 几何 opt-in（公开 API）；契约见上方块注释。

    返回 None = 未启用（零改动）；启用且成功返回摘要 dict。启用但清单非法 => 抛
    ValueError（fail-closed，全局逐字未动）。config 导入末尾自动调用一次（发生在
    configure_catalog_from_environment 的追加合并**之前**）= manager 启动期开关
    （CLI / daemon 都会导入 config，无需外部接线）。

    重复调用同一生效值 = 返回缓存快照（非热重载入口）；已翻转的进程里换清单 => 抛。
    """
    global DESKTOPS, DESKTOP_BY_ID, BASE_AUTO_LOADED, BASE_AUTO_SUMMARY
    ids = _parse_base_auto_ids(env)
    if not ids:
        return None
    if BASE_AUTO_SUMMARY is not None:
        if tuple(BASE_AUTO_SUMMARY["ids"]) == ids:
            return _base_auto_snapshot()
        raise ValueError("%s 已翻转为 %s ⇒ 同进程不得改为 %s（热重载=无，重启 manager 生效）"
                         % (BASE_AUTO_ENV, "+".join(BASE_AUTO_SUMMARY["ids"]),
                            "+".join(ids)))
    merged = []
    for s in DESKTOPS:
        if s.id in ids:
            if s.has_explicit_geometry:
                raise ValueError("基础桌 %s 已有显式几何 %sx%s(%s) ⇒ 拒绝二次翻转"
                                 % (s.id, s.frame_width, s.frame_height, s.resize_mode))
            s = DesktopSpec(s.id, s.name, s.port, s.relay_port,
                            s.client_display_index, s.default_app,
                            project_suffix=_spec_project_suffix(s),
                            frame_width=FRAME_WIDTH, frame_height=FRAME_HEIGHT,
                            resize_mode="auto")
        merged.append(s)
    merged = tuple(merged)
    _assert_projects_unique(merged, "base-auto 翻转后的注册表")
    by_id = {s.id: s for s in merged}
    # ---- 全部校验通过；一次性重绑（失败路径永不走到这里）----
    DESKTOPS = merged
    DESKTOP_BY_ID = by_id
    # catalog 的"基线快照"必须跟着几何层一起换：CATALOG_BASELINE_DESKTOPS 的用途是
    # "复核三桌属性未变"，若仍指向被替换掉的旧 legacy 实例，翻转后该快照就是死对象，
    # 越复核越假。id / port / relay / display / app 白名单不受几何影响，故
    # CATALOG_BASELINE_APP_IDS 与 CATALOG_BASE_DESKTOP_IDS 逐字不动（顺序也不动）。
    global CATALOG_BASELINE_DESKTOPS, CATALOG_BASELINE_REGISTERED_IDS
    CATALOG_BASELINE_DESKTOPS = merged
    CATALOG_BASELINE_REGISTERED_IDS = tuple(s.id for s in merged)
    BASE_AUTO_LOADED = ids
    BASE_AUTO_SUMMARY = {"ids": list(ids),
                         "geometry": [FRAME_WIDTH, FRAME_HEIGHT, "auto"],
                         "base": list(BASE_AUTO_IDS)}
    return _base_auto_snapshot()


# catalog 的模块体已不 import config（root 2026-11-14 协调结果：catalog 侧下沉到函数内按需
# 导入），因此这里在全部定义完成之后普通导入即成环安全：两条导入顺序（先 config /
# 先 catalog）都拿到完成初始化的 catalog，且不需要 exec_module / reload 之类的补救。
from . import catalog  # noqa: E402  (必须晚于上方全部定义：catalog 函数体内按需导入 config)

# ========================================================= 宿主 EasyConnect opt-in（启动期）
# root 任务卡 2026-11-16：chrome-1 桌面图标可拉起**宿主** Sangfor EasyConnect。
# 默认关闭 = 注册表逐字节不变（APP_IDS_BY_DESKTOP 三桌仍是 ("chrome","vcmi")）。
#
# 唯一开关 = WT_KASM_EASYCONNECT：
#   - 未设置 / 显式空串 / 纯空白 => 未启用：零改动（不发分支、不登记 app）。
#   - 逐字 "1" => 启用：chrome-1 的 app 白名单追加 easyconnect（顺序 chrome, vcmi,
#     easyconnect），其余桌面逐字不变。
#   - 其它值（含 "0" / "true" / "1 " / "yes" / 非 str）=> 抛 ValueError：fail-closed，
#     全局绑定逐字未动，不存在半表。开关取值**不 trim、不猜**。
#
# 注册后的语义（实现见 manager/hostapps.py）：
#   argv 固定 = [EASYCONNECT_BIN] + list(EASYCONNECT_ARGS)，协议 / CLI / 图标都无参数通道；
#   只允许 EASYCONNECT_DESKTOP_ID 一张桌；launch 前核验二进制存在，缺失即 failclosed；
#   单实例守卫 / 私有 HOME / relay DISPLAY / WT_KASM_MARK 台账全部复用既有通用链路。
#
# 热重载 = 无：只在模块导入期读一次（与 CATALOG_FILE / BASE_AUTO 同纪律）。进程内重复
# 调用同一生效值 = 返回缓存快照；已启用的进程里关掉 = 抛（不在进程内静默摘白名单）。

EASYCONNECT_ENV = "WT_KASM_EASYCONNECT"

# 现势（未启用 = 空字符串 / None；启用成功后 = 摘要）
EASYCONNECT_LOADED: bool = False
EASYCONNECT_SUMMARY: "dict | None" = None


def _parse_easyconnect_flag(env=None):
    """解析开关：True = 启用，False = 未启用。任何非法取值抛 ValueError。"""
    mapping = os.environ if env is None else env
    if not hasattr(mapping, "get"):
        raise TypeError("env 必须是映射，实为 %s" % type(mapping).__name__)
    raw = mapping.get(EASYCONNECT_ENV)
    if raw is None:
        return False
    if type(raw) is not str:
        raise ValueError("%s 必须是 str，实为 %s: %r"
                         % (EASYCONNECT_ENV, type(raw).__name__, raw))
    if not raw.strip():
        return False                      # 空串 / 纯空白 = 与未设置同义
    if raw != "1":
        raise ValueError('%s 取值必须逐字等于 "1"（不 trim、不猜、无 "0"/"true" 语义）: %r'
                         % (EASYCONNECT_ENV, raw))
    return True


def _easyconnect_snapshot() -> dict:
    """EASYCONNECT_SUMMARY 的副本（不共享可变容器，调用方改不动现势）。"""
    s = EASYCONNECT_SUMMARY
    return {"enabled": bool(s["enabled"]),
            "desktop": s["desktop"],
            "appId": s["appId"],
            "binary": s["binary"],
            "args": list(s["args"]),
            "apps": list(s["apps"])}


def configure_easyconnect_from_environment(env=None) -> "dict | None":
    """opt-in 入口（公开 API）：把宿主 EasyConnect 追加进 chrome-1 的 app 白名单。

    返回 None = 未启用（零改动）；启用成功 = 摘要 dict。启用但注册表状态不符预期
    （chrome-1 不存在 / 已含 easyconnect）=> 抛 ValueError：不降级、不部分启用。
    config 导入末尾自动调用一次 = manager 启动期（CLI / daemon 都会导入 config）。
    必须在 catalog / base-auto 合并**之后**调用：那两条通道会重建 APP_IDS_BY_DESKTOP，
    本块只在定稿后的表上做单点追加。
    """
    global EASYCONNECT_LOADED, EASYCONNECT_SUMMARY, APP_IDS_BY_DESKTOP
    if not _parse_easyconnect_flag(env):
        return None
    if EASYCONNECT_SUMMARY is not None:
        return _easyconnect_snapshot()            # 非热重载入口：命中缓存直接返回
    apps = APP_IDS_BY_DESKTOP.get(EASYCONNECT_DESKTOP_ID)
    if apps is None:
        raise ValueError("桌面 %s 不在注册表 ⇒ 拒绝启用 %s（opt-in 不建桌）"
                         % (EASYCONNECT_DESKTOP_ID, EASYCONNECT_ENV))
    if APP_EASYCONNECT in apps:
        raise ValueError("桌面 %s 已含 app %r ⇒ 拒绝二次注册（热重载=无，重启 manager 生效）"
                         % (EASYCONNECT_DESKTOP_ID, APP_EASYCONNECT))
    merged = dict(APP_IDS_BY_DESKTOP)               # 局部算完，全部校验通过才重绑
    merged[EASYCONNECT_DESKTOP_ID] = tuple(apps) + (APP_EASYCONNECT,)
    APP_IDS_BY_DESKTOP = merged
    EASYCONNECT_LOADED = True
    EASYCONNECT_SUMMARY = {"enabled": True,
                           "desktop": EASYCONNECT_DESKTOP_ID,
                           "appId": APP_EASYCONNECT,
                           "binary": EASYCONNECT_BIN,
                           "args": list(EASYCONNECT_ARGS),
                           "apps": list(merged[EASYCONNECT_DESKTOP_ID])}
    return _easyconnect_snapshot()


configure_adaptive_image_from_environment()
configure_adaptive_project_suffix_from_environment()
configure_base_auto_from_environment()
_validate_project_uniqueness()        # 基表现势 project 全名唯一（导入期 fail-closed）
configure_catalog_from_environment()
# 入口 origin 的端口排它门禁必须在**注册表定稿之后**跑：catalog opt-in 追加的桌面
# 也算已注册（spec.port / spec.relay_port 都纳入比对）。默认（未设开关）= 直接返回，
# 现网 25320 语义逐字不变。
_assert_public_origin_no_port_conflict()

# EasyConnect 追加必须**最后**跑：上方 catalog opt-in 会用 CATALOG_BASELINE_APP_IDS +
# CATALOG_ALLOWED_APPS **重建** APP_IDS_BY_DESKTOP，先注册会被覆盖回双 app。
configure_easyconnect_from_environment()
