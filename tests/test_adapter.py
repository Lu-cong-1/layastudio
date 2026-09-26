"""core 层测试：校验 / mock 后端 / 引擎准入 / 存储。"""

from __future__ import annotations

import asyncio
import threading

import pytest

from layastudio.adapter import (
    AdapterError,
    Engine,
    MockBackend,
    resolve_model,
    validate_request,
)
from layastudio.config import Settings
from layastudio.store import Store


# ---------------- 校验 ----------------

def test_state_required():
    with pytest.raises(AdapterError) as e:
        validate_request(None, {})
    assert e.value.status_code == 400


def test_questions_must_be_object():
    with pytest.raises(AdapterError) as e:
        validate_request("hi", ["not", "a", "dict"])
    assert e.value.status_code == 400


def test_too_many_questions_413():
    qs = {f"q{i}": {"type": "noul", "instructions": "x"} for i in range(65)}
    with pytest.raises(AdapterError) as e:
        validate_request("hi", qs)
    assert e.value.status_code == 413


def test_choice_needs_criteria_422():
    with pytest.raises(AdapterError) as e:
        validate_request("hi", {"a": {"type": "choice", "instructions": "x"}})
    assert e.value.status_code == 422


def test_choice_too_many_options_413():
    crit = {f"o{i}": "d" for i in range(101)}
    with pytest.raises(AdapterError) as e:
        validate_request("hi", {"a": {"type": "choice", "instructions": "x", "criteria": crit}})
    assert e.value.status_code == 413


def test_noul_criteria_keys_enforced():
    with pytest.raises(AdapterError) as e:
        validate_request("hi", {"a": {"type": "noul", "instructions": "x",
                                      "criteria": {"yes": "y", "no": "n"}}})
    assert e.value.status_code == 422


def test_state_too_large_413():
    with pytest.raises(AdapterError) as e:
        validate_request("x" * 50_001, {"a": {"type": "noul", "instructions": "x"}})
    assert e.value.status_code == 413


def test_valid_request_passes():
    validate_request("hello", {
        "dept": {"type": "choice", "instructions": "which?",
                 "criteria": {"billing": "invoices", "tech": "bugs"}},
        "urgent": {"type": "score", "instructions": "how urgent?",
                   "criteria": ["low", "high"]},
        "churn": {"type": "noul", "instructions": "will they leave?"},
    })


# ---------------- 模型解析 ----------------

@pytest.mark.parametrize("raw,expected", [
    ("multilingual", "multilingual"),
    ("convaiinnovations/laya-multilingual", "multilingual"),
    ("convaiinnovations/laya-typed-decisions", "typed-decisions"),
    ("convaiinnovations/laya", None),
    ("jev-1", None),
    (None, None),
    ("", None),
])
def test_resolve_model(raw, expected):
    assert resolve_model(raw) == expected


# ---------------- Mock 后端 ----------------

QUESTIONS = {
    "dept": {"type": "choice", "instructions": "Which department?",
             "criteria": {"billing": "invoices, payments, refunds",
                          "technical": "bugs, outages, system errors",
                          "other": "everything else"}},
    "urgency": {"type": "score", "instructions": "How urgent?",
                "criteria": ["not urgent", "soon", "critical"]},
    "churn": {"type": "noul", "instructions": "Does the user threaten to cancel?"},
}


def test_mock_answer_shapes():
    result = MockBackend().predict(
        "We were billed twice, please refund the duplicate charge today.",
        QUESTIONS)
    assert set(result) >= {"answers", "usage", "routing"}
    answers = result["answers"]
    assert answers["dept"]["type"] == "choice"
    assert answers["dept"]["choice"] in QUESTIONS["dept"]["criteria"]
    probs = answers["dept"]["probabilities"]
    assert set(probs) == set(QUESTIONS["dept"]["criteria"])
    assert abs(sum(probs.values()) - 1.0) < 1e-3
    assert 0.0 <= answers["urgency"]["score"] <= 2.0
    assert answers["churn"]["type"] == "noul"
    assert 0.0 <= answers["churn"]["noul"] <= 1.0
    assert result["usage"]["input_tokens"] > 0


def test_mock_is_deterministic():
    state = "Please refund the duplicate charge"
    a = MockBackend().predict(state, QUESTIONS)
    b = MockBackend().predict(state, QUESTIONS)
    assert a == b


def test_mock_billing_keyword_wins():
    result = MockBackend().predict(
        "We were billed twice, please refund the duplicate charge today.", QUESTIONS)
    assert result["answers"]["dept"]["choice"] == "billing"


# ---------------- 引擎 ----------------

def _engine(tmp_path, **overrides):
    store = Store(tmp_path / "t.db")
    settings = Settings(store)
    for k, v in overrides.items():
        settings.set(k, v)
    return Engine(store, settings)


def test_engine_predict_records_history(tmp_path):
    engine = _engine(tmp_path)
    result, latency = engine.predict_sync(
        "refund the invoice", QUESTIONS, source="playground")
    assert latency >= 0
    assert "answers" in result
    total, runs = engine.store.list_runs()
    assert total == 1
    assert runs[0]["source"] == "playground"
    detail = engine.store.get_run(runs[0]["id"])
    assert detail["answers"]["dept"]["choice"] == "billing"


def test_engine_validation_not_recorded(tmp_path):
    engine = _engine(tmp_path)
    with pytest.raises(AdapterError):
        engine.predict_sync("hi", {"a": {"type": "choice", "instructions": "x"}})
    total, _ = engine.store.list_runs()
    assert total == 0


def test_engine_admission_refuses_503(tmp_path):
    engine = _engine(tmp_path, max_concurrent="1", record_history="0")
    backend = engine.backend
    original = backend.predict
    entered = threading.Event()
    gate = threading.Event()

    def slow(state, questions, model=None):
        entered.set()
        assert gate.wait(timeout=5)
        return original(state, questions, model)

    backend.predict = slow

    async def drive():
        first = asyncio.ensure_future(engine.predict_async("a", QUESTIONS))
        for _ in range(300):
            if entered.is_set():
                break
            await asyncio.sleep(0.01)
        assert entered.is_set()
        try:
            await engine.predict_async("b", QUESTIONS)
            code = 200
        except AdapterError as exc:
            code = exc.status_code
        gate.set()
        await first
        return code

    assert asyncio.run(drive()) == 503


def test_engine_health(tmp_path):
    engine = _engine(tmp_path)
    health = engine.health()
    assert health["status"] == "ok"
    assert health["backend"] == "mock"  # conftest 强制 LAYASTUDIO_BACKEND=mock
    assert isinstance(health["laya_installed"], bool)
    assert health["max_concurrent"] == 4


# ---------------- 存储 ----------------

def test_store_run_lifecycle(tmp_path):
    store = Store(tmp_path / "s.db")
    run_id = store.add_run(
        source="api", backend="mock", model_requested=None, model_routed="mock",
        state="hello", questions=QUESTIONS, answers={"a": 1},
        routing={"model": "mock"}, usage={"input_tokens": 3, "output_tokens": 0},
        latency_ms=1.5, status="ok")
    total, runs = store.list_runs(limit=10)
    assert total == 1 and runs[0]["id"] == run_id
    assert store.get_run(run_id)["answers"] == {"a": 1}
    assert store.delete_run(run_id) is True
    assert store.get_run(run_id) is None
    assert store.delete_run(run_id) is False
    assert store.clear_runs() == 0


def test_store_search_filter(tmp_path):
    store = Store(tmp_path / "s.db")
    store.add_run(source="api", backend="mock", model_requested=None,
                  model_routed=None, state="refund invoice", questions={}, status="ok")
    store.add_run(source="api", backend="mock", model_requested=None,
                  model_routed=None, state="unrelated", questions={}, status="error",
                  error="boom")
    total, _ = store.list_runs(q="refund")
    assert total == 1
    total, _ = store.list_runs(status="error")
    assert total == 1
