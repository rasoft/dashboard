"""Parse SurfaceFlinger --events timing via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_WORK_RE = re.compile(r"mWorkDuration\s*=\s*([\d.]+)", re.I)
_READY_RE = re.compile(r"mReadyDuration\s*=\s*([\d.]+)", re.I)
_VSYNC_RE = re.compile(r"last\s+vsync\s+time\s+([\d.]+)\s*ms", re.I)
_APP_RE = re.compile(r"^app:\s*(.+)$", re.I | re.M)
_PENDING_RE = re.compile(r"pending events\s*\(count=(\d+)\)", re.I)
_CONN_RE = re.compile(r"connections\s*\(count=(\d+)\)", re.I)


def parse_events(text: str) -> dict[str, Any]:
    """Extract work/ready/vsync timing fields from --events output."""
    raw = text or ""
    work = _WORK_RE.search(raw)
    ready = _READY_RE.search(raw)
    vsync = _VSYNC_RE.search(raw)
    app = _APP_RE.search(raw)
    pending = _PENDING_RE.search(raw)
    connections = _CONN_RE.search(raw)

    work_ms = float(work.group(1)) if work else None
    ready_ms = float(ready.group(1)) if ready else None
    last_vsync_ms = float(vsync.group(1)) if vsync else None

    return {
        "work_duration_ms": work_ms,
        "ready_duration_ms": ready_ms,
        "last_vsync_ms": last_vsync_ms,
        "app": (app.group(1).strip() if app else None),
        "pending_count": int(pending.group(1)) if pending else None,
        "connection_count": int(connections.group(1)) if connections else None,
    }


def sample() -> dict[str, Any]:
    """Fetch and parse SurfaceFlinger --events from the connected device."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell("dumpsys SurfaceFlinger --events", timeout=12.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or "dumpsys SurfaceFlinger --events failed").strip()
        return {"ok": False, "error": err}

    parsed = parse_events(raw)
    if (
        parsed["work_duration_ms"] is None
        and parsed["ready_duration_ms"] is None
        and parsed["last_vsync_ms"] is None
    ):
        return {
            "ok": False,
            "error": "未解析到 mWorkDuration / mReadyDuration / last vsync time",
            "raw": raw[:800],
            **parsed,
        }

    return {"ok": True, **parsed}
