"""Parse /proc/meminfo via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_LINE_RE = re.compile(r"^([A-Za-z0-9_()]+):\s+(\d+)\s*kB\s*$", re.M)


def parse_meminfo(text: str) -> dict[str, int]:
    """Parse /proc/meminfo into a name -> kB map."""
    out: dict[str, int] = {}
    for match in _LINE_RE.finditer(text or ""):
        out[match.group(1)] = int(match.group(2))
    return out


def sample() -> dict[str, Any]:
    """Fetch and parse selected fields from /proc/meminfo."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell("cat /proc/meminfo", timeout=8.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or "cat /proc/meminfo failed").strip()
        return {"ok": False, "error": err}

    fields = parse_meminfo(raw)
    required = (
        "MemTotal",
        "MemAvailable",
        "AnonPages",
        "Cached",
        "Buffers",
        "SwapTotal",
        "SwapFree",
    )
    missing = [name for name in required if name not in fields]
    if missing:
        return {
            "ok": False,
            "error": f"未解析到字段: {', '.join(missing)}",
            "raw": raw[:800],
        }

    mem_total = fields["MemTotal"]
    mem_available = fields["MemAvailable"]
    mem_used = max(0, mem_total - mem_available)
    anon_pages = fields["AnonPages"]
    cached = fields["Cached"]
    buffers = fields["Buffers"]
    cached_buffers = cached + buffers
    swap_total = fields["SwapTotal"]
    swap_free = fields["SwapFree"]
    swap_used = max(0, swap_total - swap_free)

    return {
        "ok": True,
        "mem_total_kb": mem_total,
        "mem_available_kb": mem_available,
        "mem_used_kb": mem_used,
        "anon_pages_kb": anon_pages,
        "cached_kb": cached,
        "buffers_kb": buffers,
        "cached_buffers_kb": cached_buffers,
        "swap_total_kb": swap_total,
        "swap_free_kb": swap_free,
        "swap_used_kb": swap_used,
    }
