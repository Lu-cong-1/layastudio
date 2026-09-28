"""M3：模板库 CRUD / API 开关 / 设备字段 / 卸载反馈。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from layastudio.server import create_app

NQ = {"a": {"type": "noul", "instructions": "x?"}}


def test_templates_crud(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as client:
        assert client.get("/api/templates").json() == []

        r = client.post("/api/templates", json={
            "name": "客服工单", "category": "客服",
            "form": {"mode": "batch", "batch": [{"uid": 1, "type": "choice", "key": "dept"}]},
        })
        assert r.status_code == 200
        tid = r.json()["id"]

        lst = client.get("/api/templates").json()
        assert lst[0]["name"] == "客服工单"
        assert lst[0]["form"]["mode"] == "batch"
        assert lst[0]["category"] == "客服"

        out = client.post("/api/templates/import", json={
            "items": [{"name": "另一个", "category": "通用", "form": {"mode": "choice"}},
                      {"bad": 1}],
        }).json()
        assert out["imported"] == 1

        exp = client.get("/api/templates/export")
        assert exp.status_code == 200
        assert "客服工单" in exp.text

        assert client.delete(f"/api/templates/{tid}").json()["deleted"] == tid
        assert client.delete(f"/api/templates/{tid}").status_code == 404

        assert client.post("/api/templates", json={"name": "", "form": {}}).status_code == 400
        assert client.post("/api/templates", json={"name": "x", "form": "nope"}).status_code == 400


def test_api_enabled_gate(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as client:
        body = {"state": "hi", "questions": NQ}
        assert client.post("/v1/systemone", json=body).status_code == 200

        client.put("/api/settings", json={"api_enabled": "0"})
        off = client.post("/v1/systemone", json=body)
        assert off.status_code == 503
        assert "disabled" in off.json()["detail"]
        assert client.get("/health").status_code == 200  # 探活恒开

        client.put("/api/settings", json={"api_enabled": "1"})
        assert client.post("/v1/systemone", json=body).status_code == 200


def test_status_device_and_unload(tmp_path):
    app = create_app(data_dir=tmp_path / "data")
    with TestClient(app) as client:
        st = client.get("/api/status").json()
        assert "device_resolved" in st
        assert "api_enabled" in st
        assert st["api_enabled"] is True

        up = client.post("/api/models/english/load").json()
        assert "loaded" in up
        out = client.post("/api/models/english/unload").json()
        assert "loaded" in out and "freed_mb" in out

        models = client.get("/api/models").json()
        m = models[0]
        assert "size_hint" in m and m["size_hint"]
        assert "revision" in m
