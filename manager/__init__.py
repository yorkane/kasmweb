"""wt-kasm K 路线桌面管理模块（KasmVNC / Alpine317 基座）。

唯一写源码范围 = script/webtop-kasmvnc/manager/** 与 script/webtop-kasmvnc/wt-kasm、
script/webtop-kasmvnc/install-manager.sh。所有 state/data/process 只落
/data/app/webtop-kasmvnc/（image-probe 子目录属镜像 worker，不触碰）。

契约来源：doc/Webtop多桌面通道设计-KasmVNC-并行交接-20261113.md（K 线交接）
+ root 本轮任务卡（2026-11-13）。
"""
__version__ = "0.1.2"
