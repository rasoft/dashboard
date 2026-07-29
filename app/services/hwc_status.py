"""Parse NationalChip HWC status from composer dumpsys via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

DUMP_CMD = "dumpsys android.hardware.graphics.composer3.IComposer/default"

_SECTION_RE = re.compile(r"NationalChip\s+HWC", re.I)
_DISPLAY_RE = re.compile(
    r"^HWC2\s+(.+?)\s*\|\s*layers:\s*(\d+)\s*\|\s*state_gen:\s*(\d+)\s*\|\s*validated_gen:\s*(\d+)\s*$",
    re.I,
)
_SEP_RE = re.compile(r"^-{10,}\s*$")
_HEADER_RE = re.compile(r"^\s*ID\s*\|\s*Z\s*\|", re.I)
_INT4_RE = re.compile(r"(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)")
_ALPHA_RE = re.compile(r"^([-\d.]+)\s*/\s*(-?\d+)\s*$")
_NOTE_PREFIXES = ("Content:", "Alpha:", "VPU Z-order:")


def _parse_int4(text: str) -> dict[str, int] | None:
    m = _INT4_RE.search((text or "").strip())
    if not m:
        return None
    a, b, c, d = (int(m.group(i)) for i in range(1, 5))
    return {"a": a, "b": b, "c": c, "d": d}


def _rect_ltrb(text: str) -> dict[str, int] | None:
    vals = _parse_int4(text)
    if not vals:
        return None
    left, top, right, bottom = vals["a"], vals["b"], vals["c"], vals["d"]
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": max(0, right - left),
        "height": max(0, bottom - top),
    }


def _box_xywh(text: str) -> dict[str, int] | None:
    vals = _parse_int4(text)
    if not vals:
        return None
    x, y, w, h = vals["a"], vals["b"], vals["c"], vals["d"]
    return {"x": x, "y": y, "width": w, "height": h}


def _parse_alpha(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    m = _ALPHA_RE.match(raw)
    if not m:
        return {"raw": raw, "float": None, "byte": None}
    return {
        "raw": raw,
        "float": float(m.group(1)),
        "byte": int(m.group(2)),
    }


def _parse_layer_row(line: str) -> dict[str, Any] | None:
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 11:
        return None
    try:
        layer_id = int(parts[0])
        z = int(parts[1])
    except ValueError:
        return None

    comp_raw = parts[3]
    comp_star = comp_raw.endswith("*")
    comp = comp_raw.rstrip("*").strip()

    return {
        "id": layer_id,
        "z": z,
        "content": parts[2],
        "comp": comp,
        "comp_star": comp_star,
        "vpu": parts[4],
        "format": parts[5],
        "alpha": _parse_alpha(parts[6]),
        "disp_frame": _rect_ltrb(parts[7]),
        "source_crop": _rect_ltrb(parts[8]),
        "vpu_view": _box_xywh(parts[9]),
        "vpu_clip": _box_xywh(parts[10]),
    }


def parse_hwc_status(text: str) -> dict[str, Any]:
    """Parse NationalChip HWC table from composer dumpsys text."""
    lines = (text or "").replace("\r", "").splitlines()

    start = None
    for i, line in enumerate(lines):
        if _SECTION_RE.search(line):
            start = i
            break

    display_name = None
    layer_count_hdr = None
    state_gen = None
    validated_gen = None
    layers: list[dict[str, Any]] = []
    notes: list[str] = []

    if start is None:
        return {
            "display_name": display_name,
            "state_gen": state_gen,
            "validated_gen": validated_gen,
            "layers": layers,
            "notes": notes,
            "count": 0,
            "header_layers": layer_count_hdr,
        }

    in_table = False
    seen_header = False

    for line in lines[start:]:
        stripped = line.strip()
        if not stripped:
            continue

        m_disp = _DISPLAY_RE.match(stripped)
        if m_disp:
            display_name = m_disp.group(1).strip()
            layer_count_hdr = int(m_disp.group(2))
            state_gen = int(m_disp.group(3))
            validated_gen = int(m_disp.group(4))
            continue

        if _HEADER_RE.match(stripped):
            seen_header = True
            in_table = False
            continue

        if _SEP_RE.match(stripped):
            if seen_header and not in_table:
                in_table = True
            elif in_table:
                in_table = False
            continue

        if in_table:
            row = _parse_layer_row(stripped)
            if row:
                layers.append(row)
            continue

        if any(stripped.startswith(p) for p in _NOTE_PREFIXES):
            notes.append(stripped)

    layers.sort(key=lambda layer: (layer["z"], layer["id"]), reverse=True)

    return {
        "display_name": display_name,
        "state_gen": state_gen,
        "validated_gen": validated_gen,
        "layers": layers,
        "notes": notes,
        "count": len(layers),
        "header_layers": layer_count_hdr,
    }


def sample() -> dict[str, Any]:
    """Fetch and parse NationalChip HWC status from the connected device."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell(DUMP_CMD, timeout=15.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or f"{DUMP_CMD} failed").strip()
        return {"ok": False, "error": err}

    parsed = parse_hwc_status(raw)
    if parsed["count"] == 0:
        return {
            "ok": False,
            "error": "no NationalChip HWC layers parsed",
            "raw": raw[:1200],
            **parsed,
        }

    return {"ok": True, **parsed}
