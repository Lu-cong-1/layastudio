"""服务层测试：Jev 端点协议兼容 + 工作台 API（TestClient，无 GPU）。"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from layastudio.server import create_app

QUESTIONS = {
    "dept": {"type": "choice", "instructions": "Which department?",
             "criteria": {"billing": "invoices, payments, refunds",
                          "technical": "bugs, outages"}},
    "urgent": {"type": "noul", "instructions": "Is this urgent?"},
}

REQ = {
    "state": "We were billed twice for March, please refund today or we cancel.",
    "questions": QUESTIONS,
}


@pytest.fixture()
def client(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as c:
        yield c


# ---------------- Jev 端点 ----------------

def test_systemone_happy_path(client):
    r = client.post("/v1/systemone", json=REQ)
    assert r.status_code == 200
    body = r.json()
    assert set(["answers", "usage"]).issubset(body)
    assert body["answers"]["dept"]["choice"] in QUESTIONS["dept"]["criteria"]
    assert body["usage"]["input_tokens"] > 0
    assert r.headers["Server-Timing"].startswith("inference;dur=")
    assert float(r.headers["X-Inference-Time-Ms"]) >= 0


def test_systemone_unknown_model_is_auto(client):
    r = client.post("/v1/systemone", json={**REQ, "model": "jev-1"})
    assert r.status_code == 200


def test_systemone_known_model_honoured(client):
    r = client.post("/v1/systemone", json={**REQ, "model": "multilingual"})
    assert r.status_code == 200
    assert r.json()["routing"]["model"] == "multilingual"


def test_missing_state_400(client):
    r = client.post("/v1/systemone", json={"questions": QUESTIONS})
    assert r.status_code == 400
    assert "'state' is required" in r.json()["detail"]


def test_missing_questions_400(client):
    r = client.post("/v1/systemone", json={"state": "hi"})
    assert r.status_code == 400


def test_malformed_json_400(client):
    r = client.post("/v1/systemone", content=b"{not json",
                    headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["detail"] == "request body must be valid JSON"


def test_state_too_large_413(client):
    r = client.post("/v1/systemone", json={"state": "x" * 50_001, "questions": QUESTIONS})
    assert r.status_code == 413


def test_choice_without_criteria_422(client):
    r = client.post("/v1/systemone", json={
        "state": "hi", "questions": {"a": {"type": "choice", "instructions": "x"}}})
    assert r.status_code == 422


def test_auth_flow(client):
    assert client.put("/api/settings", json={"api_key": "s3cret"}).status_code == 200
    assert client.post("/v1/systemone", json=REQ).status_code == 401
    ok = client.post("/v1/systemone", json=REQ,
                     headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200
    client.put("/api/settings", json={"api_key": ""})


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["backend"] == "mock"


# ---------------- 工作台 API ----------------

def test_status_shape(client):
    body = client.get("/api/status").json()
    assert body["version"]
    assert body["backend"] == "mock"
    assert body["limits"]["max_questions"] == 64
    assert body["hf_endpoint"].startswith("https://")


def test_predict_playground_records_history(client):
    r = client.post("/api/predict", json=REQ)
    assert r.status_code == 200
    payload = r.json()
    assert "result" in payload and payload["latency_ms"] >= 0
    history = client.get("/api/history").json()
    assert history["total"] == 1
    assert history["runs"][0]["source"] == "playground"


def test_history_lifecycle(client):
    client.post("/api/predict", json=REQ)
    history = client.get("/api/history").json()
    run_id = history["runs"][0]["id"]
    detail = client.get(f"/api/history/{run_id}").json()
    assert detail["answers"]["dept"]["choice"] in ("billing", "technical")
    assert client.delete(f"/api/history/{run_id}").status_code == 200
    assert client.get(f"/api/history/{run_id}").status_code == 404
    client.post("/api/predict", json=REQ)
    assert client.post("/api/history/clear").json()["deleted"] == 1


def test_presets(client):
    presets = client.get("/api/presets").json()
    assert len(presets) == 5
    triage = next(p for p in presets if p["id"] == "triage")
    assert "department" in triage["questions"]


def test_models_list_in_mock_mode(client):
    models = client.get("/api/models").json()
    assert {m["key"] for m in models} == {"english", "multilingual", "typed-decisions"}
    for m in models:
        assert m["installed"] is False
        assert m["download"]["status"] == "idle"
        assert m["loaded"] is False


def test_settings_roundtrip(client):
    before = client.get("/api/settings").json()
    assert before["backend"] in ("auto", "mock")  # conftest 可能强制 mock
    after = client.put("/api/settings", json={"backend": "mock", "max_concurrent": "8"})
    assert after.status_code == 200
    assert after.json()["max_concurrent"] == "8"
    assert client.get("/api/status").json()["max_concurrent"] == 8
    bad = client.put("/api/settings", json={"nope": "1"})
    assert bad.status_code == 422


def test_dataset_export(client):
    for _ in range(2):
        client.post("/api/predict", json=REQ)
    r = client.post("/api/dataset/export", json={})
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["rows"] == 2
    exports = client.get("/api/exports").json()
    assert any(e["filename"] == payload["filename"] for e in exports)
    # 无记录可导出
    client.post("/api/history/clear")
    empty = client.post("/api/dataset/export", json={})
    assert empty.status_code == 400


def test_eval_roundtrip(client):
    dataset = [
        {"state": "Please refund the duplicate charge on invoice 4411",
         "questions": {"dept": QUESTIONS["dept"]},
         "expected": {"dept": "billing"}},
        {"state": "The server returns 500 on every request",
         "questions": {"dept": QUESTIONS["dept"]},
         "expected": {"dept": "technical"}},
    ]
    r = client.post("/api/eval", json={"name": "smoke", "dataset": dataset})
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    job = None
    for _ in range(100):
        job = client.get(f"/api/eval/{job_id}").json()
        if job["status"] in ("done", "error", "cancelled"):
            break
        time.sleep(0.05)
    assert job["status"] == "done", job
    assert job["total"] == 2 and job["done"] == 2
    assert job["metrics"]["overall_accuracy"] == 1.0
    assert job["metrics"]["choice_accuracy"] == 1.0
    assert len(job["items"]) == 2
    assert client.get("/api/eval").json()[0]["id"] == job_id
    assert client.delete(f"/api/eval/{job_id}").json()["deleted"] == job_id


def test_eval_bad_dataset_400(client):
    r = client.post("/api/eval", json={"dataset": "not json at all"})
    assert r.status_code == 400
    r = client.post("/api/eval", json={"dataset": [{"nope": 1}]})
    assert r.status_code == 400


def test_index_served(client):
    r = client.get("/")
    # index.html 尚未创建前为 404；存在则 200
    assert r.status_code in (200, 404)
