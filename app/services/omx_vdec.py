"""OMX/C2 video decoder debug status via ADB.

OMX status is still a JSON file under /data/vendor/media (needs adb root to
read). C2 status is `dumpsys android.hardware.media.c2.IComponentStore/default`
and does not need root. DumpFrame YUV pulls still need root for both stacks.

A background thread fills an in-memory cache so HTTP handlers are not blocked
by ADB latency.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
from typing import Any

from flask import current_app

from app.services import adb

logger = logging.getLogger(__name__)

STATUS_PATH_DEFAULT = "/data/vendor/media/omx_vdec_status.json"
ENABLE_PROP = "persist.vendor.omx.vdec.debug"
JSON_PATH_PROP = "persist.vendor.omx.vdec.debug.json"
C2_DUMPSYS_CMD = "dumpsys android.hardware.media.c2.IComponentStore/default"
C2_DUMPSYS_MARKER = "--- NC C2 VDEC status ---"
C2_NO_USERDEBUG_HINT = "C2 状态经 dumpsys 读取，开播后即有实例（不需要 userdebug / root）"
C2_DUMPFRAME_EN_PROP = "persist.vendor.codec2.dumpframe.en"
OMX_DUMPFRAME_EN_PROP = "persist.vendor.omx.dumpframe.en"
DUMPFRAME_DIR = "/data/vendor/media"
_SNAP_NAME_RE = re.compile(r"(omx|c2)_last_frame\.V(\d+)\.json$")

# Dashboard-exportable controls only (never free-form setprop).
CONTROLS: list[dict[str, Any]] = [
    {
        "id": "loglevel",
        "prop": "persist.vendor.omx.loglevel",
        "type": "choice",
        "label": "OMX Log",
        "group": "OMX",
        "default": "3",
        "choices": [
            {"value": "1", "label": "DEBUG"},
            {"value": "2", "label": "INFO"},
            {"value": "3", "label": "ERROR"},
        ],
        "hint": "新建 decoder 后生效（1=DEBUG 2=INFO 3=ERROR；组件默认 3）",
    },
    {
        "id": "flowctrl",
        "prop": "persist.vendor.omx.flowctrl.en",
        "type": "bool",
        "label": "OMX FlowCtrl",
        "group": "OMX",
        "default_on": True,
        "hint": "新建 FlowCtrl / decoder 后生效",
    },
    {
        "id": "dumpes",
        "prop": "persist.vendor.omx.dumpes.en",
        "type": "bool",
        "label": "OMX ES Dump",
        "group": "OMX",
        "default_on": False,
        "hint": "新建 decoder 后生效；默认 /data/vendor/media/debug",
    },
    {
        "id": "dumpes_rawpts",
        "prop": "persist.vendor.omx.dumpes.rawpts",
        "type": "bool",
        "label": "OMX ES rawpts",
        "group": "OMX",
        "default_on": False,
        "hint": "配合 ES Dump；新建 decoder 后生效",
    },
    {
        "id": "use_wtl",
        "prop": "persist.vendor.omx.use_wtl",
        "type": "bool",
        "label": "OMX WTL",
        "group": "OMX",
        "default_on": True,
        "hint": "策略开关；新建 decoder 后生效（实际还看 4K/now_wtl_size）",
    },
    {
        "id": "vdec_debug",
        "prop": ENABLE_PROP,
        "type": "bool",
        "label": "OMX Status",
        "group": "OMX",
        "default_on": False,
        "hint": "状态 JSON 导出；需重新开播才会 register",
    },
    {
        "id": "omx_dumpframe",
        "prop": OMX_DUMPFRAME_EN_PROP,
        "type": "bool",
        "label": "OMX DumpFrame",
        "group": "OMX",
        "default_on": False,
        "hint": "开播时读取；打开后约每秒抓一帧。需重新开播生效",
    },
    {
        "id": "c2_loglevel",
        "prop": "persist.vendor.codec2.loglevel",
        "type": "choice",
        "label": "C2 Log",
        "group": "C2",
        "default": "3",
        "choices": [
            {"value": "1", "label": "DEBUG"},
            {"value": "2", "label": "INFO"},
            {"value": "3", "label": "ERROR"},
        ],
        "hint": "新建 Codec2 decoder 后生效（1=DEBUG 2=INFO 3=ERROR；组件默认 3）",
    },
    {
        "id": "c2_flowctrl",
        "prop": "persist.vendor.codec2.flowctrl.en",
        "type": "bool",
        "label": "C2 FlowCtrl",
        "group": "C2",
        "default_on": True,
        "hint": "新建 Codec2 FlowCtrl / decoder 后生效",
    },
    {
        "id": "c2_dumpes",
        "prop": "persist.vendor.codec2.dumpes.en",
        "type": "bool",
        "label": "C2 ES Dump",
        "group": "C2",
        "default_on": False,
        "hint": "新建 Codec2 decoder 后生效；默认 /data/vendor/media/debug",
    },
    {
        "id": "c2_dumpes_rawpts",
        "prop": "persist.vendor.codec2.dumpes.rawpts",
        "type": "bool",
        "label": "C2 ES rawpts",
        "group": "C2",
        "default_on": False,
        "hint": "配合 C2 ES Dump；新建 decoder 后生效",
    },
    {
        "id": "c2_use_wtl",
        "prop": "persist.vendor.codec2.use_wtl",
        "type": "bool",
        "label": "C2 WTL",
        "group": "C2",
        "default_on": True,
        "hint": "策略开关；新建 Codec2 decoder 后生效",
    },
    {
        "id": "c2_dumpframe",
        "prop": C2_DUMPFRAME_EN_PROP,
        "type": "bool",
        "label": "C2 DumpFrame",
        "group": "C2",
        "default_on": False,
        "hint": "开播时读取；打开后约每秒抓一帧。需重新开播生效",
    },
]

_CONTROL_BY_ID = {c["id"]: c for c in CONTROLS}
_CONTROL_PROPS = [c["prop"] for c in CONTROLS]

_ROOT_COOLDOWN_S = 30.0
_PROP_REFRESH_S = 3.0
_POLL_TARGET_S = 0.35
_IDLE_STOP_S = 45.0

_root_lock = threading.Lock()
_last_root_mono = 0.0

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {
    "ok": False,
    "error": "尚未采样",
    "path": STATUS_PATH_DEFAULT,
}
_cache_mono = 0.0
_last_client_mono = 0.0
_omx_client_mono = 0.0
_c2_client_mono = 0.0

_poller_lock = threading.Lock()
_poller_thread: threading.Thread | None = None
_poller_stop = threading.Event()

_cached_enabled = ""
_cached_path = STATUS_PATH_DEFAULT
_cached_c2_enabled = "1"
_cached_c2_path = C2_DUMPSYS_CMD
_cached_controls: list[dict[str, Any]] = []
_last_prop_mono = 0.0

_SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9._\-]+$")


def _ensure_root(*, force: bool = False) -> dict[str, Any]:
    """Best-effort adb root. Rate-limited — adb root restarts adbd and is expensive."""
    global _last_root_mono

    with _root_lock:
        now = time.monotonic()
        if not force and _last_root_mono and (now - _last_root_mono) < _ROOT_COOLDOWN_S:
            return {
                "ok": True,
                "skipped": True,
                "steps": [{"step": "adb root", "skipped": True, "reason": "cooldown"}],
            }
        _last_root_mono = now

    steps: list[dict[str, Any]] = []
    try:
        root = adb.run_adb(["root"], timeout=12.0)
        steps.append(
            {
                "step": "adb root",
                "returncode": root.returncode,
                "stdout": (root.stdout or "").strip()[:200],
                "stderr": (root.stderr or "").strip()[:200],
            }
        )
    except OSError as exc:
        return {"ok": False, "error": f"adb root failed: {exc}", "steps": steps}
    except Exception as exc:
        return {"ok": False, "error": f"adb root failed: {exc}", "steps": steps}

    try:
        adb.run_adb(["wait-for-device"], timeout=15.0)
        time.sleep(0.8)
    except Exception as exc:
        return {"ok": False, "error": f"wait-for-device failed: {exc}", "steps": steps}

    return {"ok": True, "steps": steps}


def _prop_on(raw: str, default_on: bool) -> bool:
    value = (raw or "").strip().lower()
    if value in ("1", "true", "on", "yes"):
        return True
    if value in ("0", "false", "off", "no"):
        return False
    return default_on


def _normalize_set_value(ctrl: dict[str, Any], value: Any) -> str | None:
    if ctrl["type"] == "bool":
        if isinstance(value, bool):
            return "1" if value else "0"
        text = str(value).strip().lower()
        if text in ("1", "true", "on", "yes"):
            return "1"
        if text in ("0", "false", "off", "no"):
            return "0"
        return None
    text = str(value).strip()
    if not text or not _SAFE_VALUE_RE.match(text):
        return None
    allowed = {c["value"] for c in ctrl.get("choices") or []}
    if allowed and text not in allowed:
        return None
    return text


def _filter_controls(controls: list[dict[str, Any]], src: str) -> list[dict[str, Any]]:
    group = "C2" if src == "c2" else "OMX"
    return [c for c in controls if (c.get("group") or group) == group]


def _build_controls(raw_map: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ctrl in CONTROLS:
        raw = raw_map.get(ctrl["prop"], "")
        item: dict[str, Any] = {
            "id": ctrl["id"],
            "prop": ctrl["prop"],
            "type": ctrl["type"],
            "label": ctrl["label"],
            "group": ctrl.get("group", ""),
            "hint": ctrl.get("hint", ""),
            "raw": raw,
        }
        if ctrl["type"] == "bool":
            default_on = bool(ctrl.get("default_on", False))
            item["default_on"] = default_on
            item["on"] = _prop_on(raw, default_on)
            item["value"] = "1" if item["on"] else "0"
            item["explicit"] = raw != ""
        else:
            default = str(ctrl.get("default", ""))
            value = raw if raw != "" else default
            # UI only offers 1/2/3 (DEBUG/INFO/ERROR); coerce nearby OMX levels.
            if ctrl["id"] in ("loglevel", "c2_loglevel"):
                if value == "0":
                    value = "1"
                elif value == "4":
                    value = "3"
                elif value not in ("1", "2", "3"):
                    value = default
            item["default"] = default
            item["value"] = value
            item["choices"] = list(ctrl.get("choices") or [])
            item["explicit"] = raw != ""
        out.append(item)
    return out


def _refresh_props(*, force: bool = False) -> None:
    global _cached_enabled, _cached_path, _cached_controls, _last_prop_mono
    now = time.monotonic()
    if not force and _last_prop_mono and (now - _last_prop_mono) < _PROP_REFRESH_S:
        return

    props = list(dict.fromkeys([*_CONTROL_PROPS, JSON_PATH_PROP]))
    script = " ; ".join(f'echo "__P__|{p}|$(getprop {p})"' for p in props)
    raw_map: dict[str, str] = {}
    try:
        result = adb.run_shell(script, timeout=5.0)
        for line in (result.stdout or "").splitlines():
            if not line.startswith("__P__|"):
                continue
            parts = line.split("|", 2)
            if len(parts) >= 3:
                raw_map[parts[1]] = parts[2].strip()
    except Exception as exc:
        logger.warning("omx props refresh failed: %s", exc)

    _cached_enabled = raw_map.get(ENABLE_PROP, _cached_enabled)
    _cached_path = raw_map.get(JSON_PATH_PROP) or STATUS_PATH_DEFAULT
    _cached_controls = _build_controls(raw_map)
    _last_prop_mono = now


def list_controls(*, src: str | None = None) -> dict[str, Any]:
    _refresh_props(force=True)
    controls = list(_cached_controls)
    if src in ("omx", "c2"):
        controls = _filter_controls(controls, src)
    return {"ok": True, "controls": controls, "src": src or ""}


def set_control(control_id: str, value: Any, *, src: str | None = None) -> dict[str, Any]:
    """Set one allowlisted OMX/C2 debug prop on device."""
    ctrl = _CONTROL_BY_ID.get(control_id)
    if ctrl is None:
        return {"ok": False, "error": f"unknown control: {control_id}"}
    if src in ("omx", "c2"):
        group = "C2" if src == "c2" else "OMX"
        if (ctrl.get("group") or group) != group:
            return {"ok": False, "error": f"{control_id} is not a {group} control"}

    normalized = _normalize_set_value(ctrl, value)
    if normalized is None:
        return {"ok": False, "error": f"invalid value for {control_id}: {value!r}"}

    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    root = _ensure_root(force=False)
    if not root.get("ok"):
        return root

    prop = ctrl["prop"]
    try:
        result = adb.run_shell(f"setprop {prop} {normalized}", timeout=5.0)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "steps": root.get("steps")}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "setprop failed").strip()
        return {"ok": False, "error": err, "prop": prop, "steps": root.get("steps")}

    _refresh_props(force=True)
    try:
        _ensure_poller(current_app._get_current_object())
    except Exception:
        pass

    matched = next((c for c in _cached_controls if c["id"] == control_id), None)
    controls = list(_cached_controls)
    if src in ("omx", "c2"):
        controls = _filter_controls(controls, src)
    return {
        "ok": True,
        "id": control_id,
        "prop": prop,
        "value": normalized,
        "control": matched,
        "controls": controls,
        "hint": ctrl.get("hint", ""),
        "steps": root.get("steps"),
    }


def enable() -> dict[str, Any]:
    """Enable OMX VDEC debug status export (compat wrapper)."""
    return set_control("vdec_debug", "1")


def _yuv_preview_jpeg(data: bytes, meta: dict[str, Any]) -> str | None:
    try:
        import cv2
        import numpy as np
    except Exception:
        return None

    w = int(meta.get("w") or 0)
    h = int(meta.get("h") or 0)
    stride = int(meta.get("stride") or w)
    clip_w = int(meta.get("clip_w") or w)
    clip_h = int(meta.get("clip_h") or h)
    fmt = str(meta.get("format") or "NV12").upper().replace("-", "")
    if stride <= 0 or h <= 0:
        return None
    need = stride * h * 3 // 2
    if len(data) < need:
        return None
    yuv = np.frombuffer(data, dtype=np.uint8, count=need)
    packed = yuv.reshape((h * 3 // 2, stride))
    # WTL is advertised as YV12 to Android but the dump is planar Y-U-V (I420).
    if fmt in ("I420", "IYUV", "YUV420P", "YUV420", "YV12"):
        code = cv2.COLOR_YUV2BGR_I420
    else:
        code = cv2.COLOR_YUV2BGR_NV12
    try:
        bgr = cv2.cvtColor(packed, code)
    except Exception:
        return None
    if clip_h > 0 and clip_w > 0:
        bgr = bgr[: min(clip_h, bgr.shape[0]), : min(clip_w, bgr.shape[1])]
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _dumpframe_globs(src: str | None, *, json_only: bool = False) -> str:
    suffix = ".json" if json_only else ""
    names: list[str] = []
    if src in (None, "omx"):
        names.append(f"{DUMPFRAME_DIR}/omx_last_frame.V*{suffix}")
    if src in (None, "c2"):
        names.append(f"{DUMPFRAME_DIR}/c2_last_frame.V*{suffix}")
    return " ".join(names)


def _list_snap_json_paths(src: str | None = None) -> list[str]:
    result = adb.run_shell(
        f"ls {_dumpframe_globs(src, json_only=True)} 2>/dev/null",
        timeout=4.0,
    )
    paths: list[str] = []
    for token in (result.stdout or "").split():
        token = token.strip()
        if token.endswith(".json") and ("omx_last_frame.V" in token or "c2_last_frame.V" in token):
            paths.append(token)
    return paths


def _pull_snap_meta(path: str) -> dict[str, Any] | None:
    try:
        result = adb.run_adb(["exec-out", "cat", path], timeout=4.0)
    except Exception:
        return None
    text = (result.stdout or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _pull_snap_yuv(path: str) -> bytes:
    result = adb.run_adb_bytes(["exec-out", "cat", path], timeout=12.0)
    return result.stdout or b""


def _frames_from_metas(matched: list[dict[str, Any]]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    for meta in matched:
        item: dict[str, Any] = {
            "src": meta.get("src") or "omx",
            "log_id": meta.get("log_id"),
            "ok": bool(meta.get("ok")),
            "w": meta.get("w"),
            "h": meta.get("h"),
            "stride": meta.get("stride"),
            "clip_w": meta.get("clip_w"),
            "clip_h": meta.get("clip_h"),
            "size": meta.get("size"),
            "pts_us": meta.get("pts_us"),
            "compress": meta.get("compress"),
            "format": meta.get("format") or "",
            "path": meta.get("path") or "",
            "error": meta.get("error") or "",
            "req": meta.get("req"),
        }
        yuv_path = str(item["path"] or "")
        if item["ok"] and yuv_path:
            yuv = _pull_snap_yuv(yuv_path)
            item["yuv_bytes"] = len(yuv)
            jpeg = _yuv_preview_jpeg(yuv, meta) if yuv else None
            if jpeg:
                item["jpeg"] = jpeg
            elif yuv:
                item["error"] = item["error"] or "yuv 已拉取，预览转换失败"
            else:
                item["error"] = item["error"] or "yuv 拉取为空"
                item["ok"] = False
        frames.append(item)
    return frames


def _live_snap_ids(src: str | None) -> set[tuple[str, int]]:
    with _cache_lock:
        insts = list(_cache.get("instances") or [])
    out: set[tuple[str, int]] = set()
    for inst in insts:
        if not isinstance(inst, dict):
            continue
        isrc = str(inst.get("src") or "omx")
        if src and isrc != src:
            continue
        lid = inst.get("log_id")
        if lid is None:
            lid = inst.get("id")
        try:
            out.add((isrc, int(lid)))
        except (TypeError, ValueError):
            continue
    return out


def pull_latest_snaps(*, src: str | None = None) -> dict[str, Any]:
    """Pull already-written last-frame YUV (no dumpframe.req bump)."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    root = _ensure_root(force=False)
    if not root.get("ok"):
        return root

    want = (src or "").strip().lower()
    live = _live_snap_ids(want or None)
    found: list[dict[str, Any]] = []
    for path in _list_snap_json_paths(want or None):
        named = _SNAP_NAME_RE.search(path)
        if named:
            isrc, lid = named.group(1), int(named.group(2))
            if want and isrc != want:
                continue
            if (isrc, lid) not in live:
                continue
        elif not live:
            continue
        meta = _pull_snap_meta(path)
        if not meta:
            continue
        if not meta.get("src"):
            meta["src"] = "c2" if "c2_last_frame" in path else "omx"
        if want and str(meta.get("src") or "") != want:
            continue
        try:
            lid = int(meta.get("log_id"))
        except (TypeError, ValueError):
            continue
        if (str(meta.get("src") or "omx"), lid) not in live:
            continue
        found.append(meta)

    frames = _frames_from_metas(found)
    any_ok = any(f.get("ok") for f in frames)
    return {
        "ok": any_ok,
        "frames": frames,
        "error": "" if any_ok else (frames[0].get("error") if frames else "尚无抓帧文件"),
    }


def _list_dumpframe_paths(src: str | None = None) -> list[str]:
    result = adb.run_shell(
        f"ls {_dumpframe_globs(src, json_only=False)} 2>/dev/null",
        timeout=4.0,
    )
    paths: list[str] = []
    for token in (result.stdout or "").split():
        token = token.strip()
        if "*" in token:
            continue
        if "/omx_last_frame.V" in token or "/c2_last_frame.V" in token:
            paths.append(token)
    return paths


def clear_debug_temps(*, src: str | None = None) -> dict[str, Any]:
    """Delete dumpframe leftovers under /data/vendor/media (engineers, rooted)."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    root = _ensure_root(force=False)
    if not root.get("ok"):
        return root

    before = _list_dumpframe_paths(src)
    try:
        result = adb.run_shell(
            f"rm -f {_dumpframe_globs(src, json_only=False)}",
            timeout=8.0,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "removed": 0, "steps": root.get("steps")}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "rm failed").strip()
        return {"ok": False, "error": err, "removed": 0, "steps": root.get("steps")}

    leftover = _list_dumpframe_paths(src)
    return {
        "ok": True,
        "removed": max(0, len(before) - len(leftover)),
        "paths": before,
        "leftover": leftover,
        "steps": root.get("steps"),
    }


def _attach_controls(payload: dict[str, Any]) -> dict[str, Any]:
    out = dict(payload)
    out["controls"] = list(_cached_controls)
    out["enabled"] = _cached_enabled
    out["c2_enabled"] = _cached_c2_enabled
    out["path"] = out.get("path") or _cached_path or STATUS_PATH_DEFAULT
    out["c2_path"] = out.get("c2_path") or C2_DUMPSYS_CMD
    return out


def _c2_sanitize_text(text: str, *, fallback: str = "") -> str:
    """Drop leftover HAL/dashboard copy that still tells C2 users they need userdebug."""
    s = (text or "").strip()
    if not s:
        return fallback
    low = s.lower()
    if (
        "userdebug" in low
        or "c2_vdec_debug_status" in low
        or "not compiled" in low
        or "编进" in s
        or "调试导出" in s
    ):
        return fallback or C2_NO_USERDEBUG_HINT
    return s


def _parse_json_body(raw: str, *, enabled: str, path: str, src: str = "omx") -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        hint = ""
        if src == "c2":
            hint = C2_NO_USERDEBUG_HINT
        elif enabled not in ("1", "true"):
            hint = f"请先打开 Status（{ENABLE_PROP}=1），并重新开播"
        else:
            hint = "调试已开但尚无状态文件：需 userdebug OMX 构建，且至少创建过一个 decoder"
        return {
            "ok": False,
            "error": "无法读取 dumpsys 状态（空）" if src == "c2" else "无法读取状态文件（空）",
            "hint": hint,
            "path": path,
            "enabled": enabled,
        }

    lower = text.lower()
    if "permission denied" in lower:
        return {
            "ok": False,
            "error": "permission denied",
            "hint": (
                "shell 无法 dumpsys C2 HAL（DUMP 权限）"
                if src == "c2"
                else "打开 Status 或手动 adb root 后再试"
            ),
            "path": path,
            "enabled": enabled,
            "permission_denied": True,
        }
    if "no such file" in lower or "not found" in lower:
        return {
            "ok": False,
            "error": text[:200],
            "hint": (
                "dumpsys 无 C2 VDEC 段：确认已开播"
                if src == "c2"
                else "尚无状态文件：确认 Status 已开并重新开播"
            ),
            "path": path,
            "enabled": enabled,
        }

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "error": f"JSON 解析失败: {exc}",
            "path": path,
            "enabled": enabled,
            "raw": text[:800],
        }

    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "状态根节点不是 object" if src == "c2" else "状态文件根节点不是 object",
            "path": path,
            "enabled": enabled,
        }

    instances = payload.get("instances")
    if not isinstance(instances, list):
        instances = []
    tagged: list[dict[str, Any]] = []
    for inst in instances:
        if isinstance(inst, dict):
            item = dict(inst)
            item.setdefault("src", src)
            tagged.append(item)

    return {
        "ok": True,
        "path": path,
        "enabled": enabled,
        "src": src,
        "status_path": payload.get("status_path", path),
        "server_uptime_ms": payload.get("server_uptime_ms", 0),
        "instance_count": payload.get("instance_count", len(tagged)),
        "instances": tagged,
    }


def _cat_status_file(path: str) -> tuple[str, str]:
    raw = ""
    err = ""
    try:
        result = adb.run_adb(["exec-out", "cat", path], timeout=4.0)
        raw = result.stdout or ""
        if result.returncode != 0 and not raw.strip():
            err = (result.stderr or "").strip()
            shell = adb.run_shell(f'cat "{path}" 2>&1', timeout=4.0)
            raw = shell.stdout or ""
            if shell.returncode != 0 and not raw.strip():
                err = (shell.stderr or err or "cat failed").strip()
    except Exception as exc:
        return "", str(exc)
    return raw, err


def _c2_dumpsys_json() -> tuple[str, str]:
    """Pull C2 VDEC JSON from HAL dump. No adb root."""
    try:
        result = adb.run_shell(C2_DUMPSYS_CMD, timeout=6.0)
    except Exception as exc:
        return "", str(exc)
    text = result.stdout or ""
    err = (result.stderr or "").strip()
    if result.returncode != 0 and not text.strip():
        return "", err or "dumpsys failed"
    lower = text.lower()
    if "permission denied" in lower and C2_DUMPSYS_MARKER not in text:
        return "", "permission denied"
    idx = text.find(C2_DUMPSYS_MARKER)
    if idx < 0:
        return "", "dumpsys 无 C2 VDEC 段（开播后才会 register）"
    body = text[idx + len(C2_DUMPSYS_MARKER) :]
    start = body.find("{")
    if start < 0:
        return "", "尚无 C2 dumpsys JSON（开播后即有）"
    decoder = json.JSONDecoder()
    try:
        _obj, end = decoder.raw_decode(body[start:])
    except json.JSONDecodeError as exc:
        return "", f"JSON 解析失败: {exc}"
    return body[start : start + end], ""


def _client_live(stamp: float) -> bool:
    return bool(stamp) and (time.monotonic() - stamp) < _IDLE_STOP_S


def _pull_once() -> dict[str, Any]:
    """OMX: cat status file (may need root). C2: dumpsys (no root)."""
    _refresh_props(force=False)
    omx_path = _cached_path or STATUS_PATH_DEFAULT
    c2_path = C2_DUMPSYS_CMD
    omx_enabled = _cached_enabled
    c2_enabled = _cached_c2_enabled
    t0 = time.monotonic()
    omx_live = _client_live(_omx_client_mono)

    if omx_live:
        omx_raw, omx_err = _cat_status_file(omx_path)
        omx_parsed = _parse_json_body(omx_raw, enabled=omx_enabled, path=omx_path, src="omx")
        if omx_parsed.get("permission_denied"):
            root = _ensure_root(force=False)
            if root.get("ok") and not root.get("skipped"):
                omx_raw, omx_err = _cat_status_file(omx_path)
                omx_parsed = _parse_json_body(
                    omx_raw, enabled=omx_enabled, path=omx_path, src="omx"
                )
    else:
        omx_err = ""
        omx_parsed = {
            "ok": False,
            "error": "",
            "path": omx_path,
            "enabled": omx_enabled,
            "instances": [],
        }

    c2_raw, c2_err = _c2_dumpsys_json()
    if c2_raw.strip():
        c2_parsed = _parse_json_body(c2_raw, enabled=c2_enabled, path=c2_path, src="c2")
    else:
        c2_parsed = _parse_json_body("", enabled=c2_enabled, path=c2_path, src="c2")
        if c2_err:
            c2_parsed["error"] = _c2_sanitize_text(
                c2_err, fallback="尚无 C2 dumpsys 状态"
            )
            if "permission denied" in c2_err.lower():
                c2_parsed["permission_denied"] = True
                c2_parsed["hint"] = "shell 无法 dumpsys C2 HAL（DUMP 权限）"
            else:
                c2_parsed["hint"] = C2_NO_USERDEBUG_HINT

    if omx_live and omx_err and not (omx_parsed.get("instances") or []) and not c2_raw.strip():
        return _attach_controls(
            {
                "ok": False,
                "error": omx_err or c2_err or omx_parsed.get("error") or "无状态",
                "path": omx_path,
                "c2_path": c2_path,
                "enabled": omx_enabled,
                "c2_enabled": c2_enabled,
                "adb_ms": int((time.monotonic() - t0) * 1000),
            }
        )

    omx_instances = list(omx_parsed.get("instances") or []) if omx_parsed.get("ok") else []
    c2_instances = list(c2_parsed.get("instances") or []) if c2_parsed.get("ok") else []
    instances: list[dict[str, Any]] = [*omx_instances, *c2_instances]

    uptime = max(
        int(omx_parsed.get("server_uptime_ms") or 0),
        int(c2_parsed.get("server_uptime_ms") or 0),
    )
    ok = bool(omx_parsed.get("ok") or c2_parsed.get("ok"))
    parsed: dict[str, Any]
    if ok:
        parsed = {
            "ok": True,
            "path": omx_path,
            "c2_path": c2_path,
            "enabled": omx_enabled,
            "c2_enabled": c2_enabled,
            "status_path": omx_parsed.get("status_path", omx_path),
            "c2_status_path": c2_parsed.get("status_path", c2_path),
            "server_uptime_ms": uptime,
            "instance_count": len(instances),
            "instances": instances,
        }
    else:
        err = c2_parsed.get("error") or omx_parsed.get("error") or "无状态"
        hint = c2_parsed.get("hint") or omx_parsed.get("hint") or ""
        parsed = {
            "ok": False,
            "error": err,
            "hint": hint,
            "path": omx_path,
            "c2_path": c2_path,
            "enabled": omx_enabled,
            "c2_enabled": c2_enabled,
            "instances": [],
            "instance_count": 0,
        }
    parsed["omx_ok"] = bool(omx_parsed.get("ok"))
    parsed["c2_ok"] = bool(c2_parsed.get("ok"))
    parsed["omx_error"] = omx_parsed.get("error") or ""
    parsed["c2_error"] = _c2_sanitize_text(c2_parsed.get("error") or "")
    parsed["omx_instance_count"] = len(omx_instances)
    parsed["c2_instance_count"] = len(c2_instances)
    parsed["adb_ms"] = int((time.monotonic() - t0) * 1000)
    return _attach_controls(parsed)


def _set_cache(payload: dict[str, Any]) -> None:
    global _cache, _cache_mono
    with _cache_lock:
        _cache = dict(payload)
        _cache_mono = time.monotonic()


def _poll_loop(app) -> None:
    logger.info("omx_vdec poller started")
    try:
        with app.app_context():
            while not _poller_stop.is_set():
                if time.monotonic() - _last_client_mono > _IDLE_STOP_S:
                    logger.info("omx_vdec poller idle-stop")
                    break
                t0 = time.monotonic()
                try:
                    payload = _pull_once()
                    _set_cache(payload)
                except Exception:
                    logger.exception("omx_vdec poll failed")
                    _set_cache(
                        _attach_controls(
                            {
                                "ok": False,
                                "error": "poll failed",
                                "path": _cached_path or STATUS_PATH_DEFAULT,
                                "enabled": _cached_enabled,
                            }
                        )
                    )
                elapsed = time.monotonic() - t0
                delay = max(0.05, _POLL_TARGET_S - elapsed)
                if _poller_stop.wait(delay):
                    break
    finally:
        with _poller_lock:
            global _poller_thread
            _poller_thread = None
        logger.info("omx_vdec poller stopped")


def _ensure_poller(app) -> None:
    global _poller_thread, _last_client_mono
    _last_client_mono = time.monotonic()
    with _poller_lock:
        alive = _poller_thread is not None and _poller_thread.is_alive()
        if alive:
            return
        _poller_stop.clear()
        thread = threading.Thread(
            target=_poll_loop,
            args=(app,),
            name="omx-vdec-poller",
            daemon=True,
        )
        _poller_thread = thread
        thread.start()


def _status_empty_hint(payload: dict[str, Any], *, src: str | None = None) -> str:
    """Per-panel empty copy. Do not mention the other codec stack."""
    existing = (payload.get("hint") or "").strip()
    omx_on = _prop_on(str(payload.get("enabled") or ""), False)
    count = int(payload.get("instance_count") or 0)
    if src == "c2":
        if count == 0:
            return _c2_sanitize_text(existing, fallback=C2_NO_USERDEBUG_HINT)
        return _c2_sanitize_text(existing)
    if src == "omx":
        if count == 0:
            if not omx_on:
                return "打开 OMX Status 后重新开播才会出实例。"
            return existing or "尚无 OMX 状态实例。"
        return existing
    return existing


def _project(payload: dict[str, Any], src: str) -> dict[str, Any]:
    """Slice merged poller cache into an OMX-only or C2-only panel payload."""
    out = dict(payload)
    out["src"] = src
    instances = [
        i
        for i in (out.get("instances") or [])
        if isinstance(i, dict) and str(i.get("src") or "omx") == src
    ]
    out["instances"] = instances
    out["instance_count"] = len(instances)
    out["controls"] = _filter_controls(out.get("controls") or [], src)
    if src == "c2":
        out["ok"] = bool(out.get("c2_ok") or instances)
        if not out["ok"]:
            out["error"] = _c2_sanitize_text(
                out.get("c2_error") or out.get("error") or "",
                fallback=C2_NO_USERDEBUG_HINT,
            )
        out["enabled"] = "1"
        out["c2_enabled"] = "1"
        out["path"] = C2_DUMPSYS_CMD
        out["c2_path"] = C2_DUMPSYS_CMD
        out["status_path"] = C2_DUMPSYS_CMD
    else:
        out["ok"] = bool(out.get("omx_ok") or instances)
        if not out["ok"]:
            out["error"] = out.get("omx_error") or out.get("error") or "无状态"
    hint = _status_empty_hint(out, src=src)
    if hint:
        out["hint"] = hint
    return out


def sample(*, src: str | None = None) -> dict[str, Any]:
    """Return latest cached status; keep background poller alive."""
    global _omx_client_mono, _c2_client_mono
    now = time.monotonic()
    if src == "omx":
        _omx_client_mono = now
    elif src == "c2":
        _c2_client_mono = now
    app = current_app._get_current_object()
    _ensure_poller(app)

    with _cache_lock:
        payload = dict(_cache)
        age_ms = int((time.monotonic() - _cache_mono) * 1000) if _cache_mono else None

    if age_ms is None or (not payload.get("ok") and payload.get("error") == "尚未采样"):
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.05)
            with _cache_lock:
                payload = dict(_cache)
                age_ms = int((time.monotonic() - _cache_mono) * 1000) if _cache_mono else None
            if age_ms is not None and payload.get("error") != "尚未采样":
                break

    if "controls" not in payload:
        payload = _attach_controls(payload)
    payload["cache_age_ms"] = age_ms
    payload["poll_target_ms"] = int(_POLL_TARGET_S * 1000)
    if src in ("omx", "c2"):
        return _project(payload, src)
    hint = _status_empty_hint(payload)
    if hint:
        payload["hint"] = hint
    return payload
