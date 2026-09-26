"""模型管理：目录注册、下载（支持 HF 镜像）、安装状态、加载/卸载委托。

下载写入 Hugging Face 默认缓存（与 laya 加载路径一致），
成功后写 data/models/<key>.installed.json 标记作为安装凭证。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("layastudio.models")


@dataclass(frozen=True)
class ModelInfo:
    key: str
    repo: str
    label: str
    encoder: str
    params: str
    context: str
    use_for: str
    ignore_patterns: Optional[List[str]] = None


CATALOG: Dict[str, ModelInfo] = {
    "english": ModelInfo(
        key="english",
        repo="convaiinnovations/laya",
        label="Laya English",
        encoder="ModernBERT-large",
        params="421M",
        context="512",
        use_for="英文主力 checkpoint",
        # 根 repo 打包了三个 checkpoint；英文只取根层文件
        ignore_patterns=["multilingual/*", "typed-decisions/*"],
    ),
    "multilingual": ModelInfo(
        key="multilingual",
        repo="convaiinnovations/laya-multilingual",
        label="Laya Multilingual",
        encoder="mmBERT-base",
        params="322M",
        context="1024（max 8192）",
        use_for="100+ 语言，非英文流量路由到此",
    ),
    "typed-decisions": ModelInfo(
        key="typed-decisions",
        repo="convaiinnovations/laya-typed-decisions",
        label="Laya Typed-Decisions",
        encoder="ModernBERT-large",
        params="421M",
        context="1024",
        use_for="typed-decisions 工作流微调 checkpoint（0.766）",
    ),
}


class ModelManager:
    def __init__(self, data_dir: Path, settings, engine) -> None:
        self.data_dir = Path(data_dir)
        self.marker_dir = self.data_dir / "models"
        self.marker_dir.mkdir(parents=True, exist_ok=True)
        self.settings = settings
        self.engine = engine
        self._downloads: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ---- 状态 ----

    def _marker_path(self, key: str) -> Path:
        return self.marker_dir / f"{key}.installed.json"

    def is_installed(self, key: str) -> bool:
        return self._marker_path(key).exists()

    def _download_state(self, key: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._downloads.get(key, {"status": "idle"}))

    def list_models(self) -> List[Dict[str, Any]]:
        try:
            loaded = self.engine.backend.loaded
        except Exception:
            loaded = []
        out = []
        for info in CATALOG.values():
            marker = self._marker_path(info.key)
            installed = marker.exists()
            installed_at = None
            if installed:
                try:
                    installed_at = json.loads(marker.read_text("utf-8")).get("downloaded_at")
                except Exception:
                    pass
            out.append({
                **asdict(info),
                "installed": installed,
                "installed_at": installed_at,
                "loaded": info.key in loaded,
                "download": self._download_state(info.key),
            })
        return out

    # ---- 下载 ----

    def download(self, key: str) -> None:
        if key not in CATALOG:
            raise KeyError(key)
        with self._lock:
            current = self._downloads.get(key, {"status": "idle"})
            if current.get("status") == "downloading":
                return
            self._downloads[key] = {"status": "downloading", "started_at": time.time()}
        thread = threading.Thread(
            target=self._download_worker, args=(key,), daemon=True, name=f"dl-{key}"
        )
        thread.start()

    def _download_worker(self, key: str) -> None:
        info = CATALOG[key]
        try:
            # 国内镜像：在 import huggingface_hub 之前生效
            endpoint = self.settings.get("hf_endpoint").strip()
            if endpoint:
                os.environ.setdefault("HF_ENDPOINT", endpoint)
            from huggingface_hub import snapshot_download

            path = snapshot_download(
                repo_id=info.repo,
                ignore_patterns=info.ignore_patterns,
            )
            marker = {
                "repo": info.repo,
                "path": str(path),
                "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            self._marker_path(key).write_text(
                json.dumps(marker, ensure_ascii=False, indent=2), "utf-8")
            with self._lock:
                self._downloads[key] = {"status": "done", **marker}
            log.info("model %s downloaded to %s", key, path)
        except Exception as exc:
            log.exception("download failed: %s", key)
            with self._lock:
                self._downloads[key] = {"status": "error", "error": str(exc)}

    # ---- 加载 / 卸载 ----

    def load(self, key: str) -> List[str]:
        if key not in CATALOG:
            raise KeyError(key)
        return self.engine.preload([key])

    def unload(self, key: Optional[str] = None) -> List[str]:
        if key is not None and key not in CATALOG:
            raise KeyError(key)
        return self.engine.unload(key)
