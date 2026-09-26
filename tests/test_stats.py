"""观测台 /api/stats 聚合测试。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from layastudio.server import create_app

QUESTIONS = {
    "dept": {"type": "choice", "instructions": "Which department?",
             "criteria": {"billing": "invoices, refunds", "technical": "bugs, outages"}},
    "urgent": {"type": "noul", "instructions": "Is this urgent?"},
}


def _run(client, state):
    r = client.post("/api/predict", json={"state": state, "questions": QUESTIONS})
    assert r.status_code == 200, r.text


def test_stats_shape_and_aggregation(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as client:
        # 空库
        s = client.get("/api/stats").json()
        assert s["totals"]["runs"] == 0
        assert s["latency"]["recent"] == []
        assert s["hourly"] and len(s["hourly"]) == 12
        assert "live" in s and s["live"]["status"] == "ok"

        _run(client, "Please refund the duplicate charge on invoice 4411")
        _run(client, "The server returns 500 on every request")
        # 语义校验失败按设计不落库（422 是调用方错误）；error 行直接注入以测聚合
        bad = client.post("/api/predict", json={
            "state": "x", "questions": {"a": {"type": "choice", "instructions": "q"}}})
        assert bad.status_code == 422
        app.state.store.add_run(
            source="api", backend="mock", model_requested=None, model_routed=None,
            state="boom", questions={}, status="error", error="inference failed")

        s = client.get("/api/stats").json()
        assert s["totals"]["runs"] == 3
        assert s["totals"]["ok"] == 2
        assert s["totals"]["error"] == 1
        assert s["totals"]["today"] == 3
        assert len(s["latency"]["recent"]) == 2
        assert s["latency"]["p50"] is not None and s["latency"]["avg"] > 0
        assert sum(s["routing"].values()) == 2          # 仅 ok 计入路由
        assert s["intents"].get("billing", 0) >= 1      # choice 标签被聚合
        assert s["primitives"].get("choice") == 2
        assert s["primitives"].get("noul") == 2
        assert len(s["recent"]) == 3
        assert s["recent"][0]["preview"]                # 事件流带摘要
        assert sum(h["count"] for h in s["hourly"]) == 3


def test_stats_error_run_excluded_from_intent(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as client:
        _run(client, "refund please")
        s = client.get("/api/stats").json()
        ok_runs = s["totals"]["ok"]
        assert ok_runs == 1
        assert sum(s["intents"].values()) >= 1
