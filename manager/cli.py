"""wt-kasm 命令行：读命令本地执行，变更命令一律走 daemon（控制 UDS）。

  wt-kasm list | status [id] | start <id> | stop <id>
  wt-kasm app start|focus|stop|status <id> [--app chrome|vcmi] [--test-cdp]
  wt-kasm init [--force] | verify <id> | registry [--refresh]
  wt-kasm daemon [status|stop] [--foreground] [--detach] | run
退出码：0 成功 / 1 动作失败 / 2 用法或缺 daemon / 3 socket 通信失败
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import actions, config, daemon, process

PKG_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _out(doc) -> None:
    print(json.dumps(doc, ensure_ascii=False, indent=2, default=str))


def _table(rows: list) -> None:
    cols = ("id", "name", "port", "state", "appId", "url")
    hdr = "{:<10} {:<12} {:<6} {:<9} {:<6} {}".format(*cols)
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print("{:<10} {:<12} {:<6} {:<9} {:<6} {}".format(
            *[str(r.get(c, "")) for c in cols]))


def _ask(req: dict, timeout: float = 300.0) -> dict:
    try:
        res = daemon.send_request(req, timeout=timeout)
    except RuntimeError as exc:
        print("错误: " + str(exc), file=sys.stderr)
        print("提示: 先起 daemon —— wt-kasm daemon --detach 或 bash install-manager.sh",
              file=sys.stderr)
        raise SystemExit(2)
    except OSError as exc:
        print("socket 通信失败: %r" % (exc,), file=sys.stderr)
        raise SystemExit(3)
    return res


def cmd_daemon(args) -> int:
    sub = getattr(args, "sub", None)
    if getattr(args, "foreground", False) or args.cmd == "run":
        return daemon.run_foreground(refresh_interval=args.refresh_interval)
    if sub == "stop":
        res = _ask({"cmd": "shutdown"}, timeout=15.0)
        _out(res)
        return 0 if res.get("ok") else 1
    if getattr(args, "detach", False):
        if daemon.status_daemon()["running"]:
            print("daemon 已在运行")
            return 0
        process.spawn_detached(
            [sys.executable, "-m", "manager.cli", "daemon", "--foreground"],
            cwd=PKG_PARENT,
            log_path=os.path.join(config.LOG_DIR, "daemon.log"),
            env={**os.environ, "PYTHONPATH": PKG_PARENT})
        deadline = time.time() + 25
        while time.time() < deadline:
            st = daemon.status_daemon()
            if st["running"]:
                print("daemon 已启动 pid=%s socket=%s" % (st["pid"], config.CONTROL_SOCKET))
                return 0
            time.sleep(0.4)
        print("daemon 25s 内未登记 pidfile，见 logs/daemon.log", file=sys.stderr)
        return 1
    _out(daemon.status_daemon())
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="wt-kasm",
        description="K-route KasmVNC 桌面管理（vcmi / chrome-1 / chrome-2）")
    p.add_argument("--json", action="store_true", help="机器可读输出（list 默认表格）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="三桌面摘要（读 registry.json，不需要 daemon）")

    sp = sub.add_parser("status", help="详细状态（读实况）")
    sp.add_argument("id", nargs="?")

    sp = sub.add_parser("start", help="启动桌面（幂等：已运行不重建、app 不双开）")
    sp.add_argument("id")
    sp.add_argument("--no-app", action="store_true", help="只起桌面，不拉起默认 app")

    sp = sub.add_parser("stop", help="停桌面（收 app + relay + compose stop，不 rm）")
    sp.add_argument("id")

    sp = sub.add_parser("app", help="桌面内应用 start/focus/stop/status")
    sp.add_argument("action", choices=("start", "focus", "stop", "status"))
    sp.add_argument("id")
    # easyconnect = opt-in 宿主 app：choices 里出现不代表可拉起，服务端按注册表白名单
    # （config.APP_IDS_BY_DESKTOP）判定 ⇒ 未开 WT_KASM_EASYCONNECT 时照样被拒。
    sp.add_argument("--app", dest="appId", choices=("chrome", "vcmi", "easyconnect"))
    sp.add_argument("--test-cdp", action="store_true",
                    help="测试钩子：chrome-* 桌面开 CDP(port=0) 并回读 endpoint；生产默认无调试端口")
    sp.add_argument("--url", default=None,
                    help="chrome 起始 URL（仅固定 fixture；无任意 shell）")

    sp = sub.add_parser("init", help="建骨架 + 写 compose + 刷 registry（不启动容器）")
    sp.add_argument("--force", action="store_true")

    sp = sub.add_parser("verify", help="只读体检（逐检查项，不猜）")
    sp.add_argument("id")

    sp = sub.add_parser("registry", help="输出/刷新 dispatcher 消费契约")
    sp.add_argument("--refresh", action="store_true")

    sp = sub.add_parser("daemon", help="管理 daemon（--foreground 给 systemd；--detach 手工起）")
    sp.add_argument("sub", nargs="?", default="status", choices=("status", "stop"))
    sp.add_argument("--foreground", action="store_true")
    sp.add_argument("--detach", action="store_true")
    sp.add_argument("--refresh-interval", type=float,
                    default=float(os.environ.get("WT_KASM_REFRESH_INTERVAL", "30")))

    sp = sub.add_parser("run", help="等价 daemon --foreground（systemd 前台）")
    sp.add_argument("--refresh-interval", type=float,
                    default=float(os.environ.get("WT_KASM_REFRESH_INTERVAL", "30")))
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cmd = args.cmd
    if cmd in ("daemon", "run"):
        return cmd_daemon(args)
    if cmd == "list":
        rows = actions.list_brief()
        _out(rows) if args.json else _table(rows)
        return 0
    if cmd == "status":
        did = getattr(args, "id", None)
        if did and did not in config.DESKTOP_BY_ID:
            print("未登记的 id: %s（只认 %s）" % (did, ",".join(config.REGISTERED_IDS)),
                  file=sys.stderr)
            return 2
        _out(_ask({"cmd": "status", "args": {"id": did}}, timeout=120.0))
        return 0
    if cmd == "registry":
        _out(_ask({"cmd": "registry", "args": {"refresh": args.refresh}}, timeout=120.0))
        return 0
    if cmd == "init":
        res = _ask({"cmd": "init", "args": {"force": args.force}}, timeout=180.0)
    elif cmd == "verify":
        res = _ask({"cmd": "verify", "args": {"id": args.id}}, timeout=180.0)
        _out(res)
        d = res.get("data") or {}
        # 门禁诚实：verify 的退出码由**自动 12 项 plumbing 的 data.ok** 决定，
        # 不由 RPC 信封 ok 决定（root 2026-11-13 裁决）。GUI 实证不进 checks、
        # 只作中性字段 guiVerified=false ⇒ 既不把 GUI 记成 FAIL，也不因健康全绿把它改真。
        return 0 if (res.get("ok") and d.get("ok") and d.get("fail") == 0) else 1
    elif cmd == "start":
        res = _ask({"cmd": "start", "args": {"id": args.id, "app": not args.no_app}},
                   timeout=600.0)
    elif cmd == "stop":
        res = _ask({"cmd": "stop", "args": {"id": args.id}}, timeout=240.0)
    elif cmd == "app":
        res = _ask({"cmd": "app", "args": {"id": args.id, "action": args.action,
                                          "appId": args.appId, "cdp": args.test_cdp,
                                          "url": args.url}}, timeout=420.0)
    else:
        return 2
    _out(res)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
