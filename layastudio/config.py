"""运行时设置：默认值、LAYASTUDIO_* 环境变量覆盖、SQLite 持久化。

读取优先级：环境变量 > 数据库 > 默认值。
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Dict, Optional

if TYPE_CHECKING:
    from .store import Store

DEFAULTS: Dict[str, str] = {
    # auto = 能 import laya 就用真实后端，否则回落 mock
    "backend": "auto",          # auto | laya | mock
    "device": "",               # "" = 自动，或 cuda / cpu / mps / xpu
    "hf_endpoint": "https://hf-mirror.com",
    "hf_cache_dir": "",         # 空 = HuggingFace 默认缓存
    "max_concurrent": "4",      # 推理准入上限，超限 503（防 GPU 过载）
    "api_key": "",              # 非空则 /v1/systemone 要求 Bearer
    "api_enabled": "1",         # 0 = 停用 /v1/systemone（/health 恒开）
    "record_history": "1",
    "option_warn_threshold": "20",  # UI 对超过该选项数的 choice 出警示
    "host": "127.0.0.1",
    "port": "9527",
}


class Settings:
    def __init__(self, store: Optional["Store"] = None) -> None:
        self.store = store
        self._cache: Dict[str, str] = dict(DEFAULTS)
        if store is not None:
            for key, value in store.all_settings().items():
                if key in DEFAULTS:
                    self._cache[key] = value
        for key in DEFAULTS:
            env = os.environ.get(f"LAYASTUDIO_{key.upper()}")
            if env is not None:
                self._cache[key] = env

    def get(self, key: str) -> str:
        return self._cache.get(key, DEFAULTS.get(key, ""))

    def get_int(self, key: str) -> int:
        try:
            return int(self.get(key))
        except (TypeError, ValueError):
            try:
                return int(DEFAULTS[key])
            except (KeyError, ValueError):
                return 0

    def get_bool(self, key: str) -> bool:
        return self.get(key).strip().lower() in ("1", "true", "yes", "on")

    def set(self, key: str, value) -> None:
        if key not in DEFAULTS:
            raise KeyError(f"unknown setting: {key}")
        self._cache[key] = str(value)
        if self.store is not None:
            self.store.set_setting(key, self._cache[key])

    def update(self, values: Dict[str, object]) -> None:
        for key, value in values.items():
            self.set(key, value)

    def as_dict(self) -> Dict[str, str]:
        return dict(self._cache)
