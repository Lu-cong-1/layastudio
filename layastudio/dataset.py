"""微调数据集导出：把推理历史转成 Laya 微调风格的 JSONL。

每行：{"state": ..., "questions": {...}, "answers": {...}} —— 与 predict() 输出同形。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def export_runs(store, run_ids: Optional[List[int]], export_dir: Path) -> Dict[str, Any]:
    runs = store.iter_runs(run_ids)
    if not runs:
        raise ValueError("没有可导出的成功推理记录（需要 status=ok 的 run）")
    export_dir = Path(export_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    filename = f"laya_finetune_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
    path = export_dir / filename
    rows: List[Dict[str, Any]] = []
    with path.open("w", encoding="utf-8") as fh:
        for run in runs:
            row = {
                "state": run["state"],
                "questions": run["questions"],
                "answers": run["answers"],
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            rows.append({
                "run_id": run["id"],
                "created_at": run["created_at"],
                "model_routed": run["model_routed"],
            })
    return {
        "path": str(path),
        "filename": filename,
        "rows": len(rows),
        "run_ids": [r["run_id"] for r in rows],
    }


def list_exports(export_dir: Path) -> List[Dict[str, Any]]:
    export_dir = Path(export_dir)
    if not export_dir.exists():
        return []
    out = []
    for path in sorted(export_dir.glob("*.jsonl"), reverse=True):
        stat = path.stat()
        out.append({
            "filename": path.name,
            "path": str(path),
            "size_bytes": stat.st_size,
            "modified_at": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
        })
    return out
