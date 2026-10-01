"""SQLite 持久层：推理历史、评估任务、设置。

单连接 + 线程锁（WAL 模式），读写均走本模块，其余代码不直接碰 SQL。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'api',
    backend TEXT,
    model_requested TEXT,
    model_routed TEXT,
    state_json TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    routing_json TEXT,
    usage_json TEXT,
    latency_ms REAL,
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dataset_name TEXT,
    model TEXT,
    backend TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    metrics_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS eval_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES eval_jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    expected_json TEXT,
    predicted_json TEXT,
    results_json TEXT,
    correct INTEGER,
    latency_ms REAL,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_items_job ON eval_items(job_id);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '默认',
    form_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dumps(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _loads(text: Optional[str]) -> Any:
    if text is None:
        return None
    return json.loads(text)


class Store:
    def __init__(self, path: Path | str) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ---------------- runs ----------------

    def add_run(
        self,
        *,
        source: str,
        backend: Optional[str],
        model_requested: Optional[str],
        model_routed: Optional[str],
        state: Any,
        questions: Any,
        answers: Any = None,
        routing: Any = None,
        usage: Any = None,
        latency_ms: Optional[float] = None,
        status: str = "ok",
        error: Optional[str] = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """INSERT INTO runs
                   (created_at, source, backend, model_requested, model_routed,
                    state_json, questions_json, answers_json, routing_json,
                    usage_json, latency_ms, status, error)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    _now(), source, backend, model_requested, model_routed,
                    _dumps(state), _dumps(questions), _dumps(answers),
                    _dumps(routing), _dumps(usage), latency_ms, status, error,
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    @staticmethod
    def _run_row(row: sqlite3.Row, detail: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": row["id"],
            "created_at": row["created_at"],
            "source": row["source"],
            "backend": row["backend"],
            "model_requested": row["model_requested"],
            "model_routed": row["model_routed"],
            "latency_ms": row["latency_ms"],
            "status": row["status"],
            "error": row["error"],
        }
        if detail:
            state = _loads(row["state_json"])
            out["state"] = state
            out["state_preview"] = (state if isinstance(state, str)
                                    else json.dumps(state, ensure_ascii=False))[:200]
            out["questions"] = _loads(row["questions_json"])
            out["answers"] = _loads(row["answers_json"])
            out["routing"] = _loads(row["routing_json"])
            out["usage"] = _loads(row["usage_json"])
        return out

    def list_runs(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        q: Optional[str] = None,
        status: Optional[str] = None,
        source: Optional[str] = None,
    ) -> Tuple[int, List[Dict[str, Any]]]:
        where: List[str] = []
        args: List[Any] = []
        if status:
            where.append("status = ?")
            args.append(status)
        if source:
            where.append("source = ?")
            args.append(source)
        if q:
            where.append("(state_json LIKE ? OR error LIKE ?)")
            like = f"%{q}%"
            args.extend([like, like])
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) AS n FROM runs{clause}", args
            ).fetchone()["n"]
            rows = self._conn.execute(
                f"SELECT * FROM runs{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
        return total, [self._run_row(r, detail=False) for r in rows]

    def get_run(self, run_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
        return self._run_row(row, detail=True) if row else None

    def iter_runs(self, run_ids: Optional[Iterable[int]] = None) -> List[Dict[str, Any]]:
        with self._lock:
            if run_ids is None:
                rows = self._conn.execute(
                    "SELECT * FROM runs WHERE status = 'ok' ORDER BY id"
                ).fetchall()
            else:
                ids = list(run_ids)
                if not ids:
                    return []
                marks = ",".join("?" * len(ids))
                rows = self._conn.execute(
                    f"SELECT * FROM runs WHERE status = 'ok' AND id IN ({marks}) ORDER BY id",
                    ids,
                ).fetchall()
        return [self._run_row(r, detail=True) for r in rows]

    def delete_run(self, run_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def clear_runs(self) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM runs")
            self._conn.commit()
            return cur.rowcount

    # ---------------- 统计（观测台） ----------------

    def fetch_stats_rows(self, limit: int = 500) -> List[Dict[str, Any]]:
        """按 id DESC 取最近 N 条，仅统计所需列。"""
        with self._lock:
            rows = self._conn.execute(
                """SELECT id, created_at, source, model_routed, latency_ms, status,
                          state_json, answers_json, routing_json
                   FROM runs ORDER BY id DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def count_runs(self, since: Optional[str] = None) -> int:
        with self._lock:
            if since:
                row = self._conn.execute(
                    "SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?", (since,)
                ).fetchone()
            else:
                row = self._conn.execute("SELECT COUNT(*) AS n FROM runs").fetchone()
        return int(row["n"])

    # ---------------- settings ----------------

    def all_settings(self) -> Dict[str, str]:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO settings(key, value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            self._conn.commit()

    # ---------------- eval jobs ----------------

    def create_job(
        self,
        *,
        name: str,
        dataset_name: Optional[str],
        model: Optional[str],
        backend: Optional[str],
        total: int,
        status: str = "running",
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """INSERT INTO eval_jobs
                   (name, dataset_name, model, backend, status, total, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (name, dataset_name, model, backend, status, total, _now()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def update_job(self, job_id: int, **fields: Any) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self._lock:
            self._conn.execute(
                f"UPDATE eval_jobs SET {cols} WHERE id = ?", (*fields.values(), job_id)
            )
            self._conn.commit()

    def get_job(self, job_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM eval_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if not row:
            return None
        return self._job_row(row)

    def list_jobs(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM eval_jobs ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._job_row(r, with_items=False) for r in rows]

    @staticmethod
    def _job_row(row: sqlite3.Row, with_items: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": row["id"],
            "name": row["name"],
            "dataset_name": row["dataset_name"],
            "model": row["model"],
            "backend": row["backend"],
            "status": row["status"],
            "total": row["total"],
            "done": row["done"],
            "correct": row["correct"],
            "metrics": _loads(row["metrics_json"]),
            "error": row["error"],
            "created_at": row["created_at"],
            "finished_at": row["finished_at"],
        }
        if with_items:
            out["items"] = []
        return out

    def add_job_item(self, job_id: int, item: Dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """INSERT INTO eval_items
                   (job_id, idx, state_json, questions_json, expected_json,
                    predicted_json, results_json, correct, latency_ms, error)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    job_id, item.get("idx", 0),
                    _dumps(item.get("state")), _dumps(item.get("questions")),
                    _dumps(item.get("expected")), _dumps(item.get("predicted")),
                    _dumps(item.get("results")), item.get("correct"),
                    item.get("latency_ms"), item.get("error"),
                ),
            )
            self._conn.commit()

    def list_job_items(self, job_id: int, limit: int = 200) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM eval_items WHERE job_id = ? ORDER BY idx LIMIT ?",
                (job_id, limit),
            ).fetchall()
        return [
            {
                "idx": r["idx"],
                "state": _loads(r["state_json"]),
                "questions": _loads(r["questions_json"]),
                "expected": _loads(r["expected_json"]),
                "predicted": _loads(r["predicted_json"]),
                "results": _loads(r["results_json"]),
                "correct": r["correct"],
                "latency_ms": r["latency_ms"],
                "error": r["error"],
            }
            for r in rows
        ]

    def delete_job(self, job_id: int) -> bool:
        with self._lock:
            self._conn.execute("DELETE FROM eval_items WHERE job_id = ?", (job_id,))
            cur = self._conn.execute("DELETE FROM eval_jobs WHERE id = ?", (job_id,))
            self._conn.commit()
            return cur.rowcount > 0

    # ---------------- 模板库 ----------------

    def add_template(self, name: str, category: str, form: Dict[str, Any]) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO templates (name, category, form_json, created_at) VALUES (?,?,?,?)",
                (name, category or "默认", _dumps(form), _now()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def list_templates(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM templates ORDER BY category, id"
            ).fetchall()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "category": r["category"],
                "form": _loads(r["form_json"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def delete_template(self, tpl_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM templates WHERE id = ?", (tpl_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()
