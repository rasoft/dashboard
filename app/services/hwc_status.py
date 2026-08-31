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
# Accept optional fields between layers and gens, e.g. Sequence:N.
_DISPLAY_RE = re.compile(
    r"^HWC2\s+(.+?)\s*\|\s*layers:\s*(\d+)\s*\|(?:.*?\|\s*)?"
    r"\s*state_gen:\s*(\d+)\s*\|\s*validated_gen:\s*(\d+)\s*$",
    re.I,
)
_SEP_RE = re.compile(r"^-{10,}\s*$")
_HEADER_RE = re.compile(r"^\s*ID\s*\|\s*Z\s*\|", re.I)
_INT4_RE = re.compile(r"(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)")
# Legacy: "1.000 / 255"  New: "255|GLOBAL" / "255|PIXEL"
_ALPHA_SLASH_RE = re.compile(r"^([-\d.]+)\s*/\s*(-?\d+)\s*$")
_ALPHA_PIPE_RE = re.compile(r"^(\d+)\s*\|\s*(\w+)\s*$", re.I)
_NOTE_PREFIXES = ("Content:", "Alpha:", "VPU Z-order:")

# Map header cell text -> logical field. Prefer longer / more specific keys first
# when matching (handled by sorting keys by length descending).
_HEADER_ALIASES: dict[str, str] = {
    "id": "id",
    "z": "z",
    "content": "content",
    "comp": "comp",
    "vpu": "vpu",
    "format": "format",
    "hal fmt": "hal_fmt",
    "vpu fmt": "vpu_fmt",
    "alpha": "alpha",
    "disp frame (l t r b)": "disp_frame",
    "disp frame": "disp_frame",
    "source crop (l t r b)": "source_crop",
    "source crop": "source_crop",
    "vpu view (x y w h)": "vpu_view",
    "vpu view": "vpu_view",
    "vpu clip (x y w h)": "vpu_clip",
    "vpu clip": "vpu_clip",
}


def _parse_int4(text: str) -> dict[str, int] | None:
    m = _INT4_RE.search((text or "").strip())
    if not m:
        return None
    a, b, c, d = (int(m.group(i)) for i in range(1, 5))
    return {"a": a, "b": b, "c": c, "d": d}


def _rect_ltrb(text: str) -> dict[str, int] | None:
    """Parse left/top/right/bottom rectangle."""
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
    """Parse x/y/width/height box (3rd=width, 4th=height — not right/bottom)."""
    vals = _parse_int4(text)
    if not vals:
        return None
    x, y, w, h = vals["a"], vals["b"], vals["c"], vals["d"]
    return {"x": x, "y": y, "width": w, "height": h}


def _parse_alpha(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    m = _ALPHA_SLASH_RE.match(raw)
    if m:
        return {
            "raw": raw,
            "float": float(m.group(1)),
            "byte": int(m.group(2)),
            "mode": None,
        }
    m = _ALPHA_PIPE_RE.match(raw)
    if m:
        byte = int(m.group(1))
        return {
            "raw": raw,
            "float": byte / 255.0,
            "byte": byte,
            "mode": m.group(2).upper(),
        }
    return {"raw": raw, "float": None, "byte": None, "mode": None}


def _normalize_header_cell(cell: str) -> str:
    return re.sub(r"\s+", " ", (cell or "").strip().lower())


def _split_table_cells(line: str, expected_cols: int | None = None) -> list[str]:
    """Split a table row on '|', re-joining Alpha cells like '255|GLOBAL'."""
    parts = [p.strip() for p in (line or "").split("|")]
    # Alpha may embed a pipe ("255|GLOBAL" / "255|PIXEL"), which inflates the
    # column count and shifts VPU View / Clip. Merge digit + mode pairs.
    mode_re = re.compile(r"^(GLOBAL|PIXEL|LOCAL)\w*$", re.I)
    guard = 0
    while guard < 8:
        guard += 1
        if expected_cols is not None and len(parts) <= expected_cols:
            break
        merged = False
        for i in range(len(parts) - 1):
            if re.fullmatch(r"\d+", parts[i]) and mode_re.match(parts[i + 1] or ""):
                parts[i] = f"{parts[i]}|{parts[i + 1]}"
                del parts[i + 1]
                merged = True
                break
        if not merged:
            break
    return parts


def _header_field_map(header_line: str) -> dict[str, int]:
    """Map logical field name -> column index from the table header row."""
    parts = [_normalize_header_cell(p) for p in _split_table_cells(header_line)]
    aliases = sorted(_HEADER_ALIASES.items(), key=lambda kv: len(kv[0]), reverse=True)
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(parts):
        for alias, field in aliases:
            if cell == alias or cell.startswith(alias):
                mapping.setdefault(field, idx)
                break
    mapping["_ncols"] = len(parts)  # type: ignore[assignment]
    return mapping


def _cell(parts: list[str], colmap: dict[str, int], field: str) -> str:
    idx = colmap.get(field)
    if idx is None or idx < 0 or idx >= len(parts):
        return ""
    return parts[idx].strip()


def _parse_layer_row(line: str, colmap: dict[str, int]) -> dict[str, Any] | None:
    expected = colmap.get("_ncols")
    parts = _split_table_cells(line, expected_cols=expected if isinstance(expected, int) else None)
    if len(parts) < 5:
        return None

    id_text = _cell(parts, colmap, "id") or (parts[0] if parts else "")
    z_text = _cell(parts, colmap, "z") or (parts[1] if len(parts) > 1 else "")
    try:
        layer_id = int(id_text)
        z = int(z_text)
    except ValueError:
        return None

    comp_raw = _cell(parts, colmap, "comp") or (parts[3] if len(parts) > 3 else "")
    comp_star = comp_raw.endswith("*")
    comp = comp_raw.rstrip("*").strip()

    format_text = (
        _cell(parts, colmap, "vpu_fmt")
        or _cell(parts, colmap, "format")
        or _cell(parts, colmap, "hal_fmt")
    )

    # VPU View / Clip are (x y w h): 3rd=width, 4th=height.
    vpu_view = _box_xywh(_cell(parts, colmap, "vpu_view"))
    vpu_clip = _box_xywh(_cell(parts, colmap, "vpu_clip"))

    return {
        "id": layer_id,
        "z": z,
        "content": _cell(parts, colmap, "content") or (parts[2] if len(parts) > 2 else ""),
        "comp": comp,
        "comp_star": comp_star,
        "vpu": _cell(parts, colmap, "vpu") or (parts[4] if len(parts) > 4 else ""),
        "format": format_text,
        "hal_fmt": _cell(parts, colmap, "hal_fmt") or None,
        "vpu_fmt": _cell(parts, colmap, "vpu_fmt") or None,
        "alpha": _parse_alpha(_cell(parts, colmap, "alpha")),
        "disp_frame": _rect_ltrb(_cell(parts, colmap, "disp_frame")),
        "source_crop": _rect_ltrb(_cell(parts, colmap, "source_crop")),
        "vpu_view": vpu_view,
        "vpu_clip": vpu_clip,
    }


def parse_hwc_status(text: str) -> dict[str, Any]:
    """Parse NationalChip HWC table from composer dumpsys text."""
    lines = (text or "").replace("\r", "").replace("\0", "").splitlines()

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
    colmap: dict[str, int] = {}

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
            colmap = _header_field_map(stripped)
            continue

        if _SEP_RE.match(stripped):
            if seen_header and not in_table:
                in_table = True
            elif in_table:
                in_table = False
            continue

        if in_table:
            if not colmap:
                continue
            row = _parse_layer_row(stripped, colmap)
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

    raw = (result.stdout or "").replace("\0", "")
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
