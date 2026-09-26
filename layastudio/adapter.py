"""Jev 兼容决策适配层（最高优先级模块）。

职责：
- 请求校验，错误码与 laya/serve.py 1:1 对齐（400/413/422/500/503）
- 双后端：LayaBackend（真实 laya Router）/ MockBackend（确定性关键词启发）
- Engine：准入控制（防 GPU 过载）、单工作线程推理执行器、历史落库

其余模块（HTTP 层、UI、评估、导出）一律通过 Engine 调用，不直接碰后端。
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("layastudio.adapter")

# ---- 限制（镜像 laya/serve.py）----
MAX_QUESTIONS = 64
MAX_STATE_CHARS = 50_000
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_CHOICE_OPTIONS = 100
MAX_SCORE_LEVELS = 32
MAX_TOTAL_OPTIONS = 512

KNOWN_MODELS = {"english", "multilingual", "typed-decisions"}
# 与 serve.py 一致：根 repo convaiinnovations/laya 刻意不在表内 → 表示“交给 Router 自动路由”
PUBLISHED_MODEL_IDS = {
    "convaiinnovations/laya-multilingual": "multilingual",
    "convaiinnovations/laya-typed-decisions": "typed-decisions",
}

_QTYPES = {"choice", "score", "noul"}

# mock 演示用同义词扩展：常见选项标签 → 领域词。仅作用于 label 恰好同名的选项
_LABEL_SYNONYMS = {
    "billing": ["refund", "invoice", "billed", "charge", "charged", "payment",
                "overcharged", "receipt", "chargeback"],
    "technical": ["error", "bug", "crash", "outage", "broken", "fail", "failed",
                  "timeout", "exception", "downtime", "stacktrace"],
    "sales": ["pricing", "quote", "quotation", "contract", "upgrade", "renewal"],
    "support": ["help", "question", "how", "assist"],
    "other": [],
}


class AdapterError(Exception):
    """带 HTTP 状态码的适配层错误。"""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def resolve_model(model: Optional[str]) -> Optional[str]:
    """把客户端 model 字段映射为 Laya checkpoint 名；无法识别 → None（自动路由）。"""
    if not model:
        return None
    key = str(model).strip().lower()
    published = PUBLISHED_MODEL_IDS.get(key)
    if published is not None:
        return published
    if key in KNOWN_MODELS:
        return key
    # 别名
    aliases = {"en": "english", "zh": "multilingual", "multi": "multilingual", "td": "typed-decisions"}
    return aliases.get(key)


def state_text(state: Any) -> str:
    if isinstance(state, str):
        return state
    return json.dumps(state, ensure_ascii=False)


def validate_request(state: Any, questions: Any) -> None:
    """HTTP 层限制（400/413）+ 语义校验（422），错误码与 laya/serve.py 对齐。"""
    if state is None:
        raise AdapterError(400, "'state' is required")
    if not isinstance(questions, dict):
        raise AdapterError(400, "'questions' must be an object")
    if len(questions) > MAX_QUESTIONS:
        raise AdapterError(413, f"too many questions ({len(questions)} > {MAX_QUESTIONS})")

    total_options = 0
    for qid, question in questions.items():
        if not isinstance(question, dict):
            raise AdapterError(422, f"question {qid!r}: must be an object")
        qtype = question.get("type")
        if qtype not in _QTYPES:
            raise AdapterError(
                422, f"question {qid!r}: type must be one of {sorted(_QTYPES)}")
        crit = question.get("criteria")
        if qtype == "choice":
            if not isinstance(crit, (dict, list)) or len(crit) == 0:
                raise AdapterError(
                    422, f"question {qid!r}: a choice question needs at least one criterion")
            count = len(crit)
            total_options += count
            if count > MAX_CHOICE_OPTIONS:
                raise AdapterError(
                    413, f"too many choice options for {qid!r} ({count} > {MAX_CHOICE_OPTIONS})")
        elif qtype == "score":
            if not isinstance(crit, list) or len(crit) == 0:
                raise AdapterError(
                    422, f"question {qid!r}: a score question needs a list of levels")
            count = len(crit)
            total_options += count
            if count > MAX_SCORE_LEVELS:
                raise AdapterError(
                    413, f"too many score levels for {qid!r} ({count} > {MAX_SCORE_LEVELS})")
            if any(not isinstance(lv, str) or not lv.strip() for lv in crit):
                raise AdapterError(422, f"question {qid!r}: every score level needs a description")
        else:  # noul
            if crit is not None:
                if not isinstance(crit, dict) or not set(crit) <= {"true", "false"}:
                    raise AdapterError(
                        422,
                        f"question {qid!r}: noul criteria must be keyed 'true'/'false'",
                    )
                if any(not isinstance(v, str) or not v.strip() for v in crit.values()):
                    raise AdapterError(
                        422, f"question {qid!r}: noul criteria values must be non-empty strings")
            labels = question.get("labels")
            if labels is not None:
                if (not isinstance(labels, dict) or set(labels) != {"true", "false"}
                        or len({str(v) for v in labels.values()}) != 2
                        or any(not str(v).strip() for v in labels.values())):
                    raise AdapterError(
                        422,
                        f"question {qid!r}: labels must map exactly true/false to distinct non-empty strings",
                    )

    if total_options > MAX_TOTAL_OPTIONS:
        raise AdapterError(
            413,
            f"too many answer options across questions ({total_options} > {MAX_TOTAL_OPTIONS})",
        )
    try:
        state_len = len(state) if isinstance(state, str) else len(str(state))
    except Exception:
        state_len = MAX_STATE_CHARS + 1
    if state_len > MAX_STATE_CHARS:
        raise AdapterError(413, f"state too large ({state_len} > {MAX_STATE_CHARS} chars)")


# ============================================================
# Mock 后端：确定性关键词启发，零模型依赖（开发 / 演示 / 无 GPU）
# ============================================================

_WORD_RE = re.compile(r"[a-z0-9']+")
_CJK_RE = re.compile(r"[一-鿿]")
_STOPWORDS = {
    "the", "a", "an", "of", "to", "and", "or", "for", "is", "are", "was", "were",
    "be", "been", "being", "in", "on", "at", "by", "with", "as", "it", "its",
    "this", "that", "these", "those", "we", "you", "they", "he", "she", "i",
    "our", "your", "their", "not", "no", "do", "does", "did", "have", "has",
    "had", "will", "would", "can", "could", "should", "please", "from", "if",
    "into", "than", "then", "so", "what", "which", "who", "when", "how",
}


def _tokens(text: str) -> set:
    text = text.lower()
    toks: set = set()

    def add(w: str) -> None:
        if w in _STOPWORDS or len(w) < 2:
            return
        toks.add(w)

    for w in _WORD_RE.findall(text):
        if w in _STOPWORDS:
            continue
        add(w)
        # 粗粒度词干（仅补充候选，不删除原词）：invoice(s)/canceling/fixed 互认即可
        if len(w) > 3 and w.endswith("s"):
            add(w[:-1])
        if len(w) > 5 and w.endswith("ing"):
            add(w[:-3])
        if len(w) > 4 and w.endswith("ed"):
            base = w[:-2]
            if len(base) >= 3:
                add(base)
                add(base + "e")
    cjk = _CJK_RE.findall(text)
    toks.update(cjk)
    for a, b in zip(cjk, cjk[1:]):
        toks.add(a + b)
    return toks - _STOPWORDS


def _overlap(text_toks: set, phrase: str) -> float:
    ptoks = _tokens(phrase or "") - _STOPWORDS
    if not ptoks:
        return 0.0
    hits = sum(1 for t in ptoks if t in text_toks)
    return hits / (len(ptoks) ** 0.5)


def _jitter(seed: str) -> float:
    """跨进程稳定的确定性抖动（打破平局，不用盐化的 hash()）。"""
    digest = hashlib.sha1(seed.encode("utf-8", "replace")).digest()
    return (digest[0] / 255.0 - 0.5) * 0.1


def _softmax(scores: List[float], temperature: float = 0.45) -> List[float]:
    if not scores:
        return []
    m = max(scores)
    exps = [math.exp((s - m) / temperature) for s in scores]
    total = sum(exps)
    return [e / total for e in exps]


def _dist_confidence(probs: List[float]) -> float:
    """1 - 归一化熵，与 laya 对 confidence 的定义一致。"""
    n = len(probs)
    if n <= 1:
        return 1.0
    h = -sum(p * math.log(p) for p in probs if p > 0)
    return max(0.0, min(1.0, 1.0 - h / math.log(n)))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _criteria_pairs(crit: Any) -> List[Tuple[str, str]]:
    if isinstance(crit, dict):
        return [(str(k), "" if v is None else str(v)) for k, v in crit.items()]
    if isinstance(crit, list):
        return [(str(item), "") for item in crit]
    return []


class MockBackend:
    """确定性 mock：关键词重叠 + softmax。形状与真实 predict() 输出对齐。"""

    name = "mock"

    def __init__(self) -> None:
        self._loaded: List[str] = []

    @property
    def loaded(self) -> List[str]:
        return list(self._loaded)

    def preload(self, keys: Optional[List[str]] = None) -> None:
        for key in (keys or ["english", "multilingual", "typed-decisions"]):
            if key in KNOWN_MODELS and key not in self._loaded:
                self._loaded.append(key)

    def unload(self) -> None:
        self._loaded = []

    def unload_key(self, key: str) -> None:
        if key in self._loaded:
            self._loaded.remove(key)

    def predict(self, state: Any, questions: Dict[str, Any],
                model: Optional[str] = None) -> Dict[str, Any]:
        text = state_text(state)
        text_toks = _tokens(text)
        answers: Dict[str, Any] = {}
        total_tokens = max(1, round(len(text) / 3))

        for qid, q in questions.items():
            qtype = q.get("type")
            instructions = str(q.get("instructions") or "")
            crit = q.get("criteria")
            seed_base = f"{text}|{qid}"

            if qtype == "choice":
                pairs = _criteria_pairs(crit)
                scores = []
                for label, desc in pairs:
                    s = 3.0 * _overlap(text_toks, f"{label} {desc} {instructions}")
                    syn = _LABEL_SYNONYMS.get(label.lower())
                    if syn:
                        s += 1.6 * _overlap(text_toks, " ".join(syn))
                    s += _jitter(f"{seed_base}|{label}")
                    scores.append(s)
                probs = _softmax(scores)
                best = max(range(len(pairs)), key=lambda i: probs[i]) if pairs else -1
                answer = {
                    "type": "choice",
                    "choice": pairs[best][0] if best >= 0 else None,
                    "probabilities": {pairs[i][0]: round(probs[i], 4)
                                      for i in range(len(pairs))},
                    "confidence": round(_dist_confidence(probs), 4),
                }
            elif qtype == "score":
                levels = [str(lv) for lv in (crit or [])]
                n = len(levels)
                if n == 1:
                    answer = {"type": "score", "score": 0.0,
                              "probabilities": {levels[0]: 1.0}, "confidence": 1.0,
                              "legend": levels}
                else:
                    top = _overlap(text_toks, levels[-1])
                    bottom = _overlap(text_toks, levels[0])
                    intensity = 0.0
                    for marker in ("urgent", "asap", "immediately", "critical",
                                   "blocking", "cancel", "lawsuit", "emergency",
                                   "紧急", "立刻", "马上", "马上处理", "中断", "退款"):
                        if _overlap(text_toks, marker) > 0:
                            intensity += 0.12
                    e = 0.5 + 0.5 * (top - bottom) + min(intensity, 0.45)
                    e = max(0.0, min(1.0, e)) + _jitter(seed_base)
                    e = max(0.0, min(1.0, e))
                    expected = e * (n - 1)
                    raw = [max(0.0, 1.0 - abs(k - expected)) for k in range(n)]
                    s = sum(raw) or 1.0
                    probs = [r / s for r in raw]
                    answer = {
                        "type": "score",
                        "score": round(expected, 2),
                        "probabilities": {levels[k]: round(probs[k], 4)
                                          for k in range(n)},
                        "confidence": round(_dist_confidence(probs), 4),
                        "legend": levels,
                    }
            else:  # noul
                crit_dict = crit if isinstance(crit, dict) else {}
                true_desc = str(crit_dict.get("true") or "")
                false_desc = str(crit_dict.get("false") or "")
                st = (0.5 * _overlap(text_toks, instructions)
                      + 1.0 * _overlap(text_toks, true_desc))
                sf = 1.0 * _overlap(text_toks, false_desc)
                p = _sigmoid(2.5 * (st - sf) + 0.6 * _jitter(seed_base + "noul"))
                p = max(0.001, min(0.999, p))
                answer = {
                    "type": "noul",
                    "noul": round(p, 4),
                    "probabilities": {"false": round(1 - p, 4), "true": round(p, 4)},
                    "confidence": round(max(p, 1 - p), 4),
                }
            answers[qid] = answer

        return {
            "model": "laya-rl-agent",
            "answers": answers,
            "usage": {"input_tokens": total_tokens, "output_tokens": 0},
            "routing": {
                "model": model or "mock",
                "reason": "mock backend — 关键词启发式，仅用于演示/开发（真实推理需安装 laya）",
            },
        }


# ============================================================
# 真实后端：laya Router 封装
# ============================================================

class LayaBackend:
    name = "laya"

    def __init__(self, device: Optional[str] = None) -> None:
        from laya import Router  # 惰性导入：不在 import layastudio 时拖入 torch

        self.router = Router(device=device or None)

    def predict(self, state: Any, questions: Dict[str, Any],
                model: Optional[str] = None) -> Dict[str, Any]:
        return self.router.predict(state, questions, model=model)

    @property
    def loaded(self) -> List[str]:
        return list(getattr(self.router, "loaded", []) or [])

    def preload(self, keys: Optional[List[str]] = None) -> None:
        self.router.preload(keys or None)

    def unload(self) -> None:
        if hasattr(self.router, "unload"):
            self.router.unload()

    def unload_key(self, key: str) -> None:
        # Router 无单 checkpoint 卸载 API；释放全部后按需重建
        self.unload()


def laya_installed() -> bool:
    import importlib.util

    return importlib.util.find_spec("laya") is not None


# ============================================================
# Engine：准入控制 + 串行推理 + 历史落库
# ============================================================

class Engine:
    def __init__(self, store, settings) -> None:
        self.store = store
        self.settings = settings
        self._lock = threading.Lock()
        self._backend = None
        self._backend_sig: Optional[Tuple[str, str]] = None
        self._in_flight = 0
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ls-infer")
        self.last_backend_error: Optional[str] = None

    # ---- 后端生命周期 ----

    def _build_backend(self):
        want = self.settings.get("backend") or "auto"
        device = self.settings.get("device") or ""
        sig = (want, device)
        with self._lock:
            if self._backend is not None and self._backend_sig == sig:
                return self._backend
            try:
                if want == "mock":
                    backend = MockBackend()
                else:
                    try:
                        backend = LayaBackend(device=device or None)
                    except Exception as exc:  # laya 缺失 / torch 缺失
                        if want == "laya":
                            raise AdapterError(
                                503, f"laya 后端不可用：{exc}") from exc
                        log.info("laya 不可用，回落 mock 后端：%s", exc)
                        backend = MockBackend()
                self._backend = backend
                self._backend_sig = sig
                self.last_backend_error = None
                return backend
            except AdapterError:
                raise

    @property
    def backend(self):
        return self._build_backend()

    @property
    def backend_name(self) -> str:
        try:
            return self._build_backend().name
        except AdapterError:
            return "unavailable"

    def health(self) -> Dict[str, Any]:
        with self._lock:
            in_flight = self._in_flight
        try:
            backend = self._build_backend()
            name = backend.name
            loaded = backend.loaded
            error = None
        except AdapterError as exc:
            name, loaded, error = "unavailable", [], exc.detail
        return {
            "status": "ok",
            "backend": name,
            "backend_setting": self.settings.get("backend"),
            "laya_installed": laya_installed(),
            "loaded": loaded,
            "in_flight": in_flight,
            "max_concurrent": self.settings.get_int("max_concurrent"),
            "device": self.settings.get("device") or "auto",
            "error": error or self.last_backend_error,
        }

    def preload(self, keys: Optional[List[str]] = None) -> List[str]:
        backend = self._build_backend()
        backend.preload(keys)
        return backend.loaded

    def unload(self, key: Optional[str] = None) -> List[str]:
        backend = self._build_backend()
        if key is None:
            backend.unload()
        else:
            backend.unload_key(key)
        return backend.loaded

    # ---- 推理 ----

    def predict_sync(
        self,
        state: Any,
        questions: Dict[str, Any],
        *,
        model: Optional[str] = None,
        source: str = "api",
        record: bool = True,
    ) -> Tuple[Dict[str, Any], float]:
        validate_request(state, questions)
        routed = resolve_model(model)
        backend = self._build_backend()
        t0 = time.perf_counter()
        try:
            result = backend.predict(state, questions, model=routed)
        except AdapterError:
            raise
        except ValueError as exc:
            # 语义校验错误：指向具体 question，安全回给客户端（422）
            if record:
                self._record(source, backend, model, state, questions,
                             None, None, None, 0.0, "error", str(exc))
            raise AdapterError(422, str(exc)) from exc
        except Exception:
            log.exception("inference failed (backend=%s, model=%s)", backend.name, model)
            if record:
                self._record(source, backend, model, state, questions,
                             None, None, None, 0.0, "error", "inference failed")
            raise AdapterError(500, "inference failed") from None
        latency = (time.perf_counter() - t0) * 1000.0
        if record and self.settings.get_bool("record_history"):
            self._record(source, backend, model, state, questions,
                         result.get("answers"), result.get("routing"),
                         result.get("usage"), latency, "ok", None)
        return result, latency

    async def predict_async(
        self,
        state: Any,
        questions: Dict[str, Any],
        *,
        model: Optional[str] = None,
        source: str = "api",
        record: bool = True,
    ) -> Tuple[Dict[str, Any], float]:
        # 准入控制：非阻塞，超限直接 503（与 serve.py 一致，防止缓冲区无界增长）
        limit = max(1, self.settings.get_int("max_concurrent"))
        with self._lock:
            if self._in_flight >= limit:
                raise AdapterError(503, "server busy, try again later")
            self._in_flight += 1
        try:
            loop = asyncio.get_running_loop()
            fn = functools.partial(
                self.predict_sync, state, questions,
                model=model, source=source, record=record,
            )
            # 同步 torch 推理绝不能跑在事件循环上，否则 /health 都会被阻塞
            return await loop.run_in_executor(self._executor, fn)
        finally:
            with self._lock:
                self._in_flight -= 1

    def _record(
        self,
        source: str,
        backend,
        model: Optional[str],
        state: Any,
        questions: Any,
        answers: Any,
        routing: Any,
        usage: Any,
        latency_ms: float,
        status: str,
        error: Optional[str],
    ) -> None:
        routed = (routing or {}).get("model") if isinstance(routing, dict) else None
        try:
            self.store.add_run(
                source=source,
                backend=getattr(backend, "name", None),
                model_requested=model,
                model_routed=routed,
                state=state,
                questions=questions,
                answers=answers,
                routing=routing,
                usage=usage,
                latency_ms=round(latency_ms, 2),
                status=status,
                error=error,
            )
        except Exception:
            log.exception("failed to record run")

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            self._backend = None
            self._backend_sig = None
