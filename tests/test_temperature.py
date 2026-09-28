"""P1-2：checkpoint 温度校准状态读取。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from layastudio.server import create_app


def _isolate_cache(models, tmp_path, monkeypatch):
    """隔离本机真实 HF 缓存，避免测试读到真实已装模型。"""
    monkeypatch.setattr(
        type(models), "_repo_cache_dir",
        lambda self, repo: tmp_path / "no-such-cache")


def _mk_cfg(models, key: str, cfg) -> None:
    base = models._marker_path(key).parent.parent / f"ckpt-{key}"
    base.mkdir(parents=True, exist_ok=True)
    (base / "rl_agent_config.json").write_text(
        json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    models._marker_path(key).write_text(
        json.dumps({"repo": "x", "path": str(base)}), encoding="utf-8")


def test_temperature_states(tmp_path, monkeypatch):
    app = create_app(data_dir=tmp_path / "data")
    models = app.state.models
    _isolate_cache(models, tmp_path, monkeypatch)

    # 未安装（无 marker 且缓存被隔离）
    assert models.read_temperature("english")["state"] == "unavailable"

    # 单一全局温度
    _mk_cfg(models, "english", {"temperature": 0.85})
    t = models.read_temperature("english")
    assert t["state"] == "global" and abs(t["value"] - 0.85) < 1e-9

    # 分桶（按选项数）
    _mk_cfg(models, "english",
            {"temperature_by_options": {"1": 0.9, "2": 1.1, "4": 1.3}})
    t2 = models.read_temperature("english")
    assert t2["state"] == "bucket"
    assert any("temperature" in k for k in t2["keys"])

    # 嵌套结构里的全局温度
    _mk_cfg(models, "english", {"agent": {"config": {"temperature": 1.2}}})
    t3 = models.read_temperature("english")
    assert t3["state"] == "global" and abs(t3["value"] - 1.2) < 1e-9

    # 无温度配置 = 未校准
    _mk_cfg(models, "english", {"learning_rate": 0.001})
    assert models.read_temperature("english")["state"] == "none"


def test_models_api_exposes_temperature(tmp_path, monkeypatch):
    app = create_app(data_dir=tmp_path / "data")
    _isolate_cache(app.state.models, tmp_path, monkeypatch)
    with TestClient(app) as client:
        models = client.get("/api/models").json()
        for m in models:
            assert "temperature" in m
            assert m["temperature"]["state"] in (
                "unavailable", "none", "global", "bucket", "multi", "unknown")
        assert models[0]["temperature"]["state"] == "unavailable"
