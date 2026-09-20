"""Detect whether the connected DUT prefers / is using OMX or Codec2."""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

_CACHE_S = 12.0
_DUMPSYS_CACHE_S = 4.0

_lock = threading.Lock()
_cache: dict[str, Any] = {}
_cache_serial = ""
_cache_mono = 0.0
_dumpsys_mono = 0.0
_dumpsys_names: list[str] = []

_C2_NAME_RE = re.compile(r"\bc2\.nc\.[A-Za-z0-9._]+|\bc2\.nationalchip\.[A-Za-z0-9._]+")
_OMX_NAME_RE = re.compile(r"\bOMX\.nationalchip\.[A-Za-z0-9._]+")

_PROBE_SH = (
    'echo "__CCODEC__|$(getprop debug.stagefright.ccodec)"; '
    'echo "__C2HAL__|$(getprop media.c2.hal.selection)"; '
    "c2so=0; omxso=0; "
    "[ -e /vendor/lib/libcodec2_nc_video_decoder.so ] && c2so=1; "
    "[ -e /vendor/lib64/libcodec2_nc_video_decoder.so ] && c2so=1; "
    "[ -e /vendor/lib/libOMX.nationalchip.video_decoder.so ] && omxso=1; "
    "[ -e /vendor/lib64/libOMX.nationalchip.video_decoder.so ] && omxso=1; "
    'echo "__C2SO__|$c2so"; echo "__OMXSO__|$omxso"; '
    "c2xml=0; [ -e /vendor/etc/media_codecs_c2.xml ] && c2xml=1; "
    'echo "__C2XML__|$c2xml"; '
    'echo "__C2PID__|$(pidof media.c2 android.hardware.media.c2-service 2>/dev/null)"; '
    'echo "__OMXPID__|$(pidof media.codec 2>/dev/null)"'
)

# dumpsys media.player always appends the full MediaCodecList
# ("Decoder infos by media types"). Grepping that looks like C2 is
# always playing. Stop after the live client dump.
_DUMPSYS_SH = (
    "timeout 2.5 dumpsys media.player 2>/dev/null | "
    "sed '/Files opened and\\/or mapped:/q' | "
    "grep -oE 'c2\\.nc\\.[A-Za-z0-9._]+|c2\\.nationalchip\\.[A-Za-z0-9._]+|"
    "OMX\\.nationalchip\\.[A-Za-z0-9._]+' | sort -u"
)


def _preferred(c2_so: bool, omx_so: bool, ccodec: int | None) -> str | None:
    c2_on = c2_so and ccodec != 0
    if c2_on and not omx_so:
        return "c2"
    if omx_so and not c2_on:
        return "omx"
    if c2_on and omx_so:
        # 0 = hide C2. 1-2 rank vendor *avc* C2 last. 3-4 (default 4) = C2 normal.
        if ccodec is None or ccodec >= 3:
            return "c2"
        return "omx"
    if c2_so:
        return "c2"
    if omx_so:
        return "omx"
    return None


def _label(*, preferred: str | None, installed: list[str], playing: str | None) -> str:
    if playing == "both":
        return "C2+OMX 播放中"
    if playing == "c2":
        return "C2 播放中"
    if playing == "omx":
        return "OMX 播放中"
    if preferred == "c2" and "omx" in installed:
        return "C2 优先"
    if preferred == "omx" and "c2" in installed:
        return "OMX 优先"
    if preferred == "c2":
        return "C2"
    if preferred == "omx":
        return "OMX"
    if installed:
        return "+".join(x.upper() for x in installed)
    return "未知"


def _playing_from_names(names: list[str]) -> str | None:
    has_c2 = any(_C2_NAME_RE.search(n) for n in names)
    has_omx = any(_OMX_NAME_RE.search(n) for n in names)
    if has_c2 and has_omx:
        return "both"
    if has_c2:
        return "c2"
    if has_omx:
        return "omx"
    return None


def _refresh_dumpsys_locked() -> None:
    global _dumpsys_mono, _dumpsys_names
    now = time.monotonic()
    if _dumpsys_mono and (now - _dumpsys_mono) < _DUMPSYS_CACHE_S:
        return
    _dumpsys_mono = now
    try:
        result = adb.run_shell(_DUMPSYS_SH, timeout=4.0)
        names: list[str] = []
        for line in (result.stdout or "").splitlines():
            token = line.strip()
            if token:
                names.append(token)
        _dumpsys_names = names
    except Exception as exc:
        logger.debug("codec dumpsys skipped: %s", exc)


def probe(*, force: bool = False) -> dict[str, Any]:
    """Return installed / preferred / currently-playing vendor video stack."""
    global _cache, _cache_serial, _cache_mono, _dumpsys_mono, _dumpsys_names

    status = adb.get_status()
    if not status.get("available"):
        return {
            "ok": False,
            "error": "no adb device online",
            "preferred": None,
            "current": None,
            "label": "无设备",
        }

    serial = (status.get("selected") or {}).get("serial") or ""
    now = time.monotonic()
    with _lock:
        if serial != _cache_serial:
            _dumpsys_mono = 0.0
            _dumpsys_names = []
        if (
            not force
            and _cache
            and _cache_serial == serial
            and _cache_mono
            and (now - _cache_mono) < _CACHE_S
        ):
            _refresh_dumpsys_locked()
            playing = _playing_from_names(_dumpsys_names)
            payload = dict(_cache)
            payload["playing"] = playing
            payload["codecs"] = list(_dumpsys_names)
            payload["current"] = playing or payload.get("preferred")
            payload["label"] = _label(
                preferred=payload.get("preferred"),
                installed=list(payload.get("installed") or []),
                playing=playing,
            )
            _cache = payload
            return dict(payload)

        raw_map: dict[str, str] = {}
        try:
            result = adb.run_shell(_PROBE_SH, timeout=5.0)
            for line in (result.stdout or "").splitlines():
                if line.startswith("__") and "|" in line:
                    key, val = line.split("|", 1)
                    raw_map[key.strip("_")] = val.strip()
        except Exception as exc:
            payload = {
                "ok": False,
                "error": str(exc),
                "preferred": None,
                "current": None,
                "label": "探测失败",
            }
            _cache = payload
            _cache_serial = serial
            _cache_mono = now
            return dict(payload)

        c2_so = raw_map.get("C2SO") == "1"
        omx_so = raw_map.get("OMXSO") == "1"
        c2_xml = raw_map.get("C2XML") == "1"
        ccodec_raw = (raw_map.get("CCODEC") or "").strip()
        ccodec = int(ccodec_raw) if ccodec_raw.lstrip("-").isdigit() else None
        c2_svc = bool((raw_map.get("C2PID") or "").strip())
        omx_svc = bool((raw_map.get("OMXPID") or "").strip())
        _refresh_dumpsys_locked()
        playing = _playing_from_names(_dumpsys_names)

        installed: list[str] = []
        if c2_so or c2_xml or c2_svc:
            installed.append("c2")
        if omx_so or omx_svc:
            installed.append("omx")

        preferred = _preferred(c2_so or c2_xml, omx_so, ccodec)
        current = playing or preferred
        payload = {
            "ok": True,
            "preferred": preferred,
            "current": current,
            "playing": playing,
            "installed": installed,
            "label": _label(
                preferred=preferred,
                installed=installed,
                playing=playing,
            ),
            "ccodec": ccodec,
            "c2_hal": (raw_map.get("C2HAL") or "").strip(),
            "c2_so": c2_so,
            "omx_so": omx_so,
            "c2_xml": c2_xml,
            "c2_service": c2_svc,
            "omx_service": omx_svc,
            "codecs": list(_dumpsys_names),
            "serial": serial,
        }
        _cache = payload
        _cache_serial = serial
        _cache_mono = now
        return dict(payload)
