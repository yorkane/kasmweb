#!/usr/bin/env python3
"""生成最终 openbox rc.xml：**以镜像自带 stock rc.xml 为骨架**叠加本包片段。

用法:
    merge-rc.py <stock-rc.xml> <out-rc.xml> <keyboard片段> <applications片段>

为什么以 stock 为骨架：openbox 3.6.1 与 3.6.5 的 rc schema 有差异（3.6.1 的
NextWindow 用 finalactions 子元素、无 skip_minimized 属性）。以容器内自带配置
为骨架可保证动作名/属性与该容器 openbox 版本一致，不引入未知元素。

三步变换（顺序重要）：
  1) 在 <keyboard> 段开头插入 keyboard 片段（本包只做**新增键位**，不覆盖 stock）
  2) 逐行删除 stock/init 注入的通配单行规则：
       · class="*" + <decor>no</decor>            ← wdev-webtop 无标题栏的根因
       · class="*" + <maximized>yes</maximized>   ← 2026-10-15 黑屏根因
     （幂等：文件里没有该行时静默跳过）
  3) 在 </applications> 之前追加 applications 片段
     —— openbox applications 是**后写规则覆盖先写**，故片段首条即为
        class="*" decor=yes，把 2) 删掉的"装饰默认开启"语义显式重建；
        紧接 Chrome / Chromium / chromium-browser / Google-chrome 的
        decor=yes + maximized=no 规则（root 2026-11-13 裁决：本产品是普通
        宿主 Chrome，带 Openbox 标题栏；kiosk 无框例外已撤销，maximized=no
        保留 = 2026-10-15 黑屏修复，与装饰正交）。

 4) 覆写 <dock> 段为 Bottom + Horizontal（stock 3.6.1 骨架是 TopLeft + Vertical）。
    tint2 侧写 panel_position = bottom center 只决定**面板自己**贴哪条边；面板由
    openbox 摆放，dock=TopLeft + Vertical 时多个 dock 项**纵向堆叠**，实测第二个
    tint2 落在 Y=34 顶部带 ⇒ 底部任务栏不成立。两处必须同时是"底部/横向"。

**默认给所有普通应用加标题栏**（class="*" decor=yes），不是逐类白名单：
任何 Linux 客户端窗口（VCMI / 终端 / 文件管理器 / 播放器 / IDE …）都会拿到
可拖动、可最小化的标题栏。浏览器家族（Chrome/Chromium）同样带标题栏，
只显式钉住 maximized=no（黑屏修复）与 focus 行为，无 kiosk 无框例外。

输出的 rc.xml 顶部带一行标记注释（MARKER），供 init 脚本识别"这是我们生成的"
⇒ 重复运行可幂等覆盖；用户自己写的 rc.xml 永不被覆盖（见 init 脚本）。

退出码：0 成功；2 用法/读文件失败；3 结构校验不通过（不写出结果）。
"""
import sys
import re
import xml.etree.ElementTree as ET

NL = chr(10)
NS = "{http://openbox.org/3.4/rc}"
CHROME_CLASSES = ("chrome", "chromium", "chromium-browser", "google-chrome")
MARKER = "wdev-windowing:generated"


def fail(code, msg):
    sys.stderr.write("merge-rc: " + msg + NL)
    sys.exit(code)


def fragment_body(path, wanted):
    """读片段：剥掉 xml 声明与全部注释，返回可直接内插的 XML 正文 + 顶层元素名列表。

    注释剥离用整体正则（DOTALL），不用逐行状态机：状态机在「正文之后又出现
    多行注释」时只丢注释尾行，留下未闭合的 <!-- ，实测造成
    ParseError: unclosed token（keyboard 片段第 17-21 行的注释触发）。
    """
    raw = open(path, encoding="utf-8").read()
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    kept = []
    for line in raw.split(NL):
        if line.strip().startswith("<?xml"):
            continue
        kept.append(line)
    body = NL.join(kept).strip()
    # 结构自检：包一层带命名空间的根后必须可解析，且元素名符合预期
    root = ET.fromstring('<root xmlns="' + NS[1:-1] + '">' + body + "</root>")
    names = []
    for child in root:
        tag = child.tag.split("}")[-1]
        if tag not in (wanted, "keybind", "application"):
            fail(3, "片段 " + path + " 出现非预期元素 " + tag)
        names.append(tag)
    if not names:
        fail(3, "片段 " + path + " 解析为空")
    return body, names


def drop_wildcard_lines(text):
    kept = []
    dropped = 0
    for line in text.split(NL):
        compact = "".join(line.split())
        if 'class="*"' in compact and ("<decor>no</decor>" in compact
                                       or "<maximized>yes</maximized>" in compact):
            dropped += 1
            continue
        kept.append(line)
    return NL.join(kept), dropped


DOCK_RE = re.compile(r"(<dock>.*?</dock>)", re.S)


TITLE_LAYOUT = "NLIMC"
TITLE_LAYOUT_RE = re.compile(r"<titleLayout>[^<]*</titleLayout>")


def force_title_layout(text):
    """把 <theme><titleLayout> 覆写为 TITLE_LAYOUT（补上标题栏缺失的最小化按钮）。

    为什么必须覆写：stock 3.6.1 骨架给的是 NLMC，其中的 L 是 **label（标题文字）**，
    不是最小化。Openbox 源码 openbox/frame.c 的逐字符分支：case "L" = label、
    case "I" = iconify（root 于 2026-11-12 核对：frame.c:1219 / :1235），
    默认值 NLIMC 在 config.c:1098。⇒ 骨架缺 I，**标题栏渲染不出最小化按钮**，
    2026-11-12 生产 :25180 浏览器实测症状即「可拖动、有最大化与关闭、独缺最小化」；
    同现场 xprop 显示 vcmiclient 的 _NET_WM_ALLOWED_ACTIONS 含 _NET_WM_ACTION_MINIMIZE
    ⇒ 纯按钮布局缺失，不是客户端拒绝最小化。NLIMC = 图标/标题/最小化/最大化/关闭，
    让**所有**普通应用（VCMI / 终端 / 文件管理器 …）都有可视 iconify 按钮，
    键盘 A-F9 与任务栏按钮降为备份入口。只动这一行，theme 其余保留骨架值。
    """
    hit = [False]

    def repl(_m):
        hit[0] = True
        return "<titleLayout>" + TITLE_LAYOUT + "</titleLayout>"

    text = TITLE_LAYOUT_RE.sub(repl, text, count=1)
    return text, hit[0]


def force_bottom_dock(text):
    """把 <dock> 段的 position 覆写为 Bottom、direction 覆写为 Horizontal。

    只动这两行，其余（noStrut / stacking / autoHide / hideDelay）保留 stock 值：
    noStrut=no 让面板保留占位（最大化窗口不被面板压住），stacking=Above 保证
    任务栏永远在游戏窗口之上。返回 (text, 是否命中 dock 段)。
    """
    hit = False

    def repl(m):
        nonlocal hit
        block = m.group(1)
        new = re.sub(r"<position>[^<]*</position>", "<position>Bottom</position>",
                     block, count=1)
        new = re.sub(r"<direction>[^<]*</direction>", "<direction>Horizontal</direction>",
                     new, count=1)
        # 幂等：已经是 Bottom + Horizontal 的骨架（本包产物重跑）也算命中
        hit = "<position>Bottom</position>" in new
        return new

    text = DOCK_RE.sub(repl, text, count=1)
    return text, hit


def validate(path):
    root = ET.parse(path).getroot()
    dock = root.find(NS + "dock")
    if dock is None:
        return "缺 dock 段（无法确定任务栏停靠边）"
    pos = dock.find(NS + "position")
    direction = dock.find(NS + "direction")
    if pos is None or (pos.text or "").strip() != "Bottom":
        return "dock position 不是 Bottom（任务栏不会落在底部）：%s" % (
            (pos.text or "").strip() if pos is not None else "缺失")
    if direction is not None and (direction.text or "").strip() != "Horizontal":
        return "dock direction 不是 Horizontal（多面板会纵向堆叠）：%s" % (
            (direction.text or "").strip())
    theme = root.find(NS + "theme")
    tl = theme.find(NS + "titleLayout") if theme is not None else None
    got = (tl.text or "").strip() if tl is not None and tl.text else None
    if got != TITLE_LAYOUT:
        return ("titleLayout 不是 " + TITLE_LAYOUT
                + "（标题栏没有可视最小化按钮）：" % got)
    if "I" not in (got or ""):
        return "titleLayout 缺 I（无 iconify 按钮）：" % got
    apps = root.find(NS + "applications")
    if apps is None:
        return "缺 applications 段"
    rules = apps.findall(NS + "application")

    def decor_of(el):
        node = el.find(NS + "decor")
        return node.text.strip() if node is not None and node.text else None

    def maximized_of(el):
        node = el.find(NS + "maximized")
        return node.text.strip() if node is not None and node.text else None

    wilds = [el for el in rules
             if el.get("class") == "*" and not (el.get("name") or el.get("type")
                                                or el.get("title") or el.get("role"))]
    if not wilds:
        return "没有通配规则（普通应用装饰无兜底）"
    if len(wilds) != 1:
        return "通配规则有 %d 条，语义依赖书写顺序，需收敛为 1 条" % len(wilds)
    if decor_of(wilds[0]) != "yes":
        return "通配规则 decor 不是 yes（普通应用仍无标题栏）"
    # 后写覆盖先写：通配 decor=yes 必须是**唯一**通配，且所有浏览器规则
    # 写在它之后（否则通配会重新覆盖浏览器规则）。
    wild_idx = rules.index(wilds[0])
    for el in [e for e in rules
               if (e.get("class") or "").lower() in CHROME_CLASSES]:
        if rules.index(el) < wild_idx:
            return "Chromium 例外写在通配之前，会被通配覆盖：" + str(el.attrib)
    chromes = [el for el in rules
               if (el.get("class") or "").lower() in CHROME_CLASSES]
    if not chromes:
        return "缺浏览器规则（Chrome 家族未逐类点名）"
    for el in chromes:
        if decor_of(el) != "yes":
            return "浏览器规则 decor 不是 yes（标题栏要求，root 2026-11-13）：" + str(el.attrib)
        if maximized_of(el) != "no":
            return "浏览器规则 maximized 不是 no（黑屏回归风险）：" + str(el.attrib)
    return None


def main(argv):
    if len(argv) != 5:
        fail(2, "用法: merge-rc.py <stock-rc> <out-rc> <keyboard片段> <applications片段>")
    src, dst, kb_path, ap_path = argv[1:5]
    for p in (src, kb_path, ap_path):
        try:
            open(p, encoding="utf-8").close()
        except OSError as exc:
            fail(2, "读不到 " + p + "：" + repr(exc))

    text = open(src, encoding="utf-8", errors="surrogateescape").read()
    if "<keyboard>" not in text or "</keyboard>" not in text:
        fail(3, "stock rc 缺 keyboard 段")
    if "<applications>" not in text or "</applications>" not in text:
        fail(3, "stock rc 缺 applications 段")

    kb_body, kb_names = fragment_body(kb_path, "keybind")
    ap_body, ap_names = fragment_body(ap_path, "application")

    text = text.replace("<keyboard>", "<keyboard>" + NL + kb_body + NL, 1)
    text, dropped = drop_wildcard_lines(text)
    text = text.replace("</applications>", ap_body + NL + "</applications>", 1)
    text, dock_hit = force_bottom_dock(text)
    if not dock_hit:
        fail(3, "stock rc 没有可改写的 <dock> 段")

    text, tl_hit = force_title_layout(text)
    if not tl_hit:
        fail(3, "stock rc 没有可改写的 <titleLayout>（无法保证标题栏有最小化按钮）")

    # 生成标记：放在 <openbox_config 开始标签之后，供 init 判定文件归属。
    # 只插注释，不影响 schema 校验（openbox 用 glib-gmarkup，允许注释）。
    if MARKER not in text:
        i = text.index("<openbox_config")
        j = text.index(">", i) + 1
        text = (text[:j] + NL + "  <!-- " + MARKER
                + " (do not edit by hand; regenerate via wdev-windowing-init.sh) -->"
                + NL + text[j:])

    # 先写临时文件再校验，校验失败不留半成品
    tmp = dst + ".merging"
    with open(tmp, "w", encoding="utf-8", errors="surrogateescape") as fh:
        fh.write(text)
    problem = validate(tmp)
    if problem:
        import os
        os.replace(tmp, dst + ".rejected")
        fail(3, "结构校验不通过：" + problem + "（留证 " + dst + ".rejected）")
    import os
    os.replace(tmp, dst)
    sys.stderr.write("merge-rc: +%d keybind, +%d application, -%d 通配 decor=no/maximized=yes -> %s"
                     % (len(kb_names), len(ap_names), dropped, dst) + NL)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
