"""批量评估：jsonl 数据集 → 逐条预测 → 指标汇总（后台线程执行）。

数据集格式（每行一个对象）：
    {"state": ..., "questions": {...}, "expected": {"qid": expected_value}}
    choice → 标签字符串；noul → 布尔；score → 数值（容忍 ±0.51）
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("layastudio.evals")


def parse_dataset(text: str) -> List[Dict[str, Any]]:
    """接受 JSON 数组，或 JSONL（每行一个对象）。"""
    text = text.strip()
    if not text:
        raise ValueError("数据集为空")
    if text.startswith("["):
        data = json.loads(text)
        if not isinstance(data, list):
            raise ValueError("JSON 数组才是合法数据集")
        rows = data
    else:
        rows = []
        for i, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"第 {i} 行不是合法 JSON：{exc}") from exc
    for i, row in enumerate(rows):
        if not isinstance(row, dict) or "state" not in row or "questions" not in row:
            raise ValueError(f"第 {i + 1} 条缺少 state/questions 字段")
    if not rows:
        raise ValueError("数据集为空")
    return rows


def _compare(qtype: str, answer: Dict[str, Any], expected: Any) -> Optional[bool]:
    """返回 True/False；无法比较（类型不匹配等）返回 None。"""
    if qtype == "choice":
        return answer.get("choice") == expected
    if qtype == "noul":
        p = answer.get("noul")
        if p is None or expected is None:
            return None
        if isinstance(expected, bool):
            return (p >= 0.5) == expected
        if isinstance(expected, (int, float)):
            return abs(float(p) - float(expected)) <= 0.25
        return None
    if qtype == "score":
        pred = answer.get("score")
        if pred is None or not isinstance(expected, (int, float)):
            return None
        return abs(float(pred) - float(expected)) <= 0.51
    return None


class EvalRunner:
    """后台线程跑一个评估任务；取消通过 job 状态轮询实现。"""

    def __init__(self, store, engine) -> None:
        self.store = store
        self.engine = engine
        self._cancel: Dict[int, threading.Event] = {}

    def start(self, *, name: str, dataset_name: Optional[str], rows: List[Dict[str, Any]],
              model: Optional[str]) -> int:
        job_id = self.store.create_job(
            name=name, dataset_name=dataset_name, model=model,
            backend=self.engine.backend_name, total=len(rows),
        )
        cancel = threading.Event()
        self._cancel[job_id] = cancel
        thread = threading.Thread(
            target=self._run, args=(job_id, rows, model, cancel),
            daemon=True, name=f"eval-{job_id}",
        )
        thread.start()
        return job_id

    def cancel(self, job_id: int) -> bool:
        event = self._cancel.get(job_id)
        if event is None:
            return False
        event.set()
        return True

    def _run(self, job_id: int, rows: List[Dict[str, Any]],
             model: Optional[str], cancel: threading.Event) -> None:
        by_type: Dict[str, List[bool]] = {"choice": [], "noul": [], "score": []}
        latencies: List[float] = []
        rows_correct = 0
        scored = 0
        try:
            for idx, row in enumerate(rows):
                if cancel.is_set():
                    self.store.update_job(
                        job_id, status="cancelled",
                        finished_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    )
                    return
                state = row["state"]
                questions = row["questions"]
                expected = row.get("expected") or {}
                item: Dict[str, Any] = {
                    "idx": idx, "state": state, "questions": questions,
                    "expected": expected,
                }
                try:
                    result, latency = self.engine.predict_sync(
                        state, questions, model=model,
                        source="eval", record=False,
                    )
                    answers = result.get("answers") or {}
                    item["predicted"] = answers
                    item["latency_ms"] = round(latency, 2)
                    latencies.append(latency)
                    item_results: Dict[str, Any] = {}
                    all_ok = True
                    any_compared = False
                    for qid, exp in expected.items():
                        ans = answers.get(qid) or {}
                        qtype = ans.get("type") or questions.get(qid, {}).get("type")
                        verdict = _compare(qtype, ans, exp) if qtype else None
                        item_results[qid] = verdict
                        if verdict is not None:
                            any_compared = True
                            by_type.setdefault(qtype, []).append(verdict)
                            scored += 1
                            if not verdict:
                                all_ok = False
                    if not any_compared:
                        all_ok = False
                    item["results"] = item_results
                    item["correct"] = 1 if (all_ok and expected) else 0
                    if item["correct"]:
                        rows_correct += 1
                except Exception as exc:
                    item["error"] = str(exc)
                    item["correct"] = 0
                self.store.add_job_item(job_id, item)
                self.store.update_job(job_id, done=idx + 1, correct=rows_correct)

            metrics: Dict[str, Any] = {
                "overall_accuracy": round(rows_correct / len(rows), 4) if rows else 0.0,
                "scored": scored,
                "mean_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
            }
            for qtype, verdicts in by_type.items():
                if verdicts:
                    metrics[f"{qtype}_accuracy"] = round(
                        sum(1 for v in verdicts if v) / len(verdicts), 4)
                    metrics[f"{qtype}_n"] = len(verdicts)
            self.store.update_job(
                job_id, status="done", metrics_json=json.dumps(metrics, ensure_ascii=False),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            )
        except Exception as exc:
            log.exception("eval job %s crashed", job_id)
            self.store.update_job(
                job_id, status="error", error=str(exc),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            )
        finally:
            self._cancel.pop(job_id, None)
