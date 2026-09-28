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
    size_hint: str = ""
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
        size_hint="约 810 MB",
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
        size_hint="约 650 MB",
    ),
    "typed-decisions": ModelInfo(
        key="typed-decisions",
        repo="convaiinnovations/laya-typed-decisions",
        label="Laya Typed-Decisions",
        encoder="ModernBERT-large",
        params="421M",
        context="1024",
        use_for="typed-decisions 工作流微调 checkpoint（0.766）",
        size_hint="约 850 MB",
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
        if self._marker_path(key).exists():
            return True
        # 外部手动下载（如 huggingface-cli）也识别为已安装
        try:
            cache = self._repo_cache_dir(CATALOG[key].repo)
            return cache.exists() and any(cache.iterdir())
        except Exception:
            return False

    # ---- RLCD 温度校准状态（P1-2） ----

    @staticmethod
    def _find_rl_config(base: Path) -> Optional[Path]:
        direct = base / "rl_agent_config.json"
        if direct.exists():
            return direct
        try:
            for p in base.rglob("rl_agent_config.json"):
                return p
        except OSError:
            pass
        return None

    @staticmethod
    def _collect_temperature(obj: Any, found: List[Any]) -> None:
        """递归收集所有含 temperature 的键值（全局数值 / 分桶结构均兼容）。"""
        if isinstance(obj, dict):
            for k, v in obj.items():
                if "temperature" in str(k).lower():
                    found.append((str(k), v))
                elif isinstance(v, (dict, list)):
                    ModelManager._collect_temperature(v, found)
        elif isinstance(obj, list):
            for v in obj:
                if isinstance(v, (dict, list)):
                    ModelManager._collect_temperature(v, found)

    def read_temperature(self, key: str) -> Dict[str, Any]:
        """checkpoint 温度校准状态。

        state: unavailable=未安装 · none=无温度配置（未校准）·
               global=单一全局温度 · bucket/multi=分桶或多处温度 · unknown=解析失败
        """
        if key not in CATALOG:
            return {"state": "unavailable"}
        if not self.is_installed(key):
            return {"state": "unavailable"}
        base: Optional[Path] = None
        marker = self._marker_path(key)
        if marker.exists():
            try:
                p = json.loads(marker.read_text("utf-8")).get("path")
                if p:
                    base = Path(p)
            except Exception:
                base = None
        if base is None or not base.exists():
            base = self._repo_cache_dir(CATALOG[key].repo)
        if base is None or not base.exists():
            return {"state": "unavailable"}
        cfg_path = self._find_rl_config(base)
        if cfg_path is None:
            return {"state": "none"}
        try:
            cfg = json.loads(cfg_path.read_text("utf-8"))
        except Exception:
            return {"state": "unknown"}
        found: List[Any] = []
        self._collect_temperature(cfg, found)
        if not found:
            return {"state": "none"}
        nums = [(k, v) for k, v in found
                if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if len(nums) == 1:
            return {"state": "global", "value": round(float(nums[0][1]), 4),
                    "key": nums[0][0]}
        if len(nums) > 1:
            return {"state": "multi", "keys": [k for k, _ in nums]}
        return {"state": "bucket", "keys": [k for k, _ in found]}

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
            revision = None
            if installed:
                try:
                    data = json.loads(marker.read_text("utf-8"))
                    installed_at = data.get("downloaded_at")
                    revision = data.get("revision")
                except Exception:
                    pass
            out.append({
                **asdict(info),
                "installed": installed,
                "installed_at": installed_at,
                "revision": revision,
                "loaded": info.key in loaded,
                "download": self._download_state(info.key),
                "temperature": self.read_temperature(info.key),
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
            self._downloads[key] = {
                "status": "downloading", "started_at": time.time(),
                "total_bytes": None, "got_bytes": 0,
            }
        thread = threading.Thread(
            target=self._download_worker, args=(key,), daemon=True, name=f"dl-{key}"
        )
        thread.start()

    def _hf_cache_dir(self) -> Optional[str]:
        configured = (self.settings.get("hf_cache_dir") or "").strip()
        return configured or None

    def _repo_cache_dir(self, repo: str) -> Path:
        import os as _os
        cache_root = self._hf_cache_dir() or _os.environ.get("HF_HUB_CACHE") or (
            Path.home() / ".cache" / "huggingface" / "hub"
        )
        return Path(cache_root) / ("models--" + repo.replace("/", "--"))

    @staticmethod
    def _dir_size(path: Path) -> int:
        total = 0
        if not path.exists():
            return 0
        for f in path.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                continue
        return total

    def _download_worker(self, key: str) -> None:
        info = CATALOG[key]
        stop_ticker = threading.Event()
        try:
            endpoint = self.settings.get("hf_endpoint").strip()
            if endpoint:
                os.environ.setdefault("HF_ENDPOINT", endpoint)
            from huggingface_hub import snapshot_download

            # 总量：model_info 的 sibling 文件尺寸之和（拿不到就只显示已下字节）
            total_bytes = None
            revision = None
            try:
                from huggingface_hub import HfApi

                meta = HfApi().model_info(info.repo, files_metadata=True)
                total_bytes = sum(
                    (s.size or 0) for s in (meta.siblings or [])
                ) or None
                revision = (getattr(meta, "sha", "") or "")[:7] or None
            except Exception:
                pass
            with self._lock:
                self._downloads[key]["total_bytes"] = total_bytes

            def ticker() -> None:
                cache_dir = self._repo_cache_dir(info.repo)
                while not stop_ticker.is_set():
                    got = self._dir_size(cache_dir)
                    with self._lock:
                        if key in self._downloads and self._downloads[key].get("status") == "downloading":
                            self._downloads[key]["got_bytes"] = got
                    stop_ticker.wait(1.5)

            threading.Thread(target=ticker, daemon=True, name=f"dl-prog-{key}").start()

            path = snapshot_download(
                repo_id=info.repo,
                ignore_patterns=info.ignore_patterns,
                cache_dir=self._hf_cache_dir(),
            )
            marker = {
                "repo": info.repo,
                "path": str(path),
                "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "revision": revision,
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
        finally:
            stop_ticker.set()

    # ---- 加载 / 卸载 ----

    def load(self, key: str) -> List[str]:
        if key not in CATALOG:
            raise KeyError(key)
        return self.engine.preload([key])

    def unload(self, key: Optional[str] = None) -> List[str]:
        if key is not None and key not in CATALOG:
            raise KeyError(key)
        return self.engine.unload(key)
