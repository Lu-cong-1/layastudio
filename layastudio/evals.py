"""批量评估：数据集 → 逐条预测 → 指标汇总（后台线程执行）。

支持三种数据集格式：
- JSON 数组：[{"state":..., "questions":{...}, "expected":{...}}, ...]
- JSONL：每行一个上述对象
- CSV：表头含 state,questions,expected 列；questions/expected 单元格为 JSON 字符串
  （Excel 可直接编辑导出；expected 可留空）

expected 值约定：choice → 标签字符串；noul → 布尔；score → 数值（容忍 ±0.51）
"""

from __future__ import annotations

import csv
import io
import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("layastudio.evals")


def _parse_csv(text: str) -> List[Dict[str, Any]]:
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    fields = [(f or "").strip() for f in (reader.fieldnames or [])]
    if "state" not in fields or "questions" not in fields:
        raise ValueError(
            "CSV 需要表头列：state, questions, expected（expected 可留空）")
    rows: List[Dict[str, Any]] = []
    for i, raw in enumerate(reader, 2):
        row = {(k or "").strip(): (v or "").strip() for k, v in raw.items() if k}
        try:
            questions = json.loads(row.get("questions") or "null")
        except json.JSONDecodeError as exc:
            raise ValueError(f"第 {i} 行 questions 不是合法 JSON：{exc}") from exc
        expected: Dict[str, Any] = {}
        if row.get("expected"):
            try:
                expected = json.loads(row["expected"])
            except json.JSONDecodeError as exc:
                raise ValueError(f"第 {i} 行 expected 不是合法 JSON：{exc}") from exc
        rows.append({
            "state": row.get("state", ""),
            "questions": questions,
            "expected": expected,
        })
    if not rows:
        raise ValueError("数据集为空")
    return rows


def parse_dataset(text: str) -> List[Dict[str, Any]]:
    """接受 JSON 数组、JSONL、或带 state/questions/expected 表头的 CSV。"""
    text = text.strip()
    if not text:
        raise ValueError("数据集为空")
    first_line = text.splitlines()[0]
    # JSON / JSONL 以 [ 或 { 开头；其余含分隔符的表格文本按 CSV 处理
    looks_csv = (
        not text.startswith(("[", "{"))
        and any(d in first_line for d in (",", ";", "\t"))
    )
    if looks_csv:
        return _parse_csv(text)
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
        confusion: Dict[str, Dict[str, int]] = {}
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
                        # choice 混淆矩阵：期望 × 预测（含对角线）
                        if qtype == "choice" and exp is not None and ans.get("choice") is not None:
                            e_lbl, p_lbl = str(exp), str(ans["choice"])
                            row_cm = confusion.setdefault(e_lbl, {})
                            row_cm[p_lbl] = row_cm.get(p_lbl, 0) + 1
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
            if confusion:
                metrics["choice_confusion"] = confusion
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


def build_report_md(job: Dict[str, Any], items: List[Dict[str, Any]]) -> str:
    """把评估任务渲染为 Markdown 报告文本（含混淆矩阵与错误样本清单）。"""
    metrics = job.get("metrics") or {}
    confusion = metrics.get("choice_confusion") or {}
    lines = [
        f"# 评估报告 · {job.get('name') or job.get('id')}",
        "",
        f"- 任务 ID：{job.get('id')}",
        f"- 数据集：{job.get('dataset_name') or '（未命名）'}",
        f"- 后端：{job.get('backend') or '—'}　模型：{job.get('model') or 'auto'}",
        f"- 状态：{job.get('status')}　样本：{job.get('total')}　完成：{job.get('done')}　"
        f"全对行：{job.get('correct')}",
        f"- 创建：{job.get('created_at')}　结束：{job.get('finished_at') or '—'}",
        "",
        "## 指标",
        "",
    ]
    for key in ("overall_accuracy", "choice_accuracy", "choice_n",
                "noul_accuracy", "noul_n", "score_accuracy", "score_n",
                "scored", "mean_latency_ms"):
        if key in metrics:
            lines.append(f"- {key}：{metrics[key]}")

    if confusion:
        labels = sorted(set(list(confusion.keys()) +
                            [p for row in confusion.values() for p in row]))
        lines += ["", "## Choice 混淆矩阵（行=期望 / 列=预测）", "",
                  "| 期望 \\ 预测 | " + " | ".join(labels) + " |",
                  "|---" * (len(labels) + 1) + "|"]
        for true_lbl in labels:
            cells = [str(confusion.get(true_lbl, {}).get(pred, 0)) for pred in labels]
            lines.append(f"| **{true_lbl}** | " + " | ".join(cells) + " |")

    wrong = [it for it in items if not it.get("correct")]
    lines += ["", f"## 错误样本（{len(wrong)} 条）", ""]
    if not wrong:
        lines.append("（无）")
    for it in wrong:
        state = it.get("state")
        state_s = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        if len(state_s) > 80:
            state_s = state_s[:80] + "…"
        lines += [
            f"### #{it.get('idx')} {state_s}",
            "",
            f"- 期望：`{json.dumps(it.get('expected') or {}, ensure_ascii=False)}`",
            f"- 预测：`{json.dumps(it.get('results') or {}, ensure_ascii=False)}`",
            "",
        ]
        if it.get("error"):
            lines += [f"- 错误：`{it['error']}`", ""]
    return "\n".join(lines)
