"""FastAPI 服务：Jev /v1/systemone 兼容端点 + 工作台管理 API + 静态前端。

协议与错误码 1:1 镜像 laya/serve.py；管理 API 供 index.html 工作台使用。
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .adapter import (
    MAX_BODY_BYTES,
    MAX_CHOICE_OPTIONS,
    MAX_QUESTIONS,
    MAX_SCORE_LEVELS,
    MAX_STATE_CHARS,
    MAX_TOTAL_OPTIONS,
    AdapterError,
    Engine,
)
from .config import DEFAULTS, Settings
from .dataset import export_runs, list_exports
from .evals import EvalRunner, parse_dataset
from .model_manager import CATALOG, ModelManager
from .presets import PRESETS
from .store import Store

log = logging.getLogger("layastudio.server")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAX_EVAL_ROWS = 2000


def _resolve_data_dir() -> Path:
    env = os.environ.get("LAYASTUDIO_DATA_DIR")
    if env:
        return Path(env)
    return PROJECT_ROOT / "data"


def create_app(data_dir: Optional[Path] = None) -> FastAPI:
    data_dir = Path(data_dir) if data_dir else _resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    # 挂载环形日志缓冲（uvicorn 与业务 logger 全量进入，UI/导出只读）
    from .logs import get_handler

    get_handler()
    store = Store(data_dir / "layastudio.db")
    settings = Settings(store)
    engine = Engine(store, settings)
    models = ModelManager(data_dir, settings, engine)
    runner = EvalRunner(store, engine)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # uvicorn.run 的 logging dictConfig 发生在 app 创建之后，这里再挂一次
        from .logs import get_handler

        get_handler()
        try:
            yield
        finally:
            engine.shutdown()
            store.close()

    app = FastAPI(title="LayaStudio", version=__version__, lifespan=lifespan)
    # Agent 客户端常来自其他端口/本机服务
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    app.state.store = store
    app.state.settings = settings
    app.state.engine = engine
    app.state.models = models
    app.state.runner = runner
    app.state.data_dir = data_dir

    # ---------------- 鉴权（与 serve.py 一致） ----------------

    def check_auth(authorization: Optional[str]) -> None:
        api_key = settings.get("api_key").strip() or os.environ.get("LAYA_API_KEY") or None
        if api_key is None:
            return
        expected = ("Bearer " + api_key).encode("utf-8", "surrogateescape")
        supplied = (authorization or "").encode("utf-8", "surrogateescape")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    def map_adapter_error(exc: AdapterError) -> None:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    # ---------------- Jev 兼容端点 ----------------

    @app.get("/health")
    def health() -> Dict[str, Any]:
        payload = engine.health()
        payload["version"] = __version__
        return payload

    @app.post("/v1/systemone")
    async def systemone(request: Request, authorization: Optional[str] = Header(default=None)):
        if not settings.get_bool("api_enabled"):
            raise HTTPException(status_code=503, detail="API service disabled")
        check_auth(authorization)
        # 声明长度超限先拒；流式读取才是对 chunked 的真正封顶（镜像 serve.py #330）
        declared = request.headers.get("content-length")
        if declared:
            try:
                if int(declared) > MAX_BODY_BYTES:
                    raise HTTPException(status_code=413, detail="request body too large")
            except ValueError:
                pass
        total = 0
        chunks: List[bytes] = []
        async for chunk in request.stream():
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body too large")
            chunks.append(chunk)
        raw = b"".join(chunks)
        try:
            body = json.loads(raw)
        except (ValueError, RecursionError):
            raise HTTPException(status_code=400, detail="request body must be valid JSON")
        if not isinstance(body, dict) or "questions" not in body:
            raise HTTPException(
                status_code=400,
                detail="request body must be an object with a 'questions' field",
            )
        try:
            result, latency = await engine.predict_async(
                body.get("state"), body["questions"],
                model=body.get("model"), source="api",
            )
        except AdapterError as exc:
            map_adapter_error(exc)
        return JSONResponse(
            content=result,
            headers={
                "Server-Timing": f"inference;dur={latency:.2f}",
                "X-Inference-Time-Ms": f"{latency:.2f}",
            },
        )

    # ---------------- 工作台 API ----------------

    @app.get("/api/status")
    def api_status() -> Dict[str, Any]:
        status = engine.health()
        status.update({
            "version": __version__,
            "python": sys.version.split()[0],
            "data_dir": str(data_dir),
            "hf_endpoint": settings.get("hf_endpoint"),
            "record_history": settings.get_bool("record_history"),
            "option_warn_threshold": settings.get_int("option_warn_threshold"),
            "api_enabled": settings.get_bool("api_enabled"),
            "limits": {
                "max_questions": MAX_QUESTIONS,
                "max_state_chars": MAX_STATE_CHARS,
                "max_body_bytes": MAX_BODY_BYTES,
                "max_choice_options": MAX_CHOICE_OPTIONS,
                "max_score_levels": MAX_SCORE_LEVELS,
                "max_total_options": MAX_TOTAL_OPTIONS,
            },
        })
        from .hwmon import device_kind

        resolved = device_kind()
        wanted = (settings.get("device") or "").strip().lower()
        status["device_resolved"] = resolved
        status["device_fallback"] = bool(
            wanted and resolved and wanted not in ("auto", resolved))
        return status

    @app.get("/api/stats")
    def api_stats() -> Dict[str, Any]:
        """观测台聚合：KPI / 分位延迟 / 路由与意图分布 / 小时分桶 / 事件流。"""
        from .hwmon import hw_snapshot
        from .stats import collect_stats

        payload = collect_stats(store)
        payload["live"] = engine.health()
        payload["hw"] = hw_snapshot()
        return payload

    @app.get("/api/hw")
    def api_hw() -> Dict[str, Any]:
        """显存 / 内存占用快照。"""
        from .hwmon import hw_snapshot

        return hw_snapshot()

    @app.get("/api/logs")
    def api_logs(level: str = "INFO", limit: int = 200) -> Dict[str, Any]:
        from .logs import get_logs

        return {"logs": get_logs(level=level, limit=max(1, min(limit, 1000)))}

    @app.get("/api/logs/export")
    def api_logs_export(level: str = "DEBUG"):
        from fastapi.responses import PlainTextResponse

        from .logs import export_text

        name = f"layastudio_logs_{time.strftime('%Y%m%d_%H%M%S')}.txt"
        return PlainTextResponse(
            export_text(level=level),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @app.post("/api/predict")
    async def api_predict(payload: Dict[str, Any]):
        if not isinstance(payload, dict) or "questions" not in payload:
            raise HTTPException(status_code=400, detail="'questions' is required")
        try:
            result, latency = await engine.predict_async(
                payload.get("state"), payload["questions"],
                model=payload.get("model"), source="playground",
            )
        except AdapterError as exc:
            map_adapter_error(exc)
        return {"result": result, "latency_ms": round(latency, 2)}

    @app.get("/api/models")
    def api_models() -> List[Dict[str, Any]]:
        return models.list_models()

    @app.post("/api/models/{key}/download")
    def api_model_download(key: str) -> Dict[str, Any]:
        if key not in CATALOG:
            raise HTTPException(status_code=404, detail=f"unknown model: {key}")
        models.download(key)
        return {"status": "downloading"}

    @app.post("/api/models/{key}/load")
    def api_model_load(key: str) -> Dict[str, Any]:
        if key not in CATALOG:
            raise HTTPException(status_code=404, detail=f"unknown model: {key}")
        try:
            loaded = models.load(key)
        except AdapterError as exc:
            map_adapter_error(exc)
        return {"loaded": loaded}

    @app.post("/api/models/{key}/unload")
    def api_model_unload(key: str) -> Dict[str, Any]:
        from .hwmon import hw_snapshot

        if key not in CATALOG:
            raise HTTPException(status_code=404, detail=f"unknown model: {key}")
        before = hw_snapshot()
        loaded = models.unload(key)
        after = hw_snapshot()
        freed = None
        if before.get("gpu") and after.get("gpu"):
            freed = before["gpu"]["used_mb"] - after["gpu"]["used_mb"]
        return {"loaded": loaded, "freed_mb": freed}

    @app.get("/api/presets")
    def api_presets() -> List[Dict[str, Any]]:
        return PRESETS

    @app.get("/api/history")
    def api_history(limit: int = 50, offset: int = 0, q: Optional[str] = None,
                    status: Optional[str] = None, source: Optional[str] = None):
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        total, runs = store.list_runs(
            limit=limit, offset=offset, q=q, status=status, source=source)
        return {"total": total, "runs": runs}

    @app.get("/api/history/{run_id}")
    def api_history_get(run_id: int):
        run = store.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        return run

    @app.delete("/api/history/{run_id}")
    def api_history_delete(run_id: int):
        if not store.delete_run(run_id):
            raise HTTPException(status_code=404, detail="run not found")
        return {"deleted": run_id}

    @app.post("/api/history/clear")
    def api_history_clear():
        return {"deleted": store.clear_runs()}

    @app.post("/api/dataset/export")
    def api_dataset_export(payload: Optional[Dict[str, Any]] = None):
        payload = payload or {}
        run_ids = payload.get("run_ids")
        if run_ids is not None and not isinstance(run_ids, list):
            raise HTTPException(status_code=400, detail="run_ids must be a list")
        if run_ids is not None and len(run_ids) == 0:
            raise HTTPException(status_code=400, detail="run_ids 不能为空")
        filters = payload.get("filters") or None
        if filters is not None and not isinstance(filters, dict):
            raise HTTPException(status_code=400, detail="filters must be an object")
        try:
            return export_runs(store, run_ids, data_dir / "exports", filters=filters)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/exports")
    def api_exports():
        return list_exports(data_dir / "exports")

    # ---- 评估 ----

    @app.post("/api/eval")
    def api_eval_start(payload: Dict[str, Any]):
        if not isinstance(payload, dict) or "dataset" not in payload:
            raise HTTPException(status_code=400, detail="'dataset' is required")
        dataset = payload["dataset"]
        try:
            if isinstance(dataset, list):
                rows = parse_dataset(json.dumps(dataset, ensure_ascii=False))
            else:
                rows = parse_dataset(str(dataset))
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"数据集解析失败：{exc}")
        if len(rows) > MAX_EVAL_ROWS:
            raise HTTPException(
                status_code=413, detail=f"too many rows ({len(rows)} > {MAX_EVAL_ROWS})")
        name = str(payload.get("name") or "").strip() or f"eval-{len(runner.store.list_jobs()) + 1}"
        job_id = runner.start(
            name=name,
            dataset_name=str(payload.get("dataset_name") or "").strip() or None,
            rows=rows,
            model=payload.get("model") or None,
        )
        return {"id": job_id}

    @app.get("/api/eval")
    def api_eval_list():
        return runner.store.list_jobs()

    @app.get("/api/eval/{job_id}")
    def api_eval_get(job_id: int, items: int = 50):
        job = runner.store.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        job["items"] = runner.store.list_job_items(job_id, limit=max(1, min(items, 500)))
        return job

    @app.post("/api/eval/{job_id}/cancel")
    def api_eval_cancel(job_id: int):
        if runner.store.get_job(job_id) is None:
            raise HTTPException(status_code=404, detail="job not found")
        return {"cancelled": runner.cancel(job_id)}

    @app.delete("/api/eval/{job_id}")
    def api_eval_delete(job_id: int):
        if not runner.store.delete_job(job_id):
            raise HTTPException(status_code=404, detail="job not found")
        return {"deleted": job_id}

    @app.post("/api/eval/{job_id}/report")
    def api_eval_report(job_id: int):
        """把评估任务渲染成 Markdown 报告并落盘（混淆矩阵 + 错误清单）。"""
        from .evals import build_report_md

        job = runner.store.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        items = runner.store.list_job_items(job_id, limit=10000)
        md = build_report_md(job, items)
        export_dir = data_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        name = f"eval_report_{job_id}_{time.strftime('%Y%m%d_%H%M%S')}.md"
        path = export_dir / name
        path.write_text(md, encoding="utf-8")
        return {"filename": name, "path": str(path), "bytes": len(md.encode("utf-8"))}

    @app.post("/api/eval/{job_id}/export-dataset")
    def api_eval_export_dataset(job_id: int):
        """评估样本 → 微调标注 JSONL（state/questions/expected，官方 notebook 输入形状）。"""
        job = runner.store.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        items = runner.store.list_job_items(job_id, limit=10000)
        rows = [
            {
                "state": it["state"],
                "questions": it["questions"],
                "expected": it.get("expected") or {},
            }
            for it in items
            if it.get("questions") is not None
        ]
        if not rows:
            raise HTTPException(status_code=400, detail="该任务没有可导出的样本")
        export_dir = data_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        name = f"eval_{job_id}_finetune_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
        path = export_dir / name
        with path.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        return {
            "filename": name,
            "path": str(path),
            "rows": len(rows),
            "job": job.get("name") or job_id,
        }

    # ---- 模板库 ----

    @app.get("/api/templates")
    def api_templates_list():
        return store.list_templates()

    @app.post("/api/templates")
    def api_template_add(payload: Dict[str, Any]):
        name = str(payload.get("name") or "").strip()
        form = payload.get("form")
        if not name:
            raise HTTPException(status_code=400, detail="模板名称不能为空")
        if not isinstance(form, dict):
            raise HTTPException(status_code=400, detail="form 必须是表单状态对象")
        tid = store.add_template(name, str(payload.get("category") or "默认"), form)
        return {"id": tid, "name": name}

    @app.post("/api/templates/import")
    def api_templates_import(payload: Dict[str, Any]):
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise HTTPException(status_code=400, detail="items 必须是非空数组")
        imported = 0
        for it in items:
            if isinstance(it, dict) and it.get("name") and isinstance(it.get("form"), dict):
                store.add_template(
                    str(it["name"]), str(it.get("category") or "默认"), it["form"])
                imported += 1
        return {"imported": imported}

    @app.get("/api/templates/export")
    def api_templates_export():
        from fastapi.responses import Response

        items = [
            {"name": t["name"], "category": t["category"], "form": t["form"]}
            for t in store.list_templates()
        ]
        body = json.dumps({"templates": items}, ensure_ascii=False, indent=2)
        name = f"layastudio_templates_{time.strftime('%Y%m%d_%H%M%S')}.json"
        return Response(
            body,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @app.delete("/api/templates/{tpl_id}")
    def api_template_delete(tpl_id: int):
        if not store.delete_template(tpl_id):
            raise HTTPException(status_code=404, detail="template not found")
        return {"deleted": tpl_id}

    # ---- 设置 ----

    @app.get("/api/settings")
    def api_settings_get() -> Dict[str, Any]:
        return settings.as_dict()

    @app.put("/api/settings")
    def api_settings_put(payload: Dict[str, Any]):
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="settings must be an object")
        unknown = [k for k in payload if k not in DEFAULTS]
        if unknown:
            raise HTTPException(status_code=422, detail=f"unknown settings: {unknown}")
        try:
            settings.update(payload)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        # backend/device 变更由 Engine 按签名自动重建
        return settings.as_dict()

    # ---------------- 静态前端 ----------------

    @app.get("/", include_in_schema=False)
    def index():
        path = PROJECT_ROOT / "index.html"
        if not path.exists():
            raise HTTPException(status_code=404, detail="index.html not found")
        return FileResponse(path)

    for sub in ("css", "js"):
        target = PROJECT_ROOT / sub
        target.mkdir(exist_ok=True)
        app.mount(f"/{sub}", StaticFiles(directory=target), name=sub)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(prog="layastudio", description="LayaStudio 本地工作台")
    parser.add_argument("--host", default=None, help="绑定地址（默认读设置）")
    parser.add_argument("--port", type=int, default=None, help="端口（默认读设置）")
    parser.add_argument("--data-dir", default=None, help="数据目录（SQLite/模型标记/导出）")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    if args.data_dir:
        os.environ["LAYASTUDIO_DATA_DIR"] = args.data_dir
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    import uvicorn

    app = create_app()
    settings: Settings = app.state.settings
    host = args.host or settings.get("host") or "127.0.0.1"
    port = args.port or settings.get_int("port") or 9527
    print(f"LayaStudio v{__version__} → http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level=args.log_level)


if __name__ == "__main__":
    main()
