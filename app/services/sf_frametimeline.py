"""Parse SurfaceFlinger --frametimeline -all via ADB."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_COUNT_RE = re.compile(r"Number of display frames\s*:\s*(\d+)", re.I)
_DISPLAY_RE = re.compile(r"^Display Frame\s+(\d+)(.*)$", re.I)
_LAYER_RE = re.compile(r"^\s*Layer\s*-\s*(.+?)\s*$", re.I)
_KV_RE = re.compile(r"^\s*([^:]+?)\s*:\s*(.*?)\s*$")
_TABLE_HEADER_RE = re.compile(r"Start time.*End time.*Present time", re.I)
_TIMELINE_RE = re.compile(
    r"^\s*(Expected|Actual)\s*\|?\s*(N/A|[\d.+-]+)?\s*\|?\s*(N/A|[\d.+-]+)?\s*\|?\s*(N/A|[\d.+-]+)?\s*$",
    re.I,
)
_SEP_RE = re.compile(r"^-{10,}\s*$")


def _parse_ms(value: str | None) -> float | None:
    if value is None:
        return None
    text = value.strip()
    if not text or text.upper() == "N/A":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _empty_timeline() -> dict[str, float | None]:
    return {"start_ms": None, "end_ms": None, "present_ms": None}


def _apply_timeline_row(
    target: dict[str, Any], kind: str, start: str | None, end: str | None, present: str | None
) -> None:
    key = "expected" if kind.lower() == "expected" else "actual"
    target[key] = {
        "start_ms": _parse_ms(start),
        "end_ms": _parse_ms(end),
        "present_ms": _parse_ms(present),
    }


def _new_display_frame(index: int, janky: bool) -> dict[str, Any]:
    return {
        "index": index,
        "janky": janky,
        "jank_type": None,
        "prediction_state": None,
        "present_metadata": None,
        "finish_metadata": None,
        "start_metadata": None,
        "vsync_period_ms": None,
        "present_delta_ms": None,
        "sf": {
            "expected": _empty_timeline(),
            "actual": _empty_timeline(),
        },
        "layers": [],
    }


def _new_layer(name: str, janky: bool) -> dict[str, Any]:
    return {
        "name": name.strip(),
        "janky": janky,
        "token": None,
        "jank_type": None,
        "prediction_state": None,
        "present_state": None,
        "present_metadata": None,
        "finish_metadata": None,
        "expected": _empty_timeline(),
        "actual": _empty_timeline(),
    }


def _set_kv(target: dict[str, Any], key: str, value: str) -> None:
    k = key.strip().lower().rstrip(":")
    v = value.strip()
    if k == "jank type":
        target["jank_type"] = v
        if v and v.lower() != "none":
            target["janky"] = True
    elif k == "prediction state":
        target["prediction_state"] = v
    elif k == "present metadata":
        target["present_metadata"] = v
    elif k == "finish metadata":
        target["finish_metadata"] = v
    elif k == "start metadata":
        target["start_metadata"] = v
    elif k == "vsync period":
        target["vsync_period_ms"] = _parse_ms(v)
    elif k == "present delta":
        target["present_delta_ms"] = _parse_ms(v)
    elif k == "present state":
        target["present_state"] = v
    elif k == "token":
        try:
            target["token"] = int(v)
        except ValueError:
            target["token"] = v


def parse_frametimeline(text: str) -> dict[str, Any]:
    """Parse FrameTimeline --all dump into structured display frames."""
    lines = (text or "").replace("\r", "").splitlines()
    display_frames: list[dict[str, Any]] = []
    current_df: dict[str, Any] | None = None
    current_layer: dict[str, Any] | None = None
    count_hint: int | None = None

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue

        m_count = _COUNT_RE.search(line)
        if m_count:
            count_hint = int(m_count.group(1))
            continue

        m_df = _DISPLAY_RE.match(line.strip())
        if m_df:
            janky = "[*]" in (m_df.group(2) or "")
            current_df = _new_display_frame(int(m_df.group(1)), janky)
            current_layer = None
            display_frames.append(current_df)
            continue

        m_layer = _LAYER_RE.match(line)
        if m_layer and current_df is not None:
            name = m_layer.group(1).strip()
            janky = "[*]" in name
            if name.endswith("[*]"):
                name = name[: -len("[*]")].rstrip()
                janky = True
            current_layer = _new_layer(name, janky)
            current_df["layers"].append(current_layer)
            continue

        if _TABLE_HEADER_RE.search(line) or _SEP_RE.match(line.strip()):
            continue

        m_tl = _TIMELINE_RE.match(line)
        if m_tl and current_df is not None:
            if current_layer is not None:
                _apply_timeline_row(
                    current_layer,
                    m_tl.group(1),
                    m_tl.group(2),
                    m_tl.group(3),
                    m_tl.group(4),
                )
            else:
                _apply_timeline_row(
                    current_df["sf"],
                    m_tl.group(1),
                    m_tl.group(2),
                    m_tl.group(3),
                    m_tl.group(4),
                )
            continue

        m_kv = _KV_RE.match(line)
        if m_kv and current_df is not None:
            target = current_layer if current_layer is not None else current_df
            _set_kv(target, m_kv.group(1), m_kv.group(2))
            continue

    jank_count = sum(1 for df in display_frames if df.get("janky"))
    return {
        "display_frames": display_frames,
        "count": len(display_frames),
        "count_hint": count_hint,
        "jank_count": jank_count,
    }


def sample() -> dict[str, Any]:
    """Fetch and parse SurfaceFlinger FrameTimeline dump."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell(
            "dumpsys SurfaceFlinger --frametimeline -all",
            timeout=20.0,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or "dumpsys SurfaceFlinger --frametimeline failed").strip()
        return {"ok": False, "error": err}

    parsed = parse_frametimeline(raw)
    if parsed["count"] == 0:
        return {
            "ok": False,
            "error": "未解析到 Display Frame（设备可能不支持 FrameTimeline 或暂无数据）",
            "raw": raw[:1200],
            **parsed,
        }

    return {"ok": True, **parsed}
