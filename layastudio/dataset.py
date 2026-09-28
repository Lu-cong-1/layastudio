"""微调数据集导出：把推理历史转成 Laya 微调风格的 JSONL。

每行：{"state": ..., "questions": {...}, "answers": {...}} —— 与 predict() 输出同形。
支持筛选：按置信度阈值、按任务类型（choice/score/noul）过滤后导出。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def _run_confidence(run: Dict[str, Any]) -> Optional[float]:
    """该 run 全部答案中的最高置信度（answer_confidence 优先）。"""
    answers = run.get("answers") or {}
    confs = []
    for ans in answers.values():
        if not isinstance(ans, dict):
            continue
        c = ans.get("answer_confidence", ans.get("confidence"))
        if c is not None:
            try:
                confs.append(float(c))
            except (TypeError, ValueError):
                continue
    return max(confs) if confs else None


def _match_filters(run: Dict[str, Any], filters: Optional[Dict[str, Any]]) -> bool:
    if not filters:
        return True
    min_conf = filters.get("min_confidence")
    if min_conf is not None:
        conf = _run_confidence(run)
        if conf is None or conf < float(min_conf):
            return False
    has_type = filters.get("has_type")
    if has_type:
        types = {
            a.get("type")
            for a in (run.get("answers") or {}).values()
            if isinstance(a, dict)
        }
        if has_type not in types:
            return False
    return True


def export_runs(
    store,
    run_ids: Optional[List[int]],
    export_dir: Path,
    filters: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    runs = [r for r in store.iter_runs(run_ids) if _match_filters(r, filters)]
    if not runs:
        raise ValueError("没有符合条件的可导出记录（需 status=ok 且通过筛选）")
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
        "filtered_out": None if filters is None else "applied",
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
