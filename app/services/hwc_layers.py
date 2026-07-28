"""Parse SurfaceFlinger --hwclayers output via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_SEP_RE = re.compile(r"^-{10,}\s*$")
_DISPLAY_RE = re.compile(r"^Display\s+(\S+)\s+\(([^)]*)\)\s+HWC layers:", re.I)
_DATA_RE = re.compile(
    r"^\s*rel\s+(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(\S+)\s*\|\s*(-?\d+)\s*\|"
    r"\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\|"
    r"\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\|"
    r"(.*)$"
)


def parse_hwclayers(text: str) -> dict[str, Any]:
    """Parse dumpsys SurfaceFlinger --hwclayers text into structured layers."""
    display_id = None
    display_state = None
    layers: list[dict[str, Any]] = []

    lines = (text or "").replace("\r", "").splitlines()
    i = 0
    pending_name: str | None = None

    while i < len(lines):
        line = lines[i].rstrip()
        i += 1
        if not line:
            continue

        m_disp = _DISPLAY_RE.match(line)
        if m_disp:
            display_id = m_disp.group(1)
            display_state = m_disp.group(2).strip()
            pending_name = None
            continue

        if _SEP_RE.match(line):
            pending_name = None
            continue

        if "Layer name" in line and "|" not in line:
            pending_name = None
            continue

        m_data = _DATA_RE.match(line)
        if m_data and pending_name:
            focused = "[*]" in (m_data.group(13) or "")
            left, top, right, bottom = (
                int(m_data.group(5)),
                int(m_data.group(6)),
                int(m_data.group(7)),
                int(m_data.group(8)),
            )
            layers.append(
                {
                    "name": pending_name.strip(),
                    "z": int(m_data.group(1)),
                    "window_type": int(m_data.group(2)),
                    "comp_type": m_data.group(3).upper(),
                    "transform": int(m_data.group(4)),
                    "frame": {
                        "left": left,
                        "top": top,
                        "right": right,
                        "bottom": bottom,
                        "width": max(0, right - left),
                        "height": max(0, bottom - top),
                    },
                    "source_crop": {
                        "left": float(m_data.group(9)),
                        "top": float(m_data.group(10)),
                        "right": float(m_data.group(11)),
                        "bottom": float(m_data.group(12)),
                    },
                    "focused": focused,
                }
            )
            pending_name = None
            continue

        # Layer name line (not a separator / header / data row)
        if "|" not in line and not line.startswith("Display"):
            pending_name = line.strip()

    # Preserve dumpsys table order: first row = bottom, last row = top.
    for idx, layer in enumerate(layers):
        layer["index"] = idx

    width = 0
    height = 0
    for layer in layers:
        fr = layer["frame"]
        width = max(width, fr["right"])
        height = max(height, fr["bottom"])
    if width <= 0:
        width = 1920
    if height <= 0:
        height = 1080

    return {
        "display_id": display_id,
        "display_state": display_state,
        "width": width,
        "height": height,
        "layers": layers,
        "count": len(layers),
    }


def sample() -> dict[str, Any]:
    """Fetch and parse current HWC layers from the connected device."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell("dumpsys SurfaceFlinger --hwclayers", timeout=15.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or "dumpsys SurfaceFlinger --hwclayers failed").strip()
        return {"ok": False, "error": err}

    parsed = parse_hwclayers(raw)
    if parsed["count"] == 0:
        return {
            "ok": False,
            "error": "no HWC layers parsed",
            "raw": raw[:800],
            **parsed,
        }

    return {"ok": True, **parsed}
