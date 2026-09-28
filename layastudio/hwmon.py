"""硬件快照：显存 / 内存占用。

采集链兜底：显存以 torch.cuda.mem_get_info（驱动级 free/total）为主路径
—— 本机 nvidia-smi 的 NVML 初始化存在已知故障，不可依赖；psutil 读内存。
全部失败时返回 None 字段，UI 显示「—」。
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def device_kind() -> Optional[str]:
    """实际可执行推理的设备类别：cuda / cpu / None（未知）。"""
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return None


def hw_snapshot() -> Dict[str, Any]:
    out: Dict[str, Any] = {"gpu": None, "mem": None}

    try:
        import psutil

        vm = psutil.virtual_memory()
        out["mem"] = {
            "total_mb": round(vm.total / 1048576),
            "used_mb": round(vm.used / 1048576),
            "percent": round(vm.percent, 1),
        }
    except Exception:
        pass

    try:
        import torch

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            used = total - free
            out["gpu"] = {
                "name": torch.cuda.get_device_name(0),
                "total_mb": round(total / 1048576),
                "used_mb": round(used / 1048576),
                "percent": round(used / total * 100, 1) if total else 0.0,
            }
    except Exception:
        pass

    return out
