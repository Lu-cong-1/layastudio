"""M2：硬件快照与环形日志缓冲。"""

from __future__ import annotations

import logging

from layastudio import logs as L
from layastudio.hwmon import hw_snapshot


def test_hw_snapshot_shape():
    s = hw_snapshot()
    assert set(s.keys()) == {"gpu", "mem"}
    if s["gpu"] is not None:
        assert {"name", "total_mb", "used_mb", "percent"} <= set(s["gpu"].keys())
        assert s["gpu"]["total_mb"] > 0
        assert 0 <= s["gpu"]["percent"] <= 100
    if s["mem"] is not None:
        assert s["mem"]["total_mb"] > 0


def test_logs_ring_buffer_filter_export():
    lg = logging.getLogger("test.laya.logs")
    lg.setLevel(logging.DEBUG)  # 显式放行，否则 DEBUG 被 root 级别拦掉
    L.get_handler()
    lg.error("boom 中文错误")
    err_logs = L.get_logs(level="ERROR", limit=100)
    assert any("boom 中文错误" in e["msg"] for e in err_logs)
    assert all(e["level"] in ("ERROR", "CRITICAL") for e in err_logs)

    lg.debug("hidden-debug-marker")
    still_err = L.get_logs(level="ERROR", limit=100)
    assert all("hidden-debug-marker" not in e["msg"] for e in still_err)

    all_txt = L.export_text(level="DEBUG")
    assert "boom 中文错误" in all_txt
    assert "hidden-debug-marker" in all_txt


def test_logs_capacity_capped():
    h = L.get_handler()
    logger = logging.getLogger("test.laya.burst")
    logger.setLevel(logging.DEBUG)
    for i in range(50):
        logger.info("burst-%d", i)
    entries = L.get_logs(level="DEBUG", limit=100000)
    assert len(entries) <= L.MAX_LOGS
