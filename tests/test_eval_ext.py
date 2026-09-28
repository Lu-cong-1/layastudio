"""M1：CSV 导入 / 评估报告 / 筛选导出。"""

from __future__ import annotations

import csv
import io
import json

import pytest

from layastudio.dataset import export_runs
from layastudio.evals import build_report_md, parse_dataset
from layastudio.store import Store

Q = {"dept": {"type": "choice", "instructions": "d", "criteria": {"a": "甲", "b": "乙"}}}


def _csv_text():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["state", "questions", "expected"])
    w.writerow(["请退款", json.dumps(Q, ensure_ascii=False), json.dumps({"dept": "a"})])
    w.writerow(["查订单", json.dumps(Q, ensure_ascii=False), ""])
    return buf.getvalue()


def test_parse_csv_ok():
    rows = parse_dataset(_csv_text())
    assert len(rows) == 2
    assert rows[0]["expected"] == {"dept": "a"}
    assert rows[1]["expected"] == {}
    assert rows[0]["questions"]["dept"]["type"] == "choice"
    assert rows[0]["state"] == "请退款"


def test_parse_csv_bad_questions():
    bad = "state,questions,expected\nhi,not-json,\n"
    with pytest.raises(ValueError) as e:
        parse_dataset(bad)
    assert "第 2 行" in str(e.value)


def test_parse_csv_missing_cols():
    with pytest.raises(ValueError) as e:
        parse_dataset("foo,bar\n1,2\n")
    assert "表头" in str(e.value)


def test_jsonl_still_works():
    line = json.dumps({"state": "s", "questions": Q, "expected": {"dept": "a"}})
    rows = parse_dataset(line)
    assert rows[0]["state"] == "s"


def test_build_report_md():
    job = {
        "id": 7, "name": "t", "status": "done", "total": 2, "done": 2, "correct": 1,
        "backend": "mock", "model": None, "dataset_name": "d",
        "created_at": "x", "finished_at": "y",
        "metrics": {
            "overall_accuracy": 0.5, "choice_accuracy": 0.5, "choice_n": 2,
            "choice_confusion": {"a": {"a": 1, "b": 1}},
        },
    }
    items = [
        {"idx": 0, "state": "s1", "expected": {"dept": "a"},
         "results": {"dept": True}, "correct": 1},
        {"idx": 1, "state": "s2", "expected": {"dept": "a"},
         "results": {"dept": False},
         "predicted": {"dept": {"type": "choice", "choice": "b"}}, "correct": 0},
    ]
    md = build_report_md(job, items)
    assert "评估报告 · t" in md
    assert "混淆矩阵" in md
    assert "错误样本（1 条）" in md
    assert "s2" in md
    assert "overall_accuracy" in md


def test_export_filters(tmp_path):
    store = Store(tmp_path / "t.db")
    hi = store.add_run(
        source="api", backend="mock", model_requested=None, model_routed="mock",
        state="s", questions=Q,
        answers={"a": {"type": "choice", "choice": "x", "confidence": 0.95}},
        status="ok")
    lo = store.add_run(
        source="api", backend="mock", model_requested=None, model_routed="mock",
        state="s2", questions=Q,
        answers={"a": {"type": "noul", "noul": 0.4, "confidence": 0.4}},
        status="ok")
    out = export_runs(store, None, tmp_path / "ex", filters={"min_confidence": 0.9})
    assert out["rows"] == 1 and out["run_ids"] == [hi]
    out2 = export_runs(store, None, tmp_path / "ex", filters={"has_type": "noul"})
    assert out2["rows"] == 1 and out2["run_ids"] == [lo]
    with pytest.raises(ValueError):
        export_runs(store, None, tmp_path / "ex", filters={"min_confidence": 0.999, "has_type": "score"})

def test_eval_export_dataset(tmp_path):
    import json as _json
    import time as _t
    from pathlib import Path

    from fastapi.testclient import TestClient as _TC

    from layastudio.server import create_app as _ca

    with _TC(_ca(data_dir=tmp_path / "data")) as client:
        ds = _json.dumps(
            [{"state": "refund please", "questions": Q, "expected": {"dept": "billing"}}],
            ensure_ascii=False)
        r = client.post("/api/eval", json={"name": "exp-ds", "dataset": ds})
        job_id = r.json()["id"]
        for _ in range(60):
            j = client.get(f"/api/eval/{job_id}").json()
            if j["status"] == "done":
                break
            _t.sleep(0.05)
        assert j["status"] == "done"
        out = client.post(f"/api/eval/{job_id}/export-dataset")
        assert out.status_code == 200
        payload = out.json()
        assert payload["rows"] == 1
        assert "finetune" in payload["filename"]
        lines = Path(payload["path"]).read_text(encoding="utf-8").strip().splitlines()
        row = _json.loads(lines[0])
        assert row["expected"] == {"dept": "billing"}
        assert "questions" in row and "state" in row