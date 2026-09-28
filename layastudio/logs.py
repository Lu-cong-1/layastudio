"""环形日志缓冲：捕获 root logger 输出，供 UI 查看 / 分级过滤 / 导出。

uvicorn 与业务 logger 默认 propagate 到 root，挂一个 handler 即可全量收集；
容量 1000 条，超出丢弃最旧。UI 与导出都只读本缓冲，不改写文件日志。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional

MAX_LOGS = 1000
_LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

_handler: Optional["RingBufferHandler"] = None
_lock = threading.Lock()


class RingBufferHandler(logging.Handler):
    def __init__(self, capacity: int = MAX_LOGS) -> None:
        super().__init__()
        self.buf: deque = deque(maxlen=capacity)
        self._buf_lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(record.created)),
                "level": record.levelname,
                "logger": record.name,
                "msg": self.format(record),
            }
            with self._buf_lock:
                self.buf.append(entry)
        except Exception:  # 日志失败绝不打扰业务
            pass


def get_handler() -> RingBufferHandler:
    """获取（并幂等挂载）环形 handler。

    策略：handler 只挂 root；uvicorn 的三个 logger 设 propagate=True 让记录
    单次冒泡到 root（其默认 propagate=False，且 dictConfig 会重置，故需幂等重挂）。
    若在 leaf 上也挂 handler 会出现「leaf + root」双重记录。
    """
    global _handler
    with _lock:
        if _handler is None:
            handler = RingBufferHandler()
            handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
            _handler = handler
        handler = _handler
        root = logging.getLogger()
        if handler not in root.handlers:
            root.addHandler(handler)
        for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
            logging.getLogger(name).propagate = True
        return handler


def get_logs(level: str = "INFO", limit: int = 200) -> List[Dict[str, Any]]:
    handler = get_handler()
    min_lv = _LEVELS.get(level.upper(), 20)
    with handler._buf_lock:
        entries = list(handler.buf)
    return [e for e in entries if _LEVELS.get(e["level"], 20) >= min_lv][-max(1, limit):]


def export_text(level: str = "DEBUG") -> str:
    entries = get_logs(level=level, limit=MAX_LOGS)
    return "\n".join(f'[{e["ts"]}] {e["level"]} {e["msg"]}' for e in entries) + "\n"
