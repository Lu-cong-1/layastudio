"""观测台统计聚合：从历史 runs 计算 KPI、分位延迟、路由/意图分布。

单请求聚合最近 scan_limit 条记录，SQLite 只做一次范围读，Python 内存聚合——
本地工作台数据量级（<10万条）下无需物化表。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

RECENT_POINTS = 60      # 延迟时间线点数
EVENT_ROWS = 8          # 实时事件流条数
SCAN_LIMIT = 500        # 聚合扫描上限
HOURS_WINDOW = 12       # 请求量分桶窗口


def _percentile(sorted_vals: List[float], p: float) -> Optional[float]:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = (len(sorted_vals) - 1) * p
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def collect_stats(store) -> Dict[str, Any]:
    rows = store.fetch_stats_rows(limit=SCAN_LIMIT)  # id DESC
    ok = [r for r in rows if r["status"] == "ok"]
    err_count = len(rows) - len(ok)

    # ---- 延迟 ----
    lats = sorted(r["latency_ms"] for r in ok if r["latency_ms"] is not None)
    recent = [r["latency_ms"] for r in reversed(ok[:RECENT_POINTS])
              if r["latency_ms"] is not None]
    latency = {
        "avg": round(sum(lats) / len(lats), 2) if lats else None,
        "p50": round(_percentile(lats, 0.5), 2) if lats else None,
        "p95": round(_percentile(lats, 0.95), 2) if lats else None,
        "min": round(lats[0], 2) if lats else None,
        "max": round(lats[-1], 2) if lats else None,
        "recent": recent,
    }

    # ---- 路由 / 脚本 ----
    routing: Dict[str, int] = {}
    scripts: Dict[str, int] = {}
    intents: Dict[str, int] = {}
    primitives: Dict[str, int] = {}
    for r in ok:
        model = r.get("model_routed") or "auto"
        routing[model] = routing.get(model, 0) + 1
        routing_json = r.get("routing_json")
        if routing_json:
            try:
                route = json.loads(routing_json)
            except (ValueError, TypeError):
                route = {}
        else:
            route = {}
        detection = route.get("detection") or {}
        script = detection.get("script")
        if script:
            scripts[script] = scripts.get(script, 0) + 1
        answers = r.get("answers_json")
        if not answers:
            continue
        try:
            parsed = json.loads(answers)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        for ans in parsed.values():
            if not isinstance(ans, dict):
                continue
            atype = ans.get("type") or "?"
            primitives[atype] = primitives.get(atype, 0) + 1
            if atype == "choice" and ans.get("choice"):
                label = str(ans["choice"])
                intents[label] = intents.get(label, 0) + 1

    # ---- 小时分桶（近 12 小时，UTC）----
    now = datetime.now(timezone.utc)
    hour_keys = [(now - timedelta(hours=h)).strftime("%Y-%m-%dT%H")
                 for h in range(HOURS_WINDOW - 1, -1, -1)]
    counts: Dict[str, int] = {k: 0 for k in hour_keys}
    for r in rows:
        key = (r.get("created_at") or "")[:13]
        if key in counts:
            counts[key] += 1
    hourly = [{"hour": k[11:] + ":00", "count": counts[k]} for k in hour_keys]

    # ---- 汇总 ----
    today_prefix = now.date().isoformat()
    total = store.count_runs()
    today = store.count_runs(since=today_prefix)
    recent_events = []
    for r in rows[:EVENT_ROWS]:
        state = r.get("state_json") or ""
        try:
            parsed_state = json.loads(state)
            if not isinstance(parsed_state, str):
                parsed_state = json.dumps(parsed_state, ensure_ascii=False)
        except (ValueError, TypeError):
            parsed_state = str(state)
        recent_events.append({
            "id": r["id"],
            "created_at": r["created_at"],
            "model_routed": r.get("model_routed"),
            "latency_ms": r.get("latency_ms"),
            "status": r["status"],
            "source": r.get("source"),
            "preview": parsed_state[:80],
        })

    return {
        "totals": {"runs": total, "today": today, "ok": len(ok), "error": err_count},
        "latency": latency,
        "routing": dict(sorted(routing.items(), key=lambda kv: -kv[1])),
        "scripts": dict(sorted(scripts.items(), key=lambda kv: -kv[1])),
        "intents": dict(sorted(intents.items(), key=lambda kv: -kv[1])),
        "primitives": dict(sorted(primitives.items(), key=lambda kv: -kv[1])),
        "hourly": hourly,
        "recent": recent_events,
        "generated_at": now.isoformat(timespec="seconds"),
    }
