"""Parse SurfaceFlinger --hwclayers output via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_SEP_RE = re.compile(r"^-{10,}\s*$")
_DISPLAY_RE = re.compile(r"^\s*Display\s+(\S+)\s+\(([^)]*)\)\s+HWC layers:", re.I)

# Android 14 (and 15 legacy): relative Z is prefixed with "rel".
#   rel      0 |            1 |     DEVICE |          0 |    0    0 1920 1080 | ...
_DATA_RE_A14 = re.compile(
    r"^\s*rel\s+(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(\S+)\s*\|\s*(-?\d+)\s*\|"
    r"\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\|"
    r"\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\|"
    r"(.*)$"
)

# Android 16: global Z, no "rel" prefix. Transform is a token (often "0").
#            3 |            1 |     DEVICE |          0 |    0    0 3840 2160 | ...
_DATA_RE_A16 = re.compile(
    r"^\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|"
    r"\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\|"
    r"\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\|"
    r"(.*)$"
)


def hwclayers_format(android: dict[str, Any] | None) -> str:
    """Pick a dumpsys --hwclayers parser from the probed Android version."""
    major = (android or {}).get("major")
    if isinstance(major, int) and major >= 16:
        return "a16"
    return "a14"


def _transform_value(token: str) -> int | str:
    try:
        return int(token)
    except (TypeError, ValueError):
        return token


def _layer_from_match(name: str, match: re.Match[str]) -> dict[str, Any]:
    focused = "[*]" in (match.group(13) or "")
    left, top, right, bottom = (
        int(match.group(5)),
        int(match.group(6)),
        int(match.group(7)),
        int(match.group(8)),
    )
    return {
        "name": name.strip(),
        "z": int(match.group(1)),
        "window_type": int(match.group(2)),
        "comp_type": match.group(3).upper(),
        "transform": _transform_value(match.group(4)),
        "frame": {
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "width": max(0, right - left),
            "height": max(0, bottom - top),
        },
        "source_crop": {
            "left": float(match.group(9)),
            "top": float(match.group(10)),
            "right": float(match.group(11)),
            "bottom": float(match.group(12)),
        },
        "focused": focused,
    }


def parse_hwclayers(text: str, *, fmt: str = "a14") -> dict[str, Any]:
    """Parse dumpsys SurfaceFlinger --hwclayers text into structured layers."""
    data_re = _DATA_RE_A16 if fmt == "a16" else _DATA_RE_A14
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

        m_data = data_re.match(line)
        if m_data and pending_name:
            layers.append(_layer_from_match(pending_name, m_data))
            pending_name = None
            continue

        # Layer name line (not a separator / header / data row)
        if "|" not in line and not line.lstrip().lower().startswith("display"):
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
        "format": fmt if fmt == "a16" else "a14",
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

    android = status.get("android")
    fmt = hwclayers_format(android)
    parsed = parse_hwclayers(raw, fmt=fmt)
    if parsed["count"] == 0:
        other = "a14" if fmt == "a16" else "a16"
        alt = parse_hwclayers(raw, fmt=other)
        if alt["count"] > 0:
            parsed = alt
    if parsed["count"] == 0:
        label = "Android 16" if fmt == "a16" else "Android 14"
        return {
            "ok": False,
            "error": f"no HWC layers parsed ({label} format)",
            "raw": raw[:800],
            "android": android,
            **parsed,
        }

    return {"ok": True, "android": android, **parsed}
